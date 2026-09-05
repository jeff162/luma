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
import sys
from pathlib import Path


DEFAULT_APP_NAME = "Luma"

# The version the running application reports, and the one the packaged artifact is named for. Stated
# here rather than in either packaging manifest because this module is the one place both can reach: it
# is imported before anything else in the backend, and it is inside the frozen bundle, where
# `frontend/package.json` and `pyproject.toml` are not.
#
# Those two manifests still carry their own copy — npm and Python packaging each read theirs before any
# code runs, so neither can derive it — and `backend/tests/test_app_version.py` fails if the three ever
# disagree. That check is the whole mechanism: a version bump touches three files on purpose, and
# missing one is a failing test rather than a release named differently from what it reports.
APP_VERSION = "0.4.0"

# Built-in defaults, stated once. The database modules resolve their own location at import time (before
# anything else runs, so they cannot wait for the resolver), and `app_config`'s registry reads the same
# constants — so the default a running instance uses and the default its configuration report claims can
# never drift apart. The database *filenames* are fixed rather than configurable: the location is what
# distinguishes one installation's data from another's.
# Beside the executable in a packaged build, the working directory in a checkout. An *installed* build
# replaces it with the per-OS user-data directory instead — `default_data_dir()` is what chooses between
# the two, and is what the configuration report shows as the built-in default.
DEFAULT_DATA_DIR = "."
CONTROL_DB_FILENAME = "luma-control.db"
DB_FILENAME = "luma-data.db"
DEFAULT_BACKEND_PORT = "8000"
DEFAULT_FRONTEND_PORT = "5173"
# Loopback, so the dev server is not on the LAN unless someone asks for it. `localhost` rather than
# `127.0.0.1` because the browser's origin becomes the WebAuthn Relying Party id, and an address is not
# a domain — binding the numeric form would silently disable passkey vault slots in development.
DEFAULT_FRONTEND_HOST = "localhost"
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
    return anchor_relative(Path(os.getenv("DATA_DIR") or default_data_dir()))


def resolve_db_path() -> str:
    explicit = (os.getenv("DB_PATH") or "").strip()
    return str(anchor_relative(Path(explicit))) if explicit else str(data_dir() / DB_FILENAME)


def resolve_control_db_path() -> str:
    explicit = (os.getenv("CONTROL_DB_PATH") or "").strip()
    return str(anchor_relative(Path(explicit))) if explicit else str(data_dir() / CONTROL_DB_FILENAME)


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


def is_frozen() -> bool:
    """Whether this is a packaged build rather than a checkout. PyInstaller sets `sys.frozen`."""
    return bool(getattr(sys, "frozen", False))


def bundle_root() -> Path:
    """Where read-only resources shipped *inside* the application live — the built frontend, above all.

    A checkout and a packaged build put these in different places, which is the whole reason two roots
    exist where one used to. A onefile build unpacks itself to a temporary directory and hands its path
    over as `sys._MEIPASS`; that directory is deleted on exit, so it is the right answer for resources
    and the wrong one for anything that has to survive the process."""
    if is_frozen():
        meipass = getattr(sys, "_MEIPASS", None)
        return Path(meipass) if meipass else Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent.parent


def bundled_license_path() -> Path | None:
    """The license text shipped *with* this copy of the application, if there is one.

    Present in a checkout (the repository's own LICENSE) and in a packaged build (the spec places it at
    the bundle root). Absent is a real answer rather than an error: a build assembled some other way
    still runs, and the UI simply keeps pointing at the published copy, which is the authoritative one
    regardless — a local file travels with a binary that may have been modified.
    """
    candidate = bundle_root() / "LICENSE"
    return candidate if candidate.is_file() else None


def install_root() -> Path:
    """Where the application *sits* — the directory a portable copy keeps its data and its `.env` beside.

    Distinct from `bundle_root` only in a packaged build, which is why nothing needed the distinction
    before one existed."""
    if is_frozen():
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent.parent


def anchor_relative(path: Path) -> Path:
    """Resolve a configured relative path against the application rather than the working directory —
    but only in a packaged build.

    A relative `DATA_DIR` has always meant "relative to where the app was started from", which is fine
    when it is started from a checkout and useless for something double-clicked from a file manager: the
    working directory is then the user's home, or `/`, or wherever the shortcut pointed. Anchoring it to
    the executable is what makes a portable copy — binary and databases in one folder — behave like one
    thing regardless of where it is launched from.

    Deliberately **not** applied to a checkout. Doing so would silently relocate the databases of every
    existing install that runs with a relative `DATA_DIR`, which is exactly the presentation of total
    data loss the per-file overrides exist to prevent."""
    if is_frozen() and not path.is_absolute():
        return install_root() / path
    return path


# How a copy was distributed, which is what decides where writable data defaults to. `checkout` is a
# working copy; the other two are what a build declares about itself.
DIST_FORM_CHECKOUT = "checkout"
DIST_FORM_PORTABLE = "portable"
DIST_FORM_INSTALLED = "installed"
# Only the two a build can declare — a checkout is recognized rather than declared.
DECLARABLE_DIST_FORMS = frozenset({DIST_FORM_PORTABLE, DIST_FORM_INSTALLED})
# Sits at the root of the bundle holding one of those two words, written at build time by
# `scripts/luma.spec`. A bundled file rather than a generated module: the signal then travels inside the
# artifact, and a build cannot leave one behind in a checkout to change how a developer's copy resolves.
DIST_FORM_FILENAME = "distribution-form"

# The directory name an installed build keeps its data under, per-OS convention. Fixed literals rather
# than `app_name()`, which exists for white-labelling and is settable by environment variable: a display
# setting that silently relocated the databases would present as total data loss.
USER_DATA_DIR_NAME = "Luma"
USER_DATA_DIR_NAME_XDG = "luma"


def distribution_form() -> str:
    """Which of the three forms this copy is, which is what decides where writable data defaults to —
    not the operating system, and not anything the user configures.

    A build declares itself by carrying `DIST_FORM_FILENAME` in its bundle. It has to be declared rather
    than detected because the two forms are otherwise the same binary: nothing observable at runtime
    distinguishes a copy that was unzipped from one that was installed.

    An unreadable or unrecognized declaration falls back to the form that platform can actually support,
    which is not the same answer everywhere. On macOS the two are not interchangeable — "beside the
    executable" resolves inside `Luma.app/Contents/MacOS`, where writing invalidates a signature and
    where App Translocation may have mounted the bundle read-only at a path that disappears. Guessing
    portable there would lose data, so the guess follows the platform rather than being a fixed
    default."""
    if not is_frozen():
        return DIST_FORM_CHECKOUT
    try:
        declared = (bundle_root() / DIST_FORM_FILENAME).read_text(encoding="utf-8").strip()
    except OSError:
        declared = ""
    if declared in DECLARABLE_DIST_FORMS:
        return declared
    return DIST_FORM_INSTALLED if sys.platform == "darwin" else DIST_FORM_PORTABLE


def user_data_dir() -> Path:
    """Where an installed build keeps its data: the per-OS convention for a user's application data.

    Written out rather than delegated to `platformdirs`, which would put a runtime dependency inside
    every bundle to decide three branches whose semantics are worth stating here anyway. Each branch
    honors the environment variable the platform defines for relocating it, since a user who has moved
    their profile has already answered this question once.

    Only consulted for the installed form. A portable copy keeps its data beside the executable and a
    checkout uses the working directory, so neither reaches here."""
    if sys.platform == "win32":
        # Local, not roaming. A roaming profile is synchronised at logon and logoff, usually over SMB,
        # and a SQLite database is the worst possible passenger: open during a sync, or diverged across
        # two machines, it resolves last-writer-wins on a binary file — silent loss rather than a
        # conflict anyone sees. Windows' own guidance keeps databases out of roaming for that reason,
        # and the ledger would drag its backups through every logon of every machine besides.
        local = os.getenv("LOCALAPPDATA")
        base = Path(local) if local else Path.home() / "AppData" / "Local"
        return base / USER_DATA_DIR_NAME
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / USER_DATA_DIR_NAME
    # The XDG spec requires an absolute path and says to ignore the variable otherwise, which matters
    # here because a relative one would land the databases wherever the app happened to be started from.
    xdg = os.getenv("XDG_DATA_HOME")
    base = Path(xdg) if xdg and Path(xdg).is_absolute() else Path.home() / ".local" / "share"
    return base / USER_DATA_DIR_NAME_XDG


def default_data_dir() -> str:
    """The built-in `DATA_DIR` default for this copy — the layer everything else overrides.

    Returned as a string because it is a configuration value: `app_config` reports it as the default,
    and the environment layer that outranks it supplies strings too."""
    if distribution_form() == DIST_FORM_INSTALLED:
        return str(user_data_dir())
    return DEFAULT_DATA_DIR


def env_file_path() -> Path:
    """The optional override file. `LUMA_ENV_FILE` redirects it — the Playwright E2E harness points it at
    an isolated file so its throwaway database paths take effect without touching the real one.

    Anchored to `install_root`, not `bundle_root`: a portable copy ships its `.env` beside the binary,
    where the user can read and edit it. Inside the bundle it would be neither.

    An installed build has no such place — on macOS the install root is inside the `.app`, which an
    upgrade replaces wholesale — so its `.env` lives in the user-data directory instead. Deliberately
    `user_data_dir()` rather than `data_dir()`: this file is one of the things that may *set* `DATA_DIR`,
    so looking for it at the configured location would make it unreachable in the one case it is for."""
    override = os.getenv("LUMA_ENV_FILE")
    if override:
        return Path(override)
    if distribution_form() == DIST_FORM_INSTALLED:
        return user_data_dir() / ".env"
    return install_root() / ".env"


def generate_session_secret() -> str:
    return secrets.token_urlsafe(48)


def is_placeholder_session_secret(value: str | None) -> bool:
    return (value or "").strip() in PLACEHOLDER_SESSION_SECRETS
