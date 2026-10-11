# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
What the running server can tell an administrator about itself, beyond its configuration.

Today that is the errors in its log file (`backend/app_log_file.py`), read by Administration -> Error log.
Admin-only, like the configuration it sits beside: a traceback can carry transaction details and the
file paths of this installation.

Reading the errors is also what clears the Tasks reminder about them: the page acknowledges the count it
was shown, for the whole install.
"""

from fastapi import APIRouter, Query, Request
from pydantic import BaseModel

from backend import app_log_file
from backend.authorization import require_admin_or_local
from backend.db.control_database import acknowledge_server_errors

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
