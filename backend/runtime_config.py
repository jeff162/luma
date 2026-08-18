# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Environment-layer primitives for application configuration.

The environment is the outermost of three configuration layers — the layered resolver itself lives in
`app_config.py` (hardcoded default < control-DB `app_setting` row < environment variable). This module
carries only the pieces that layer needs *before* a database is reachable: value coercion, the built-in
defaults, secret generation, and where the optional `.env` file is. Keeping them here rather than in the
resolver is what lets `db/` import them without a cycle back through the control database.

Nothing here writes `.env`. The file is an optional override; an install that has none is the normal
case, and the values that must persist across restarts are stored in the control DB instead.
"""

import os
import secrets
from pathlib import Path


DEFAULT_APP_NAME = "Luma"

# Built-in defaults, stated once. The database modules resolve their own location at import time (before
# anything else runs, so they cannot wait for the resolver), and `app_config`'s registry reads the same
# constants — so the default a running instance uses and the default its configuration report claims can
# never drift apart. The database *filenames* are fixed rather than configurable: the location is what
# distinguishes one installation's data from another's.
DEFAULT_DATA_DIR = "."
CONTROL_DB_FILENAME = "luma-control.db"
DB_FILENAME = "luma-data.db"
DEFAULT_BACKEND_PORT = "8000"
DEFAULT_FRONTEND_PORT = "5173"
DEFAULT_FRONTEND_DOCKER_PORT = "3000"
DEFAULT_BACKEND_READY_TIMEOUT = "180"

# Session secrets that mean "no secret". Two were shipped as placeholders in earlier `.env` templates
# and one was the old in-code fallback; an install still carrying any of them is treated as unconfigured
# so a real secret gets generated, rather than signing cookies with a value that is public knowledge.
PLACEHOLDER_SESSION_SECRETS = frozenset({
    "dev-session-secret-change-me",
    "change_me_to_a_long_random_value",
})


def data_dir() -> Path:
    """Directory holding both databases, under fixed filenames. One setting rather than a path per file:
    the databases always travel together, so a second installation wants a second directory, not two
    renamed files.

    `DB_PATH` / `CONTROL_DB_PATH` stay honored and still win for their own file, because fixing the
    filenames makes a database that does *not* use the default name reachable only that way — including
    an install carrying databases named before a rename. Dropping the per-file overrides would not
    inconvenience such an install; it would silently create empty databases beside data that still
    exists, which reads as total data loss. That is why this fallback is not a deprecation to clean up
    later."""
    return Path(os.getenv("DATA_DIR") or DEFAULT_DATA_DIR)


def resolve_db_path() -> str:
    explicit = (os.getenv("DB_PATH") or "").strip()
    return str(Path(explicit)) if explicit else str(data_dir() / DB_FILENAME)


def resolve_control_db_path() -> str:
    explicit = (os.getenv("CONTROL_DB_PATH") or "").strip()
    return str(Path(explicit)) if explicit else str(data_dir() / CONTROL_DB_FILENAME)


def app_name() -> str:
    """Display name for the application, surfaced in user-facing backend strings (the API title, the
    provider link client name, the sign-in issuer). Overridable by env for white-labelling; mirrors the
    frontend's build-time VITE_APP_NAME so the two stay in step.

    Read at call time rather than captured at import: this module is imported during bootstrap to locate
    the optional `.env` file, which is necessarily *before* that file has been loaded."""
    return (os.getenv("APP_NAME") or DEFAULT_APP_NAME).strip() or DEFAULT_APP_NAME


def truthy(value: str | None, default: bool = False) -> bool:
    normalized = (value or "").strip().lower()
    if not normalized:
        return default
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    return default


def project_root() -> Path:
    return Path(__file__).resolve().parent.parent


def env_file_path() -> Path:
    """The optional override file. `LUMA_ENV_FILE` redirects it — the Playwright E2E harness points it at
    an isolated file so its throwaway database paths take effect without touching the real one."""
    override = os.getenv("LUMA_ENV_FILE")
    return Path(override) if override else project_root() / ".env"


def generate_session_secret() -> str:
    return secrets.token_urlsafe(48)


def is_placeholder_session_secret(value: str | None) -> bool:
    return (value or "").strip() in PLACEHOLDER_SESSION_SECRETS
