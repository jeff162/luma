# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: GPL-3.0-or-later

"""
Shared categorization contract for sync, imports, previews, and retroactive rule apply.

The important invariant is that every caller sees the same winner for the same
transaction text, owner, account, and amount window.
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
    display_name: str | None,
    amount: float,
    conn: sqlite3.Connection,
    owner_id: str | None = None,
    account_id: str | None = None,
) -> dict | None:
    text = " ".join(filter(None, [display_name, merchant_name, raw_name])).lower()
    if not text:
        return None

    # Ordering is the user-visible precedence model: account/owner-scoped rules and
    # tighter keywords win before broader fallbacks, so previews match future imports.
    rules = conn.execute(
        """SELECT category_id, keyword, amount_min, amount_max, owner_id, account_id, clean_name
           FROM   category_rule
           ORDER  BY
               CASE WHEN owner_id IS NOT NULL THEN 1 ELSE 0 END DESC,
               CASE WHEN account_id IS NOT NULL THEN 1 ELSE 0 END DESC,
               LENGTH(keyword) DESC,
               (CASE WHEN amount_min IS NOT NULL THEN 1 ELSE 0 END +
                CASE WHEN amount_max IS NOT NULL THEN 1 ELSE 0 END +
                CASE WHEN owner_id   IS NOT NULL THEN 1 ELSE 0 END +
                CASE WHEN account_id IS NOT NULL THEN 1 ELSE 0 END) DESC"""
    ).fetchall()

    for rule in rules:
        if rule["owner_id"] is not None and rule["owner_id"] != owner_id:
            continue
        if rule["account_id"] is not None and rule["account_id"] != account_id:
            continue
        if rule["keyword"].lower() not in text:
            continue
        if not _amount_matches(amount, rule["amount_min"], rule["amount_max"]):
            continue
        return {
            "category_id": rule["category_id"],
            "clean_name": rule["clean_name"],
        }

    return None


def recategorize_all(conn: sqlite3.Connection) -> int:
    # Retroactive recategorization is intentionally opt-in and skips manual overrides,
    # so user edits remain the final authority even after rules evolve.
    txns = conn.execute(
        """SELECT id, merchant_name, display_name, raw_name, amount, owner_id, account_id, category_id
           FROM   txn
           WHERE  category_overridden = 0"""
    ).fetchall()

    updated = 0
    for txn in txns:
        result = categorize_transaction(
            txn["merchant_name"], txn["raw_name"], txn["display_name"], txn["amount"], conn,
            owner_id=txn["owner_id"],
            account_id=txn["account_id"],
        )
        cat_id = result["category_id"] if isinstance(result, dict) else result
        display_name = (
            result.get("clean_name") if isinstance(result, dict) else None
        ) or txn["merchant_name"] or txn["raw_name"]
        if cat_id != txn["category_id"]:
            conn.execute(
                "UPDATE txn SET category_id = ?, display_name = ? WHERE id = ?",
                (cat_id, display_name, txn["id"]),
            )
            updated += 1

    return updated


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
