# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
What a data connection is called on screen: the user's `connection.nickname` where one is set, otherwise
the provider's `institution`.

The nickname is display only. `institution` stays the provider's value: a re-link writes it again, account
creation is passed it, and every stored label derived from it keeps the value it was written with — an
import card's title (`"<institution> · <Month Year>"`, written once when the card is made) and a sync log
row's `institution`. So the substitution happens where a label is read for the screen, never by rewriting
what was stored, and a connection that is removed takes its nickname with it: what it left behind reads as
it was recorded.
"""

import sqlite3
from typing import Optional


def connection_display_name(institution: Optional[str], nickname: Optional[str]) -> Optional[str]:
    """The name to show for a connection: its nickname, else its institution (None when it has neither)."""
    return (nickname or "").strip() or institution


def normalize_nickname(nickname: Optional[str], institution: Optional[str]) -> Optional[str]:
    """The value to store for a nickname the user typed. Blank, or the institution's own name, clears it,
    since a nickname equal to that name says nothing new."""
    value = (nickname or "").strip()
    return None if value in ("", (institution or "").strip()) else value


def nicknamed_connections(conn: sqlite3.Connection) -> dict[str, dict]:
    """Connection id → `{institution, provider, nickname}` for every connection with a nickname — the only
    ones whose stored labels read differently on screen. Few rows by nature, so a reader calls this once and
    looks each label up rather than joining it into its own query."""
    return {
        r["id"]: {"institution": r["institution"], "provider": r["provider"], "nickname": r["nickname"]}
        for r in conn.execute(
            "SELECT id, institution, provider, nickname FROM connection WHERE COALESCE(nickname, '') <> ''"
        ).fetchall()
    }


def card_title(filename: Optional[str], connection: Optional[dict]) -> Optional[str]:
    """A sync card's title as shown: the name prefix the sync wrote (`routers/sync.py`, the connection's
    institution or provider) replaced by the connection's nickname. A title that does not start with that
    prefix — the institution has changed since the card was made — is shown as stored."""
    if not filename or not connection or not connection.get("nickname"):
        return filename
    prefix = f"{connection.get('institution') or connection.get('provider') or 'Connection'} · "
    if not filename.startswith(prefix):
        return filename
    return f"{connection['nickname']} · {filename[len(prefix):]}"


def card_title_sql(batch: str, connection: str) -> str:
    """`card_title` as a SQL expression over an `import_batch` alias and a `connection` alias LEFT JOINed on
    `connection.id = batch.connection_id`, for a query that selects a card's title beside other columns.
    The two must agree; a test holds them together."""
    prefix = f"(COALESCE(NULLIF({connection}.institution, ''), NULLIF({connection}.provider, ''), 'Connection') || ' · ')"
    return (
        f"CASE WHEN COALESCE({connection}.nickname, '') <> '' "
        f"AND substr({batch}.filename, 1, length({prefix})) = {prefix} "
        f"THEN {connection}.nickname || ' · ' || substr({batch}.filename, length({prefix}) + 1) "
        f"ELSE {batch}.filename END"
    )
