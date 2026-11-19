"""A write waits for the lock rather than failing at once.

SQLite refuses to let a transaction that has already read wait for the write lock. A deferred `BEGIN`
followed by anything that reads — even preparing a DELETE on `txn`, whose full-text index reads its
settings — therefore turns another request's brief write into an immediate `database is locked`. These
pin the two ways a transaction opens: the one Python opens before a write, and an explicit one.
"""

import re
import sqlite3
import tempfile
import threading
import time
import unittest
from pathlib import Path

from backend.db.database import get_db, init_db

BACKEND = Path(__file__).resolve().parents[1]


class WriteTransactionTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = str(Path(self.tempdir.name) / "ledger.db")
        init_db(self.db_path)

    def tearDown(self):
        self.tempdir.cleanup()

    def _hold_write_lock(self, seconds: float) -> threading.Thread:
        taken = threading.Event()

        def hold():
            other = sqlite3.connect(self.db_path)
            other.execute("BEGIN IMMEDIATE")
            taken.set()
            time.sleep(seconds)
            other.commit()
            other.close()

        thread = threading.Thread(target=hold)
        thread.start()
        taken.wait()
        return thread

    def test_a_write_after_an_empty_executemany_waits_for_the_lock(self):
        # The shape that failed: a helper with nothing to record still opens the transaction, and the
        # delete that follows is then prepared inside it.
        holder = self._hold_write_lock(0.5)
        try:
            with get_db(self.db_path) as conn:
                conn.executemany("INSERT INTO db_meta (key, value) VALUES (?, 'x')", [])
                conn.execute("DELETE FROM txn WHERE account_id = 'none'")
        finally:
            holder.join()

    def test_no_code_path_opens_a_deferred_transaction(self):
        deferred = re.compile(r"""execute\(\s*["']BEGIN(\s+DEFERRED)?\s*["']""", re.IGNORECASE)
        offenders = [
            str(path.relative_to(BACKEND))
            for path in BACKEND.rglob("*.py")
            if "venv" not in path.parts and "tests" not in path.parts
            and deferred.search(path.read_text(encoding="utf-8"))
        ]
        self.assertEqual(offenders, [], "open a transaction with BEGIN IMMEDIATE")


if __name__ == "__main__":
    unittest.main()
