# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Shared transaction-tag contract.

Tags have two independent sources of truth:
- rule_present means the current rule set would apply the tag
- manual_state lets the user force a tag present or absent on one transaction

This keeps retroactive rule reruns deterministic without taking manual add/remove
control away from the user.
"""

from __future__ import annotations

import sqlite3
from typing import Iterable


VISIBLE_TXN_TAG_SQL = "(tt.manual_state = 1 OR (tt.manual_state = 0 AND tt.rule_present = 1))"

# Source precedence when a tag reaches a transaction through more than one path.
# Direct (rule + manual) beats category-level beats group-level beats account-level — so a tag
# the user explicitly attached to a transaction is reported as 'direct' even if it would also be
# inherited from the category, its parent group, or its account. Account is the broadest scope,
# so it is the most general (lowest) source.
_SOURCE_PRIORITY = {"account": 0, "group": 1, "category": 2, "direct": 3}

# A transaction's account tags come from its *effective* (top-level) account: a child account
# resolves to its parent, so a parent's tags propagate to children's transactions while a child's
# own tags stay dormant while merged.
_EFFECTIVE_ACCOUNT_ID_SQL = "COALESCE((SELECT parent_account_id FROM account WHERE id = t.account_id), t.account_id)"


def get_visible_transaction_tag_map(
    conn: sqlite3.Connection,
    txn_ids: Iterable[str],
) -> dict[str, list[dict]]:
    txn_ids = [str(txn_id) for txn_id in txn_ids if txn_id]
    if not txn_ids:
        return {}
    placeholders = ",".join("?" for _ in txn_ids)

    direct_rows = conn.execute(
        f"""
        SELECT
            tt.txn_id,
            g.id,
            g.name,
            g.color,
            g.sort_order
        FROM txn_tag tt
        JOIN tag g ON g.id = tt.tag_id
        WHERE tt.txn_id IN ({placeholders})
          AND {VISIBLE_TXN_TAG_SQL}
        """,
        txn_ids,
    ).fetchall()

    # Inherited tags: pulled additively from the transaction's leaf category and its
    # parent group. The CASE on category_id picks the most specific source so we can
    # mark each tag with where it came from for downstream UI affordances.
    inherited_rows = conn.execute(
        f"""
        SELECT
            t.id  AS txn_id,
            g.id  AS id,
            g.name,
            g.color,
            g.sort_order,
            CASE
                WHEN ct.category_id = t.category_id THEN 'category'
                ELSE 'group'
            END AS source
        FROM txn t
        JOIN category c ON c.id = t.category_id
        JOIN category_tag ct
          ON ct.category_id = t.category_id
          OR ct.category_id = c.parent_id
        JOIN tag g ON g.id = ct.tag_id
        WHERE t.id IN ({placeholders})
        """,
        txn_ids,
    ).fetchall()

    # Account-level tags, resolved through the effective (top-level) account.
    account_rows = conn.execute(
        f"""
        SELECT
            t.id  AS txn_id,
            g.id  AS id,
            g.name,
            g.color,
            g.sort_order,
            'account' AS source
        FROM txn t
        JOIN account_tag at ON at.account_id = {_EFFECTIVE_ACCOUNT_ID_SQL}
        JOIN tag g ON g.id = at.tag_id
        WHERE t.id IN ({placeholders})
        """,
        txn_ids,
    ).fetchall()

    # Merge per transaction, keyed by tag id so a tag contributed via more than one
    # path collapses into one entry tagged with the highest-priority source.
    merged: dict[str, dict[str, dict]] = {txn_id: {} for txn_id in txn_ids}
    for row in list(account_rows) + list(inherited_rows):
        bucket = merged[row["txn_id"]]
        existing = bucket.get(row["id"])
        if existing is None or _SOURCE_PRIORITY[row["source"]] > _SOURCE_PRIORITY[existing["source"]]:
            bucket[row["id"]] = {
                "id": row["id"],
                "name": row["name"],
                "color": row["color"],
                "source": row["source"],
                "_sort": row["sort_order"] or 0,
            }
    for row in direct_rows:
        merged[row["txn_id"]][row["id"]] = {
            "id": row["id"],
            "name": row["name"],
            "color": row["color"],
            "source": "direct",
            "_sort": row["sort_order"] or 0,
        }

    tag_map: dict[str, list[dict]] = {}
    for txn_id, bucket in merged.items():
        sorted_tags = sorted(
            bucket.values(),
            key=lambda t: (t["_sort"], (t["name"] or "").lower(), t["name"] or "", t["id"]),
        )
        tag_map[txn_id] = [
            {"id": t["id"], "name": t["name"], "color": t["color"], "source": t["source"]}
            for t in sorted_tags
        ]
    return tag_map


def list_visible_transaction_tags(conn: sqlite3.Connection, txn_id: str) -> list[dict]:
    return get_visible_transaction_tag_map(conn, [txn_id]).get(txn_id, [])


def _get_txn_tag_rows(conn: sqlite3.Connection, txn_id: str) -> list[sqlite3.Row]:
    return conn.execute(
        """
        SELECT txn_id, tag_id, rule_present, manual_state
        FROM txn_tag
        WHERE txn_id = ?
        """,
        (txn_id,),
    ).fetchall()


def _predict_rule_tag_sync_change(
    rows: dict[str, sqlite3.Row],
    next_rule_tag_ids: set[str],
    *,
    clear_manual_blocks: bool,
) -> bool:
    for tag_id, row in rows.items():
        next_rule_present = 1 if tag_id in next_rule_tag_ids else 0
        next_manual_state = row["manual_state"]
        if clear_manual_blocks and next_rule_present and next_manual_state == -1:
            next_manual_state = 0
        if next_rule_present != row["rule_present"] or next_manual_state != row["manual_state"]:
            return True
        if next_rule_present == 0 and next_manual_state == 0:
            return True
    return any(tag_id not in rows for tag_id in next_rule_tag_ids)


def load_rule_tag_sync_rows(conn: sqlite3.Connection) -> dict:
    """Preload {txn_id: {tag_id: row}} from txn_tag so a batch preview/recategorize can hand each
    transaction's existing direct-tag rows to would_sync_rule_tags_change instead of querying per row.
    Each transaction's rows are read at most once before that transaction is (re)written, so a write to
    one row never staling another's preloaded entry."""
    rows_by_txn: dict = {}
    for row in conn.execute(
        "SELECT txn_id, tag_id, rule_present, manual_state FROM txn_tag"
    ).fetchall():
        rows_by_txn.setdefault(row["txn_id"], {})[row["tag_id"]] = row
    return rows_by_txn


def would_sync_rule_tags_change(
    conn: sqlite3.Connection,
    txn_id: str,
    tag_ids: Iterable[str],
    *,
    clear_manual_blocks: bool = False,
    existing_rows: dict | None = None,
) -> bool:
    if existing_rows is None:
        existing_rows = {row["tag_id"]: row for row in _get_txn_tag_rows(conn, txn_id)}
    next_rule_tag_ids = {str(tag_id) for tag_id in tag_ids if tag_id}
    return _predict_rule_tag_sync_change(existing_rows, next_rule_tag_ids, clear_manual_blocks=clear_manual_blocks)


def sync_rule_tags_for_transaction(
    conn: sqlite3.Connection,
    txn_id: str,
    tag_ids: Iterable[str],
    *,
    clear_manual_blocks: bool = False,
) -> bool:
    existing_rows = {row["tag_id"]: row for row in _get_txn_tag_rows(conn, txn_id)}
    next_rule_tag_ids = {str(tag_id) for tag_id in tag_ids if tag_id}
    changed = False

    for tag_id, row in existing_rows.items():
        next_rule_present = 1 if tag_id in next_rule_tag_ids else 0
        next_manual_state = row["manual_state"]
        if clear_manual_blocks and next_rule_present and next_manual_state == -1:
            next_manual_state = 0
        if next_rule_present == row["rule_present"] and next_manual_state == row["manual_state"]:
            if next_rule_present == 0 and next_manual_state == 0:
                conn.execute(
                    "DELETE FROM txn_tag WHERE txn_id = ? AND tag_id = ?",
                    (txn_id, tag_id),
                )
                changed = True
            continue
        if next_rule_present == 0 and next_manual_state == 0:
            conn.execute(
                "DELETE FROM txn_tag WHERE txn_id = ? AND tag_id = ?",
                (txn_id, tag_id),
            )
        else:
            conn.execute(
                """
                UPDATE txn_tag
                SET rule_present = ?, manual_state = ?
                WHERE txn_id = ? AND tag_id = ?
                """,
                (next_rule_present, next_manual_state, txn_id, tag_id),
            )
        changed = True

    for tag_id in next_rule_tag_ids:
        if tag_id in existing_rows:
            continue
        conn.execute(
            """
            INSERT INTO txn_tag (txn_id, tag_id, rule_present, manual_state)
            VALUES (?, ?, 1, 0)
            """,
            (txn_id, tag_id),
        )
        changed = True

    return changed


def set_manual_transaction_tag(
    conn: sqlite3.Connection,
    txn_id: str,
    tag_id: str,
    *,
    present: bool,
) -> None:
    row = conn.execute(
        """
        SELECT rule_present, manual_state
        FROM txn_tag
        WHERE txn_id = ? AND tag_id = ?
        """,
        (txn_id, tag_id),
    ).fetchone()

    if present:
        if row:
            next_manual_state = 0 if row["rule_present"] else 1
            if next_manual_state == row["manual_state"]:
                return
            conn.execute(
                """
                UPDATE txn_tag
                SET manual_state = ?
                WHERE txn_id = ? AND tag_id = ?
                """,
                (next_manual_state, txn_id, tag_id),
            )
            return
        conn.execute(
            """
            INSERT INTO txn_tag (txn_id, tag_id, rule_present, manual_state)
            VALUES (?, ?, 0, 1)
            """,
            (txn_id, tag_id),
        )
        return

    if not row:
        return
    if row["rule_present"]:
        if row["manual_state"] == -1:
            return
        conn.execute(
            """
            UPDATE txn_tag
            SET manual_state = -1
            WHERE txn_id = ? AND tag_id = ?
            """,
            (txn_id, tag_id),
        )
        return
    conn.execute(
        "DELETE FROM txn_tag WHERE txn_id = ? AND tag_id = ?",
        (txn_id, tag_id),
    )
