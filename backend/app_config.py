# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Layered application configuration.

Every setting resolves through three layers, highest wins:

    hardcoded default  <  control-DB `app_setting` row  <  environment variable

The reason for the layering is that a plain install should need no `.env` file. Defaults cover the
ordinary case, and the two values that must *persist* across restarts — the session signing secret and
the cookie name — are generated once and stored in the control DB rather than written into a file. The
environment layer still wins everywhere, so an operator can force any value from `.env` or the shell.

Settings that must be known before the app exists (the bind port), before the database can be found
(the database locations), or that gate destructive tooling (developer options) are declared
`stored=False`: there is nowhere earlier than the environment to read them from, so they have no
in-app form. That is the irreducible core the optional `.env` file exists for.

The registry below is the single declaration of each setting. The resolver, the effective-configuration
report the Settings page renders, and any setting added later all read from it, so a new knob is one
entry rather than an entry plus a reader plus a display row.
"""

import hashlib
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from dotenv import dotenv_values

from backend.db import control_database, database
from backend.db.control_database import delete_app_setting, get_app_setting, set_app_setting
from backend.runtime_config import (
    DEFAULT_APP_NAME,
    DEFAULT_BACKEND_PORT,
    DEFAULT_BACKEND_READY_TIMEOUT,
    DEFAULT_DATA_DIR,
    DEFAULT_FRONTEND_DOCKER_PORT,
    DEFAULT_FRONTEND_PORT,
    env_file_path,
    generate_session_secret,
    is_placeholder_session_secret,
    truthy,
)


SOURCE_DEFAULT = "default"
SOURCE_APP_SETTING = "app_setting"
SOURCE_ENV = "env"
# A value computed from another setting rather than configured in its own right. Reported separately so
# the panel can say "this follows the data directory" instead of implying someone chose it.
SOURCE_DERIVED = "derived"


@dataclass(frozen=True)
class Setting:
    key: str
    env_var: str
    label: str
    help: str
    default: str | Callable[[], str]
    # A stored setting also has a control-DB row, seeded from the default on first resolve. Everything
    # else is default-or-environment, because it is consumed before the database is available.
    stored: bool = False
    # Never report the value itself, only whether one is set and where it came from.
    redact: bool = False
    # Rejects an environment value that means "unconfigured", so the layer below is used instead.
    sanitize: Callable[[str], str | None] | None = None
    # Reads the value actually in force from the module that owns it, for settings resolved during
    # import and then held as module state (the database locations). Re-deriving those from the
    # environment here would let the report claim a path the process is not using.
    live: Callable[[], str] | None = None
    # The setting this one follows when nothing overrides it directly. Drives both the reported source
    # and the nesting in the configuration panel, so a value computed from another is never presented as
    # an independent knob.
    derived_from: str | None = None
    # A filesystem location: the report carries the absolute form alongside the configured one, since a
    # relative value (or a bare filename) does not say which file is open.
    is_path: bool = False
    # Rarely relevant to an ordinary install, so the panel keeps it behind a disclosure. A property of
    # the setting rather than of its current value — which is what makes the grouping stable — but the
    # panel still surfaces one that is actually overridden, since an override is direct evidence that
    # this installation cares about it.
    advanced: bool = False


def _reject_placeholder_secret(value: str) -> str | None:
    return None if is_placeholder_session_secret(value) else value


def _default_session_cookie_name() -> str:
    """Derived from the control database this instance is pointed at, so two instances never share a
    cookie name in one browser — including the case the install directory cannot distinguish: one
    checkout run against two databases by swapping `.env` files. Sharing a name there is not dangerous
    (each database signs with its own secret, so the other instance's cookie simply fails verification)
    but it signs the user out on every swap.

    The parent directory names it for a human reading their cookie list; the path digest is what actually
    guarantees distinctness, since two installs can easily share a directory *name*. Only a seed — the
    resolved name is stored on first run, so moving the database later does not sign anyone out."""
    path = Path(value_of("control_db_path")).expanduser().resolve()
    label = _sanitize_cookie_label(path.parent.name) or _sanitize_cookie_label(path.stem) or "luma"
    digest = hashlib.sha256(str(path).encode("utf-8")).hexdigest()[:8]
    return f"{label}_{digest}_session"


def _sanitize_cookie_label(value: str) -> str:
    return "".join(ch.lower() if ch.isalnum() else "_" for ch in value).strip("_")


SETTINGS: tuple[Setting, ...] = (
    Setting(
        key="app_name",
        env_var="APP_NAME",
        label="Application name",
        help="Display name used in page titles, the sign-in issuer, and provider link screens.",
        default=DEFAULT_APP_NAME,
        advanced=True,
    ),
    Setting(
        key="session_secret",
        env_var="SESSION_SECRET",
        label="Session secret",
        help="Signs session cookies. Generated on first run and kept in the control database; changing it signs everyone out.",
        default=generate_session_secret,
        stored=True,
        redact=True,
        sanitize=_reject_placeholder_secret,
        advanced=True,
    ),
    Setting(
        key="session_cookie_name",
        env_var="SESSION_COOKIE_NAME",
        label="Session cookie name",
        help="Keeps browser sessions separate when several installations run on one machine. Derived from the control database path on first run, then stored.",
        default=_default_session_cookie_name,
        stored=True,
        advanced=True,
    ),
    Setting(
        key="session_cookie_secure",
        env_var="SESSION_COOKIE_SECURE",
        label="Secure session cookie",
        help="Sends the session cookie over HTTPS only. Set by a TLS-terminated install; left off for the loopback default.",
        default="false",
        advanced=True,
    ),
    Setting(
        key="cors_origins",
        env_var="CORS_ORIGINS",
        label="Allowed cross-origin callers",
        help="Other web origins whose pages may call this API from a browser with cookies. Empty by default: the SPA and the API are served on one origin (the dev server and the Docker frontend both proxy /api), so nothing needs a grant.",
        default="",
        advanced=True,
    ),
    Setting(
        key="data_dir",
        env_var="DATA_DIR",
        label="Data directory",
        help="Where both databases live. The one setting to change when moving an installation's data, or to run a second installation on the same machine.",
        default=DEFAULT_DATA_DIR,
        is_path=True,
    ),
    Setting(
        key="control_db_path",
        env_var="CONTROL_DB_PATH",
        label="Control database",
        help="Contains application data, not financial data (identities, the secrets vault, etc).",
        default=DEFAULT_DATA_DIR,
        live=lambda: control_database.CONTROL_DB_PATH,
        derived_from="data_dir",
        is_path=True,
    ),
    Setting(
        key="db_path",
        env_var="DB_PATH",
        label="Financial database",
        help="Accounts, transactions, rules, categories, preferences, import history, etc. Also contains the secrets used with data connections although not the key to decrypt them.",
        default=DEFAULT_DATA_DIR,
        live=lambda: database.DB_PATH,
        derived_from="data_dir",
        is_path=True,
    ),
    Setting(
        key="backend_port",
        env_var="BACKEND_PORT",
        label="Backend port",
        help="Port the backend listens on, and the port the frontend uses to reach it.",
        default=DEFAULT_BACKEND_PORT,
    ),
    Setting(
        key="frontend_port",
        env_var="FRONTEND_PORT",
        label="Frontend port",
        help="Port to connect to from a browser.",
        default=DEFAULT_FRONTEND_PORT,
    ),
    Setting(
        key="frontend_docker_port",
        env_var="FRONTEND_DOCKER_PORT",
        label="Frontend port (Docker)",
        help="Published frontend port when running under Docker.",
        default=DEFAULT_FRONTEND_DOCKER_PORT,
        advanced=True,
    ),
    Setting(
        key="use_log_files",
        env_var="LUMA_USE_LOG_FILES",
        label="Launcher log files",
        help="Writes backend and frontend launcher logs on each start. Read by the start scripts before the app runs.",
        default="false",
        advanced=True,
    ),
    Setting(
        key="backend_ready_timeout",
        env_var="LUMA_BACKEND_READY_TIMEOUT",
        label="Backend startup timeout",
        help="Maximum number of seconds the launcher waits for the backend health check before starting the frontend.",
        default=DEFAULT_BACKEND_READY_TIMEOUT,
        advanced=True,
    ),
    Setting(
        key="developer_options",
        env_var="LUMA_DEVELOPER_OPTIONS",
        label="Developer options",
        help="Unlocks developer tooling, including destructive reset actions. Not useful for regular use.",
        default="false",
        advanced=True,
    ),
)

_BY_KEY = {setting.key: setting for setting in SETTINGS}


def _env_file_keys() -> frozenset[str]:
    """Which keys the optional `.env` file supplied. Reporting-only: the values themselves already
    reached the process environment via `load_dotenv`, and this just lets the configuration report say
    *where* an override came from instead of an undifferentiated "environment"."""
    path = env_file_path()
    values = dotenv_values(str(path)) if path.exists() else {}
    return frozenset(key for key, value in values.items() if (value or "").strip())


def _default_value(setting: Setting) -> str:
    return setting.default() if callable(setting.default) else setting.default


def _env_value(setting: Setting) -> str | None:
    raw = os.getenv(setting.env_var)
    if raw is None:
        return None
    value = raw.strip()
    if not value:
        return None
    return setting.sanitize(value) if setting.sanitize else value


def _resolve(setting: Setting, *, seed: bool) -> tuple[str, str]:
    """The resolved value and the layer it came from. `seed` writes a stored setting's generated default
    to the control DB — resolution during startup persists, the read-only report does not."""
    env_value = _env_value(setting)
    if setting.live is not None:
        # The value is whatever the owning module resolved at import; the layers only explain where it
        # came from. Its own variable is the only thing that counts as configured — a path that simply
        # followed the directory setting reports as derived, so the panel never implies a file was named
        # deliberately when it was not.
        if env_value is not None:
            return setting.live(), SOURCE_ENV
        return setting.live(), SOURCE_DERIVED if setting.derived_from else SOURCE_DEFAULT
    if env_value is not None:
        return env_value, SOURCE_ENV

    if setting.stored:
        stored = (get_app_setting(setting.key) or "").strip()
        if stored:
            return stored, SOURCE_APP_SETTING
        value = _default_value(setting)
        if seed:
            set_app_setting(setting.key, value)
            return value, SOURCE_APP_SETTING
        return value, SOURCE_DEFAULT

    return _default_value(setting), SOURCE_DEFAULT


def value_of(key: str, *, seed: bool = True) -> str:
    return _resolve(_BY_KEY[key], seed=seed)[0]


def effective_config() -> list[dict]:
    """Every setting with its effective value and the layer that supplied it, for the Settings page.
    Read-only: nothing here creates a stored row, so opening the page cannot change configuration."""
    env_file_supplied = _env_file_keys()
    rows = []
    for setting in SETTINGS:
        value, source = _resolve(setting, seed=False)
        # The variable is named only when it is what supplied the value. Naming it otherwise would
        # advertise the per-file database overrides as ordinary settings, when they exist for the narrow
        # case of a database that is not on the default filename.
        configured_by_env = source == SOURCE_ENV
        rows.append({
            "key": setting.key,
            "label": setting.label,
            "help": setting.help,
            "env_var": setting.env_var if configured_by_env or not setting.derived_from else None,
            "source": source,
            "derived_from": setting.derived_from,
            "advanced": setting.advanced,
            "from_env_file": configured_by_env and setting.env_var in env_file_supplied,
            # Offered only where clearing the row would actually change what the next start uses; an
            # environment override outranks the stored value, so resetting under one is a no-op.
            "resettable": setting.stored and not configured_by_env,
            "redacted": setting.redact,
            "value": None if setting.redact else value,
            "absolute_value": _absolute_display(value) if setting.is_path and value else None,
            "is_set": bool(value),
        })
    return rows


def _absolute_display(value: str) -> str | None:
    """The absolute form of a configured path, or None when the configured value already is one. Shown
    beside the literal value rather than replacing it, because the literal is what appears in `.env`."""
    resolved = str(Path(value).expanduser().resolve())
    return None if resolved == value else resolved


def clear_stored_value(key: str) -> dict:
    """Drop a stored setting so its default applies again on the next start.

    The one write this surface offers, and it exists because a stored value is otherwise permanent: a
    cookie name stored under an earlier derivation would never pick up the current one, and a leaked
    session secret could not be rotated without editing the database by hand. Clearing rather than
    editing is deliberate — both of these settings derive or generate themselves, so the useful operation
    is "forget what was stored", not "type a replacement".

    Refused while the environment overrides the setting: the write would succeed and change nothing,
    because the environment layer still wins. The panel hides the action in that case for the same
    reason, and the two must agree — a client-side-only rule would let a stale page perform a write that
    silently does nothing."""
    setting = _BY_KEY.get(key)
    if setting is None:
        raise KeyError(key)
    if not setting.stored:
        raise ValueError(f"{setting.label} is not stored in the app")
    if _env_value(setting) is not None:
        raise ValueError(f"{setting.label} is set by {setting.env_var} and has to be changed there")

    delete_app_setting(setting.key)
    return {
        "key": setting.key,
        # What the next start will use, where that is knowable. A regenerated secret is random by
        # definition, so promising a value would be a lie.
        "pending_value": None if setting.redact else _default_value(setting),
        "restart_required": True,
    }


def developer_options_enabled() -> bool:
    """Whether developer options (extra reset tools, connection sync diagnostics) are available. Off by
    default, and env-only by design: it gates destructive tooling, so it is not something an in-app
    toggle should invite anyone to flip."""
    return truthy(value_of("developer_options"))


@dataclass(frozen=True)
class AppConfig:
    app_name: str
    session_secret: str
    session_cookie_name: str
    session_cookie_secure: bool
    cors_origins: tuple[str, ...]


def resolve() -> AppConfig:
    """Resolve everything the application needs at construction time. Called once, before the middleware
    stack is built — the session secret and cookie name are constructor arguments to `SessionMiddleware`,
    so they cannot be resolved lazily on the first request."""
    origins = [origin.strip() for origin in value_of("cors_origins").split(",") if origin.strip()]
    return AppConfig(
        app_name=value_of("app_name"),
        session_secret=value_of("session_secret"),
        session_cookie_name=value_of("session_cookie_name"),
        session_cookie_secure=truthy(value_of("session_cookie_secure")),
        cors_origins=tuple(dict.fromkeys(origins)),
    )
