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
report Settings renders, and any setting added later all read from it, so a new knob is one
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
    CONTROL_DB_FILENAME,
    DB_FILENAME,
    DEFAULT_APP_NAME,
    DEFAULT_BACKEND_HOST,
    DEFAULT_BACKEND_PORT,
    DEFAULT_BACKEND_READY_TIMEOUT,
    DEFAULT_FRONTEND_HOST,
    DEFAULT_FRONTEND_PORT,
    anchor_relative,
    DIST_FORM_CHECKOUT,
    default_data_dir,
    distribution_form,
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
        help="Display name used in the sign-in issuer, provider link screens, and the label saved passkeys carry on the device. Set it per instance where several run on one host, so their passkey entries can be told apart.",
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
        help="Other web origins whose pages may call this API from a browser with cookies. Empty by default: the SPA and the API are served on one origin (the dev server proxies /api, and everywhere else one process serves both), so nothing needs a grant.",
        default="",
        advanced=True,
    ),
    Setting(
        key="data_dir",
        env_var="DATA_DIR",
        label="Data directory",
        help="Where the databases and the document directory live.",
        default=default_data_dir,
        is_path=True,
    ),
    Setting(
        key="control_db_path",
        env_var="CONTROL_DB_PATH",
        label="Control database",
        help="Contains application data, not financial data (settings, identities, the secrets vault, etc).",
        default=default_data_dir,
        live=lambda: control_database.CONTROL_DB_PATH,
        derived_from="data_dir",
        is_path=True,
    ),
    Setting(
        key="db_path",
        env_var="DB_PATH",
        label="Financial database",
        help="Accounts, transactions, rules, categories, preferences, import history, etc. Also contains the secrets used with data connections although not the key to decrypt them.",
        default=default_data_dir,
        live=lambda: database.DB_PATH,
        derived_from="data_dir",
        is_path=True,
    ),
    Setting(
        key="backend_port",
        env_var="BACKEND_PORT",
        label="Backend port",
        help="Port the backend listens on when the interface is served separately (running from source), which passes API requests on to it. A downloaded build does not use it, and neither does a container.",
        default=DEFAULT_BACKEND_PORT,
        # Advanced since downloads stopped reading it: only a source install has the internal hop it
        # names, and the port a person actually looks for is the frontend's.
        advanced=True,
    ),
    Setting(
        key="backend_host",
        env_var="BACKEND_HOST",
        label="Backend bind address",
        help="Address the backend listens on when run from source. This computer only by default; set to 0.0.0.0 to reach it from another device on the network, over plain HTTP. A downloaded build uses Bind address instead.",
        default=DEFAULT_BACKEND_HOST,
        advanced=True,
    ),
    Setting(
        key="frontend_port",
        env_var="FRONTEND_PORT",
        # "Port", not "Frontend port": it is the one port a person looks for, and in a downloaded build it is
        # the only one. The variable keeps its FRONTEND_ name, which pairs it with FRONTEND_HOST and would
        # break every existing .env to rename.
        label="Port",
        help="Port the browser connects to. A downloaded build serves everything on this one port, and starts on a free port instead if it is busy (in server mode it refuses to start).",
        default=DEFAULT_FRONTEND_PORT,
    ),
    Setting(
        key="frontend_host",
        env_var="FRONTEND_HOST",
        label="Bind address",
        help="Address the browser-facing server listens on: the development server when run from source, and a downloaded build in server mode. This computer only by default; set to 0.0.0.0 to reach it from another device on the network, over plain HTTP. A downloaded build outside server mode always listens to this computer only.",
        default=DEFAULT_FRONTEND_HOST,
    ),
    Setting(
        key="server_mode",
        env_var="SERVER_MODE",
        label="Server mode",
        help="Runs a downloaded build as a server for other devices to reach, behind a reverse proxy on the same machine or directly: no browser is opened, the port is fixed, and the in-app shutdown is not offered. The --server and --no-server options override it.",
        default="false",
        advanced=True,
    ),
    Setting(
        key="mdns_name",
        env_var="MDNS_NAME",
        label="Network name",
        help="The name a server-mode installation answers to on the local network, without the .local ending. Set it per installation where two share a network: a name already in use refuses the start. A reverse proxy in front has to use this name as its site address.",
        # Fixed rather than following `APP_NAME`: the proxy's certificate is issued for this name, so
        # it must not move because a display name was set for some other reason.
        default=DEFAULT_APP_NAME.lower(),
        advanced=True,
    ),
    Setting(
        key="use_log_files",
        env_var="LUMA_USE_LOG_FILES",
        label="Launcher log files",
        help="Saves the start scripts' backend and frontend terminal output beside the scripts, overwritten on each start. Read by the start scripts before the app runs. The server's own luma.log, beside the data, is written either way.",
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
        key="watch_folder_roots",
        env_var="WATCH_FOLDER_ROOTS",
        label="Watched folder roots",
        help="Folders a data source may watch, with everything inside them, in addition to the imports folder beside the data, which is always allowed; several are separated by the system's path separator (: on Linux and macOS, ; on Windows). An installation other devices can reach watches only the imports folder until this is set. One only this computer can open may watch any folder unless this is set, in which case it is confined the same way.",
        default="",
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
    beside the literal value rather than replacing it, because the literal is what appears in `.env`.

    Resolved through `anchor_relative` rather than against the working directory, or a packaged build
    would report a path it is not using: a relative setting means "beside the executable" once frozen,
    while the working directory of something launched from a file manager is the user's home or `/`.
    The whole point of showing this row is that the location stays visible rather than inferred."""
    resolved = str(anchor_relative(Path(value).expanduser()).resolve())
    return None if resolved == value else resolved



def _home_relative(path: Path) -> str:
    """A `~`-prefixed form when the path sits inside the user's home, the path itself otherwise.

    For display only, and always carried alongside the absolute form: the point of showing a location is
    that it can be read at a glance in a narrow column, and the home prefix is the longest part of it
    that never distinguishes one installation from another."""
    try:
        return str(Path("~") / path.relative_to(Path.home()))
    except (OSError, RuntimeError, ValueError):
        # No home to speak of, or the path is elsewhere — either way the absolute form is the answer.
        return str(path)


def data_location() -> dict:
    """Which databases this copy is open on, and whether that is worth saying without being asked.

    The paths are read from the modules that own them rather than re-resolved here, for the same reason
    the configuration report's `live` hook exists: a re-derivation can name a file the process is not
    actually using. They are resolved to absolute form because a checkout's default is a *relative*
    path (`DEFAULT_DATA_DIR`), and "luma-data.db" answers nothing.

    `show_by_default` is the answer to "would this installation want to say where its data is, unasked".
    Three ways to qualify, any one of which is enough:

    - **The databases are not where a fresh copy of this build would put them.** Someone moved them, or
      is running a second installation, or is on per-file overrides — all cases where which database is
      open is a live question rather than a given.
    - **This copy is a checkout.** A working copy is a development context by definition, and the
      question it answers there — repository database or real data — is the one asked most often. Tying
      this to `developer_options` instead would miss it: that flag gates destructive reset tooling, so
      plenty of people working on the app never turn it on.
    - **Developer options are on**, which keeps the line in step with the version badge beside it and
      lets a packaged installation at its default location opt in.

    It is a *default*, not a rule: the user preference behind the nav line overrides it in both
    directions, and an untouched preference follows this — so setting `DATA_DIR` later makes the line
    appear on its own.
    """
    db_path = Path(database.DB_PATH).resolve()
    control_db_path = Path(control_database.CONTROL_DB_PATH).resolve()
    default_dir = anchor_relative(Path(default_data_dir()))
    stock_location = (
        db_path == (default_dir / DB_FILENAME).resolve()
        and control_db_path == (default_dir / CONTROL_DB_FILENAME).resolve()
    )
    return {
        "db_path": str(db_path),
        "db_display_path": _home_relative(db_path),
        "control_db_path": str(control_db_path),
        "control_db_display_path": _home_relative(control_db_path),
        # The name this server goes by, which is not necessarily the one on screen: the interface's is
        # fixed when it is built. It rides here because it answers the same question the paths do —
        # which copy is this — and is the only thing telling two copies' saved passkeys apart.
        "app_name": value_of("app_name"),
        "show_by_default": (
            not stock_location
            or distribution_form() == DIST_FORM_CHECKOUT
            or developer_options_enabled()
        ),
    }


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


def server_mode_enabled() -> bool:
    """Whether the launcher runs as a server rather than a desktop application, before its command line
    has had a say. Env-only because it is read before the server exists, and it is a property of how the
    process is started — not the topology, which stays a per-request fact (`backend/transport.py`)."""
    return truthy(value_of("server_mode"))


def watch_folder_roots() -> list[str]:
    """The folders named for watching beyond the imports folder, as configured; empty when none are. Env-only, because a
    folder outside the data directory is the server's filesystem, which only someone with a shell on the
    machine should decide the app may read (`docs/security-model.md` → *Reading and deleting outside the
    data directory*)."""
    return [part.strip() for part in value_of("watch_folder_roots").split(os.pathsep) if part.strip()]


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
