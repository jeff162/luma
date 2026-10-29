# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Whether the two databases are intact, and what they hold.

**The check is structural only.** It runs SQLite's `integrity_check` (pages, B-trees, records, and every
index agreeing with its table) and `foreign_key_check` (rows pointing at a parent that is gone), which
are separate passes: a database can pass the first with a table full of orphans. Neither knows anything
about the app's own invariants, so a database that passes is a file that is not damaged, not a ledger
that is coherent (`docs/operations.md` → *Checking the databases*).

**It reads through a read-only connection**, so checking never creates a missing file, never takes a
write lock and never changes what it is checking. A file too damaged to open is a failed check, not an
error.

**One repair is offered, and only where it is complete.** When every problem the check found is an
index disagreeing with its table, rebuilding the indexes (`REINDEX`) makes them agree again and loses
nothing, since an index holds no data of its own. Any other problem has no repair here that is both
general and lossless: the answer is a backup.

The check is run on demand, before every backup (whose history row records the outcome) and after every
restore. At ledger scale it takes about a tenth of a second, so it is never backgrounded.
"""

from __future__ import annotations

import re
import sqlite3
from collections import Counter
from contextlib import closing
from pathlib import Path

from backend.app_logging import log_info, log_warning
from backend.db import control_database
from backend.db.database import current_db_path, get_db

# The two databases, by the names the backup already gives their contents: the financial data, and the
# accounts part (sign-in, backup keys, the vault).
DATA = "data"
ACCOUNTS = "accounts"

# The messages `integrity_check` writes for an index out of step with its table — the one kind of
# problem `REINDEX` repairs completely.
_INDEX_PROBLEM = re.compile(
    r"^(row \d+ missing from index |wrong # of entries in index |non-unique entry in UNIQUE index )"
)


def _paths() -> dict[str, str]:
    return {DATA: current_db_path(), ACCOUNTS: str(control_database.CONTROL_DB_PATH)}


def _open_read_only(path: str) -> sqlite3.Connection:
    uri = f"{Path(path).resolve().as_uri()}?mode=ro"
    conn = sqlite3.connect(uri, uri=True, timeout=15)
    conn.row_factory = sqlite3.Row
    return conn


def check_connection(conn: sqlite3.Connection) -> dict:
    """Both checks over one connection. `problems` are `integrity_check`'s messages; `orphans` are the
    rows `foreign_key_check` found, counted per table and the parent each one is missing.
    `indexes_repairable` is true when there are problems and every one of them is an index's."""
    try:
        problems = [row[0] for row in conn.execute("PRAGMA integrity_check") if row[0] != "ok"]
        orphan_rows = conn.execute("PRAGMA foreign_key_check").fetchall()
    except sqlite3.DatabaseError as exc:
        return {"ok": False, "problems": [str(exc)], "orphans": [], "indexes_repairable": False}
    counted = Counter((row[0], row[2]) for row in orphan_rows)
    orphans = [{"table": table, "parent": parent, "rows": rows} for (table, parent), rows in sorted(counted.items())]
    return {
        "ok": not problems and not orphans,
        "problems": problems,
        "orphans": orphans,
        "indexes_repairable": bool(problems) and all(_INDEX_PROBLEM.match(p) for p in problems),
    }


def check_database(path: str) -> dict:
    if not Path(path).exists():
        return {"ok": False, "problems": ["The database file does not exist."], "orphans": [],
                "indexes_repairable": False}
    try:
        with closing(_open_read_only(path)) as conn:
            return check_connection(conn)
    except sqlite3.Error as exc:
        return {"ok": False, "problems": [str(exc)], "orphans": [], "indexes_repairable": False}


def check_databases() -> dict:
    """Both databases, each under its name, and whether both passed."""
    databases = {name: check_database(path) for name, path in _paths().items()}
    for name, result in databases.items():
        if not result["ok"]:
            log_warning(f"[db] the {name} database failed its check: {result['problems'][:3]} "
                        f"orphans={result['orphans'][:3]}")
    return {"ok": all(r["ok"] for r in databases.values()), "databases": databases}


def check_passed() -> bool | None:
    """`check_databases` as a yes or no for a caller that must not fail on it: None when the check could
    not be run at all."""
    try:
        return check_databases()["ok"]
    except Exception as exc:                                        # pragma: no cover - defensive
        log_warning(f"[db] the database check did not run: {exc}")
        return None


def repair_indexes() -> dict | None:
    """Rebuild the indexes of each database whose only problems are its indexes, then check again.
    None when no database has a problem this repairs."""
    before = check_databases()["databases"]
    repairable = [name for name, result in before.items() if result["indexes_repairable"]]
    if not repairable:
        return None
    for name in repairable:
        log_info(f"[db] rebuilding the indexes of the {name} database: {before[name]['problems'][:3]}",
                 keep_in_file=True)
        opener = get_db(_paths()[DATA]) if name == DATA else control_database.get_control_db()
        with opener as conn:
            conn.execute("REINDEX")
    after = check_databases()
    log_info(f"[db] index rebuild done; the check now {'passes' if after['ok'] else 'still fails'}",
             keep_in_file=True)
    return after


def _file_bytes(path: str) -> tuple[int, int]:
    wal = Path(f"{path}-wal")
    return Path(path).stat().st_size, (wal.stat().st_size if wal.exists() else 0)


def _table_usage(conn: sqlite3.Connection) -> tuple[list[dict], bool]:
    """Each table's rows, and its bytes with its indexes counted in. The bytes come from the `dbstat`
    table, which not every SQLite build includes; without it they are None and the second value says so."""
    names = [row[0] for row in conn.execute(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
    try:
        sizes = {row[0]: row[1] for row in conn.execute(
            "SELECT s.tbl_name, SUM(d.pgsize) FROM dbstat d JOIN sqlite_schema s ON s.name = d.name "
            "GROUP BY s.tbl_name")}
        sized = True
    except sqlite3.OperationalError:
        sizes, sized = {}, False
    tables = []
    for name in names:
        quoted = '"' + name.replace('"', '""') + '"'
        tables.append({
            "name": name,
            "rows": conn.execute(f"SELECT COUNT(*) FROM {quoted}").fetchone()[0],
            "bytes": sizes.get(name) if sized else None,
        })
    return tables, sized


def database_usage(path: str) -> dict:
    """The file and its write-ahead log on disk, the part of the file on the free list (what compacting
    would give back), and the tables, largest first where their sizes are known."""
    file_bytes, wal_bytes = _file_bytes(path)
    with closing(_open_read_only(path)) as conn:
        page_size = conn.execute("PRAGMA page_size").fetchone()[0]
        free_bytes = conn.execute("PRAGMA freelist_count").fetchone()[0] * page_size
        tables, sized = _table_usage(conn)
    tables.sort(key=lambda t: (-(t["bytes"] or 0), -t["rows"], t["name"]))
    return {"file_bytes": file_bytes, "wal_bytes": wal_bytes, "free_bytes": free_bytes,
            "tables": tables, "table_sizes_known": sized}


def usage() -> dict:
    """`database_usage` for both databases. A database that cannot be read reports its error instead."""
    result = {}
    for name, path in _paths().items():
        try:
            result[name] = database_usage(path)
        except (OSError, sqlite3.Error) as exc:
            result[name] = {"error": str(exc)}
    return result
