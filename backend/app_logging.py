# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Small logging shim used across the backend.

It prefers the active Uvicorn logger when available so startup and request logs
land in the same stream, but still falls back to plain stdout in contexts like
scripts or tests where the app logger stack has not been configured yet.

The level is a statement about who needs to know. `log_error` is a failure someone should look at — a step
that failed after the work around it succeeded is the usual case — and it reaches Settings -> Error log and
the Tasks reminder for administrators (`app_log_file.py`). `log_warning` is something the server coped
with, or that is already reported where a user will see it; it stays in the file. An info line stays out of
the file unless it is logged with `keep_in_file` — for work the server undertakes on its own that a reader
diagnosing a stall would need to line up against it, such as compacting the database.
"""

import logging
import sys
import traceback

# The record attribute `app_log_file` reads to keep a line below WARNING.
KEEP_IN_FILE_ATTR = "keep_in_file"


def _resolve_logger(level: int, logger_name: str | None = None) -> tuple[logging.Logger, bool]:
    uvicorn_logger = logging.getLogger("uvicorn.error")
    if uvicorn_logger.hasHandlers() and uvicorn_logger.isEnabledFor(level):
        return uvicorn_logger, False

    logger = logging.getLogger(logger_name or "luma")
    if logger.hasHandlers() and logger.isEnabledFor(level):
        return logger, False

    return logger, True


def log_message(level: int, message: str, logger_name: str | None = None,
                exc_info: BaseException | None = None, *, keep_in_file: bool = False):
    logger, fallback_to_print = _resolve_logger(level, logger_name)
    if fallback_to_print:
        print(f"{logging.getLevelName(level)}: {message}")
        if exc_info is not None:
            traceback.print_exception(exc_info, file=sys.stdout)
        return
    logger.log(level, message, exc_info=exc_info, extra={KEEP_IN_FILE_ATTR: True} if keep_in_file else None)


def log_info(message: str, logger_name: str | None = None, *, keep_in_file: bool = False):
    log_message(logging.INFO, message, logger_name, keep_in_file=keep_in_file)


def log_warning(message: str, logger_name: str | None = None):
    log_message(logging.WARNING, message, logger_name)


def log_error(message: str, logger_name: str | None = None, exc_info: BaseException | None = None):
    """Pass the caught exception as `exc_info` wherever there is one: its traceback is what the Error log
    shows, and the message alone rarely says where the failure was."""
    log_message(logging.ERROR, message, logger_name, exc_info)
