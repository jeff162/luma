# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""The backup history: the backups this system has made, and the file its data was last restored from.

A row is written when a backup file is complete on the server, before it is saved, so it says the file was
made rather than that it arrived anywhere. Where the browser has a save picker the file was named before the
backup was asked for and the row has that name; otherwise it has the one the server suggested, which the
browser may change. Each row splits the file's size into the ledger, the accounts part and the attached
documents, which is what shows whether documents are becoming the bulk of a backup. It also says whether the
databases passed their check as the file was made (`services/database_health.py`): a backup can be taken
from a database that failed, since a partial copy of a failing database is better than none, and the row is
what keeps such a file from later being trusted as a good one.

**The history rides the data backup, and a restore decides whose history survives.** Restoring a backup
this system made keeps the live history, which already holds everything the file's copy does and every
backup made since. Restoring anything else takes the file's history, as a restore onto an empty system
does, and adds a row for the file itself, since a backup never holds its own row
(`routers/import_export/backup.py` → `_restore_backup_history`).

**Retention is a count**, a ledger setting: the history keeps the newest rows outside the trash, however
old. Backups are made by hand, so an age would keep a handful of rows for one person and hundreds for
another, and could leave a history whose only backup had aged out reading as "no backup was ever made". A
trashed row does not count, since it is not one the history is showing; it goes once it is older than the
oldest row kept.

**A row can be wrong, and the person who made the backup is the only one who can tell.** The server cannot
see whether the browser's save went through or what name it was saved under (the page trashes the row
itself when its own write fails, but a plain download reports nothing), so a row can be moved to the trash
(`deleted_at`) and its filename corrected. Trashing a row withdraws the credentials-export record made
with it (`control_database.set_credentials_exports_withdrawn`), so the vault's recovery and passphrase-change
lists stop naming a file that was never kept; restoring the row restores that record.
"""

from __future__ import annotations

import json
import sqlite3
import uuid

from backend.services.preferences import get_shared_preference, set_shared_preference
from backend.time_utils import utcnow_iso

DEFAULT_RETENTION_COUNT = 50
RETENTION_PREF_KEY = "backups.history_retention_count"
MIN_RETENTION_COUNT = 1
MAX_RETENTION_COUNT = 1000
MAX_FILENAME_LENGTH = 255

_COLUMNS = (
    "made_at", "made_by", "filename", "encrypted", "key_labels", "credentials_included",
    "credentials_left_out", "total_bytes", "ledger_bytes", "accounts_bytes", "documents_bytes",
    "document_count", "restored_at", "database_check",
)


def retention_count(conn: sqlite3.Connection) -> int:
    """The ledger's retention, clamped. An unreadable stored value falls back to the default."""
    raw = get_shared_preference(conn, RETENTION_PREF_KEY)
    if raw is None:
        return DEFAULT_RETENTION_COUNT
    try:
        count = int(str(raw).strip().strip('"'))
    except (TypeError, ValueError):
        return DEFAULT_RETENTION_COUNT
    return max(MIN_RETENTION_COUNT, min(count, MAX_RETENTION_COUNT))


def set_retention_count(conn: sqlite3.Connection, count) -> int:
    """Store a new retention and apply it at once."""
    try:
        value = int(count)
    except (TypeError, ValueError):
        raise ValueError("That is not a number of backups.")
    if value < MIN_RETENTION_COUNT or value > MAX_RETENTION_COUNT:
        raise ValueError(f"Choose between {MIN_RETENTION_COUNT} and {MAX_RETENTION_COUNT} backups.")
    set_shared_preference(conn, RETENTION_PREF_KEY, str(value))
    prune(conn)
    return value


def prune(conn: sqlite3.Connection) -> None:
    """Keep the newest `retention_count` rows outside the trash, and the trashed rows no older than the
    oldest of them. `made_at` is naive-UTC ISO from `utcnow_iso` (or a backup header's `exported_at`, the
    same shape), so comparing as strings orders it."""
    count = retention_count(conn)
    kept = """SELECT id FROM backup_history WHERE deleted_at IS NULL
              ORDER BY made_at DESC, rowid DESC LIMIT ?"""
    conn.execute(f"DELETE FROM backup_history WHERE deleted_at IS NULL AND id NOT IN ({kept})", (count,))
    # Only once the history is full: until then nothing shown is old enough to outlast a trashed row.
    conn.execute(
        """
        DELETE FROM backup_history
        WHERE  deleted_at IS NOT NULL
          AND  (SELECT COUNT(*) FROM backup_history WHERE deleted_at IS NULL) >= ?
          AND  made_at < (SELECT MIN(made_at) FROM backup_history WHERE deleted_at IS NULL)
        """,
        (count,),
    )


def record(conn: sqlite3.Connection, *, backup_id: str | None = None, **fields) -> None:
    """Add a row, inside the caller's transaction. `key_labels` is a list; every other field is stored
    as given, and `made_at` defaults to now. `backup_id` is passed by a caller that has already named the
    backup elsewhere — the credentials-export record made with it."""
    unknown = set(fields) - set(_COLUMNS)
    if unknown:
        raise ValueError(f"unknown backup history fields: {sorted(unknown)}")
    row = {column: fields.get(column) for column in _COLUMNS}
    row["made_at"] = row["made_at"] or utcnow_iso()
    if row["key_labels"] is not None:
        row["key_labels"] = json.dumps(list(row["key_labels"]))
    conn.execute(
        f"INSERT INTO backup_history (id, {', '.join(_COLUMNS)}) VALUES (?, {', '.join('?' for _ in _COLUMNS)})",
        (backup_id or str(uuid.uuid4()), *(row[column] for column in _COLUMNS)),
    )
    prune(conn)


def list_rows(conn: sqlite3.Connection, *, trashed: bool = False) -> list[dict]:
    """The history newest first, or with `trashed` the rows in its trash."""
    rows = []
    for r in conn.execute(
        f"SELECT * FROM backup_history WHERE deleted_at IS {'NOT ' if trashed else ''}NULL "
        "ORDER BY made_at DESC, rowid DESC"
    ):
        row = dict(r)
        try:
            row["key_labels"] = json.loads(row["key_labels"]) if row["key_labels"] else []
        except (TypeError, ValueError):
            row["key_labels"] = []
        for flag in ("encrypted", "credentials_included"):
            row[flag] = None if row[flag] is None else bool(row[flag])
        rows.append(row)
    return rows


def clean_filename(filename: str | None) -> str:
    """A filename as a row stores it, or ValueError saying why it cannot be one."""
    name = (filename or "").strip()
    if not name:
        raise ValueError("A filename is required.")
    if len(name) > MAX_FILENAME_LENGTH:
        raise ValueError(f"A filename can be at most {MAX_FILENAME_LENGTH} characters.")
    return name


def rename(conn: sqlite3.Connection, backup_id: str, filename: str) -> bool:
    """Correct a row's filename to the one the file was saved under. False if there is no such row."""
    name = clean_filename(filename)
    return conn.execute("UPDATE backup_history SET filename = ? WHERE id = ?", (name, backup_id)).rowcount > 0


def set_trashed(conn: sqlite3.Connection, backup_id: str, trashed: bool) -> bool:
    """Move a row into the trash or back out. False if there is no such row; a row already where it is
    asked to go is left as it is, so trashing twice keeps the first date."""
    if conn.execute("SELECT 1 FROM backup_history WHERE id = ?", (backup_id,)).fetchone() is None:
        return False
    if trashed:
        conn.execute("UPDATE backup_history SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL",
                     (utcnow_iso(), backup_id))
    else:
        conn.execute("UPDATE backup_history SET deleted_at = NULL WHERE id = ?", (backup_id,))
    return True


def empty_trash(conn: sqlite3.Connection) -> None:
    """Delete the trashed rows for good. Their credentials-export records stay withdrawn."""
    conn.execute("DELETE FROM backup_history WHERE deleted_at IS NOT NULL")
