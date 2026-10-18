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
whose only backup had aged out would read as "no backup was ever made".
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
          AND  id <> (SELECT id FROM backup_history ORDER BY made_at DESC, rowid DESC LIMIT 1)
        """,
        (cutoff,),
    )


def record(conn: sqlite3.Connection, **fields) -> None:
    """Add a row, inside the caller's transaction. `key_labels` is a list; every other field is stored
    as given, and `made_at` defaults to now."""
    unknown = set(fields) - set(_COLUMNS)
    if unknown:
        raise ValueError(f"unknown backup history fields: {sorted(unknown)}")
    row = {column: fields.get(column) for column in _COLUMNS}
    row["made_at"] = row["made_at"] or utcnow_iso()
    if row["key_labels"] is not None:
        row["key_labels"] = json.dumps(list(row["key_labels"]))
    conn.execute(
        f"INSERT INTO backup_history (id, {', '.join(_COLUMNS)}) VALUES (?, {', '.join('?' for _ in _COLUMNS)})",
        (str(uuid.uuid4()), *(row[column] for column in _COLUMNS)),
    )
    prune(conn)


def list_rows(conn: sqlite3.Connection) -> list[dict]:
    """Every row, newest first."""
    rows = []
    for r in conn.execute("SELECT * FROM backup_history ORDER BY made_at DESC, rowid DESC"):
        row = dict(r)
        try:
            row["key_labels"] = json.loads(row["key_labels"]) if row["key_labels"] else []
        except (TypeError, ValueError):
            row["key_labels"] = []
        for flag in ("encrypted", "credentials_included"):
            row[flag] = None if row[flag] is None else bool(row[flag])
        rows.append(row)
    return rows
