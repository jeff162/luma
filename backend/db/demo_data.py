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
    pid = str(uuid.uuid4())
    conn.execute(
        """INSERT INTO csv_import_profile
             (id, name, column_map, date_format, amount_convention, use_imported_categories)
           VALUES (?, ?, ?, '%Y-%m-%d', 'single_signed', ?)""",
        (pid, name, json.dumps(column_map), use_imported_categories),
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
    or a linked connection (`plaid_item`) means the user has set up their own pipeline, so the demo
    offer disappears even before any rows have imported or synced."""
    row = conn.execute(
        """
        SELECT (SELECT COUNT(*) FROM account)            AS accounts,
               (SELECT COUNT(*) FROM txn)                AS txns,
               (SELECT COUNT(*) FROM plaid_item)         AS connections,
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


def load_demo_data(conn, scope_id: str | None = None) -> dict:
    """Populate an empty tenant with the demo dataset. No-op (returns skipped=True) on a non-empty DB.
    When `scope_id` (the local preference-profile id) is given, also seed UI preferences so the demo
    opens expanded. Caller owns the transaction/commit."""
    if not is_demo_loadable(conn):
        return {"skipped": True, "reason": "tenant already has accounts or transactions"}

    from backend.db.database import _seed_default_categories, SHARED_OWNER_ID
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
        conn.execute("INSERT INTO owner (id, name, color) VALUES (?, ?, ?)", (oid, name, color))

    accounts = {
        "checking": (str(uuid.uuid4()), "Everyday Checking", "depository", owners["Alex"][0]),
        "savings": (str(uuid.uuid4()), "Rainy Day Savings", "savings", SHARED_OWNER_ID),
        "card": (str(uuid.uuid4()), "Rewards Card", "credit", owners["Jordan"][0]),
        "brokerage": (str(uuid.uuid4()), "Brokerage", "investment", owners["Jordan"][0]),
    }
    for aid, name, acct_type, owner_id in accounts.values():
        conn.execute(
            """INSERT INTO account (id, plaid_account_id, plaid_item_id, name, display_name, type, owner_id)
               VALUES (?, NULL, 'manual', ?, ?, ?, ?)""",
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

    for i in range(6):
        bank(7 + i * 14, "Acme Corp Payroll", "Salary", -3200.00, "checking")
    for m in range(3):
        base = m * 30
        bank(base + 1, "Parkside Apartments", "Rent & Mortgage", 2200.00, "checking")
        bank(base + 3, "City Power & Light", "Electricity", 94.50 + m, "checking")
        bank(base + 4, "Fiberlink", "Internet", 69.99, "checking")
        bank(base + 5, "CellOne Mobile", "Phone", 55.00, "checking")
        bank(base + 6, "Metro Water", "Water", 38.25, "checking")
    bank(30, "Transfer to Savings", "Bank Transfer", 500.00, "checking")
    bank(30, "Transfer from Checking", "Bank Transfer", -500.00, "savings")
    bank(31, "Interest Payment", "Interest Income", -12.18, "savings")
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

    for m in range(3):
        base = m * 30
        card(base + 8, "Netflix", 15.99)        # rule → Streaming Services
        card(base + 9, "FitClub", 40.00)        # no rule → uncategorized
    grocers = ["Costco", "Trader Joe's", "Whole Foods", "Safeway"]
    grocery_amts = [182.40, 64.10, 121.75, 88.30]
    for i in range(12):
        card(2 + i * 7, grocers[i % 4], grocery_amts[i % 4] + i)   # Costco → rule; the rest uncategorized
    coffee_amts = [4.75, 5.40, 6.25, 4.10, 5.95]
    for i in range(10):
        card(1 + i * 6, "Starbucks" if i % 2 else "Blue Bottle", coffee_amts[i % 5])  # Starbucks → rule
    diners = ["The Corner Bistro", "Sushi House", "Taco Stand", "Pasta Bar"]
    for i in range(8):
        card(3 + i * 9, diners[i % 4], 28.50 + i * 4)             # uncategorized
    for i in range(6):
        card(4 + i * 11, "Shell" if i % 2 else "Chevron", 42.00 + i * 3)   # Shell → rule
    online_amts = [23.99, 119.40, 14.25, 56.80, 31.10, 78.65, 19.99, 44.50]
    for i in range(8):
        card(5 + i * 8, "Amazon", online_amts[i])                # Amazon → rule
    card(15, "Amazon Refund", -45.00)                            # refund (income); "amazon" → rule
    card(45, "Quarterly Dividend", -52.40, "brokerage")          # uncategorized income
    card(26, "Annual Membership", 96.00)                         # cross-account duplicate, leg B

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
        ("costco", "Groceries"),
        ("shell", "Gas"),
        ("amazon", "Online Shopping"),
        ("petco", "Pet Care"),
        ("chewy", "Pet Care"),
    ]:
        if leaf_name in leaves and not conn.execute(
            "SELECT 1 FROM category_rule WHERE LOWER(keyword) = ?", (keyword,)
        ).fetchone():
            conn.execute(
                "INSERT INTO category_rule (id, category_id, keyword) VALUES (?, ?, ?)",
                (str(uuid.uuid4()), leaves[leaf_name], keyword),
            )

    # Import the raw source (no categories). The core's post-import sweep flags the cross-account
    # "Annual Membership" duplicate against the checking row from the first import.
    _import(
        _render_csv(["Transaction Date", "Payee", "Amount", "Account"], card_rows),
        profile_id=card_profile_id, column_map=card_cols, account_keys=("card", "brokerage"),
        use_imported_categories=False, filename="rewards-card.csv",
    )

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

    add_tag(ESSENTIAL_TAG, "#16a34a", 0, leaf_names=("Groceries", "Rent & Mortgage", "Gas"), group_names=("Utilities",))
    add_tag(DISCRETIONARY_TAG, "#f59e0b", 1, leaf_names=("Dining Out", "Coffee & Drinks"), group_names=("Entertainment", "Shopping"))

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
        "batches": 2,
        "transactions": txn_count,
        "suspects_flagged": suspects_flagged,
        "tags": [ESSENTIAL_TAG, DISCRETIONARY_TAG],
    }
