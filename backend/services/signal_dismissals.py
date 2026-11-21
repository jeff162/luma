# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
The keyed "seen it, it's fine" store, shared by the derive-on-read finding surfaces.

The recurring signals (`recurring_signals.py`), the rule range-drift findings (`rule_range_drift.py`) and
the balance-history flags (`net_worth.py`) compute their findings fresh from the ledger every time and
store nothing but the user's dismissals. That leaves one durable question — *is this key currently
dismissed* — with one answer for all of them, so the table lives here rather than being reached into from
each module.

Keys are disjoint by construction: a recurring signal's key is a series fingerprint or a transaction
id prefixed by its kind, a range-drift key is `<kind>:<rule id>:<transaction id>`, and a history flag's is
`balance_history:<account id>:<date>`. Nothing needs to enforce that, because a key is only ever asked
about by the module that mints it.

The table is still named `recurring_signal_dismissal`: it predates the other consumers, and renaming it
would be a migration that changes no behavior and drops every dismissal already recorded under the old
name. A dismissal is shared at the data-DB level rather than per-user — saying a finding is fine is
curation of the ledger, like confirming a series, not a UI preference — and carries no foreign key, so
one whose subject later disappears simply stops matching anything. That is why nothing prunes them.
"""

import sqlite3


def dismissed_keys(conn: sqlite3.Connection) -> set[str]:
    return {r["signal_key"] for r in conn.execute("SELECT signal_key FROM recurring_signal_dismissal")}


def one_off_keys(conn: sqlite3.Connection) -> set[str]:
    """The dismissals that said "fine this time" rather than "fine" — see `recurring_signals`'
    `_load_one_off_charges` for what that changes."""
    return {r["signal_key"] for r in conn.execute(
        "SELECT signal_key FROM recurring_signal_dismissal WHERE one_off = 1")}


def dismiss(conn: sqlite3.Connection, key: str, kind: str, *, one_off: bool = False) -> None:
    # `one_off` is stated here even though the column defaults to 0: a DDL default is fixed at the
    # migration that added it, so the insert site is where the value is actually owned. Re-dismissing
    # the same key replaces the answer, which is how a one-off becomes an ordinary dismissal and back.
    conn.execute(
        """
        INSERT INTO recurring_signal_dismissal (signal_key, kind, one_off, dismissed_at)
        VALUES (?, ?, ?, datetime('now'))
        ON CONFLICT(signal_key) DO UPDATE SET kind = excluded.kind, one_off = excluded.one_off,
                                              dismissed_at = excluded.dismissed_at
        """,
        (key, kind, 1 if one_off else 0),
    )


def restore(conn: sqlite3.Connection, key: str) -> None:
    conn.execute("DELETE FROM recurring_signal_dismissal WHERE signal_key = ?", (key,))
