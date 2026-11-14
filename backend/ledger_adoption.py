# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
`luma --adopt-ledger`: pair the configured financial database with this control database.

A server whose two databases do not belong together refuses to open the ledger and says why
(`backend/pairing_lock.py`). Usually the settings point at the wrong file and the fix is the setting. This
is for the other case: the file is the right one and has to be adopted — a ledger carried over from another
machine without a backup, or, when there is no ledger at all, an empty one to restore a backup into.

It is a console tool for the reason `--reset-password` is (`backend/account_recovery.py`): whoever can run
it can already read both files, while anyone who can reach the server cannot. It names both files and
what the ledger holds, and asks before writing, since adopting the wrong file is the likely mistake. It
changes nothing a running server holds in memory, so the server is started again afterwards.

Output is plain ASCII, as in `account_recovery.py`, for a Windows console.
"""

import sqlite3
from contextlib import closing
from pathlib import Path
from typing import Callable

from backend.db import control_database
from backend.runtime_config import app_name


def run(*, ask: Callable[[str], str] = input, say: Callable[[str], None] = print) -> int:
    """Pair the configured ledger after asking, and return the exit status."""
    ledger = Path(control_database.DB_PATH).resolve()
    say(f"Financial database: {ledger}")
    say(f"Control database:   {Path(control_database.CONTROL_DB_PATH).resolve()}")

    if control_database.workspace_id() is None:
        say("The control database has no accounts yet; the first one created adopts the financial database. "
            "Nothing was changed.")
        return 0
    problem = control_database.pairing_problem()
    if problem is None:
        say("These two databases already belong together. Nothing was changed.")
        return 0
    if problem.kind == control_database.PAIRING_UNREADABLE:
        say("The financial database is not a database file. Nothing was changed.")
        return 1

    if problem.kind == control_database.PAIRING_MISSING:
        say("There is no financial database there. An empty one can be created for this control database, "
            f"and a backup restored into it once {app_name()} is running.")
        question = "Create it? [y/N] "
    else:
        contents = _describe(ledger)
        if contents is None:
            say(f"That file is not a {app_name()} financial database. Nothing was changed.")
            return 1
        if problem.kind == control_database.PAIRING_OTHER_WORKSPACE:
            say("It belongs to a different control database.")
        else:
            say("It has not been paired with a control database.")
        say(contents)
        question = "Pair it with this control database? [y/N] "

    try:
        answer = ask(question)
    except (EOFError, KeyboardInterrupt):
        say("\nCancelled. Nothing was changed.")
        return 1
    if answer.strip().lower() not in {"y", "yes"}:
        say("Nothing was changed.")
        return 1

    control_database.adopt_ledger()
    say("Done. The two databases now belong together.")
    say(f"Start {app_name()} again; if it is still running, stop it first.")
    return 0


def _describe(ledger: Path) -> str | None:
    """What the ledger holds, for recognizing it, or None when it is not one of ours."""
    try:
        with closing(sqlite3.connect(ledger)) as conn:
            if not conn.execute(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'db_meta'"
            ).fetchone():
                return None
            transactions, latest = conn.execute(
                "SELECT COUNT(*), MAX(date) FROM txn WHERE trashed_at IS NULL"
            ).fetchone()
            accounts = conn.execute("SELECT COUNT(*) FROM account WHERE trashed_at IS NULL").fetchone()[0]
            sealed = conn.execute(
                "SELECT COUNT(*) FROM connection WHERE credential_enc IS NOT NULL"
            ).fetchone()[0]
    except sqlite3.DatabaseError:
        return None
    lines = [f"It holds {transactions:,} transactions in {accounts:,} accounts"
             + (f", the latest dated {latest}." if latest else ".")]
    if sealed:
        lines.append("Its saved data-source credentials open only with the vault of the control database "
                     "they were saved under.")
    return "\n".join(lines)
