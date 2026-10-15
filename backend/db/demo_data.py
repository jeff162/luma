# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Fictional-but-realistic demo dataset, loaded into an empty tenant DB.

Two consumers share this builder: a prospective user exploring the app before committing their own
data, and the Playwright E2E suite, which needs a populated, past-onboarding baseline. The data is
entirely invented (generic well-known vendors only, fictional owners/accounts — no PII), and shaped to
exercise the features worth showing: multiple owners and account types, per-account import batches
(provenance), custom categories and rules, category-level tags that *inherit* onto transactions, a year
of recurring + one-off activity, a standing two-legged inter-account transfer, card payments, a
refund, an Amazon order history reconciled against the card, and a cross-account duplicate that the real
post-import sweep flags for review.

Amount sign follows the stored convention (categorizer `_amount_side_matches`): debits/spending are
**positive**, credits/income are **negative**. `content_hash` mirrors the importer's `make_hash` so a
later re-import of equivalent rows dedupes naturally.

`load_demo_data` is a no-op on any non-empty tenant (guards on existing accounts/transactions), so it
can never overwrite or pollute real data.
"""

import csv
import hashlib
import io
import json
import uuid
from datetime import date, timedelta


ESSENTIAL_TAG = "Essential Expenses"
DISCRETIONARY_TAG = "Discretionary"

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
    parsed, items_by_order, names, _unrecognized, _already, file_hashes = read_amazon_exports(
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

    # An organized starter tree to map imported labels into: a file category that matches a starter leaf
    # reuses it; one that doesn't (e.g. "Pet Care") is created under Unassigned by the import itself.
    _seed_default_categories(conn, include_leaves=True)

    today = date.today()

    def d(days_ago: int) -> str:
        return (today - timedelta(days=days_ago)).isoformat()

    # --- Owners + accounts up front (typed + owned). The CSVs reference accounts by name, so the import
    # maps onto these rather than creating untyped, unowned accounts. ---
    owners = {
        "Alex": (str(uuid.uuid4()), "Alex Rivera", "#2563eb"),
        "Jordan": (str(uuid.uuid4()), "Jordan Lee", "#db2777"),
    }
    for oid, name, color in owners.values():
        conn.execute(
            "INSERT INTO owner (id, name, color, flag_new_for_review) VALUES (?, ?, ?, 1)", (oid, name, color)
        )

    accounts = {
        "checking": (str(uuid.uuid4()), "Everyday Checking", "depository", owners["Alex"][0]),
        "savings": (str(uuid.uuid4()), "Rainy Day Savings", "savings", SHARED_OWNER_ID),
        "card": (str(uuid.uuid4()), "Rewards Card", "credit", owners["Jordan"][0]),
        "brokerage": (str(uuid.uuid4()), "Brokerage", "investment", owners["Jordan"][0]),
        "amazon": (str(uuid.uuid4()), "Amazon", "amazon", owners["Jordan"][0]),
    }
    for aid, name, acct_type, owner_id in accounts.values():
        conn.execute(
            """INSERT INTO account (id, external_account_id, connection_id, provider, name, display_name, type, owner_id)
               VALUES (?, NULL, NULL, 'manual', ?, ?, ?, ?)""",
            (aid, name, name, acct_type, owner_id),
        )
    name_of = {key: accounts[key][1] for key in accounts}

    # ===== Source 1: "Everyday Bank" — a curated export WITH a Category column (checking + savings).
    # Format A headers: Date, Description, Category, Amount, Account. Spending positive, income negative. =====
    bank_rows = []  # (date, description, category, amount, account_name)

    # `amount` is the intended STORED value (spending +, income −). The CSV carries the natural bank
    # convention (income +, spending −); single_signed import negates it back (parse_amount → -val).
    def bank(days_ago, desc, category, amount, acct):
        bank_rows.append((d(days_ago), desc, category, f"{-amount:.2f}", name_of[acct]))

    # The steady activity runs thirteen months, so "Last 12 months" — the dashboard's default period — is
    # full from end to end and every trend chart has a year of shape rather than a few recent bars. The
    # figures are sized to one household: income clears spending by a believable margin, not by double.
    def seasonal(by_month, m):
        # `m` counts back from this month, so the seasonal position follows the real calendar.
        return by_month[(today.month - 1 - m) % 12]

    for i in range(28):
        bank(7 + i * 14, "Acme Corp Payroll", "Salary", -2400.00, "checking")
    # Occasional freelance work: irregular in both timing and size, the income that is not a paycheck.
    for days_ago, amount in [(24, 1150.00), (118, 860.00), (205, 1400.00), (290, 725.00), (370, 980.00)]:
        bank(days_ago, "Brightline Design — invoice", "Freelance", -amount, "checking")
    # Electricity peaks in summer (air conditioning), the opposite of the gas bill below.
    power_by_month = [88.40, 81.15, 76.30, 72.85, 84.10, 118.60,
                      146.25, 152.90, 121.40, 86.75, 78.20, 90.65]
    for m in range(13):
        base = m * 30
        bank(base + 1, "Parkside Apartments", "Rent & Mortgage", 2200.00, "checking")
        bank(base + 3, "City Power & Light", "Electricity", seasonal(power_by_month, m), "checking")
        bank(base + 4, "Fiberlink", "Internet", 69.99, "checking")
        bank(base + 5, "CellOne Mobile", "Phone", 55.00, "checking")
        bank(base + 10, "Keystone Auto Insurance", "Auto Insurance", 132.00, "checking")
    # Month 0's water bill is the one that outgrew its rule, further down.
    for m in range(1, 13):
        bank(m * 30 + 6, "Metro Water", "Water", 34.10 + (m * 7) % 12, "checking")
    # A gas bill with a real winter peak, carried back far enough to be seasonal rather than noisy. Two
    # features need this shape and nothing else in the set provides it: the price-change signal's
    # tightness test (which reads the whole prior history, so four flat summer bills must not make the
    # series look fixed-price) and the range learning behind dismissing one of its warnings. It also
    # gives year-over-year comparison a second year to compare against.
    gas_by_month = [148.20, 132.75, 88.40, 61.30, 44.85, 39.10,
                    41.60, 43.25, 58.90, 79.40, 104.60, 139.80]
    for m in range(14):
        bank(m * 30 + 8, "Northgate Gas", "Natural Gas", seasonal(gas_by_month, m), "checking")

    # A subscription that stops two periods before the data ends. Two constraints decide those numbers
    # and they pull against each other: the missed signal is judged against how fresh the *data* is
    # rather than against today, so the series has to stop before the newest rows — but detection scores
    # recency to zero at three periods without a charge, and an undetected series cannot be missed. A
    # long run ending about two and a half months back sits in the gap, and reads as what it is: a
    # subscription that was cancelled, or a payment method that quietly expired.
    for m in range(2, 9):
        bank(m * 30 + 12, "CloudVault Backup", "Software & Subscriptions", 9.99, "checking")

    # The other bill from the same biller, and the reason its rule carries a floor rather than the water
    # rule simply matching everything: told apart by size, nothing else about them differs.
    bank(75, "Metro Water", "Home Repairs", 185.00, "checking")

    # The newest water bill, arriving just past the ceiling on the rule that files these. It carries no
    # category *because* of that: the range on a rule is a matching gate, so a bill that grows past it
    # stops matching and quietly stops being categorized. Nothing else in the app notices, which is the
    # whole reason the drift signal exists — and why this row must not be filed under Water here, since
    # a row already carrying the rule's own category is by definition fine.
    bank(4, "Metro Water", "", 63.40, "checking")

    # A standing transfer, recorded twice — leaving checking and arriving in savings — which is what
    # every movement between two tracked accounts looks like to a ledger organized by account. Detection
    # makes two series of it and the Recurring page folds them back into the one movement they describe
    # (services/recurring_pairs.py), so this runs over enough months for that pairing to be visible. The
    # two sides are worded differently on purpose: pairing is structural — rows that offset exactly — and
    # a demo whose legs shared a name would let a name-based shortcut look like it worked.
    for m in range(13):
        bank(m * 30 + 5, "Transfer to Savings", "Bank Transfer", 500.00, "checking")
        bank(m * 30 + 5, "Transfer from Checking", "Bank Transfer", -500.00, "savings")
    # One row only: categorize.spec.js finds it by name as the single categorized row it edits.
    bank(31, "Interest Payment", "Interest Income", -12.18, "savings")

    # Paying off the card: the other movement every household with a credit card makes, and the one a
    # ledger most often counts twice — once as the purchases on the card, again as the payment leaving
    # checking. Both legs file under Credit Card Payment, which sits in the excluded Transfers group, so
    # the purchases count and the payment does not. The amount follows the statement rather than a fixed
    # figure, and the card side posts a day later, because pairing is by exact amount within a window and
    # a demo with identical amounts on identical dates would not show that either is tolerated. The
    # card-side rows are in the card source below; a rule files them.
    card_payments = [812.48, 945.10, 833.92, 898.15, 1010.37, 887.60, 924.33,
                     861.75, 1102.40, 979.05, 846.62, 1218.90, 905.14]
    for m, amount in enumerate(card_payments):
        bank(m * 30 + 15, "Rewards Card Autopay", "Credit Card Payment", amount, "checking")

    # A sofa paid for in two instalments: a deposit when ordered, the balance on delivery. Each payment is
    # real money on its own date and is already counted correctly, so what the multi-payment purchase
    # built afterwards adds is only the relationship — and the expected total that shows nothing is still
    # owed. "Furniture" is not a starter leaf; it is grouped after the import, as a user part-way through
    # the imported-categories workspace would have done.
    bank(70, "Oakline Furniture", "Furniture", 450.00, "checking")
    bank(16, "Oakline Furniture", "Furniture", 1149.00, "checking")

    # The irregular spending of a year: a summer trip, the dentist twice, prescriptions, and the holidays
    # (placed by calendar month, like the bills above, so December lands in December).
    bank(250, "SkyWest Air", "Air Travel", 586.40, "checking")
    bank(236, "Coastline Car Rental", "Rental Car", 214.75, "checking")
    bank(160, "Bright Smile Dental", "Dental", 95.00, "checking")
    bank(340, "Bright Smile Dental", "Dental", 95.00, "checking")
    for days_ago, amount in [(38, 24.60), (132, 18.25), (221, 24.60), (309, 31.40)]:
        bank(days_ago, "Lakeview Pharmacy", "Pharmacy", amount, "checking")
    for m in range(1, 13):
        if (today.month - 1 - m) % 12 in (10, 11):   # November, December
            bank(m * 30 + 13, "Maple & Co. Gifts", "Gifts Given", 145.00 + m * 6, "checking")

    # The money coming back. Each is claimed by one of the reimbursements built after the import; until
    # then they are ordinary inflows, which is exactly what they look like to someone who has not
    # recorded the debt.
    bank(27, "Expense reimbursement — Northwind Ltd", "Reimbursed Expenses", -388.00, "checking")
    bank(26, "Sam Okafor — lunch", "Reimbursed Expenses", -24.00, "checking")
    bank(26, "Priya Raman — lunch", "Reimbursed Expenses", -24.00, "checking")
    bank(26, "Dana Whitfield — lunch", "Reimbursed Expenses", -24.00, "checking")
    bank(22, "Sam Okafor — concert ticket", "Reimbursed Expenses", -35.00, "checking")
    # Receivables still being worked on; demo_examples files and tracks them.
    bank(52, "Brightwater Physical Therapy", "Medical Services", 180.00, "checking")
    bank(19, "Summit Health Plan claim", "Reimbursed Expenses", -144.00, "checking")
    bank(95, "Pinecrest Cabins", "Hotel", 480.00, "checking")
    bank(9, "Print & Copy Depot", "Home Office", 42.80, "checking")
    bank(3, "Acme Corp Expense Reimb", "Reimbursed Expenses", -42.80, "checking")
    # "Pet Care" isn't a starter leaf, so importing it here creates the leaf (under Unassigned).
    bank(20, "Petco", "Pet Care", 46.20, "checking")
    bank(48, "Chewy", "Pet Care", 61.85, "checking")
    # A handful of categories that AREN'T in the starter set, so they land in Unassigned and give the
    # "Group imported categories" workspace something to demonstrate. (Labels matching a starter leaf
    # reuse it, and income labels auto-file under the Income group, so only novel expense labels surface.)
    bank(12, "WeWork Desk", "Home Office", 180.00, "checking")
    bank(22, "Bright Kids Daycare", "Childcare", 850.00, "checking")
    bank(40, "City Vet Clinic", "Veterinary", 120.00, "checking")
    bank(52, "Red Cross Donation", "Charitable Giving", 75.00, "checking")
    bank(26, "Annual Membership", "Fees & Charges", 96.00, "checking")   # cross-account duplicate, leg A

    # ===== Source 2: "Rewards Card" — a raw export WITHOUT categories (card + brokerage). Format B uses
    # different header names (so it's a distinct data source); rows here are categorized only by the rules
    # created below, or land uncategorized — demonstrating the other import path. =====
    card_rows = []  # (transaction date, payee, amount, account_name)

    def card(days_ago, payee, amount, acct="card"):
        card_rows.append((d(days_ago), payee, f"{-amount:.2f}", name_of[acct]))

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
        base = m * 30
        card(base + 8, "Netflix", 15.99 if m else 18.99)   # rule → Streaming Services
        card(base + 9, "FitClub", 40.00)                   # recurring rule → Gym Membership
        card(base + 17, "Spotify", 11.99)                  # rule → Streaming Services
    # The everyday spending repeats on a cadence but never at one price; the small deterministic wobble
    # (`(i * k) % n`) keeps every month's total close to the last without any row repeating exactly.
    grocers = ["Costco", "Trader Joe's", "Whole Foods", "Safeway"]
    grocery_amts = [168.40, 58.10, 104.75, 76.30]
    for i in range(56):
        card(2 + i * 7, grocers[i % 4], grocery_amts[i % 4] + (i * 7) % 23)   # rules → Groceries
    # Blue Bottle is the one merchant no rule claims, so a few rows stay uncategorized to work on.
    coffee_amts = [4.75, 5.40, 6.25, 4.10, 5.95]
    for i in range(32):
        card(1 + i * 12, "Starbucks" if i % 2 else "Blue Bottle", coffee_amts[i % 5])  # Starbucks → rule
    diners = ["The Corner Bistro", "Sushi House", "Taco Stand", "Pasta Bar"]
    for i in range(36):
        card(3 + i * 11, diners[i % 4], 26.50 + (i * 5) % 19)     # rules → Dining Out
    for i in range(30):
        card(4 + i * 13, "Shell" if i % 2 else "Chevron", 38.00 + (i * 3) % 17)   # rules → Gas
    for days_ago, amount in [(19, 31.50), (87, 28.00), (163, 34.50), (241, 28.00), (318, 31.50)]:
        card(days_ago, "Cinemark Theatres", amount)               # rule → Movies & Events
    for days_ago, amount in [(11, 18.40), (57, 23.75), (128, 16.90), (199, 27.30), (274, 21.15)]:
        card(days_ago, "Uber Trip", amount)                       # rule → Rideshare
    online_amts = [23.99, 119.40, 14.25, 56.80, 31.10, 78.65, 19.99, 44.50]
    amazon_charges = []   # (days_ago, amount), for the order history imported against them below
    for i in range(8):
        card(5 + i * 8, "Amazon", online_amts[i])                # Amazon → rule
        amazon_charges.append((5 + i * 8, online_amts[i]))
    card(15, "Amazon Refund", -45.00)                            # refund (income); "amazon" → rule

    # Rows the worked examples further down build on. They import as ordinary transactions; what makes
    # them examples is what is done to them afterwards.
    card(33, "Warehouse Club", 214.60)          # split across two categories
    card(41, "Northgate Hotel", 388.00)         # work expense, repaid in full a fortnight later
    card(41, "Sky Harbor Parking", 64.00)       # part of the same trip, attached receipt
    card(26, "Lakeside Taverna", 96.00)         # lunch for four, repaid the same day
    card(30, "Riverstone Amphitheater", 105.00) # three tickets, two of them owed back
    for q, amount in enumerate([52.40, 49.85, 47.10, 45.60]):
        card(45 + q * 91, "Quarterly Dividend", -amount, "brokerage")   # uncategorized income
    card(26, "Annual Membership", 96.00)                         # cross-account duplicate, leg B
    for m, amount in enumerate(card_payments):
        card(m * 30 + 14, "Payment Received - Thank You", -amount)   # the card side of each autopay

    bank_cols = {"date": "Date", "description": "Description", "category": "Category", "amount": "Amount", "account": "Account"}
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
        _render_csv(["Date", "Description", "Category", "Amount", "Account"], bank_rows),
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
        # The card side of the autopay; the bank side arrives already categorized.
        ("payment received", "Credit Card Payment"),
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

    # Import the raw source (no categories). The core's post-import sweep flags the cross-account
    # "Annual Membership" duplicate against the checking row from the first import.
    _import(
        _render_csv(["Transaction Date", "Payee", "Amount", "Account"], card_rows),
        profile_id=card_profile_id, column_map=card_cols, account_keys=("card", "brokerage"),
        use_imported_categories=False, filename="rewards-card.csv",
    )

    from backend.routers.rules import ensure_rule_series
    ensure_rule_series(conn, gym_rule_id, "monthly")

    _import_amazon_orders(conn, accounts["amazon"][0], accounts["card"][0], amazon_charges, d)

    # --- Category-level tags (transactions inherit them through their category/group) ---
    groups, leaves = _category_lookup(conn)

    def add_tag(name, color, sort_order, leaf_names=(), group_names=()):
        tid = str(uuid.uuid4())
        conn.execute("INSERT INTO tag (id, name, color, sort_order) VALUES (?, ?, ?, ?)", (tid, name, color, sort_order))
        for n in leaf_names:
            if n in leaves:
                conn.execute("INSERT INTO category_tag (category_id, tag_id) VALUES (?, ?)", (leaves[n], tid))
        for n in group_names:
            if n in groups:
                conn.execute("INSERT INTO category_tag (category_id, tag_id) VALUES (?, ?)", (groups[n], tid))
        return tid

    tag_ids = {}
    tag_ids[ESSENTIAL_TAG] = add_tag(ESSENTIAL_TAG, "#16a34a", 0, leaf_names=("Groceries", "Rent & Mortgage", "Gas"), group_names=("Utilities",))
    tag_ids[DISCRETIONARY_TAG] = add_tag(DISCRETIONARY_TAG, "#f59e0b", 1, leaf_names=("Dining Out", "Coffee & Drinks"), group_names=("Entertainment", "Shopping"))

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
        "tags": [ESSENTIAL_TAG, DISCRETIONARY_TAG],
        **examples,
    }
