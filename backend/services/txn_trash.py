# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Moving transactions into and out of the trash.

Every path that trashes or restores a transaction goes through these two functions, because trash state
is read by more than the ledger's filters. A trashed row stops being a recurring occurrence and a
restored one becomes one again, so each move owes the rows' payees a recurring rescan
(`owe_recurring_rescan`), recorded in the caller's transaction. The caller runs `settle_owed_rescans`
once that transaction has committed.

- **Only the move is owned here.** Why a row left (`rejection_reason`, `dedupe_resolved_by` and the
  other dedupe provenance) is the calling flow's record, written by it beside the move.
- **A move acts only on rows not already in the target state**, so re-trashing keeps a row's original
  `trashed_at` (which emptying the trash by age reads), and the returned ids are the rows that moved.
"""

from __future__ import annotations

import sqlite3
from collections.abc import Iterable

from backend.services.recurring_detection import owe_recurring_rescan

_CHUNK = 500


def _move(conn: sqlite3.Connection, ids: Iterable[str], *, set_sql: str, from_state_sql: str) -> list[str]:
    wanted = list(dict.fromkeys(i for i in ids if i))
    moved: list[str] = []
    for start in range(0, len(wanted), _CHUNK):
        chunk = wanted[start:start + _CHUNK]
        placeholders = ",".join("?" * len(chunk))
        moved += [
            r["id"] for r in conn.execute(
                f"SELECT id FROM txn WHERE id IN ({placeholders}) AND {from_state_sql}", chunk
            ).fetchall()
        ]
    for start in range(0, len(moved), _CHUNK):
        chunk = moved[start:start + _CHUNK]
        placeholders = ",".join("?" * len(chunk))
        conn.execute(f"UPDATE txn SET {set_sql} WHERE id IN ({placeholders})", chunk)
    if moved:
        owe_recurring_rescan(conn, moved)
    return moved


def trash_txns(conn: sqlite3.Connection, ids: Iterable[str]) -> list[str]:
    """Trash the live rows among `ids`. Returns the ids trashed."""
    return _move(conn, ids, set_sql="trashed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
                 from_state_sql="trashed_at IS NULL")


def restore_txns(conn: sqlite3.Connection, ids: Iterable[str]) -> list[str]:
    """Restore the trashed rows among `ids`. Returns the ids restored."""
    return _move(conn, ids, set_sql="trashed_at = NULL", from_state_sql="trashed_at IS NOT NULL")
