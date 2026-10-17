# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
The marker that carries a restore across the gap between its ledger and its files.

A restore commits the ledger atomically and then writes attached documents, which are not
transactional. This records where in that sequence it got to, so an interruption is a state the app can
describe and finish rather than a silent inconsistency.

**A phase, not a flag**, because the two possible values mean opposite things about the data:

- ``staging`` — the restore has not committed. *Nothing was changed*, so finding this after an unclean
  shutdown means the attempt can be reported and the row cleared.
- ``documents_pending`` — the ledger is live and its files are not all there yet, so the documents phase
  has work outstanding and the app should say so instead of serving broken links.

**Why the data DB and not the control DB.** The instinct is the control DB, on the precedent of state
that must survive a data restore. But the requirement here is stronger than survival: the marker must be
*atomic with the committed ledger*. Written inside the restore transaction, it exists exactly when the
ledger it describes exists — a crash before commit leaves neither, a commit leaves both. A control-DB row
could land without the ledger, or the ledger without it.

**Why its own table and not a key in ``import_workflow_state``.** The restore *wipes* that table, so a
marker living there would sit inside the blast radius of the very operation it tracks. Being outside the
wipe list also keeps it out of the backup payload for free: this is machine-local operational state and
must never travel to another install.

This module holds only the state itself and the gate that reads it. The restore logic that writes it
lives in ``routers/import_export/backup.py``; keeping the accessors here is what lets the import and
sync paths consult the gate without importing the backup router.
"""

from __future__ import annotations

import sqlite3
from typing import Optional

from fastapi import HTTPException

from backend.time_utils import utcnow_iso

RESTORE_PHASE_STAGING = "staging"
RESTORE_PHASE_DOCUMENTS = "documents_pending"


def get_restore_state(conn: sqlite3.Connection) -> Optional[dict]:
    row = conn.execute(
        "SELECT phase, started_at, artifact_path, artifact_id FROM restore_state WHERE id = 1"
    ).fetchone()
    return dict(row) if row else None


def set_restore_state(conn: sqlite3.Connection, phase: str,
                      artifact_path: Optional[str], artifact_id: Optional[str]) -> None:
    conn.execute(
        "INSERT OR REPLACE INTO restore_state (id, phase, started_at, artifact_path, artifact_id) "
        "VALUES (1, ?, ?, ?, ?)",
        (phase, utcnow_iso(), artifact_path, artifact_id),
    )


def clear_restore_state(conn: sqlite3.Connection) -> None:
    conn.execute("DELETE FROM restore_state WHERE id = 1")


def require_no_pending_restore(conn: sqlite3.Connection, action: str) -> None:
    """Refuse an operation while a restore still owes its document files.

    The same gate the demo-data marker applies, for a related reason: between the ledger commit and the
    last file written, the ledger is correct but incomplete on disk, and anything that *adds* data in
    that window — an import, a sync, an attached document, a second restore — either races the file
    writes or is erased by the sweep that ends the phase, which reconciles the directory against the
    ledger as it then stands.
    Refusing is honest; the alternative is losing whatever arrived during the gap.
    """
    state = get_restore_state(conn)
    if state and state["phase"] == RESTORE_PHASE_DOCUMENTS:
        raise HTTPException(status_code=409, detail={
            "code": "restore_documents_pending",
            "message": f"A restore is still writing its attached documents. Finish that before {action}.",
        })
