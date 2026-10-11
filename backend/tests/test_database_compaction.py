"""Giving freed pages back to the filesystem after a bulk deletion nobody asked to reclaim space from."""

from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from backend.db import database
from backend.db.database import compact_if_worthwhile

# Scaled down so the fixture stays small; the fraction is left at its real value.
_TEST_MIN_FREE_BYTES = 256 * 1024


class CompactIfWorthwhileTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.db_path = Path(tmp.name) / "ledger.db"
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("CREATE TABLE row (body TEXT)")
            conn.executemany("INSERT INTO row VALUES (?)", [("x" * 1000,) for _ in range(2000)])
        patcher = mock.patch.object(database, "COMPACT_MIN_FREE_BYTES", _TEST_MIN_FREE_BYTES)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _delete(self, where: str):
        conn = sqlite3.connect(self.db_path)
        with conn:
            conn.execute(f"DELETE FROM row WHERE {where}")
        conn.close()

    def _on_disk(self) -> int:
        wal = Path(f"{self.db_path}-wal")
        return self.db_path.stat().st_size + (wal.stat().st_size if wal.exists() else 0)

    def test_slack_below_the_threshold_is_left_for_sqlite_to_reuse(self):
        self._delete("rowid <= 20")
        before = self._on_disk()
        self.assertEqual(compact_if_worthwhile(str(self.db_path), reason="test"), 0)
        self.assertEqual(self._on_disk(), before)

    def test_large_slack_is_given_back_even_with_another_connection_open(self):
        """A running server holds other connections, and with one open VACUUM leaves the rebuilt pages in
        the write-ahead log: the database file shrinks and the disk does not, unless it is checkpointed."""
        self._delete("rowid > 1000")
        before = self._on_disk()
        other = sqlite3.connect(self.db_path)
        self.addCleanup(other.close)
        other.execute("SELECT COUNT(*) FROM row").fetchone()

        freed = compact_if_worthwhile(str(self.db_path), reason="test")

        self.assertGreater(freed, _TEST_MIN_FREE_BYTES)
        self.assertEqual(self._on_disk(), before - freed)


if __name__ == "__main__":
    unittest.main()
