"""
Read paths that write a cache must not leave the write lock held.

A DELETE or UPDATE takes SQLite's write lock even when it matches nothing, and the caller's transaction
then holds it until its block ends. The import history and the Tasks poll both write a cache and then go
on reading for the length of a listing, so a write left open there makes every other writer wait out
the busy timeout behind a request that is only reading. What is pinned is the lock, not the cached
values: `conn.in_transaction` is true exactly while this connection holds it.
"""

from __future__ import annotations

import tempfile
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path

from backend.db.database import get_db, init_db, reset_current_db_path, set_current_db_path
from backend.services.import_batch_totals import refresh_batch_totals
from backend.services.reconciliation_attention import batch_attention, ledger_cached


class ReadPathWriteLockTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "read-path-lock.db"
        init_db(str(self.db_path))
        self.account_id, self.batch_id = str(uuid.uuid4()), str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    "INSERT INTO account (id, provider, name, display_name, type) "
                    "VALUES (?, 'fixture', 'Checking', 'Checking', 'depository')",
                    (self.account_id,),
                )
                conn.execute("INSERT INTO import_batch (id, filename) VALUES (?, 'statement.csv')", (self.batch_id,))
                conn.execute(
                    "INSERT INTO import_batch_account (batch_id, csv_value, account_id) VALUES (?, '', ?)",
                    (self.batch_id, self.account_id),
                )

    def tearDown(self):
        self.tempdir.cleanup()

    @contextmanager
    def _use_db_path(self):
        token = set_current_db_path(str(self.db_path))
        try:
            yield
        finally:
            reset_current_db_path(token)

    def test_reconciling_a_consistent_history_takes_no_write_lock(self):
        with self._use_db_path():
            with get_db() as conn:
                refresh_batch_totals(conn, [self.batch_id])
                self.assertFalse(conn.in_transaction)

    def test_a_cache_written_on_a_read_path_releases_the_lock_at_once(self):
        with self._use_db_path():
            with get_db() as conn:
                self.assertEqual(batch_attention(conn, self.batch_id, lambda _conn, _batch: 3), 3)
                self.assertFalse(conn.in_transaction)
                self.assertEqual(ledger_cached(conn, "fixture_cache", lambda _conn: {"n": 1}), {"n": 1})
                self.assertFalse(conn.in_transaction)

    def test_a_cache_written_inside_a_callers_write_leaves_that_write_whole(self):
        # Committing here would split the caller's own transaction, making half its work durable on its own.
        with self._use_db_path():
            with get_db() as conn:
                conn.execute("UPDATE account SET display_name = 'Renamed' WHERE id = ?", (self.account_id,))
                batch_attention(conn, self.batch_id, lambda _conn, _batch: 3)
                self.assertTrue(conn.in_transaction)
                conn.rollback()
                name = conn.execute("SELECT display_name FROM account WHERE id = ?", (self.account_id,)).fetchone()
        self.assertEqual(name["display_name"], "Checking")


if __name__ == "__main__":
    unittest.main()
