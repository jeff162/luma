"""
A fresh database and an upgraded one end up with the same schema.

The two paths share no code: a fresh install is created by `init_db`'s CREATE script and stamped
`CURRENT_VERSION`, while an existing file runs the same script (every statement `IF NOT EXISTS`) and then
the registered migrations. A column added to the CREATE script without a migration, or the reverse,
splits them, and only users with older databases see it. See `docs/data-model.md` → *Schema evolution*.

The upgrade starts from `fixtures/schema_v17.sql`, the oldest schema the chain supports upgrading, and goes
through `init_db` rather than `run_migrations` alone, because that is the order a real upgrade runs in:
tables the old database lacks are created in today's shape before any migration sees them.

Structure is read through the PRAGMAs, not `sqlite_master.sql`, which differs in whitespace and column
order on the two paths. CHECK constraints are visible only in that text, so they are not compared.
"""

from __future__ import annotations

import re
import sqlite3
import tempfile
import unittest
from pathlib import Path

from backend.db import database

BASELINE = Path(__file__).parent / "fixtures" / "schema_v17.sql"
BASELINE_VERSION = 17

# Differences that exist on every database upgraded through a given migration and that a later migration
# cannot undo, since SQLite alters a column's constraints only by rebuilding its table. Each one names
# why it is harmless; the test fails if one disappears, so a fix removes its entry.
KNOWN_DRIFT = {
    ("foreign key", "recurring_series", "counterpart_account_id"): (
        "v50 added the column without its REFERENCES clause. Deleting an account removes the series that "
        "name it explicitly (services/account_references.py), so nothing relies on the cascade."
    ),
}


def _normalized_sql(sql: str | None) -> str:
    return re.sub(r"\s+", " ", re.sub(r"(?i)\bif not exists\b", "", sql or "")).strip()


def _schema(path: Path) -> dict[tuple, object]:
    """Every structural fact about the database, keyed so that a mismatch names the object that drifted."""
    conn = sqlite3.connect(str(path))
    try:
        facts: dict[tuple, object] = {}
        objects = conn.execute(
            "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'"
        ).fetchall()
        for kind, name, table, sql in objects:
            if kind != "table":
                facts[(kind, name)] = (table, _normalized_sql(sql))
                continue
            for _, column, col_type, not_null, default, pk in conn.execute(f'PRAGMA table_info("{name}")'):
                facts[("column", name, column)] = (col_type.upper(), not_null, default, pk)
            for row in conn.execute(f'PRAGMA foreign_key_list("{name}")'):
                facts[("foreign key", name, row[3])] = (row[2], row[4], row[5], row[6])
            # Indexes SQLite makes for UNIQUE and PRIMARY KEY constraints have no SQL of their own and are
            # numbered by column position, so they are compared by the columns they cover.
            for _, index, _unique, origin, _partial in conn.execute(f'PRAGMA index_list("{name}")'):
                if origin != "c":
                    columns = tuple(r[2] for r in conn.execute(f'PRAGMA index_info("{index}")'))
                    facts[("constraint", name, origin, columns)] = True
        return facts
    finally:
        conn.close()


class SchemaPathsAgreeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        root = Path(cls.tmp.name)

        fresh = root / "fresh.db"
        database.init_db(str(fresh))

        upgraded = root / "upgraded.db"
        conn = sqlite3.connect(str(upgraded))
        conn.executescript(BASELINE.read_text())
        conn.execute("INSERT INTO db_meta (key, value) VALUES ('version', ?)", (str(BASELINE_VERSION),))
        conn.commit()
        conn.close()
        database.init_db(str(upgraded))

        cls.fresh, cls.upgraded = _schema(fresh), _schema(upgraded)
        conn = sqlite3.connect(str(upgraded))
        conn.row_factory = sqlite3.Row
        cls.upgraded_version = database.get_db_version(conn)
        conn.close()

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_the_upgrade_reaches_the_current_version(self):
        self.assertEqual(self.upgraded_version, database.CURRENT_VERSION)

    def test_both_paths_hold_the_same_tables(self):
        # Checked first and on its own, so a table missing from one path is named as that rather than as
        # a list of its columns.
        def tables(facts):
            return {key[1] for key in facts if key[0] == "column"}

        self.assertEqual(tables(self.upgraded), tables(self.fresh))

    def test_both_paths_hold_the_same_schema(self):
        drift = {
            key: (self.fresh.get(key), self.upgraded.get(key))
            for key in self.fresh.keys() | self.upgraded.keys()
            if self.fresh.get(key) != self.upgraded.get(key)
        }
        for key in KNOWN_DRIFT:
            self.assertIn(key, drift, f"{key} no longer drifts; remove it from KNOWN_DRIFT")
            del drift[key]
        report = "\n".join(f"{key}: fresh={fresh!r} upgraded={upgraded!r}" for key, (fresh, upgraded) in sorted(drift.items(), key=str))
        self.assertEqual(drift, {}, "\n" + report)


if __name__ == "__main__":
    unittest.main()
