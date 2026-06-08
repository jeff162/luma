# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: GPL-3.0-or-later

"""
Keyword-based categorization helper.

The important guarantee is deterministic rule precedence: the same transaction
text, owner, and amount should resolve to the same category whenever this file's
matching logic is used for previews, imports, or retroactive reclassification.
"""

import sqlite3
from backend.db.database import get_db


def _amount_matches(amount: float, amount_min, amount_max) -> bool:
    if amount_min is not None and amount < amount_min:
        return False
    if amount_max is not None and amount > amount_max:
        return False
    return True


def categorize_transaction(
    merchant_name: str | None,
    raw_name: str | None,
    amount: float,
    conn: sqlite3.Connection,
    owner_id: str | None = None,
) -> dict | None:
    """
    Return the best matching rule as {"category_id": ..., "clean_name": ...}, or None.

    Rule evaluation order — most restrictive first:
      1. Owner-specific rules always beat global rules (same specificity).
      2. Within that, rules are sorted by specificity score (descending):
           - Longer keyword  → more specific (less likely to accidentally match)
           - More conditions → more specific (amount range, owner scope each add weight)
      3. Ties broken by keyword length descending, then condition count descending.

    This means:
      - "whole foods" (12 chars) beats "food" (4 chars) — correct
      - "amazon" with amount > $100 beats bare "amazon" — correct
      - "starbucks" owner=Alice beats "starbucks" (global) — correct

    No manual priority number is needed — the matching logic handles common cases
    automatically. The only tricky case is two rules with identical keyword length
    and the same number of conditions but different categories; that would be a
    user configuration error (ambiguous rules) and the first match wins.
    """
    text = " ".join(filter(None, [merchant_name, raw_name])).lower()
    if not text:
        return None

    # Any endpoint that previews "which rule wins" has to mirror this ordering exactly;
    # specificity here is the categorization contract, not just a query optimization.
    rules = conn.execute(
        """SELECT category_id, keyword, amount_min, amount_max, owner_id, clean_name
           FROM   category_rule
           ORDER BY
               CASE WHEN owner_id IS NOT NULL THEN 1 ELSE 0 END DESC,
               LENGTH(keyword) DESC,
               (CASE WHEN amount_min IS NOT NULL THEN 1 ELSE 0 END +
                CASE WHEN amount_max IS NOT NULL THEN 1 ELSE 0 END +
                CASE WHEN owner_id   IS NOT NULL THEN 1 ELSE 0 END) DESC"""
    ).fetchall()

    for rule in rules:
        if rule["owner_id"] is not None and rule["owner_id"] != owner_id:
            continue
        if rule["keyword"].lower() not in text:
            continue
        if not _amount_matches(amount, rule["amount_min"], rule["amount_max"]):
            continue
        return {
            "category_id": rule["category_id"],
            "clean_name":  rule["clean_name"],
        }

    return None


def recategorize_all(conn: sqlite3.Connection) -> int:
    txns = conn.execute(
        """SELECT id, merchant_name, raw_name, amount, owner_id
           FROM   txn
           WHERE  category_overridden = 0"""
    ).fetchall()

    updated = 0
    for txn in txns:
        result = categorize_transaction(
            txn["merchant_name"], txn["raw_name"], txn["amount"], conn,
            owner_id=txn["owner_id"],
        )
        cat_id     = result["category_id"] if isinstance(result, dict) else result
        clean_name = result.get("clean_name") if isinstance(result, dict) else None
        conn.execute(
            """UPDATE txn SET category_id = ?, category_source = ?
               WHERE id = ?""",
            (cat_id, "rule" if cat_id else None, txn["id"]),
        )
        if clean_name and clean_name != txn["merchant_name"]:
            conn.execute(
                "UPDATE txn SET merchant_name = ? WHERE id = ?",
                (clean_name, txn["id"]),
            )
        updated += 1

    return updated


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
        ("netflix",      "Subscriptions",     10, None, None),
        ("spotify",      "Subscriptions",     10, None, None),
        ("hulu",         "Subscriptions",     10, None, None),
        ("apple.com",    "Subscriptions",      9, None, None),
        ("amazon prime", "Subscriptions",      9, None, None),
        ("youtube",      "Subscriptions",      8, None, None),
        ("electric",     "Electricity",        8, None, None),
        ("water bill",   "Water",              8, None, None),
        ("comcast",      "Internet",           9, None, None),
        ("verizon",      "Phone",              9, None, None),
        ("at&t",         "Phone",              9, None, None),
        ("cvs",          "Pharmacy",           8, None, None),
        ("walgreen",     "Pharmacy",           8, None, None),
        ("amazon",       "Online Shopping",    7, None, None),
        ("target",       "Shopping",           8, None, None),
        ("walmart",      "Shopping",           8, None, None),
        ("best buy",     "Electronics",        9, None, None),
        ("airbnb",       "Vacation & Travel", 10, None, None),
        ("hotel",        "Vacation & Travel",  8, None, None),
        ("delta",        "Vacation & Travel",  9, None, None),
        ("united",       "Vacation & Travel",  9, None, None),
        ("payroll",      "Income",            10, None, None),
        ("direct dep",   "Income",             9, None, None),
        ("zelle",        "Transfer",           9, None, None),
        ("venmo",        "Transfer",           9, None, None),
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
