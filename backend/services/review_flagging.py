# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Whether a newly received transaction arrives flagged `needs_review`.

Review is a workflow, and not everyone runs it: for an owner whose rows nobody looks over, the review
pool and the "N to review" pills only ever grow. `owner.flag_new_for_review` is the choice not to
start — it decides the value an import or a sync writes into `txn.needs_review` and nothing else.

**It governs arrival only.** Switching it off leaves every row already flagged exactly as it is, and
switching it back on flags only what arrives afterwards; no stored row is rewritten in either
direction, and neither is one whose account later changes owner. Flagging by hand (bulk edit's *Set
review status*) is unaffected, so the flag, its filter and its marker all keep working for an owner
that has it off.

Per owner rather than per user: the flag is a column written at ingest, and a sync has no particular
reader to ask, while every arriving row already carries the owner its account gave it. A row with no
owner has nobody to have opted out for it, so it is always flagged.
"""

from __future__ import annotations

import sqlite3


def owners_not_flagging(conn: sqlite3.Connection) -> frozenset[str]:
    """The owners whose arriving rows are left unflagged. A run that inserts for several accounts reads
    this once, before its loop, and tests each row's owner against it."""
    return frozenset(
        row["id"] for row in conn.execute("SELECT id FROM owner WHERE flag_new_for_review = 0")
    )


def flags_new_transactions(conn: sqlite3.Connection, owner_id: str | None) -> bool:
    """Whether a row arriving for this owner is flagged — for a run whose rows all share one owner."""
    return owner_id not in owners_not_flagging(conn)
