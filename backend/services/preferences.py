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


def relocate_legacy_preferences(scope_id: str, *, is_auth: bool) -> dict[str, str]:
    """Transitional bridge: preferences used to live in the control DB. The first time a scope's
    data-DB preferences come up empty, copy that scope's values over from the control DB and clear
    the control-DB copy, so the move is invisible to the user. Returns the relocated values (empty
    if there were none). Remove this — and the control-DB pref tables — once all active scopes have
    migrated.
    """
    from backend.db.control_database import (
        clear_local_preferences,
        clear_user_preferences,
        get_local_preferences,
        get_user_preferences,
    )

    legacy = get_user_preferences(scope_id) if is_auth else get_local_preferences(scope_id)
    if not legacy:
        return {}
    for pref_key, pref_value in legacy.items():
        set_preference(scope_id, pref_key, pref_value)
    (clear_user_preferences if is_auth else clear_local_preferences)(scope_id)
    return get_preferences(scope_id)
