# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Fictional-but-realistic demo dataset, loaded into an empty tenant DB.

Two consumers share this builder: a prospective user exploring the app before committing their own
data, and the Playwright E2E suite, which needs a populated, past-onboarding baseline. The data is
entirely invented (generic well-known vendors only, fictional owners/accounts — no PII), and shaped to
exercise the features worth showing: multiple owners and account types, per-account import batches
(provenance), custom categories and rules, category- and account-level tags that *inherit* onto
transactions, a year of recurring + one-off activity, a standing two-legged inter-account transfer, card
payments, a refund, an Amazon order history reconciled against the card, a payment-app wallet whose rows
pair with their checking-side mirrors, a merchant-less rule that raises an alert, and a cross-account
duplicate that the real post-import sweep flags for review.

Amount sign follows the stored convention (categorizer `_amount_side_matches`): debits/spending are
**positive**, credits/income are **negative**. `content_hash` mirrors the importer's `make_hash` so a
later re-import of equivalent rows dedupes naturally.

`load_demo_data` is a no-op on any non-empty tenant (guards on existing accounts/transactions), so it
can never overwrite or pollute real data.
"""

import calendar
import csv
import hashlib
import io
import json
import random
import uuid
from datetime import date, timedelta


ESSENTIAL_TAG = "Essential Expenses"
DISCRETIONARY_TAG = "Discretionary"
TAX_TAG = "Tax Reporting"

# Balances as the household's position: positive held, negative owed (`services/account_balances.py`). The
# bank's are each account's balance before the file's first row; the rows carry them from there.
BANK_OPENING_BALANCES = {"checking": 4000.00, "savings": 8000.00}
CARD_STATEMENT_BALANCE = -1800.00
BROKERAGE_BALANCE = 40000.00
BROKERAGE_CONTRIBUTION = 1500.00

# Marker (in the data DB's import_workflow_state) recording that this tenant's data is the demo set.
# It is the contract that keeps demo and real data from ever mixing: while it is present, new imports
# and data-source connections are blocked, and the demo-clear wipe refuses to run unless it is present
# (so the wipe can never destroy real data, which never carries the marker).
DEMO_DATA_STATE_KEY = "demo_data"


def _content_hash(date_str: str, amount: float, description: str) -> str:
    # Mirrors routers/import_export/core.make_hash so demo rows dedupe against an equivalent re-import.
    raw = f"{date_str.strip()}|{amount:.2f}|{description.strip().lower()}"
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def _render_csv(headers: list[str], rows: list[tuple]) -> str:
    """Render header + rows to CSV text (proper quoting), so the demo feeds the real import pipeline the
    same way a user-supplied file would."""
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(headers)
    for row in rows:
        writer.writerow(row)
    return buf.getvalue()


def _insert_demo_profile(conn, name: str, column_map: dict, *, use_imported_categories: int) -> str:
    """Create a saved data-source profile so the demo's imported files land under a named source (with the
    realistic 'use categories present in the data' default) instead of the unknown-source bucket."""
    from backend.db.database import DEFAULT_CSV_TERMINAL_WINDOW_DAYS
    pid = str(uuid.uuid4())
    conn.execute(
        # terminal_window_days is stated rather than left to the column default: on a database that
        # added the column before the default changed, the default is still the old one.
        """INSERT INTO csv_import_profile
             (id, name, column_map, date_format, amount_convention, use_imported_categories,
              terminal_window_days)
           VALUES (?, ?, ?, '%Y-%m-%d', 'single_signed', ?, ?)""",
        (pid, name, json.dumps(column_map), use_imported_categories, DEFAULT_CSV_TERMINAL_WINDOW_DAYS),
    )
    return pid


def _category_lookup(conn):
    """Return (groups, leaves) name→id maps for the seeded category tree (names collide across the two
    levels, so they're kept separate)."""
    groups, leaves = {}, {}
    for row in conn.execute("SELECT id, name, parent_id FROM category"):
        (groups if row["parent_id"] is None else leaves)[row["name"]] = row["id"]
    return groups, leaves


def is_demo_loadable(conn) -> bool:
    """True only when the tenant is a true blank slate (the seeded category tree doesn't count). Guards
    the loader so it can't touch a real database, and gates the "Load demo data" offer. Beyond actual
    data rows, a **configured source counts as engagement**: a saved data source (`csv_import_profile`)
    or a linked connection (`connection`) means the user has set up their own pipeline, so the demo
    offer disappears even before any rows have imported or synced."""
    row = conn.execute(
        """
        SELECT (SELECT COUNT(*) FROM account)            AS accounts,
               (SELECT COUNT(*) FROM txn)                AS txns,
               (SELECT COUNT(*) FROM connection)         AS connections,
               (SELECT COUNT(*) FROM csv_import_profile) AS sources
        """
    ).fetchone()
    return (
        row["accounts"] == 0
        and row["txns"] == 0
        and row["connections"] == 0
        and row["sources"] == 0
    )


def is_demo_data_loaded(conn) -> bool:
    """True when this tenant's data was loaded by the demo loader (the marker in import_workflow_state).
    This is the gate for the demo-clear wipe — real data never carries the marker, so the wipe refuses to
    run on it — and the signal that blocks new imports/connections so demo and real data never mix."""
    row = conn.execute(
        "SELECT payload_json FROM import_workflow_state WHERE key = ?", (DEMO_DATA_STATE_KEY,)
    ).fetchone()
    if not row:
        return False
    try:
        return bool(json.loads(row["payload_json"] or "{}").get("loaded"))
    except (ValueError, TypeError):
        return False


def _seed_demo_preferences(conn, scope_id: str) -> None:
    """Open the demo in an inviting, expanded state. Several panels collapse by default (the accounts
    list and owners among them), which buries the seeded data on first view; seed the UI preferences
    (data DB, keyed by the profile's scope_id, JSON-encoded like the /preferences API stores them) so a
    fresh demo profile lands expanded. Add more keys here for other panels worth opening up front."""
    prefs = {
        "ui.accounts.sections": {"accountList": True, "dataSources": False, "accountOwners": True},
    }
    for key, value in prefs.items():
        conn.execute(
            """INSERT INTO ui_preference (scope_id, pref_key, pref_value, updated_at)
               VALUES (?, ?, ?, datetime('now'))
               ON CONFLICT(scope_id, pref_key) DO UPDATE SET pref_value = excluded.pref_value""",
            (scope_id, key, json.dumps(value)),
        )


# The card number Amazon's order history names. The demo card carries no mask, as an imported ledger
# usually does not, so it is the funding-source map that says which account this number charges.
_AMAZON_CARD_LAST4 = "4417"

# What was in each order, keyed by the index of the card's Amazon charge it accounts for. The newest
# charge is index 0. Index 7, the oldest, has no order — the export was taken from a week after it — so
# the reconciliation report has one Amazon charge that no order accounts for, the bucket that asks the
# user whether an earlier history covers it.
_AMAZON_ORDER_ITEMS = {
    0: [("USB-C charging cable, 2-pack", 1, 21.99)],
    1: [("Cordless stick vacuum", 1, 109.99)],
    2: [("Paperback novel", 1, 13.10)],
    3: [("Orthopedic dog bed, medium", 1, 39.99), ("Rope chew toys", 3, 4.20)],
    4: [("Printer paper, 500 sheets", 2, 9.49), ("Gel pens, 12-pack", 1, 9.99)],
    5: [("Trail running shoes", 1, 59.99), ("Phone tripod", 1, 13.50)],   # split per item afterwards
    6: [("Phone case", 1, 18.49)],
}


def _import_amazon_orders(conn, amazon_account_id: str, card_account_id: str, charges, d) -> None:
    """Import an Amazon order history through the marketplace importer, as the Amazon form would.

    The card shows only "Amazon" and an amount; the order history says what was bought. Importing it
    puts each order on the Amazon account as the spending, itemized, and moves the card charge it
    accounts for to the excluded Amazon Funding leaf, so the money counts once and the reconciliation
    report has matched orders to show. One order was paid from a gift-card balance, which no tracked
    account ever charged: it is recorded without a charge, the other case the report distinguishes.
    """
    from backend.routers.import_export.amazon import read_amazon_exports, run_amazon_import
    from backend.services.amazon_funding import upsert_funding_source
    from backend.services.amazon_import import merge

    upsert_funding_source(conn, last4=_AMAZON_CARD_LAST4, network="Visa", funding_account_id=card_account_id)

    orders, items = [], []

    def order(order_id, days_ago, contents, payments, total):
        ordered = d(days_ago)
        orders.append((order_id, "", "; ".join(desc for desc, _, _ in contents) + "; ", "Jordan Lee",
                       ordered, f"{total:.2f}", "0", "", "", f"{round(total * 0.07, 2):.2f}", "", payments))
        for desc, quantity, price in contents:
            items.append((order_id, "", ordered, quantity, desc, "", f"${price:.2f}", "0", "", ""))

    for index, contents in _AMAZON_ORDER_ITEMS.items():
        charged_days_ago, amount = charges[index]
        # Amazon charges when an order ships, so the order is placed a day or two before its charge.
        order(f"113-{4100000 + index:07d}-{2600000 + index * 7:07d}", charged_days_ago + 1 + index % 2,
              contents, f"Visa ending in {_AMAZON_CARD_LAST4}: {d(charged_days_ago)}: ${amount:.2f}; ", amount)
    order("113-4100099-2600099", 34, [("Strategy board game", 1, 27.50)], "Gift Card Balance; ", 29.43)

    orders_text = _render_csv(
        ["order id", "order url", "items", "to", "date", "total", "shipping", "shipping_refund", "gift",
         "tax", "refund", "payments"], orders)
    items_text = _render_csv(
        ["order id", "order url", "order date", "quantity", "description", "item url", "price",
         "subscribe & save", "ASIN", "category"], items)
    parsed, items_by_order, names, _unrecognized, _skipped, file_hashes = read_amazon_exports(
        [("amazon-orders.csv", orders_text), ("amazon-items.csv", items_text)])
    run_amazon_import(conn, merge(parsed, items_by_order), account_id=amazon_account_id,
                      filename=", ".join(names), file_hashes=file_hashes)


def load_demo_data(conn, scope_id: str | None = None) -> dict:
    """Populate an empty tenant with the demo dataset. No-op (returns skipped=True) on a non-empty DB.
    When `scope_id` (the local preference-profile id) is given, also seed UI preferences so the demo
    opens expanded. Caller owns the transaction/commit."""
    if not is_demo_loadable(conn):
        return {"skipped": True, "reason": "tenant already has accounts or transactions"}

    from backend.db.database import _seed_default_categories, SHARED_OWNER_ID
    from backend.db.demo_examples import seed_all
    from backend.routers.import_export.core import run_import_core
    from backend.services.account_balances import record_manual_balance
    from backend.services.wallet_accounts import fill_wallet_match_text

    # An organized starter tree to map imported labels into: a file category that matches a starter leaf
    # reuses it; one that doesn't (e.g. "Pet Care") is created under Unassigned by the import itself.
    _seed_default_categories(conn, include_leaves=True)

    today = date.today()

    def d(days_ago: int) -> str:
        return (today - timedelta(days=days_ago)).isoformat()

    # A bill falls on the same day every month. Stepping back a fixed thirty days instead drifts across
    # month ends, so depending on the load date one calendar month gets two rents and the next none, and
    # every monthly chart turns lumpy. `days_ago` places the newest occurrence; a shorter month takes its
    # last day.
    def monthly(days_ago: int, months_back: int) -> str:
        newest = today - timedelta(days=days_ago)
        year, month0 = divmod(newest.year * 12 + newest.month - 1 - months_back, 12)
        last_day = calendar.monthrange(year, month0 + 1)[1]
        return date(year, month0 + 1, min(newest.day, last_day)).isoformat()

    # Everyday spending comes at irregular gaps, bunched some weeks and sparse others, so it covers every
    # day of the month rather than repeating one weekday or one day-of-month. A fixed seed keeps the
    # ledger identical on every load.
    rng = random.Random(2026)

    def scattered(mean_gap: float, first: int, *, until: int = 388, count: int | None = None) -> list[int]:
        days_ago, day = [], first
        while (day <= until) if count is None else (len(days_ago) < count):
            days_ago.append(day)
            day += max(1, round(rng.gammavariate(3, mean_gap / 3)))
        return days_ago

    # --- Owners + accounts up front (typed + owned). The CSVs reference accounts by name, so the import
    # maps onto these rather than creating untyped, unowned accounts. ---
    owners = {
        "Alex": (str(uuid.uuid4()), "Alex Rivera", "#2563eb"),
        "Jordan": (str(uuid.uuid4()), "Jordan Lee", "#db2777"),
    }
    for oid, name, color in owners.values():
        conn.execute(
            "INSERT INTO owner (id, name, color, flag_new_for_review, count_uncategorized_in_tasks) VALUES (?, ?, ?, 1, 1)", (oid, name, color)
        )

    accounts = {
        "checking": (str(uuid.uuid4()), "Everyday Checking", "depository", owners["Alex"][0]),
        "savings": (str(uuid.uuid4()), "Rainy Day Savings", "savings", SHARED_OWNER_ID),
        "card": (str(uuid.uuid4()), "Rewards Card", "credit", owners["Jordan"][0]),
        "brokerage": (str(uuid.uuid4()), "Brokerage", "investment", owners["Jordan"][0]),
        "amazon": (str(uuid.uuid4()), "Amazon", "amazon", owners["Jordan"][0]),
        # A payment app. Being a wallet is what the type says; its name is the text its other side carries
        # on checking, which `fill_wallet_match_text` takes up as every account-creating write does.
        "wallet": (str(uuid.uuid4()), "PocketPay", "p2p", owners["Alex"][0]),
    }
    for aid, name, acct_type, owner_id in accounts.values():
        conn.execute(
            """INSERT INTO account (id, external_account_id, connection_id, provider, name, display_name, type, owner_id)
               VALUES (?, NULL, NULL, 'manual', ?, ?, ?, ?)""",
            (aid, name, name, acct_type, owner_id),
        )
    fill_wallet_match_text(conn, [accounts["wallet"][0]])
    name_of = {key: accounts[key][1] for key in accounts}

    # ===== Source 1: "Everyday Bank" — a curated export WITH a Category column (checking + savings).
    # Format A headers: Date, Description, Category, Amount, Account. Spending positive, income negative. =====
    bank_rows = []  # (date, description, category, amount, account_name)

    # `amount` is the intended STORED value (spending +, income −). The CSV carries the natural bank
    # convention (income +, spending −); single_signed import negates it back (parse_amount → -val).
    def bank(when, desc, category, amount, acct):
        bank_rows.append((when, desc, category, f"{-amount:.2f}", name_of[acct]))

    # The steady activity runs thirteen months, so "Last 12 months" — the dashboard's default period — is
    # full from end to end and every trend chart has a year of shape rather than a few recent bars. The
    # figures are sized to one household: income clears spending by a believable margin, not by double.
    def seasonal(by_month, when):
        return by_month[int(when[5:7]) - 1]

    for i in range(28):
        bank(d(7 + i * 14), "Acme Corp Payroll", "Salary", -2400.00, "checking")
    # Occasional freelance work: irregular in both timing and size, the income that is not a paycheck.
    for days_ago, amount in [(24, 1150.00), (118, 860.00), (205, 1400.00), (290, 725.00), (370, 980.00)]:
        bank(d(days_ago), "Brightline Design — invoice", "Freelance", -amount, "checking")
    # Electricity peaks in summer (air conditioning), the opposite of the gas bill below.
    power_by_month = [88.40, 81.15, 76.30, 72.85, 84.10, 118.60,
                      146.25, 152.90, 121.40, 86.75, 78.20, 90.65]
    for m in range(13):
        bank(monthly(1, m), "Parkside Apartments", "Rent & Mortgage", 2200.00, "checking")
        power_day = monthly(3, m)
        bank(power_day, "City Power & Light", "Electricity", seasonal(power_by_month, power_day), "checking")
        bank(monthly(4, m), "Fiberlink", "Internet", 69.99, "checking")
        bank(monthly(5, m), "CellOne Mobile", "Phone", 55.00, "checking")
        bank(monthly(10, m), "Keystone Auto Insurance", "Auto Insurance", 132.00, "checking")
    # A housemate pays their share of the rent back a few days after it goes out. The newest rent has
    # nothing back yet; demo_examples files the shares and these repayments as a receivable.
    for m in range(1, 13):
        paid_back = (date.fromisoformat(monthly(1, m)) + timedelta(days=3)).isoformat()
        bank(paid_back, "Jamie Ortiz — rent share", "Reimbursed Expenses", -700.00, "checking")
    # Month 0's water bill is the one that outgrew its rule, further down.
    for m in range(1, 13):
        bank(monthly(6, m), "Metro Water", "Water", 34.10 + (m * 7) % 12, "checking")
    # A gas bill with a real winter peak, carried back far enough to be seasonal rather than noisy. Two
    # features need this shape and nothing else in the set provides it: the price-change signal's
    # tightness test (which reads the whole prior history, so four flat summer bills must not make the
    # series look fixed-price) and the range learning behind dismissing one of its warnings. It also
    # gives year-over-year comparison a second year to compare against.
    gas_by_month = [148.20, 132.75, 88.40, 61.30, 44.85, 39.10,
                    41.60, 43.25, 58.90, 79.40, 104.60, 139.80]
    for m in range(14):
        gas_day = monthly(8, m)
        bank(gas_day, "Northgate Gas", "Natural Gas", seasonal(gas_by_month, gas_day), "checking")

    # A subscription that stops two periods before the data ends. Two constraints decide those numbers
    # and they pull against each other: the missed signal is judged against how fresh the *data* is
    # rather than against today, so the series has to stop before the newest rows — but detection scores
    # recency to zero at three periods without a charge, and an undetected series cannot be missed. A
    # long run ending about two and a half months back sits in the gap, and reads as what it is: a
    # subscription that was cancelled, or a payment method that quietly expired.
    for m in range(7):
        bank(monthly(72, m), "CloudVault Backup", "Software & Subscriptions", 9.99, "checking")

    # The other bill from the same biller, and the reason its rule carries a floor rather than the water
    # rule simply matching everything: told apart by size, nothing else about them differs.
    bank(d(75), "Metro Water", "Home Repairs", 185.00, "checking")

    # The newest water bill, arriving just past the ceiling on the rule that files these. It carries no
    # category *because* of that: the range on a rule is a matching gate, so a bill that grows past it
    # stops matching and quietly stops being categorized. Nothing else in the app notices, which is the
    # whole reason the drift signal exists — and why this row must not be filed under Water here, since
    # a row already carrying the rule's own category is by definition fine.
    bank(monthly(6, 0), "Metro Water", "", 63.40, "checking")

    # A standing transfer, recorded twice — leaving checking and arriving in savings — which is what
    # every movement between two tracked accounts looks like to a ledger organized by account. Detection
    # makes two series of it and the Recurring page folds them back into the one movement they describe
    # (services/recurring_pairs.py), so this runs over enough months for that pairing to be visible. The
    # two sides are worded differently on purpose: pairing is structural — rows that offset exactly — and
    # a demo whose legs shared a name would let a name-based shortcut look like it worked.
    for m in range(13):
        bank(monthly(5, m), "Transfer to Savings", "Bank Transfer", 500.00, "checking")
        bank(monthly(5, m), "Transfer from Checking", "Bank Transfer", -500.00, "savings")
    # One row only: categorize.spec.js finds it by name as the single categorized row it edits.
    bank(d(31), "Interest Payment", "Interest Income", -12.18, "savings")

    # Paying off the card: the other movement every household with a credit card makes, and the one a
    # ledger most often counts twice — once as the purchases on the card, again as the payment leaving
    # checking. Both legs file under Credit Card Payment, which sits in the excluded Transfers group, so
    # the purchases count and the payment does not. The amount follows the statement rather than a fixed
    # figure, and the card side posts a day later, because pairing is by exact amount within a window and
    # a demo with identical amounts on identical dates would not show that either is tolerated. The
    # card-side rows are in the card source below; a rule files them.
    card_payments = [812.48, 945.10, 833.92, 898.15, 1010.37, 887.60, 924.33,
                     861.75, 1102.40, 979.05, 846.62, 1218.90, 905.14]
    autopay_days = [monthly(15, m) for m in range(len(card_payments))]
    for when, amount in zip(autopay_days, card_payments):
        bank(when, "Rewards Card Autopay", "Credit Card Payment", amount, "checking")

    # What the household invests each month: without it the income left over after spending piled up in
    # checking, which then climbed all year on the Balances dashboard. The brokerage side is in the card
    # source below and posts a day later; a rule files it as the transfer it is. Neither side's name says
    # "transfer": the rule-suggestion specs that filter on the word are finding the savings transfer above.
    contribution_days = [monthly(2, m) for m in range(13)]
    for when in contribution_days:
        bank(when, "Brokerage Deposit", "Bank Transfer", BROKERAGE_CONTRIBUTION, "checking")

    # A sofa paid for in two instalments: a deposit when ordered, the balance on delivery. Each payment is
    # real money on its own date and is already counted correctly, so what the multi-payment purchase
    # built afterwards adds is only the relationship — and the expected total that shows nothing is still
    # owed. "Furniture" is not a starter leaf; it is grouped after the import, as a user part-way through
    # the imported-categories workspace would have done.
    bank(d(70), "Oakline Furniture", "Furniture", 450.00, "checking")
    bank(d(16), "Oakline Furniture", "Furniture", 1149.00, "checking")

    # ===== Source 3: "PocketPay" — a payment app's export (no categories), and the rows it leaves on
    # checking. The wallet holds the real transaction; checking sees only money crossing to or from it,
    # under the app's name, and the bank files none of those rows. Counted on both accounts, each payment
    # would count twice, so the pairing that runs after the import (services/wallet_pairs.py) pairs each
    # checking row with its wallet row. Two kinds are shown: a payment the app charged straight to checking
    # (only the checking row stops counting) and a cash-out (both rows are money movement). A payment from
    # the balance has no checking row at all, and the money received into the balance is income once. =====
    wallet_rows = []  # (date, note, amount, account_name)

    def wallet(when, note, amount):
        wallet_rows.append((when, note, f"{-amount:.2f}", name_of["wallet"]))

    def next_day(when):
        return (date.fromisoformat(when) + timedelta(days=1)).isoformat()

    for m in range(13):
        when = monthly(12, m)
        wallet(when, "Hillside Veg Box", 85.00)                              # rule → Groceries
        bank(next_day(when), "POCKETPAY *HILLSIDE VEG", "", 85.00, "checking")
    wallet(d(44), "Casey Morgan — used bike", -150.00)                       # rule → Other Income
    wallet(d(40), "Riley Park — dog walking", 40.00)                         # from the balance; rule → Pet Care
    wallet(d(38), "Cash out to bank", 110.00)                                # the rest of the balance, cashed out
    bank(d(36), "POCKETPAY TRANSFER", "", -110.00, "checking")

    # The irregular spending of a year: a summer trip, the dentist twice, prescriptions, and the holidays
    # (placed by calendar month, like the bills above, so December lands in December).
    bank(d(250), "SkyWest Air", "Air Travel", 586.40, "checking")
    bank(d(236), "Coastline Car Rental", "Rental Car", 214.75, "checking")
    bank(d(160), "Bright Smile Dental", "Dental", 95.00, "checking")
    bank(d(340), "Bright Smile Dental", "Dental", 95.00, "checking")
    for days_ago, amount in [(38, 24.60), (132, 18.25), (221, 24.60), (309, 31.40)]:
        bank(d(days_ago), "Lakeview Pharmacy", "Pharmacy", amount, "checking")
    for m in range(1, 13):
        when = monthly(13, m)
        if when[5:7] in ("11", "12"):
            bank(when, "Maple & Co. Gifts", "Gifts Given", 145.00 + m * 6, "checking")

    # The hardware store the bank's export filed two ways: some visits were a project, some a repair, and
    # nothing on the row says which. The amounts overlap and every row is on one account, so no rule can
    # tell them apart, and the Generate Rules review shows them as a conflict set to resolve.
    for days_ago, amount in [(64, 89.40), (151, 212.75), (158, 46.10), (318, 134.60)]:
        bank(d(days_ago), "Hearthside Hardware", "Home Improvement", amount, "checking")
    for days_ago, amount in [(29, 58.25), (233, 141.30)]:
        bank(d(days_ago), "Hearthside Hardware", "Home Repairs", amount, "checking")

    # A class pass given up a little over a year ago. Its rule suggestion is still pending, and it is the
    # one a one-year look-back moves into the review's Older view.
    for days_ago, amount in [(396, 85.00), (431, 85.00), (473, 120.00), (509, 85.00)]:
        bank(d(days_ago), "Harbor Yoga Studio", "Fitness Classes", amount, "checking")

    # The money coming back. Each is claimed by one of the reimbursements built after the import; until
    # then they are ordinary inflows, which is exactly what they look like to someone who has not
    # recorded the debt.
    bank(d(27), "Expense reimbursement — Northwind Ltd", "Reimbursed Expenses", -388.00, "checking")
    bank(d(26), "Sam Okafor — lunch", "Reimbursed Expenses", -24.00, "checking")
    bank(d(26), "Priya Raman — lunch", "Reimbursed Expenses", -24.00, "checking")
    bank(d(26), "Dana Whitfield — lunch", "Reimbursed Expenses", -24.00, "checking")
    bank(d(22), "Sam Okafor — concert ticket", "Reimbursed Expenses", -35.00, "checking")
    # Receivables still being worked on; demo_examples files and tracks them.
    bank(d(52), "Brightwater Physical Therapy", "Medical Services", 180.00, "checking")
    bank(d(19), "Summit Health Plan claim", "Reimbursed Expenses", -144.00, "checking")
    bank(d(95), "Pinecrest Cabins", "Hotel", 480.00, "checking")
    bank(d(9), "Print & Copy Depot", "Home Office", 42.80, "checking")
    bank(d(3), "Acme Corp Expense Reimb", "Reimbursed Expenses", -42.80, "checking")
    # "Pet Care" isn't a starter leaf, so importing it here creates the leaf (under Unassigned).
    bank(d(20), "Petco", "Pet Care", 46.20, "checking")
    bank(d(48), "Chewy", "Pet Care", 61.85, "checking")
    # A handful of categories that AREN'T in the starter set, so they land in Unassigned and give the
    # "Group imported categories" workspace something to demonstrate. (Labels matching a starter leaf
    # reuse it, and income labels auto-file under the Income group, so only novel expense labels surface.)
    bank(d(12), "WeWork Desk", "Home Office", 180.00, "checking")
    bank(d(22), "Bright Kids Daycare", "Childcare", 850.00, "checking")
    bank(d(40), "City Vet Clinic", "Veterinary", 120.00, "checking")
    bank(d(52), "Red Cross Donation", "Charitable Giving", 75.00, "checking")
    bank(d(26), "Annual Membership", "Fees & Charges", 96.00, "checking")   # cross-account duplicate, leg A

    # ===== Source 2: "Rewards Card" — a raw export WITHOUT categories (card + brokerage, plus one savings
    # row). Format B uses different header names (so it's a distinct data source); rows here are categorized
    # only by the rules created below, or land uncategorized — demonstrating the other import path. =====
    card_rows = []  # (transaction date, payee, amount, account_name)

    def card(when, payee, amount, acct="card"):
        card_rows.append((when, payee, f"{-amount:.2f}", name_of[acct]))

    # Six months rather than three so the price step below is judged against an established price. The
    # newest charge is the one that moved: price change is measured against the occurrences *preceding*
    # the latest, which is the only comparison a stored min/max band cannot make for itself.
    #
    # The size of the step is not free either. A series whose charges never vary is held to a percentage
    # floor before a move counts as a step, so a rise has to clear that floor to be reported at all — an
    # earlier 15.99 → 17.99 was 12.5%, under it, and this dataset's streaming hike therefore raised
    # nothing for as long as the comment here claimed it did. The threshold lives in
    # `recurring_signals._FIXED_STEP_FRACTION`; keep this rise comfortably the far side of it.
    for m in range(13):
        card(monthly(8, m), "Netflix", 15.99 if m else 18.99)   # rule → Streaming Services
        card(monthly(9, m), "FitClub", 40.00)                   # recurring rule → Gym Membership
        card(monthly(17, m), "Spotify", 11.99)                  # rule → Streaming Services
    # The everyday spending never repeats one price either; the small deterministic wobble (`(i * k) % n`)
    # keeps every month's total near the last without any row repeating exactly.
    grocers = ["Costco", "Trader Joe's", "Whole Foods", "Safeway"]
    grocery_amts = [168.40, 58.10, 104.75, 76.30]
    for i, days_ago in enumerate(scattered(7, 2)):
        card(d(days_ago), grocers[i % 4], grocery_amts[i % 4] + (i * 7) % 23)   # rules → Groceries
    # Blue Bottle is the one merchant no rule claims, so a few rows stay uncategorized to work on.
    coffee_amts = [4.75, 5.40, 6.25, 4.10, 5.95]
    for i, days_ago in enumerate(scattered(12, 1)):
        card(d(days_ago), "Starbucks" if i % 2 else "Blue Bottle", coffee_amts[i % 5])  # Starbucks → rule
    diners = ["The Corner Bistro", "Sushi House", "Taco Stand", "Pasta Bar"]
    for i, days_ago in enumerate(scattered(11, 3)):
        card(d(days_ago), diners[i % 4], 26.50 + (i * 5) % 19)     # rules → Dining Out
    for i, days_ago in enumerate(scattered(13, 4)):
        card(d(days_ago), "Shell" if i % 2 else "Chevron", 38.00 + (i * 3) % 17)   # rules → Gas
    for days_ago, amount in [(19, 31.50), (87, 28.00), (163, 34.50), (241, 28.00), (318, 31.50)]:
        card(d(days_ago), "Cinemark Theatres", amount)               # rule → Movies & Events
    for days_ago, amount in [(11, 18.40), (57, 23.75), (128, 16.90), (199, 27.30), (274, 21.15)]:
        card(d(days_ago), "Uber Trip", amount)                       # rule → Rideshare
    online_amts = [23.99, 119.40, 14.25, 56.80, 31.10, 78.65, 19.99, 44.50]
    amazon_charges = []   # (days_ago, amount), for the order history imported against them below
    for days_ago, amount in zip(scattered(8, 5, count=len(online_amts)), online_amts):
        card(d(days_ago), "Amazon", amount)                      # Amazon → rule
        amazon_charges.append((days_ago, amount))
    card(d(15), "Amazon Refund", -45.00)                            # refund (income); "amazon" → rule

    # Rows the worked examples further down build on. They import as ordinary transactions; what makes
    # them examples is what is done to them afterwards.
    card(d(33), "Warehouse Club", 214.60)          # split across two categories
    card(d(41), "Northgate Hotel", 388.00)         # work expense, repaid in full a fortnight later
    card(d(41), "Sky Harbor Parking", 64.00)       # part of the same trip, attached receipt
    card(d(26), "Lakeside Taverna", 96.00)         # lunch for four, repaid the same day
    card(d(30), "Riverstone Amphitheater", 105.00) # three tickets, two of them owed back
    for q, amount in enumerate([52.40, 49.85, 47.10, 45.60]):
        card(monthly(45, q * 3), "Quarterly Dividend", -amount, "brokerage")   # uncategorized income
    for when in contribution_days:
        card(next_day(when), "Contribution", -BROKERAGE_CONTRIBUTION, "brokerage")   # rule → Bank Transfer
    # Leg B lands on savings, not the card: a duplicate is one account recorded twice, and a checking row
    # and a card row can never be that (duplicate_detection.account_types_can_match).
    card(d(26), "Annual Membership", 96.00, "savings")              # cross-account duplicate, leg B
    for when, amount in zip(autopay_days, card_payments):
        posted = (date.fromisoformat(when) + timedelta(days=1)).isoformat()
        card(posted, "Payment Received - Thank You", -amount)   # the card side of each autopay

    # The bank's export states each account's balance after every row, as most bank exports do, and the
    # import records each day's closing figure as a stated balance. The column reads as a running balance
    # only when the rows run in date order, so the file is sorted first; rows within a day keep the order
    # they were written in. The savings leg of the duplicate above is in the card file, outside these
    # figures, so the savings balance checks report it as the extra row it is.
    bank_rows.sort(key=lambda row: row[0])
    running = {name_of["checking"]: BANK_OPENING_BALANCES["checking"],
               name_of["savings"]: BANK_OPENING_BALANCES["savings"]}
    for i, (when, desc, category, amount, acct_name) in enumerate(bank_rows):
        running[acct_name] = round(running[acct_name] + float(amount), 2)
        bank_rows[i] = (when, desc, category, amount, acct_name, f"{running[acct_name]:.2f}")

    bank_cols = {"date": "Date", "description": "Description", "category": "Category", "amount": "Amount",
                 "account": "Account", "balance": "Balance"}
    card_cols = {"date": "Transaction Date", "description": "Payee", "amount": "Amount", "account": "Account"}
    bank_profile_id = _insert_demo_profile(conn, "Everyday Bank", bank_cols, use_imported_categories=1)
    card_profile_id = _insert_demo_profile(conn, "Rewards Card", card_cols, use_imported_categories=0)

    def _import(text, *, profile_id, column_map, account_keys, use_imported_categories, filename):
        run_import_core(
            text,
            {
                "profile_id": profile_id,
                "filename": filename,
                "account_map": {name_of[k]: accounts[k][0] for k in account_keys},
                "column_map": column_map,
                "date_format": "%Y-%m-%d",
                "amount_convention": "single_signed",
                "apply_categorization": True,
                "use_imported_categories": use_imported_categories,
            },
            filename=filename,
            conn=conn,
        )

    # Import the curated source first (categories trusted) — this also creates the Pet Care leaf.
    _import(
        _render_csv(["Date", "Description", "Category", "Amount", "Account", "Balance"], bank_rows),
        profile_id=bank_profile_id, column_map=bank_cols, account_keys=("checking", "savings"),
        use_imported_categories=True, filename="everyday-bank.csv",
    )

    # Seed a few rules now (Pet Care exists). They categorize the raw card statement imported next,
    # demonstrating rules working on an uncategorized import; rows with no matching rule stay uncategorized.
    _groups, leaves = _category_lookup(conn)
    for keyword, leaf_name in [
        ("starbucks", "Coffee & Drinks"),
        ("netflix", "Streaming Services"),
        ("spotify", "Streaming Services"),
        ("costco", "Groceries"),
        ("trader joe", "Groceries"),
        ("whole foods", "Groceries"),
        ("safeway", "Groceries"),
        ("bistro", "Dining Out"),
        ("sushi house", "Dining Out"),
        ("taco stand", "Dining Out"),
        ("pasta bar", "Dining Out"),
        ("shell", "Gas"),
        ("chevron", "Gas"),
        ("cinemark", "Movies & Events"),
        ("uber", "Rideshare"),
        ("amazon", "Online Shopping"),
        ("petco", "Pet Care"),
        ("chewy", "Pet Care"),
        ("veg box", "Groceries"),
        ("dog walking", "Pet Care"),
        ("used bike", "Other Income"),
        # The card side of the autopay; the bank side arrives already categorized.
        ("payment received", "Credit Card Payment"),
        # The brokerage side of the monthly contribution, likewise.
        ("contribution", "Bank Transfer"),
        # Item names from the Amazon order history. "Amazon" says nothing about what was bought; the
        # order does, so rules can file a marketplace order by its contents. The rest stay for the user.
        ("dog bed", "Pet Care"),
        ("vacuum", "Household Supplies"),
        ("running shoes", "Clothing"),
        ("charging cable", "Electronics"),
    ]:
        if leaf_name in leaves and not conn.execute(
            "SELECT 1 FROM category_rule WHERE LOWER(keyword) = ?", (keyword,)
        ).fetchone():
            conn.execute(
                "INSERT INTO category_rule (id, category_id, keyword) VALUES (?, ?, ?)",
                (str(uuid.uuid4()), leaves[leaf_name], keyword),
            )
    # A rule that also owns a recurring series: the gym membership is recurring because the rule says so,
    # not because detection guessed it, so the Recurring page shows it as rule-backed. Its series is
    # created once the card import has brought the charges it claims.
    gym_rule_id = str(uuid.uuid4())
    conn.execute(
        """INSERT INTO category_rule (id, category_id, keyword, clean_name, is_recurring)
           VALUES (?, ?, 'fitclub', 'FitClub', 1)""",
        (gym_rule_id, leaves["Gym Membership"]),
    )

    # A rule with no merchant text, watching an account that should stay quiet: money comes into savings
    # and nothing is ever paid from it, so any debit there raises a Task. With no text it matches every
    # row in its scope, which is why it is scoped to the one account. Alerts record arrivals rather than
    # matches, so it is in place before the card file brings the savings charge it catches.
    conn.execute(
        """INSERT INTO category_rule (id, category_id, keyword, debit_credit, account_id, alert, alert_message)
           VALUES (?, NULL, '', 'debit', ?, 1, 'Money paid out of savings')""",
        (str(uuid.uuid4()), accounts["savings"][0]),
    )

    # Import the raw source (no categories). The core's post-import sweep flags the cross-account
    # "Annual Membership" duplicate against the checking row from the first import.
    _import(
        _render_csv(["Transaction Date", "Payee", "Amount", "Account"], card_rows),
        profile_id=card_profile_id, column_map=card_cols, account_keys=("card", "brokerage", "savings"),
        use_imported_categories=False, filename="rewards-card.csv",
    )

    from backend.routers.rules import ensure_rule_series
    ensure_rule_series(conn, gym_rule_id, "monthly")

    # The card's export has no balance column, so its balance is the last statement's, entered by hand;
    # the ledger carries it to today and works it back from there. The brokerage's moves with the market
    # rather than its rows, so a single current figure is all it can honestly be given: a monthly series
    # would differ from the dividends between each pair, and the balance checks would report every span.
    # The wallet and the marketplace are left without one, as money only passes through them.
    record_manual_balance(conn, accounts["card"][0], monthly(20, 0), CARD_STATEMENT_BALANCE)
    record_manual_balance(conn, accounts["brokerage"][0], d(2), BROKERAGE_BALANCE)

    # The wallet last, so the checking rows it pairs with are already in; the pairing runs after the
    # import as it would for a user's file.
    wallet_cols = {"date": "Date", "description": "Note", "amount": "Amount", "account": "Account"}
    wallet_profile_id = _insert_demo_profile(conn, "PocketPay", wallet_cols, use_imported_categories=0)
    _import(
        _render_csv(["Date", "Note", "Amount", "Account"], wallet_rows),
        profile_id=wallet_profile_id, column_map=wallet_cols, account_keys=("wallet",),
        use_imported_categories=False, filename="pocketpay.csv",
    )

    _import_amazon_orders(conn, accounts["amazon"][0], accounts["card"][0], amazon_charges, d)

    # --- Category- and account-level tags (transactions inherit them through their category, group or
    # account) ---
    groups, leaves = _category_lookup(conn)

    def add_tag(name, color, sort_order, leaf_names=(), group_names=(), account_keys=()):
        tid = str(uuid.uuid4())
        conn.execute("INSERT INTO tag (id, name, color, sort_order) VALUES (?, ?, ?, ?)", (tid, name, color, sort_order))
        for n in leaf_names:
            if n in leaves:
                conn.execute("INSERT INTO category_tag (category_id, tag_id) VALUES (?, ?)", (leaves[n], tid))
        for n in group_names:
            if n in groups:
                conn.execute("INSERT INTO category_tag (category_id, tag_id) VALUES (?, ?)", (groups[n], tid))
        for key in account_keys:
            conn.execute("INSERT INTO account_tag (account_id, tag_id) VALUES (?, ?)", (accounts[key][0], tid))
        return tid

    tag_ids = {}
    tag_ids[ESSENTIAL_TAG] = add_tag(ESSENTIAL_TAG, "#16a34a", 0, leaf_names=("Groceries", "Rent & Mortgage", "Gas"), group_names=("Utilities",))
    tag_ids[DISCRETIONARY_TAG] = add_tag(DISCRETIONARY_TAG, "#f59e0b", 1, leaf_names=("Dining Out", "Coffee & Drinks"), group_names=("Entertainment", "Shopping"))
    # Everything on the brokerage matters at tax time whatever it is filed under, which is a fact about
    # the account rather than any category, so the tag goes on the account.
    tag_ids[TAX_TAG] = add_tag(TAX_TAG, "#7c3aed", 2, account_keys=("brokerage",))

    # --- The features that are done *to* a transaction rather than imported with it ---
    _groups, leaves = _category_lookup(conn)
    examples = seed_all(conn, leaves, tag_ids)

    # A year of use leaves its traces: the largest imported label has been grouped (the smaller ones
    # still wait in the workspace), and everything but the last week has been looked over. The newest
    # rows keep their review markers so the Needs-review filter and Tasks have something to show.
    from backend.routers.categories import CategoryUpdate, _apply_category_update
    _apply_category_update(conn, leaves["Furniture"], CategoryUpdate(parent_id=groups["Household"]))
    conn.execute("UPDATE txn SET needs_review = 0 WHERE date < ?", (d(7),))

    # Detect the series, then accept the two the dataset was shaped around. Both are load-bearing: the
    # anomalies this demo advertises — a subscription that stopped, a bill whose price stepped —
    # are raised only for a series the user has taken on, since about an unaccepted suggestion the app
    # has no standing to say a charge is missing (see `recurring_signals._is_user_owned`). Leaving every
    # series unconfirmed would show the page with an empty Needs-attention view, which is the opposite of
    # what the demo is for. Only these two are accepted, so the Suggested pile still has something in it.
    from backend.services.recurring_detection import scan_and_store  # local: avoids an import cycle

    scan_and_store(conn)
    conn.execute(
        "UPDATE recurring_series SET confirmed = 1 WHERE source = 'auto' AND payee_key IN (?, ?, ?)",
        # The subscription that stopped, plus the two shapes of price move worth showing side by side:
        # a fixed subscription that stepped up, and a seasonal bill that peaked. They exercise the two
        # branches of the price-change test — a tight series judged on a percentage, a variable one
        # judged against the range it has been in before.
        ("cloudvault backup", "netflix", "northgate gas"),
    )

    # Mark demo-loaded LAST — after the imports, so the import-block guard never trips during the build.
    conn.execute(
        """INSERT INTO import_workflow_state (key, payload_json) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET payload_json = excluded.payload_json""",
        (DEMO_DATA_STATE_KEY, json.dumps({"loaded": True, "loaded_at": today.isoformat()})),
    )

    if scope_id:
        _seed_demo_preferences(conn, scope_id)

    txn_count = conn.execute("SELECT COUNT(*) FROM txn").fetchone()[0]
    suspects_flagged = conn.execute(
        "SELECT COUNT(*) FROM txn WHERE suspect_duplicate_of IS NOT NULL"
    ).fetchone()[0]
    return {
        "skipped": False,
        "owners": len(owners),
        "accounts": len(accounts),
        "batches": conn.execute("SELECT COUNT(*) FROM import_batch").fetchone()[0],
        "transactions": txn_count,
        "suspects_flagged": suspects_flagged,
        "tags": [ESSENTIAL_TAG, DISCRETIONARY_TAG, TAX_TAG],
        **examples,
    }
