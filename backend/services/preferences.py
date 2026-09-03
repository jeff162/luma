# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
UI/layout preferences storage, in the data DB.

Non-sensitive preferences (page layouts, dashboard tag reports, collapse state, import drafts, …)
live in the data DB's `ui_preference` table keyed by `scope_id` — the authenticated user id (auth
mode) or the local-preference-profile id (local mode). This keeps them with the data they describe
and inside data backups. The control DB keeps only identity/secrets.

Values are stored verbatim (the `/preferences` API JSON-encodes them); this layer does not parse.
"""

from __future__ import annotations

from backend.db.database import get_db


def get_preferences(scope_id: str) -> dict[str, str]:
    with get_db() as conn:
        rows = conn.execute(
            "SELECT pref_key, pref_value FROM ui_preference WHERE scope_id = ?",
            (scope_id,),
        ).fetchall()
    return {row["pref_key"]: row["pref_value"] for row in rows}


def set_preference(scope_id: str, pref_key: str, pref_value: str) -> None:
    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO ui_preference (scope_id, pref_key, pref_value, updated_at)
            VALUES (?, ?, ?, datetime('now'))
            ON CONFLICT(scope_id, pref_key)
            DO UPDATE SET pref_value = excluded.pref_value, updated_at = datetime('now')
            """,
            (scope_id, pref_key, pref_value),
        )


def clear_preferences(scope_id: str) -> None:
    with get_db() as conn:
        conn.execute("DELETE FROM ui_preference WHERE scope_id = ?", (scope_id,))


# ---------------------------------------------------------------------------
# Ledger-level settings
# ---------------------------------------------------------------------------

# A reserved scope for settings that belong to the *ledger* rather than to a person: one data DB has one
# answer, and every user reads the same one. It is a `ui_preference` scope rather than a `db_meta` key on
# purpose. `db_meta` holds derived state — schema version, scan watermarks — and is deliberately left out
# of the backup payload, so a value stored there silently reverts to its default on restore. These are
# user-chosen configuration, so they have to ride data backups the way the rest of the preferences do.
#
# Reserved rather than merely conventional: the scope is not a user id, so `clear_preferences` (only ever
# called with the caller's own scope) cannot reach it, and resetting one person's layout cannot take a
# household-wide setting with it.
SHARED_SCOPE_ID = "__ledger__"


# Both halves take the caller's connection. A service reading one of these is normally already inside a
# `get_db()` block, and opening a second connection to the same file from within an open write
# transaction is what SQLite reports as "database is locked" — so the store is read and written on the
# connection the caller already holds rather than on one of its own.
def get_shared_preference(conn, pref_key: str) -> str | None:
    row = conn.execute(
        "SELECT pref_value FROM ui_preference WHERE scope_id = ? AND pref_key = ?",
        (SHARED_SCOPE_ID, pref_key),
    ).fetchone()
    return row["pref_value"] if row else None


def set_shared_preference(conn, pref_key: str, pref_value: str) -> None:
    conn.execute(
        """
        INSERT INTO ui_preference (scope_id, pref_key, pref_value, updated_at)
        VALUES (?, ?, ?, datetime('now'))
        ON CONFLICT(scope_id, pref_key)
        DO UPDATE SET pref_value = excluded.pref_value, updated_at = datetime('now')
        """,
        (SHARED_SCOPE_ID, pref_key, pref_value),
    )
