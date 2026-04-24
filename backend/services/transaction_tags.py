# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: GPL-3.0-or-later

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


def get_visible_transaction_tag_map(
    conn: sqlite3.Connection,
    txn_ids: Iterable[str],
) -> dict[str, list[dict]]:
    txn_ids = [str(txn_id) for txn_id in txn_ids if txn_id]
    if not txn_ids:
        return {}
    placeholders = ",".join("?" for _ in txn_ids)
    rows = conn.execute(
        f"""
        SELECT
            tt.txn_id,
            g.id,
            g.name,
            g.color
        FROM txn_tag tt
        JOIN tag g ON g.id = tt.tag_id
        WHERE tt.txn_id IN ({placeholders})
          AND {VISIBLE_TXN_TAG_SQL}
        ORDER BY tt.txn_id, g.sort_order, LOWER(g.name), g.name, g.id
        """,
        txn_ids,
    ).fetchall()
    tag_map: dict[str, list[dict]] = {txn_id: [] for txn_id in txn_ids}
    for row in rows:
        tag_map.setdefault(row["txn_id"], []).append({
            "id": row["id"],
            "name": row["name"],
            "color": row["color"],
        })
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


def would_sync_rule_tags_change(
    conn: sqlite3.Connection,
    txn_id: str,
    tag_ids: Iterable[str],
    *,
    clear_manual_blocks: bool = False,
) -> bool:
    rows = {row["tag_id"]: row for row in _get_txn_tag_rows(conn, txn_id)}
    next_rule_tag_ids = {str(tag_id) for tag_id in tag_ids if tag_id}
    return _predict_rule_tag_sync_change(rows, next_rule_tag_ids, clear_manual_blocks=clear_manual_blocks)


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
