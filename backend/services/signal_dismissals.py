# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
The keyed "seen it, it's fine" store, shared by the two derive-on-read finding surfaces.

Both the recurring signals (`recurring_signals.py`) and the rule range-drift findings
(`rule_range_drift.py`) compute their findings fresh from the ledger every time and store nothing but
the user's dismissals. That leaves one durable question — *is this key currently dismissed* — with one
answer for both, so the table lives here rather than being reached into from two modules.

Keys are disjoint by construction: a recurring signal's key is a series fingerprint or a transaction
id prefixed by its kind, and a range-drift key is `<kind>:<rule id>:<transaction id>`. Nothing needs to
enforce that, because a key is only ever asked about by the module that mints it.

The table is still named `recurring_signal_dismissal`: it predates the second consumer, and renaming it
would be a migration that changes no behavior and drops every dismissal already recorded under the old
name. A dismissal is shared at the data-DB level rather than per-user — saying a finding is fine is
curation of the ledger, like confirming a series, not a UI preference — and carries no foreign key, so
one whose subject later disappears simply stops matching anything. That is why nothing prunes them.
"""

import sqlite3


def dismissed_keys(conn: sqlite3.Connection) -> set[str]:
    return {r["signal_key"] for r in conn.execute("SELECT signal_key FROM recurring_signal_dismissal")}


def dismiss(conn: sqlite3.Connection, key: str, kind: str) -> None:
    conn.execute(
        """
        INSERT INTO recurring_signal_dismissal (signal_key, kind, dismissed_at)
        VALUES (?, ?, datetime('now'))
        ON CONFLICT(signal_key) DO UPDATE SET kind = excluded.kind, dismissed_at = excluded.dismissed_at
        """,
        (key, kind),
    )


def restore(conn: sqlite3.Connection, key: str) -> None:
    conn.execute("DELETE FROM recurring_signal_dismissal WHERE signal_key = ?", (key,))
