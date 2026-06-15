# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: GPL-3.0-or-later

"""Fictional-but-realistic demo dataset, loaded into an empty tenant DB.

Two consumers share this builder: a prospective user exploring the app before committing their own
data, and the Playwright E2E suite, which needs a populated, past-onboarding baseline. The data is
entirely invented (generic well-known vendors only, fictional owners/accounts — no PII), and shaped to
exercise the features worth showing: multiple owners and account types, per-account import batches
(provenance), custom categories and rules, category-level tags that *inherit* onto transactions, a few
months of recurring + one-off activity, an inter-account transfer, a refund, and a cross-account
duplicate that the real post-import sweep flags for review.

Amount sign follows the stored convention (categorizer `_amount_side_matches`): debits/spending are
**positive**, credits/income are **negative**. `content_hash` mirrors the importer's `make_hash` so a
later re-import of equivalent rows dedupes naturally.

`load_demo_data` is a no-op on any non-empty tenant (guards on existing accounts/transactions), so it
can never overwrite or pollute real data.
"""

import hashlib
import json
import uuid
from datetime import date, timedelta


ESSENTIAL_TAG = "Essential Expenses"
DISCRETIONARY_TAG = "Discretionary"


def _content_hash(date_str: str, amount: float, description: str) -> str:
    # Mirrors routers/import_export/core.make_hash so demo rows dedupe against an equivalent re-import.
    raw = f"{date_str.strip()}|{amount:.2f}|{description.strip().lower()}"
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def _category_lookup(conn):
    """Return (groups, leaves) name→id maps for the seeded category tree (names collide across the two
    levels, so they're kept separate)."""
    groups, leaves = {}, {}
    for row in conn.execute("SELECT id, name, parent_id FROM category"):
        (groups if row["parent_id"] is None else leaves)[row["name"]] = row["id"]
    return groups, leaves


def is_demo_loadable(conn) -> bool:
    """True only when the tenant has no user financial data yet (the seeded category tree doesn't
    count). Guards the loader so it can't touch a real database."""
    accounts = conn.execute("SELECT COUNT(*) FROM account").fetchone()[0]
    txns = conn.execute("SELECT COUNT(*) FROM txn").fetchone()[0]
    return accounts == 0 and txns == 0


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


def load_demo_data(conn, scope_id: str | None = None) -> dict:
    """Populate an empty tenant with the demo dataset. No-op (returns skipped=True) on a non-empty DB.
    When `scope_id` (the local preference-profile id) is given, also seed UI preferences so the demo
    opens expanded. Caller owns the transaction/commit."""
    if not is_demo_loadable(conn):
        return {"skipped": True, "reason": "tenant already has accounts or transactions"}

    groups, leaves = _category_lookup(conn)

    # --- Owners ---
    owners = {
        "Alex": (str(uuid.uuid4()), "Alex Rivera", "#2563eb"),
        "Jordan": (str(uuid.uuid4()), "Jordan Lee", "#db2777"),
    }
    for oid, name, color in owners.values():
        conn.execute("INSERT INTO owner (id, name, color) VALUES (?, ?, ?)", (oid, name, color))

    # --- Accounts (non-Plaid: plaid_account_id NULL, plaid_item_id 'manual') ---
    accounts = {
        "checking": (str(uuid.uuid4()), "Everyday Checking", "depository", owners["Alex"][0]),
        "savings": (str(uuid.uuid4()), "Rainy Day Savings", "savings", owners["Alex"][0]),
        "card": (str(uuid.uuid4()), "Rewards Card", "credit", owners["Jordan"][0]),
        "brokerage": (str(uuid.uuid4()), "Brokerage", "investment", owners["Jordan"][0]),
    }
    for aid, name, acct_type, owner_id in accounts.values():
        conn.execute(
            """INSERT INTO account
                 (id, plaid_account_id, plaid_item_id, name, display_name, type, owner_id)
               VALUES (?, NULL, 'manual', ?, ?, ?, ?)""",
            (aid, name, name, acct_type, owner_id),
        )

    # --- Import batches: the demo arrives the way real data does — one statement import per account —
    # so transactions carry provenance (import history shows it) and the cross-account duplicate sweep,
    # which only compares ACROSS batches, has a genuine cross-batch pair to find. ---
    batch_ids = {}
    for key, (_aid, name, _type, _owner) in accounts.items():
        bid = str(uuid.uuid4())
        conn.execute(
            "INSERT INTO import_batch (id, filename, status) VALUES (?, ?, 'completed')",
            (bid, f"{name}.csv"),
        )
        batch_ids[key] = bid

    # --- A custom category (shows the tree isn't frozen to the seeded set) ---
    pet_care_id = str(uuid.uuid4())
    conn.execute(
        "INSERT INTO category (id, parent_id, name, category_type) VALUES (?, ?, ?, 'expense')",
        (pet_care_id, groups["Household"], "Pet Care"),
    )
    leaves["Pet Care"] = pet_care_id

    # --- Demo rules (skip any keyword already seeded so we don't fork duplicates) ---
    for keyword, leaf_name in [
        ("amazon", "Online Shopping"),
        ("starbucks", "Coffee & Drinks"),
        ("netflix", "Streaming Services"),
        ("costco", "Groceries"),
        ("shell", "Gas"),
        ("petco", "Pet Care"),   # a rule onto the custom category
        ("chewy", "Pet Care"),
    ]:
        exists = conn.execute(
            "SELECT 1 FROM category_rule WHERE LOWER(keyword) = ?", (keyword,)
        ).fetchone()
        if not exists:
            conn.execute(
                "INSERT INTO category_rule (id, category_id, keyword, priority) VALUES (?, ?, ?, 5)",
                (str(uuid.uuid4()), leaves[leaf_name], keyword),
            )

    # --- Tags applied at the category level → transactions inherit them ---
    def add_tag(name, color, sort_order, leaf_names=(), group_names=()):
        tid = str(uuid.uuid4())
        conn.execute(
            "INSERT INTO tag (id, name, color, sort_order) VALUES (?, ?, ?, ?)",
            (tid, name, color, sort_order),
        )
        for n in leaf_names:
            conn.execute("INSERT INTO category_tag (category_id, tag_id) VALUES (?, ?)", (leaves[n], tid))
        for n in group_names:
            conn.execute("INSERT INTO category_tag (category_id, tag_id) VALUES (?, ?)", (groups[n], tid))
        return tid

    # Essential: the Utilities *group* (every utility leaf inherits) plus specific essential leaves.
    add_tag(ESSENTIAL_TAG, "#16a34a", 0,
            leaf_names=("Groceries", "Rent & Mortgage", "Gas", "Auto Insurance"),
            group_names=("Utilities",))
    # Discretionary: the Entertainment + Shopping *groups* plus the indulgent Food leaves.
    add_tag(DISCRETIONARY_TAG, "#f59e0b", 1,
            leaf_names=("Dining Out", "Coffee & Drinks", "Take-out"),
            group_names=("Entertainment", "Shopping"))

    # --- Transactions: ~3 months, anchored on today so the demo always looks current ---
    today = date.today()
    rows = []  # (days_ago, account_key, leaf_name, merchant, amount)

    def add(days_ago, acct, leaf, merchant, amount):
        rows.append((days_ago, acct, leaf, merchant, amount))

    # Bi-weekly paycheck (income → negative), monthly bills (spending → positive).
    for i in range(6):
        add(7 + i * 14, "checking", "Salary", "Acme Corp Payroll", -3200.00)
    for m in range(3):
        base = m * 30
        add(base + 1, "checking", "Rent & Mortgage", "Parkside Apartments", 2200.00)
        add(base + 3, "checking", "Electricity", "City Power & Light", 94.50 + m)
        add(base + 4, "checking", "Internet", "Fiberlink", 69.99)
        add(base + 5, "checking", "Phone", "CellOne Mobile", 55.00)
        add(base + 6, "checking", "Water", "Metro Water", 38.25)
        add(base + 8, "card", "Streaming Services", "Netflix", 15.99)
        add(base + 9, "card", "Gym Membership", "FitClub", 40.00)

    grocers = ["Costco", "Trader Joe's", "Whole Foods", "Safeway"]
    grocery_amts = [182.40, 64.10, 121.75, 88.30]
    for i in range(12):
        add(2 + i * 7, "card", "Groceries", grocers[i % 4], grocery_amts[i % 4] + i)
    coffee_amts = [4.75, 5.40, 6.25, 4.10, 5.95]
    for i in range(10):
        add(1 + i * 6, "card", "Coffee & Drinks", "Starbucks" if i % 2 else "Blue Bottle", coffee_amts[i % 5])
    diners = ["The Corner Bistro", "Sushi House", "Taco Stand", "Pasta Bar"]
    for i in range(8):
        add(3 + i * 9, "card", "Dining Out", diners[i % 4], 28.50 + i * 4)
    for i in range(6):
        add(4 + i * 11, "card", "Gas", "Shell" if i % 2 else "Chevron", 42.00 + i * 3)
    online_amts = [23.99, 119.40, 14.25, 56.80, 31.10, 78.65, 19.99, 44.50]
    for i in range(8):
        add(5 + i * 8, "card", "Online Shopping", "Amazon", online_amts[i])
    add(20, "card", "Pet Care", "Petco", 46.20)
    add(48, "card", "Pet Care", "Chewy", 61.85)

    # One-offs: a refund (income), inter-account transfer (two legs), interest, a dividend.
    add(15, "card", "Refund", "Amazon Refund", -45.00)
    add(30, "checking", "Bank Transfer", "Transfer to Savings", 500.00)
    add(30, "savings", "Bank Transfer", "Transfer from Checking", -500.00)
    add(31, "savings", "Interest Income", "Interest Payment", -12.18)
    add(45, "brokerage", "Investment", "Quarterly Dividend", -52.40)

    # A cross-account duplicate: the same charge captured on two accounts (e.g. overlapping statement
    # imports). Same date/amount/merchant but DIFFERENT accounts and batches, so the real post-import
    # sweep flags it for review. (A same-account exact dup would instead be hard-rejected on import.)
    add(26, "checking", "Fees & Charges", "Annual Membership", 96.00)
    add(26, "card", "Fees & Charges", "Annual Membership", 96.00)

    inserted = 0
    for days_ago, acct_key, leaf_name, merchant, amount in rows:
        txn_date = (today - timedelta(days=days_ago)).isoformat()
        account_id = accounts[acct_key][0]
        owner_id = accounts[acct_key][3]
        conn.execute(
            """INSERT INTO txn
                 (id, account_id, category_id, amount, merchant_name, display_name, raw_name,
                  date, category_source, owner_id, content_hash, import_batch_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?)""",
            (
                str(uuid.uuid4()), account_id, leaves[leaf_name], amount, merchant, merchant, merchant,
                txn_date, owner_id, _content_hash(txn_date, amount, merchant), batch_ids[acct_key],
            ),
        )
        inserted += 1

    for key, bid in batch_ids.items():
        conn.execute(
            "UPDATE import_batch SET row_count = (SELECT COUNT(*) FROM txn WHERE import_batch_id = ?) WHERE id = ?",
            (bid, bid),
        )

    # Run the REAL post-import suspect sweep for the card statement (imported after checking): it flags
    # the cross-account "Annual Membership" match for review, exactly as a live import would — so the
    # demo's review queue is produced by the genuine detection logic, not a hand-set flag.
    from backend.services.duplicate_detection import mark_import_suspects
    suspects_flagged = mark_import_suspects(conn, batch_ids["card"])

    if scope_id:
        _seed_demo_preferences(conn, scope_id)

    return {
        "skipped": False,
        "owners": len(owners),
        "accounts": len(accounts),
        "batches": len(batch_ids),
        "transactions": inserted,
        "suspects_flagged": suspects_flagged,
        "tags": [ESSENTIAL_TAG, DISCRETIONARY_TAG],
    }
