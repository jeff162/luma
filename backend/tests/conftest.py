"""Per-session schema template so tests stop paying to rebuild the schema.

Every test builds its own throwaway database for isolation, and a from-scratch build costs ~140ms:
the baseline schema script plus a walk of every migration up to CURRENT_VERSION. Across the suite
that was ~90% of total runtime, and it gets worse with each migration added — the cost is per test,
so it scales with test count rather than with what any test actually exercises.

The schema a fresh build produces is identical every time, so it is built once per session into a
template file and copied per test (~0.2ms, a ~700x reduction). A copied file is byte-identical to a
freshly built one, so tests still get a private, fully isolated database; only the construction is
shared. Isolation is what makes the copy safe to do and is deliberately not traded away here.

The fast path stands in for `init_db`/`init_control_db` themselves rather than being a fixture tests
opt into, because 45+ test modules bind `init_db` by direct `from ... import`. Patching at conftest
import time — which pytest does before importing any test module — means those bindings resolve to
the fast version with no call-site changes.

Only a *fresh* build is served from the template. An existing database being re-opened, or a call
against the default path, delegates to the real builder, so re-init semantics and anything that
depends on the genuine migration walk are untouched. The migration tests build their databases by
hand (raw connection + `run_migrations`) and never route through here at all.

**Second concern, same file for the same reason: nothing in the suite may touch the configured
databases.** A test that forgets to repoint a path does not fail — it silently borrows whatever the
developer is running against, which is a real ledger and a real vault. That is invisible on the machine
where the test is written and only shows up on a clean checkout, where the borrowed database does not
exist and the failure names a missing table rather than the missing isolation. The guard below turns
the first *open* of a configured path into a hard error, at the moment it happens and on the machine
that can fix it. It refuses rather than redirecting to a throwaway: a redirect would make an
unisolated test pass, which is how the leak stayed invisible in the first place.

**Third concern, same file for the same reason: nothing in the suite may sleep for a rate limiter.**
The SimpleFIN adapter spaces its outbound requests a second apart, which is right against a real CDN
and pure waiting against a mock. Only one test in the suite makes any assertion about that spacing,
and it sets its own interval; every other test that reaches the transport was paying the full second
per request for nothing. Neutralized below, with the shipped value re-exported so a test can still
assert what actually ships.
"""

import atexit
import shutil
import sqlite3
import tempfile
from pathlib import Path

from backend.db import control_database, database

_real_init_db = database.init_db
_real_init_control_db = control_database.init_control_db

# The configured paths as they stood before any test could repoint them. Captured rather than read
# live, because the harnesses legitimately reassign `DB_PATH` / `CONTROL_DB_PATH` to their own temp
# files, and it is the original values that must stay untouched.
_AMBIENT_DATA_PATH = str(Path(database.DB_PATH))
_AMBIENT_CONTROL_PATH = str(Path(control_database.CONTROL_DB_PATH))


_ISOLATION_ADVICE = {
    "data database": "`set_current_db_path(...)` plus `init_db(...)` against a temp file",
    "control database": "reassign `control_database.CONTROL_DB_PATH` and call `init_control_db()`",
    # The store follows `current_db_path()`, not the connection a test is holding — so passing a path to
    # `get_db` is not enough on its own, and that is exactly how this one gets missed.
    "document store": "`set_current_db_path(...)`, which is what the store reads to find its directory",
}


def _refuse_ambient(kind: str, path: str):
    raise RuntimeError(
        f"Test reached the configured {kind} at {path}. Tests must never touch it — on a "
        f"developer machine it holds real data. Isolate it with "
        f"{_ISOLATION_ADVICE.get(kind, 'a temporary path')}, restoring the original in teardown "
        f"(see `backend/tests/_api_client.py`)."
    )


_real_get_db = database.get_db
_real_get_control_db = control_database.get_control_db


def _guarded_get_db(db_path: str | None = None):
    resolved = database._normalize_db_path(db_path)
    if resolved == _AMBIENT_DATA_PATH:
        _refuse_ambient("data database", resolved)
    return _real_get_db(db_path)


def _guarded_get_control_db():
    resolved = str(Path(control_database.CONTROL_DB_PATH))
    if resolved == _AMBIENT_CONTROL_PATH:
        _refuse_ambient("control database", resolved)
    return _real_get_control_db()


_template_dir = Path(tempfile.mkdtemp(prefix="luma-schema-template-"))
atexit.register(shutil.rmtree, _template_dir, ignore_errors=True)

# Built lazily so a run that touches only one of the two databases pays for only that one.
_templates: dict[str, Path] = {}


def _is_fresh_build(path: str) -> bool:
    """True when `path` has no schema yet, i.e. the caller is asking for a from-scratch build.

    Checked without opening the file when it is absent or empty, since connecting would create it
    and turn the question into its own answer.
    """
    target = Path(path)
    if not target.exists() or target.stat().st_size == 0:
        return True
    conn = sqlite3.connect(path)
    try:
        return (
            conn.execute(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
            ).fetchone()[0]
            == 0
        )
    finally:
        conn.close()


def _template(kind: str, build) -> Path:
    """Return the session's template for `kind`, building it on first use.

    `build` receives the template path and must construct a fresh database there using the real
    builder. The connection it opens is closed before this returns, which is what makes the file
    safe to copy: the databases run in WAL mode, and SQLite checkpoints and removes the -wal/-shm
    sidecars on a clean close, leaving the single .db file self-contained.
    """
    cached = _templates.get(kind)
    if cached is None:
        cached = _template_dir / f"{kind}.db"
        build(cached)
        _templates[kind] = cached
    return cached


def _serve_from_template(kind: str, build, target: str) -> None:
    Path(target).parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(_template(kind, build), target)


def _fast_init_db(db_path: str | None = None):
    # No explicit path means the configured default database, which is never a test's throwaway file.
    # Delegating lets the real builder resolve it, where the guard on `get_db` refuses it.
    if db_path is None:
        return _real_init_db(db_path)
    resolved = database._normalize_db_path(db_path)
    if resolved == _AMBIENT_DATA_PATH:
        _refuse_ambient("data database", resolved)
    if not _is_fresh_build(resolved):
        return _real_init_db(db_path)
    _serve_from_template("data", lambda path: _real_init_db(str(path)), resolved)


def _fast_init_control_db():
    # The control DB's path is module state rather than an argument, so it is read at call time —
    # the API harness repoints it per test before calling.
    resolved = control_database.CONTROL_DB_PATH
    if resolved and str(Path(resolved)) == _AMBIENT_CONTROL_PATH:
        _refuse_ambient("control database", resolved)
    if not resolved or not _is_fresh_build(resolved):
        return _real_init_control_db()

    def build(path: Path):
        original = control_database.CONTROL_DB_PATH
        control_database.CONTROL_DB_PATH = str(path)
        try:
            _real_init_control_db()
        finally:
            control_database.CONTROL_DB_PATH = original

    _serve_from_template("control", build, resolved)


database.init_db = _fast_init_db
control_database.init_control_db = _fast_init_control_db

# Patched at conftest import time for the same reason the fast path is: the application modules bind
# these by `from ... import`, and pytest imports this file before any of them.
database.get_db = _guarded_get_db
control_database.get_control_db = _guarded_get_control_db


# The document store is a third thing that lives in the data directory, and it is reached differently:
# it puts files beside whatever `current_db_path()` resolves to, which is the context variable rather
# than the connection a test happens to be holding. So a test can read and write its own temp ledger
# while dropping attachments into the developer's real `documents/` — the databases look isolated and
# the files are not. Guarded here rather than left to each test to remember.
from backend.services import documents as _documents  # noqa: E402  (after the patches above)

_AMBIENT_DOCUMENT_ROOT = _documents.documents_dir()
_real_documents_dir = _documents.documents_dir


def _guarded_documents_dir():
    resolved = _real_documents_dir()
    if resolved == _AMBIENT_DOCUMENT_ROOT:
        _refuse_ambient("document store", str(resolved))
    return resolved


_documents.documents_dir = _guarded_documents_dir


# The SimpleFIN adapter throttles its own outbound requests (see `_throttle`), which is correct against
# the Bridge's CDN and meaningless against a mocked opener — no test in this suite makes a real
# request. Left alone it cost the suite real seconds of `time.sleep`, spread across ten modules that
# never mention the throttle at all.
#
# Patched at import time like the guards above, rather than as an autouse fixture, so it holds for the
# `mock.patch.object` in `test_consecutive_requests_are_spaced_apart` too: that test sets its own small
# interval to assert the spacing *mechanism*, and unittest restores whatever was here before it.
#
# The shipped value is re-exported rather than discarded — a speedup that quietly erased the guarantee
# it was speeding up would be a bad trade, so `test_simplefin_adapter` asserts against this.
from backend.services.providers import simplefin as _simplefin  # noqa: E402  (after the patches above)

SHIPPED_SIMPLEFIN_REQUEST_INTERVAL_SECONDS = _simplefin._MIN_REQUEST_INTERVAL_SECONDS
_simplefin._MIN_REQUEST_INTERVAL_SECONDS = 0.0
