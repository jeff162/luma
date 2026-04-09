# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: GPL-3.0-or-later

"""
Small logging shim used across the backend.

It prefers the active Uvicorn logger when available so startup and request logs
land in the same stream, but still falls back to plain stdout in contexts like
scripts or tests where the app logger stack has not been configured yet.
"""

import logging


def _resolve_logger(level: int, logger_name: str | None = None) -> tuple[logging.Logger, bool]:
    uvicorn_logger = logging.getLogger("uvicorn.error")
    if uvicorn_logger.hasHandlers() and uvicorn_logger.isEnabledFor(level):
        return uvicorn_logger, False

    logger = logging.getLogger(logger_name or "fintrack")
    if logger.hasHandlers() and logger.isEnabledFor(level):
        return logger, False

    return logger, True


def log_message(level: int, message: str, logger_name: str | None = None):
    logger, fallback_to_print = _resolve_logger(level, logger_name)
    if fallback_to_print:
        print(f"{logging.getLevelName(level)}: {message}")
        return
    logger.log(level, message)


def log_info(message: str, logger_name: str | None = None):
    log_message(logging.INFO, message, logger_name)


def log_warning(message: str, logger_name: str | None = None):
    log_message(logging.WARNING, message, logger_name)


def log_error(message: str, logger_name: str | None = None):
    log_message(logging.ERROR, message, logger_name)
