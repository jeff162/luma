# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: GPL-3.0-or-later

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
