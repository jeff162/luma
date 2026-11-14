"""
Callers that find the same derived cache stale together share one computation (`services/cache_fill.py`).
"""

from __future__ import annotations

import tempfile
import threading
import time
import unittest
from pathlib import Path

from backend.db.database import get_db, init_db
from backend.services.reconciliation_attention import ledger_cached


class FillOnceTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = str(Path(self.tempdir.name) / "cache-fill.db")
        init_db(self.db_path)
        self.computed = 0
        self.counter_lock = threading.Lock()

    def tearDown(self):
        self.tempdir.cleanup()

    def _compute(self, _conn):
        with self.counter_lock:
            self.computed += 1
        # Long enough that every caller reaches the cache before the first one stores its value.
        time.sleep(0.3)
        return 7

    def _ask(self, start: threading.Barrier, answers: list):
        start.wait()
        with get_db(self.db_path) as conn:
            answers.append(ledger_cached(conn, "test_cache_fill", self._compute))

    def test_concurrent_stale_reads_compute_once(self):
        start, answers = threading.Barrier(3), []
        threads = [threading.Thread(target=self._ask, args=(start, answers)) for _ in range(3)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(answers, [7, 7, 7])
        self.assertEqual(self.computed, 1)


if __name__ == "__main__":
    unittest.main()
