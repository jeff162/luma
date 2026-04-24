# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: GPL-3.0-or-later

"""
Shared categorization contract for sync, imports, previews, and retroactive rule apply.

The important invariant is that every caller sees the same winner for the same
transaction text, owner, account, and amount window.
"""

import sqlite3

from backend.services.transaction_tags import sync_rule_tags_for_transaction, would_sync_rule_tags_change


def _amount_matches(amount: float, amount_min, amount_max) -> bool:
    if amount_min is not None and amount < amount_min:
        return False
    if amount_max is not None and amount > amount_max:
        return False
    return True


def _amount_side_matches(amount: float, debit_credit: str | None) -> bool:
    direction = str(debit_credit or "both").strip().lower()
    if direction == "debit":
        return amount > 0
    if direction == "credit":
        return amount < 0
    return True


def _amount_rule_matches(amount: float, amount_min, amount_max, debit_credit: str | None) -> bool:
    if not _amount_side_matches(amount, debit_credit):
        return False
    return _amount_matches(abs(amount), amount_min, amount_max)


def _resolve_effective_account_id(
    conn: sqlite3.Connection,
    account_id: str | None,
    effective_account_id: str | None = None,
) -> str | None:
    if effective_account_id:
        return effective_account_id
    if not account_id:
        return None
    row = conn.execute(
        "SELECT COALESCE(parent_account_id, id) AS effective_account_id FROM account WHERE id = ?",
        (account_id,),
    ).fetchone()
    return row["effective_account_id"] if row else account_id


def categorize_transaction(
    merchant_name: str | None,
    raw_name: str | None,
    display_name: str | None,
    amount: float,
    conn: sqlite3.Connection,
    owner_id: str | None = None,
    account_id: str | None = None,
    effective_account_id: str | None = None,
) -> dict | None:
    text = " ".join(filter(None, [display_name, merchant_name, raw_name])).lower()
    if not text:
        return None
    resolved_effective_account_id = _resolve_effective_account_id(conn, account_id, effective_account_id)

    # Ordering is the user-visible precedence model: account/owner-scoped rules and
    # tighter keywords win before broader fallbacks, so previews match future imports.
    rules = conn.execute(
        """SELECT id, category_id, keyword, amount_min, amount_max, debit_credit, owner_id, account_id, clean_name
           FROM   category_rule
           ORDER  BY
               CASE WHEN owner_id IS NOT NULL THEN 1 ELSE 0 END DESC,
               CASE WHEN account_id IS NOT NULL THEN 1 ELSE 0 END DESC,
               LENGTH(keyword) DESC,
               (CASE WHEN amount_min IS NOT NULL THEN 1 ELSE 0 END +
                CASE WHEN amount_max IS NOT NULL THEN 1 ELSE 0 END +
                CASE WHEN COALESCE(debit_credit, 'both') <> 'both' THEN 1 ELSE 0 END +
                CASE WHEN owner_id   IS NOT NULL THEN 1 ELSE 0 END +
                CASE WHEN account_id IS NOT NULL THEN 1 ELSE 0 END) DESC"""
    ).fetchall()

    matched_rule_ids = []
    winning_category_id = None
    winning_clean_name = None

    for rule in rules:
        if rule["owner_id"] is not None and rule["owner_id"] != owner_id:
            continue
        if rule["account_id"] is not None and rule["account_id"] != resolved_effective_account_id:
            continue
        if rule["keyword"].lower() not in text:
            continue
        if not _amount_rule_matches(amount, rule["amount_min"], rule["amount_max"], rule["debit_credit"]):
            continue
        matched_rule_ids.append(rule["id"])
        if winning_category_id is None and rule["category_id"] is not None:
            winning_category_id = rule["category_id"]
        if winning_clean_name is None and rule["clean_name"]:
            winning_clean_name = rule["clean_name"]

    if not matched_rule_ids:
        return None

    placeholders = ",".join("?" for _ in matched_rule_ids)
    tag_rows = conn.execute(
        f"""
        SELECT DISTINCT tag_id
        FROM rule_tag
        WHERE rule_id IN ({placeholders})
        """,
        matched_rule_ids,
    ).fetchall()
    return {
        "category_id": winning_category_id,
        "clean_name": winning_clean_name,
        "tag_ids": [row["tag_id"] for row in tag_rows],
        "matched_rule_ids": matched_rule_ids,
    }


def recategorize_all(conn: sqlite3.Connection) -> int:
    # Retroactive recategorization is intentionally opt-in and skips manual overrides,
    # so user edits remain the final authority even after rules evolve.
    txns = conn.execute(
        """SELECT
               t.id,
               t.merchant_name,
               t.display_name,
               t.raw_name,
               t.amount,
               t.owner_id,
               t.account_id,
               COALESCE(a.parent_account_id, t.account_id) AS effective_account_id,
               t.category_id,
               t.category_source
           FROM   txn t
           JOIN   account a ON a.id = t.account_id
           WHERE  category_overridden = 0"""
    ).fetchall()

    updated = 0
    for txn in txns:
        result = categorize_transaction(
            txn["merchant_name"], txn["raw_name"], txn["display_name"], txn["amount"], conn,
            owner_id=txn["owner_id"],
            account_id=txn["account_id"],
            effective_account_id=txn["effective_account_id"],
        )
        cat_id = result["category_id"] if isinstance(result, dict) else result
        matched_tag_ids = result.get("tag_ids", []) if isinstance(result, dict) else []
        display_name = (
            result.get("clean_name") if isinstance(result, dict) else None
        ) or txn["merchant_name"] or txn["raw_name"]
        category_changed = cat_id != txn["category_id"]
        display_name_changed = display_name != (txn["display_name"] or txn["merchant_name"] or txn["raw_name"])
        tags_changed = would_sync_rule_tags_change(conn, txn["id"], matched_tag_ids)
        if category_changed or display_name_changed:
            conn.execute(
                "UPDATE txn SET category_id = ?, display_name = ?, category_source = ? WHERE id = ?",
                (cat_id, display_name, "rule" if cat_id else None, txn["id"]),
            )
        if sync_rule_tags_for_transaction(conn, txn["id"], matched_tag_ids):
            tags_changed = True
        if category_changed or display_name_changed or tags_changed:
            updated += 1

    return updated


def preview_recategorize_count(conn: sqlite3.Connection) -> int:
    # The Rules page uses this to decide whether "re-run categorization" is the
    # likely next action, so the preview must mirror the same override-skipping
    # and rule-matching contract as the real recategorize pass.
    txns = conn.execute(
        """SELECT
               t.id,
               t.merchant_name,
               t.display_name,
               t.raw_name,
               t.amount,
               t.owner_id,
               t.account_id,
               COALESCE(a.parent_account_id, t.account_id) AS effective_account_id,
               t.category_id
           FROM   txn t
           JOIN   account a ON a.id = t.account_id
           WHERE  category_overridden = 0"""
    ).fetchall()

    pending = 0
    for txn in txns:
        result = categorize_transaction(
            txn["merchant_name"], txn["raw_name"], txn["display_name"], txn["amount"], conn,
            owner_id=txn["owner_id"],
            account_id=txn["account_id"],
            effective_account_id=txn["effective_account_id"],
        )
        cat_id = result["category_id"] if isinstance(result, dict) else result
        matched_tag_ids = result.get("tag_ids", []) if isinstance(result, dict) else []
        display_name = (
            result.get("clean_name") if isinstance(result, dict) else None
        ) or txn["merchant_name"] or txn["raw_name"]
        display_name_changed = display_name != (txn["display_name"] or txn["merchant_name"] or txn["raw_name"])
        if (
            cat_id != txn["category_id"]
            or display_name_changed
            or would_sync_rule_tags_change(conn, txn["id"], matched_tag_ids)
        ):
            pending += 1

    return pending


def seed_default_rules(conn: sqlite3.Connection):
    import uuid

    def cat_id(name: str) -> str | None:
        row = conn.execute(
            "SELECT id FROM category WHERE name = ?", (name,)
        ).fetchone()
        return row["id"] if row else None

    rules = [
        ("whole foods",  "Groceries",        10, None, None),
        ("trader joe",   "Groceries",        10, None, None),
        ("kroger",       "Groceries",         8, None, None),
        ("safeway",      "Groceries",         8, None, None),
        ("aldi",         "Groceries",         8, None, None),
        ("costco",       "Groceries",         7, None, None),
        ("doordash",     "Dining Out",        10, None, None),
        ("uber eats",    "Dining Out",        10, None, None),
        ("grubhub",      "Dining Out",        10, None, None),
        ("mcdonald",     "Dining Out",         9, None, None),
        ("starbucks",    "Coffee & Drinks",    9, None, None),
        ("chipotle",     "Dining Out",         9, None, None),
        ("restaurant",   "Dining Out",         5, None, None),
        ("cafe",         "Coffee & Drinks",    4, None, None),
        ("uber",         "Rideshare",          9, None, None),
        ("lyft",         "Rideshare",          9, None, None),
        ("shell",        "Gas",                8, None, None),
        ("chevron",      "Gas",                8, None, None),
        ("exxon",        "Gas",                8, None, None),
        ("bp",           "Gas",                7, None, None),
        ("parking",      "Parking & Tolls",    6, None, None),
        ("netflix",      "Streaming Services", 10, None, None),
        ("spotify",      "Streaming Services", 10, None, None),
        ("hulu",         "Streaming Services", 10, None, None),
        ("apple.com",    "Streaming Services", 9, None, None),
        ("amazon prime", "Streaming Services", 9, None, None),
        ("youtube",      "Streaming Services", 8, None, None),
        ("electric",     "Electricity",        8, None, None),
        ("water bill",   "Water",              8, None, None),
        ("comcast",      "Internet",           9, None, None),
        ("verizon",      "Phone",              9, None, None),
        ("at&t",         "Phone",              9, None, None),
        ("cvs",          "Pharmacy",           8, None, None),
        ("walgreen",     "Pharmacy",           8, None, None),
        ("amazon",       "Online Shopping",    7, None, None),
        ("target",       "Household Supplies", 8, None, None),
        ("walmart",      "Household Supplies", 8, None, None),
        ("best buy",     "Electronics",        9, None, None),
        ("airbnb",       "Hotel",             10, None, None),
        ("hotel",        "Hotel",              8, None, None),
        ("delta",        "Air Travel",         9, None, None),
        ("united",       "Air Travel",         9, None, None),
        ("payroll",      "Salary",            10, None, None),
        ("direct dep",   "Salary",             9, None, None),
    ]

    for keyword, cat_name, priority, amt_min, amt_max in rules:
        cid = cat_id(cat_name)
        if not cid:
            continue
        existing = conn.execute(
            "SELECT id FROM category_rule WHERE keyword = ? AND category_id = ?",
            (keyword, cid),
        ).fetchone()
        if not existing:
            conn.execute(
                """INSERT INTO category_rule
                   (id, category_id, keyword, priority, amount_min, amount_max)
                   VALUES (?,?,?,?,?,?)""",
                (str(uuid.uuid4()), cid, keyword, priority, amt_min, amt_max),
            )
