# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
What the running server can tell an administrator about itself, beyond its configuration.

The errors in its log file (`backend/app_log_file.py`), read by Settings -> Error log, and the state of
its two databases (`backend/services/database_health.py`), read by Settings -> Database. Admin-only, like
the configuration they sit beside: a traceback can carry transaction details and the file paths of this
installation, and repairing or compacting a database locks it for everyone while it runs.

Reading the errors is also what clears the Tasks reminder about them: the page acknowledges the count it
was shown, for the whole install.
"""

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel

from backend import app_log_file
from backend.authorization import require_admin_or_local
from backend.db.control_database import acknowledge_server_errors
from backend.db.database import compact_database
from backend.services import database_health

router = APIRouter()


class AcknowledgeErrors(BaseModel):
    through: int


@router.get("/log/errors")
def log_errors(request: Request, limit: int = Query(50, ge=1, le=500)):
    """The most recent errors recorded in the log file, newest first, each with its traceback where there
    was one, plus where the file is and how many errors it holds in all.

    `recorded` is the running count to acknowledge once these have been shown. Read before the file: an
    error is written to the file before it is counted, so everything this count includes is in what follows."""
    require_admin_or_local(request)
    counts = app_log_file.error_counts()
    return {**app_log_file.recent_errors(limit), **counts}


@router.post("/log/errors/acknowledge")
def acknowledge_log_errors(body: AcknowledgeErrors, request: Request):
    require_admin_or_local(request)
    acknowledge_server_errors(body.through)
    return app_log_file.error_counts()


@router.get("/database", dependencies=[Depends(require_admin_or_local)])
def database_state():
    """Both databases' check and what each holds."""
    return {"check": database_health.check_databases(), "usage": database_health.usage()}


@router.get("/database/check", dependencies=[Depends(require_admin_or_local)])
def database_check():
    """The check alone, which the backup screen runs before making a backup so it can say first."""
    return database_health.check_databases()


@router.post("/database/repair-indexes", dependencies=[Depends(require_admin_or_local)])
def repair_database_indexes():
    """Rebuild the indexes where they are the only problem, and answer with the check run afterwards.
    Refused when no database has a problem a rebuild repairs, which is when the screen offers none."""
    result = database_health.repair_indexes()
    if result is None:
        raise HTTPException(status_code=409, detail={
            "code": "nothing_to_repair",
            "message": "Neither database has a problem that rebuilding its indexes repairs.",
        })
    return {"check": result, "usage": database_health.usage()}


@router.post("/database/compact", dependencies=[Depends(require_admin_or_local)])
def compact_data_database():
    """Give the financial database's free pages back to the filesystem. The accounts database is small
    and rarely deletes anything, so it is not offered."""
    freed = compact_database(reason="compact from Settings")
    return {"freed_bytes": freed, "usage": database_health.usage()}
