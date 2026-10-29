"""The structural check of both databases, the one repair it offers, and the figures beside it.

Each kind of damage is made for real in a throwaway file, because what the check classifies is the text
SQLite writes for it: an index out of step with its table, rows whose parent is gone, and a file whose
pages are not a database at all.
"""

from __future__ import annotations

import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest import mock

from backend.services import database_health


def _make(path: Path) -> None:
    with closing(sqlite3.connect(path)) as conn, conn:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.executescript("""
            CREATE TABLE parent (id INTEGER PRIMARY KEY);
            CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id), body TEXT);
            CREATE INDEX child_body ON child(body);
        """)
        conn.execute("INSERT INTO parent VALUES (1)")
        conn.executemany("INSERT INTO child (parent_id, body) VALUES (1, ?)", [(f"row {i}",) for i in range(200)])


def _break_index(path: Path) -> None:
    """Point the index's definition at a different ordering than the entries it holds, which is how an
    index stops agreeing with its table without any page being damaged."""
    conn = sqlite3.connect(path)
    conn.execute("PRAGMA writable_schema=ON")
    conn.execute("UPDATE sqlite_schema SET sql = 'CREATE INDEX child_body ON child(body DESC)' "
                 "WHERE name = 'child_body'")
    conn.commit()
    conn.close()


def _orphan(path: Path) -> None:
    with closing(sqlite3.connect(path)) as conn, conn:
        conn.execute("INSERT INTO child (parent_id, body) VALUES (99, 'no parent')")


class CheckTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.path = Path(tmp.name) / "ledger.db"
        self.other = Path(tmp.name) / "control.db"
        _make(self.path)
        _make(self.other)
        patcher = mock.patch.object(database_health, "_paths", return_value={
            database_health.DATA: str(self.path), database_health.ACCOUNTS: str(self.other)})
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_an_intact_database_passes(self):
        result = database_health.check_databases()
        self.assertTrue(result["ok"])
        self.assertEqual(result["databases"][database_health.DATA],
                         {"ok": True, "problems": [], "orphans": [], "indexes_repairable": False})

    def test_an_index_out_of_step_is_reported_and_rebuilding_the_indexes_repairs_it(self):
        _break_index(self.path)
        before = database_health.check_databases()
        data = before["databases"][database_health.DATA]
        self.assertFalse(before["ok"])
        self.assertTrue(data["problems"])
        self.assertTrue(data["indexes_repairable"])
        self.assertTrue(before["databases"][database_health.ACCOUNTS]["ok"])

        after = database_health.repair_indexes()

        self.assertTrue(after["ok"])
        with closing(sqlite3.connect(self.path)) as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM child").fetchone()[0], 200)

    def test_orphaned_rows_are_counted_per_table_and_parent_and_offer_no_repair(self):
        """`integrity_check` passes a table full of orphans, which is why the check runs both passes."""
        _orphan(self.path)
        data = database_health.check_databases()["databases"][database_health.DATA]
        self.assertEqual(data["problems"], [])
        self.assertEqual(data["orphans"], [{"table": "child", "parent": "parent", "rows": 1}])
        self.assertFalse(data["ok"])
        self.assertFalse(data["indexes_repairable"])
        self.assertIsNone(database_health.repair_indexes())

    def test_a_file_that_is_not_a_database_fails_rather_than_raising(self):
        with closing(sqlite3.connect(self.path)) as conn:
            conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        size = self.path.stat().st_size
        self.assertGreater(size, 4096)
        with open(self.path, "r+b") as f:
            f.seek(4096)
            f.write(b"\xff" * (size - 4096))
        data = database_health.check_databases()["databases"][database_health.DATA]
        self.assertFalse(data["ok"])
        self.assertTrue(data["problems"])
        self.assertFalse(data["indexes_repairable"])

    def test_checking_a_missing_file_does_not_create_it(self):
        self.path.unlink()
        Path(f"{self.path}-wal").unlink(missing_ok=True)
        Path(f"{self.path}-shm").unlink(missing_ok=True)
        self.assertFalse(database_health.check_databases()["ok"])
        self.assertFalse(self.path.exists())

    def test_usage_lists_every_table_with_its_rows_largest_first(self):
        usage = database_health.usage()[database_health.DATA]
        self.assertEqual([t["name"] for t in usage["tables"]], ["child", "parent"])
        self.assertEqual([t["rows"] for t in usage["tables"]], [200, 1])
        if usage["table_sizes_known"]:
            self.assertGreater(usage["tables"][0]["bytes"], usage["tables"][1]["bytes"])
        self.assertGreater(usage["file_bytes"], 0)


if __name__ == "__main__":
    unittest.main()
