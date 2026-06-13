# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: GPL-3.0-or-later

"""
Shared categorization contract for sync, imports, previews, and retroactive rule apply.

The important invariant is that every caller sees the same winner for the same
transaction text, owner, account, and amount window.
"""

import sqlite3

from backend.services.transaction_tags import (
    load_rule_tag_sync_rows,
    sync_rule_tags_for_transaction,
    would_sync_rule_tags_change,
)


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


def load_categorization_rules(conn: sqlite3.Connection) -> list:
    """Load the ordered rule set ONCE so a per-transaction matcher can reuse it across a whole pass.

    The ORDER BY *is* the precedence contract (account/owner-scoped rules and longer keywords win), so any
    caller that preloads rules must use exactly this query. Hoisting this out of the per-row loop is the
    whole performance fix: re-querying it per row is cheap in isolation but, multiplied by thousands of
    rows and several concurrent requests, collapses SQLite/GIL/IO super-linearly (≈60s for 4 concurrent
    recategorize-preview calls vs ≈1s when the rules are loaded once).
    """
    return conn.execute(
        """SELECT cr.id, cr.category_id, cr.keyword, cr.amount_min, cr.amount_max,
                  cr.debit_credit, cr.owner_id, cr.account_id, cr.clean_name
           FROM   category_rule cr
           LEFT   JOIN category c ON c.id = cr.category_id
           -- Deactivating a category prunes its rules, but stay defensive: a rule must never
           -- categorize into an inactive category. Tag-only rules (category_id NULL) still apply.
           WHERE  cr.category_id IS NULL OR c.is_active = 1
           ORDER  BY
               CASE WHEN cr.owner_id IS NOT NULL THEN 1 ELSE 0 END DESC,
               CASE WHEN cr.account_id IS NOT NULL THEN 1 ELSE 0 END DESC,
               LENGTH(cr.keyword) DESC,
               (CASE WHEN cr.amount_min IS NOT NULL THEN 1 ELSE 0 END +
                CASE WHEN cr.amount_max IS NOT NULL THEN 1 ELSE 0 END +
                CASE WHEN COALESCE(cr.debit_credit, 'both') <> 'both' THEN 1 ELSE 0 END +
                CASE WHEN cr.owner_id   IS NOT NULL THEN 1 ELSE 0 END +
                CASE WHEN cr.account_id IS NOT NULL THEN 1 ELSE 0 END) DESC"""
    ).fetchall()


def load_rule_tags_by_id(conn: sqlite3.Connection) -> dict:
    """Map rule_id -> [tag_id], preloaded once so batch callers don't re-query rule_tag per matched row."""
    mapping: dict = {}
    for row in conn.execute("SELECT rule_id, tag_id FROM rule_tag").fetchall():
        mapping.setdefault(row["rule_id"], []).append(row["tag_id"])
    return mapping


def categorize_transaction(
    merchant_name: str | None,
    raw_name: str | None,
    display_name: str | None,
    amount: float,
    conn: sqlite3.Connection,
    owner_id: str | None = None,
    account_id: str | None = None,
    effective_account_id: str | None = None,
    rules: list | None = None,
    rule_tags_by_id: dict | None = None,
) -> dict | None:
    text = " ".join(filter(None, [display_name, merchant_name, raw_name])).lower()
    if not text:
        return None
    resolved_effective_account_id = _resolve_effective_account_id(conn, account_id, effective_account_id)

    # Callers that categorize many rows in a loop (recategorize, preview, import, sync) pass `rules` /
    # `rule_tags_by_id` in so they are loaded once; a lone single-row caller can omit them and we load
    # on demand. Either way the matching/ordering below is identical — see load_categorization_rules.
    if rules is None:
        rules = load_categorization_rules(conn)

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

    if rule_tags_by_id is not None:
        tag_ids = []
        seen = set()
        for rule_id in matched_rule_ids:
            for tag_id in rule_tags_by_id.get(rule_id, ()):
                if tag_id not in seen:
                    seen.add(tag_id)
                    tag_ids.append(tag_id)
    else:
        placeholders = ",".join("?" for _ in matched_rule_ids)
        tag_rows = conn.execute(
            f"SELECT DISTINCT tag_id FROM rule_tag WHERE rule_id IN ({placeholders})",
            matched_rule_ids,
        ).fetchall()
        tag_ids = [row["tag_id"] for row in tag_rows]
    return {
        "category_id": winning_category_id,
        "clean_name": winning_clean_name,
        "tag_ids": tag_ids,
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

    rules = load_categorization_rules(conn)
    rule_tags_by_id = load_rule_tags_by_id(conn)
    tag_rows_by_txn = load_rule_tag_sync_rows(conn)
    updated = 0
    for txn in txns:
        result = categorize_transaction(
            txn["merchant_name"], txn["raw_name"], txn["display_name"], txn["amount"], conn,
            owner_id=txn["owner_id"],
            account_id=txn["account_id"],
            effective_account_id=txn["effective_account_id"],
            rules=rules,
            rule_tags_by_id=rule_tags_by_id,
        )
        cat_id = result["category_id"] if isinstance(result, dict) else result
        matched_tag_ids = result.get("tag_ids", []) if isinstance(result, dict) else []
        display_name = (
            result.get("clean_name") if isinstance(result, dict) else None
        ) or txn["merchant_name"] or txn["raw_name"]
        category_changed = cat_id != txn["category_id"]
        display_name_changed = display_name != (txn["display_name"] or txn["merchant_name"] or txn["raw_name"])
        tags_changed = would_sync_rule_tags_change(conn, txn["id"], matched_tag_ids, existing_rows=tag_rows_by_txn.get(txn["id"], {}))
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

    rules = load_categorization_rules(conn)
    rule_tags_by_id = load_rule_tags_by_id(conn)
    tag_rows_by_txn = load_rule_tag_sync_rows(conn)
    pending = 0
    for txn in txns:
        result = categorize_transaction(
            txn["merchant_name"], txn["raw_name"], txn["display_name"], txn["amount"], conn,
            owner_id=txn["owner_id"],
            account_id=txn["account_id"],
            effective_account_id=txn["effective_account_id"],
            rules=rules,
            rule_tags_by_id=rule_tags_by_id,
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
            or would_sync_rule_tags_change(conn, txn["id"], matched_tag_ids, existing_rows=tag_rows_by_txn.get(txn["id"], {}))
        ):
            pending += 1

    return pending


def seed_default_rules(conn: sqlite3.Connection):
    import uuid

    def cat_id(name: str) -> str | None:
        # Default rules target leaf categories; restrict to leaves so a group that shares a leaf's
        # name (now permitted) can never be picked as a rule's category.
        row = conn.execute(
            "SELECT id FROM category WHERE name = ? AND parent_id IS NOT NULL", (name,)
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
