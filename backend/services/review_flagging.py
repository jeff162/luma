# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Whether a newly received transaction arrives flagged `needs_review`.

Review is a workflow, and not everyone runs it: on a ledger where nobody clears the flag, the review
pool and the "N to review" pills only ever grow. This setting is the choice not to start — it decides
the value an import or a sync writes into `txn.needs_review` and nothing else.

**It governs arrival only.** Switching it off leaves every row already flagged exactly as it is, and
switching it back on flags only what arrives afterwards; no stored row is rewritten in either
direction. Flagging by hand (bulk edit's *Set review status*) is unaffected, so the flag, its filter
and its marker all keep working on a ledger that has it off.

Ledger-level rather than per-user (see `preferences.SHARED_SCOPE_ID`): the flag is a column written at
ingest, and a sync has no particular reader to ask.
"""

from __future__ import annotations

import sqlite3

from backend.services.preferences import get_shared_preference, set_shared_preference

PREF_KEY = "transactions.flag_new_for_review"


def flag_new_transactions(conn: sqlite3.Connection) -> bool:
    """Whether an arriving row is flagged. On unless explicitly switched off, so an unset or unreadable
    value keeps the behaviour every ledger had before the setting existed."""
    raw = get_shared_preference(conn, PREF_KEY)
    return str(raw).strip().strip('"') != "0" if raw is not None else True


def set_flag_new_transactions(conn: sqlite3.Connection, enabled: bool) -> bool:
    set_shared_preference(conn, PREF_KEY, "1" if enabled else "0")
    return bool(enabled)
