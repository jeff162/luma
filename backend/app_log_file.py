# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
The server's own log file, beside the data database, in every kind of install.

Where a process's output goes depends on how it was started: a terminal (the portable builds, the dev
server), the system journal (a systemd service), `docker logs` (the container), or `luma-desktop.log` (the
macOS app started from Finder). Only some of those outlive the moment, so a failure that surfaced in a
terminal since closed or scrolled past cannot be diagnosed afterwards. When a Rule checkup fix was once
found half done, nothing had been kept that could say how it got that way.

So the server also writes its log records to `luma.log` beside the data database. **A copy, not a
redirect:** a handler added next to the ones uvicorn configured, so the terminal, the journal and
`docker logs` keep receiving everything they did. Replacing the streams, as the macOS launcher does where
nothing can see them (`desktop.py`), would take the output away from the supervisors that already keep it.

**What is kept:** warnings and errors from anywhere, a crashed request's traceback included (uvicorn logs
those to `uvicorn.error`); a line when the server starts, so a reader can tell one run from the next; and
access lines only for requests that failed. Successful requests stay out, or routine polling would soon
rotate a failure out of the file. It rotates at `LOG_MAX_BYTES` and keeps one previous file, so a
persistent failure cannot fill a disk and an older one is still readable.

**What anyone can cause stays out**, for the same reason: on a networked install, a client that has not
signed in could otherwise flood the file and rotate genuine failures away. That is a 401 or a 404, and
uvicorn's warnings about malformed traffic. None of them is a fault in the application, and a failure worth
diagnosing arrives with a traceback of its own.

**Read back capped.** `recent_errors` cuts each message and traceback it returns, and says so, so one
enormous record cannot make the Settings view slow. The file itself keeps the full text.

**What it cannot hold** is anything before the application starts — a missing dependency, a crash during
import. That stays in the process's output alone.

A traceback can carry transaction details and file paths. The file sits beside a database holding the
same, so it adds no new kind of exposure, but the Settings view of it is admin-only for that reason.
"""

from __future__ import annotations

import logging
import re
import time
from logging.handlers import RotatingFileHandler
from pathlib import Path

from backend import runtime_config
from backend.db import database

LOG_FILENAME = "luma.log"
LOG_MAX_BYTES = 1024 * 1024
LOG_BACKUP_COUNT = 1

_MARKER_LOGGER = "luma.log_file"
_ACCESS_LOGGER = "uvicorn.access"
# uvicorn's access line is `'%s - "%s %s HTTP/%s" %d'`, so the status is the fifth format argument.
_ACCESS_STATUS_INDEX = 4
# Failures a client can produce without signing in: the session check refuses with 401, and any path at all
# can be a 404.
_OPEN_TO_ANYONE = frozenset({401, 404})
# What uvicorn warns when a client sends traffic it cannot serve, compared against the record's format
# string (`protocols/http/*_impl.py`). Also reachable without signing in.
_CLIENT_TRAFFIC_WARNINGS = frozenset({"Invalid HTTP request received.", "Unsupported upgrade request."})

MESSAGE_LIMIT = 2_000
DETAIL_LIMIT = 20_000
# The loggers uvicorn configures. Where its logging config is in force, "uvicorn" and "uvicorn.access" stop
# propagating, so a handler on the root alone would never see them.
_SERVER_LOGGERS = ("uvicorn", "uvicorn.error", "uvicorn.access")

_ENTRY_PATTERN = re.compile(
    r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z) (DEBUG|INFO|WARNING|ERROR|CRITICAL) (\S+): (.*)$"
)
_ERROR_LEVELS = frozenset({"ERROR", "CRITICAL"})

_handler: RotatingFileHandler | None = None
_attached: list[logging.Logger] = []


class _UtcFormatter(logging.Formatter):
    # UTC with an explicit `Z`, so an entry read back by a browser in another zone means one moment.
    converter = time.gmtime


class _WorthKeeping(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        if record.name == _MARKER_LOGGER:
            return True
        if record.name == _ACCESS_LOGGER:
            status = _access_status(record)
            return status >= 400 and status not in _OPEN_TO_ANYONE
        if record.name == "uvicorn.error" and record.msg in _CLIENT_TRAFFIC_WARNINGS:
            return False
        return record.levelno >= logging.WARNING


def _access_status(record: logging.LogRecord) -> int:
    args = record.args if isinstance(record.args, tuple) else ()
    try:
        return int(args[_ACCESS_STATUS_INDEX])
    except (IndexError, TypeError, ValueError):
        return 0


def log_path() -> Path:
    """Beside the data database: `DATA_DIR` places the two together, and a per-file `DB_PATH` override
    moves the log with the database rather than leaving it behind."""
    if _handler is not None:
        return Path(_handler.baseFilename)
    return Path(database.DB_PATH).resolve().parent / LOG_FILENAME


def _reaches(logger: logging.Logger, attached: list[logging.Logger]) -> bool:
    """Whether a record logged here already arrives at a logger in `attached` by propagation. Attaching the
    handler there as well would write every such line twice."""
    current: logging.Logger | None = logger
    while current is not None:
        if current in attached:
            return True
        if not current.propagate:
            return False
        current = current.parent
    return False


def install() -> Path | None:
    """Start copying log records to the file, returning where, or None if it could not be opened, in which
    case the server runs exactly as it would have without it.

    Replaces any earlier installation rather than adding to it: the test suite runs the application's
    startup once per client, and a second handler would double every line."""
    global _handler, _attached
    uninstall()
    path = log_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        handler = RotatingFileHandler(
            path, maxBytes=LOG_MAX_BYTES, backupCount=LOG_BACKUP_COUNT, encoding="utf-8",
        )
    except OSError:
        return None
    handler.setFormatter(_UtcFormatter("%(asctime)sZ %(levelname)s %(name)s: %(message)s", "%Y-%m-%dT%H:%M:%S"))
    handler.addFilter(_WorthKeeping())

    attached: list[logging.Logger] = []
    for logger in (logging.getLogger(), *(logging.getLogger(name) for name in _SERVER_LOGGERS)):
        if not _reaches(logger, attached):
            logger.addHandler(handler)
            attached.append(logger)
    _handler, _attached = handler, attached

    marker = logging.getLogger(_MARKER_LOGGER)
    marker.setLevel(logging.INFO)
    marker.info("--- %s %s started ---", runtime_config.app_name(), runtime_config.APP_VERSION)
    return path


def uninstall() -> None:
    global _handler, _attached
    if _handler is None:
        return
    for logger in _attached:
        logger.removeHandler(_handler)
    _handler.close()
    _handler, _attached = None, []


def parse_entries(text: str) -> list[dict]:
    """The file's records, in file order. A line that does not open a record continues the one before it,
    which is how a traceback arrives. Lines before the first record are the tail of one rotated away
    part-way through, with nothing left to attach them to."""
    entries: list[dict] = []
    for line in text.splitlines():
        match = _ENTRY_PATTERN.match(line)
        if match:
            stamp, level, name, message = match.groups()
            entries.append({"time": stamp, "level": level, "logger": name, "message": message, "detail": []})
        elif entries:
            entries[-1]["detail"].append(line)
    for entry in entries:
        entry["detail"] = "\n".join(entry["detail"]).strip("\n")
    return entries


def recent_errors(limit: int = 50) -> dict:
    """The errors in the current and previous file, newest first. Warnings stay in the file and out of this
    list: they are things the server coped with, and mixed in they would bury what someone came to find."""
    path = log_path()
    rotated = [Path(f"{path}.{index}") for index in range(LOG_BACKUP_COUNT, 0, -1)]
    files = [file for file in (*rotated, path) if file.is_file()]
    entries: list[dict] = []
    for file in files:
        try:
            entries.extend(parse_entries(file.read_text(encoding="utf-8", errors="replace")))
        except OSError:
            continue
    errors = [entry for entry in entries if entry["level"] in _ERROR_LEVELS]
    errors.reverse()
    return {
        "path": str(path),
        "present": bool(files),
        "total": len(errors),
        "entries": [_clipped(entry) for entry in errors[:limit]],
    }


def _clipped(entry: dict) -> dict:
    message, detail = entry["message"], entry["detail"]
    return {
        **entry,
        "message": message[:MESSAGE_LIMIT],
        "detail": detail[:DETAIL_LIMIT],
        "truncated": len(message) > MESSAGE_LIMIT or len(detail) > DETAIL_LIMIT,
    }
