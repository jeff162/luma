# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Whose transactions each rule reaches, for the owner lens on the Rules page (`data-model.md` → *Owner
lens*).

A rule has no owner of its own, so the lens asks what it touches. A rule scoped to an owner reaches that
owner, and one scoped to an account reaches the account's owner, because a row's owner is copied from its
account. Neither needs a scan. Every other rule (unscoped, or scoped only by account type) reaches the
owners of the rows it matches now, read through the shared matcher so "which rows a rule owns" keeps one
definition.

**The scan is the cost, so it is made small and then cached.**

- Most rules compare only a row's names (and its account, for a type scope). For those, every distinct
  combination of owner, account and names stands for all the rows that share it, which is a fraction of the
  ledger. A rule with an amount condition or one matching imported source text reads fields that combination
  leaves out, so it is tested against every row.
- Each pass is row-major, as in `rule_overlaps`: a row's haystacks are derived once and tested against every
  open rule, and a rule drops out once it has met every owner bucket the ledger holds.
- The answer is cached in `db_meta`, stamped with `rule_reach_epoch`, which a trigger moves on any write to
  what the answer reads (`database._RULE_REACH_EPOCH_SOURCES`). A read with the epoch unmoved is one lookup,
  and reads that find it stale together share one scan (`services/cache_fill.py`).
  The cache travels with the database, so a restored ledger brings a cache that matches its own data or none.
"""

import json
import sqlite3

from backend.db.database import RULE_REACH_EPOCH_KEY, db_meta_epoch
from backend.services.cache_fill import MISS, fill_once
from backend.services.categorizer import row_match_texts, rule_matches_row_prepared, rule_scope_account_sql
from backend.services.transaction_facets import UNASSIGNED_OWNER_ID

_CACHE_KEY = "rule_reach_cache"

_ROW_SOURCE = """
    FROM   txn t
    JOIN   account a ON a.id = t.account_id
    LEFT   JOIN account p ON p.id = a.parent_account_id
    WHERE  t.trashed_at IS NULL
"""
_EFFECTIVE_ACCOUNT = """
    COALESCE(a.parent_account_id, t.account_id) AS effective_account_id,
    COALESCE(p.type, a.type)                    AS effective_account_type
"""
# Amount is a placeholder here: only rules with no amount condition are tested against these rows.
_NAME_ROWS_SQL = f"""
    SELECT DISTINCT t.owner_id, t.merchant_name, t.raw_name, 0 AS amount, {_EFFECTIVE_ACCOUNT}
    {_ROW_SOURCE}
"""
_FULL_ROWS_SQL = f"""
    SELECT t.owner_id, t.merchant_name, t.raw_name, t.amount, t.import_evidence_json, {_EFFECTIVE_ACCOUNT}
    {_ROW_SOURCE}
"""


def _owner_key(owner_id: str | None) -> str:
    return owner_id or UNASSIGNED_OWNER_ID


def rule_owner_reach(conn: sqlite3.Connection) -> dict[str, list[str]]:
    """`rule_id -> owner ids` for every live rule, `unassigned` standing for rows with no owner, from the
    cache when it is current. An empty list is a rule that matches nothing yet, which the lens shows to
    everyone."""
    def read():
        row = conn.execute("SELECT value FROM db_meta WHERE key = ?", (_CACHE_KEY,)).fetchone()
        if row:
            try:
                cached = json.loads(row["value"])
                if cached.get("epoch") == db_meta_epoch(conn, RULE_REACH_EPOCH_KEY):
                    return cached["reach"]
            except (TypeError, ValueError, KeyError, AttributeError):
                pass
        return MISS

    def fill() -> dict[str, list[str]]:
        epoch = db_meta_epoch(conn, RULE_REACH_EPOCH_KEY)
        reach = compute_rule_owner_reach(conn)
        # A write on a read path: committed at once when the caller had nothing open, so the write lock is
        # not held across the rest of the request (as `reconciliation_attention` does). db_meta has no
        # triggers, so this write cannot move the epoch it is stamped with.
        held = conn.in_transaction
        conn.execute(
            "INSERT INTO db_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (_CACHE_KEY, json.dumps({"epoch": epoch, "reach": reach})),
        )
        if not held:
            conn.commit()
        return reach

    return fill_once(conn, _CACHE_KEY, read, fill)


def compute_rule_owner_reach(conn: sqlite3.Connection) -> dict[str, list[str]]:
    """The reach worked out from the ledger, ignoring the cache."""
    rules = [dict(r) for r in conn.execute(
        f"""SELECT id, keyword, match_expr, amount_min, amount_max, debit_credit, owner_id,
                   {rule_scope_account_sql()}, account_type, match_source_text
            FROM   category_rule
            WHERE  deleted_at IS NULL"""
    )]
    account_owner = {row["id"]: row["owner_id"] for row in conn.execute("SELECT id, owner_id FROM account")}
    reach: dict[str, set[str]] = {rule["id"]: set() for rule in rules}
    by_name, by_row = [], []
    for rule in rules:
        if rule["owner_id"] is not None:
            reach[rule["id"]].add(rule["owner_id"])
        elif rule["account_id"] is not None:
            reach[rule["id"]].add(_owner_key(account_owner.get(rule["account_id"])))
        elif _reads_more_than_names(rule):
            by_row.append(rule)
        else:
            by_name.append(rule)
    if by_name or by_row:
        buckets = {_owner_key(row[0]) for row in conn.execute(
            "SELECT DISTINCT owner_id FROM txn WHERE trashed_at IS NULL"
        )}
        if by_name:
            _scan(conn.execute(_NAME_ROWS_SQL), by_name, reach, buckets)
        if by_row:
            _scan(conn.execute(_FULL_ROWS_SQL), by_row, reach, buckets)
    return {rule_id: sorted(owners) for rule_id, owners in reach.items()}


def _reads_more_than_names(rule: dict) -> bool:
    return bool(
        rule["match_source_text"]
        or rule["amount_min"] is not None
        or rule["amount_max"] is not None
        or (rule["debit_credit"] or "both") != "both"
    )


def _scan(rows, rules: list[dict], reach: dict[str, set[str]], buckets: set[str]) -> None:
    want_source = any(rule["match_source_text"] for rule in rules)
    for row in rows:
        owner = _owner_key(row["owner_id"])
        candidates = [rule for rule in rules if owner not in reach[rule["id"]]]
        if not candidates:
            continue
        text, source_text_lc = row_match_texts(row, want_source_text=want_source)
        settled = False
        for rule in candidates:
            if rule_matches_row_prepared(rule, row, text, source_text_lc):
                reach[rule["id"]].add(owner)
                settled = settled or len(reach[rule["id"]]) >= len(buckets)
        if settled:
            rules = [rule for rule in rules if len(reach[rule["id"]]) < len(buckets)]
            if not rules:
                return
