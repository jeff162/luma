# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""The backup history: the backups this system has made, and the file its data was last restored from.

A row is written when a backup file is complete on the server, before it is downloaded, so it says the
file was made rather than that it arrived anywhere; the filename is the one the server suggested, which
the browser may change. Each row splits the file's size into the ledger, the accounts part and the attached
documents, which is what shows whether documents are becoming the bulk of a backup.

**The history rides the data backup, and a restore decides whose history survives.** Restoring a backup
this system made keeps the live history, which already holds everything the file's copy does and every
backup made since. Restoring anything else takes the file's history, as a restore onto an empty system
does, and adds a row for the file itself, since a backup never holds its own row
(`routers/import_export/backup.py` → `_restore_backup_history`).

**Retention is by age**, a ledger setting, and the newest row is never purged however old it is: a history
whose only backup had aged out would read as "no backup was ever made". "Newest" means newest outside the
trash, since a trashed row is not one the history is showing.

**A row can be wrong, and the person who made the backup is the only one who can tell.** The server cannot
see whether the browser's save went through or what name it was saved under, so a row can be moved to the
trash (`deleted_at`) and its filename corrected. Trashing a row withdraws the credentials-export record made
with it (`control_database.set_credentials_exports_withdrawn`), so the vault's recovery and passphrase-change
lists stop naming a file that was never kept; restoring the row restores that record.
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from datetime import datetime, timedelta, timezone

from backend.services.preferences import get_shared_preference, set_shared_preference
from backend.time_utils import utcnow_iso

DEFAULT_RETENTION_DAYS = 365
RETENTION_PREF_KEY = "backups.history_retention_days"
MIN_RETENTION_DAYS = 1
MAX_RETENTION_DAYS = 3650
MAX_FILENAME_LENGTH = 255

_COLUMNS = (
    "made_at", "made_by", "filename", "encrypted", "key_labels", "credentials_included",
    "credentials_left_out", "total_bytes", "ledger_bytes", "accounts_bytes", "documents_bytes",
    "document_count", "restored_at",
)


def retention_days(conn: sqlite3.Connection) -> int:
    """The ledger's retention, clamped. An unreadable stored value falls back to the default."""
    raw = get_shared_preference(conn, RETENTION_PREF_KEY)
    if raw is None:
        return DEFAULT_RETENTION_DAYS
    try:
        days = int(str(raw).strip().strip('"'))
    except (TypeError, ValueError):
        return DEFAULT_RETENTION_DAYS
    return max(MIN_RETENTION_DAYS, min(days, MAX_RETENTION_DAYS))


def set_retention_days(conn: sqlite3.Connection, days) -> int:
    """Store a new retention and apply it at once."""
    try:
        value = int(days)
    except (TypeError, ValueError):
        raise ValueError("That is not a number of days.")
    if value < MIN_RETENTION_DAYS or value > MAX_RETENTION_DAYS:
        raise ValueError(f"Choose between {MIN_RETENTION_DAYS} and {MAX_RETENTION_DAYS} days.")
    set_shared_preference(conn, RETENTION_PREF_KEY, str(value))
    prune(conn)
    return value


def prune(conn: sqlite3.Connection) -> None:
    """Drop rows older than the retention window, except the newest. `made_at` is naive-UTC ISO from
    `utcnow_iso` (or a backup header's `exported_at`, the same shape), so comparing as strings orders it."""
    cutoff = (datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=retention_days(conn))).isoformat()
    conn.execute(
        """
        DELETE FROM backup_history
        WHERE  made_at < ?
          AND  id <> (SELECT id FROM backup_history WHERE deleted_at IS NULL
                      ORDER BY made_at DESC, rowid DESC LIMIT 1)
        """,
        (cutoff,),
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


def rename(conn: sqlite3.Connection, backup_id: str, filename: str) -> bool:
    """Correct a row's filename to the one the file was saved under. False if there is no such row."""
    name = (filename or "").strip()
    if not name:
        raise ValueError("A filename is required.")
    if len(name) > MAX_FILENAME_LENGTH:
        raise ValueError(f"A filename can be at most {MAX_FILENAME_LENGTH} characters.")
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
