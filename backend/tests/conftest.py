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
"""

import atexit
import shutil
import sqlite3
import tempfile
from pathlib import Path

from backend.db import control_database, database

_real_init_db = database.init_db
_real_init_control_db = control_database.init_control_db

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
    # No explicit path means the caller wants the configured default database; that is never a
    # test's throwaway file, so it goes to the real builder untouched.
    if db_path is None:
        return _real_init_db(db_path)
    resolved = database._normalize_db_path(db_path)
    if not _is_fresh_build(resolved):
        return _real_init_db(db_path)
    _serve_from_template("data", lambda path: _real_init_db(str(path)), resolved)


def _fast_init_control_db():
    # The control DB's path is module state rather than an argument, so it is read at call time —
    # the API harness repoints it per test before calling.
    resolved = control_database.CONTROL_DB_PATH
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
