# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
What the running server can tell an administrator about itself, beyond its configuration.

Today that is the errors in its log file (`backend/app_log_file.py`), read by Settings -> Error log.
Admin-only, like the configuration it sits beside: a traceback can carry transaction details and the
file paths of this installation.
"""

from fastapi import APIRouter, Query, Request

from backend import app_log_file
from backend.authorization import require_admin_or_local

router = APIRouter()


@router.get("/log/errors")
def log_errors(request: Request, limit: int = Query(50, ge=1, le=500)):
    """The most recent errors recorded in the log file, newest first, each with its traceback where there
    was one, plus where the file is and how many errors it holds in all."""
    require_admin_or_local(request)
    return app_log_file.recent_errors(limit)
