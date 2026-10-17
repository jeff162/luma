"""`single_runner`: the claim the app-load catch-ups take so two callers arriving together do the work once."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from backend.db.database import get_db, init_db, single_runner


class SingleRunnerTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = str(Path(self.tempdir.name) / "claims.db")
        init_db(self.db_path)

    def tearDown(self):
        self.tempdir.cleanup()

    def test_a_second_caller_is_turned_away_while_the_first_runs(self):
        with single_runner("scan", db_path=self.db_path) as first:
            with single_runner("scan", db_path=self.db_path) as second:
                self.assertTrue(first)
                self.assertFalse(second)

    def test_the_claim_is_released_on_the_way_out_including_after_a_failure(self):
        with self.assertRaises(RuntimeError):
            with single_runner("scan", db_path=self.db_path):
                raise RuntimeError("the scan failed")
        with single_runner("scan", db_path=self.db_path) as again:
            self.assertTrue(again)

    def test_a_claim_left_by_a_process_that_died_lapses(self):
        with get_db(self.db_path) as conn:
            conn.execute(
                "INSERT INTO db_meta (key, value) VALUES ('running:scan', datetime('now', '-2 hours'))"
            )
        with single_runner("scan", lease_seconds=3600, db_path=self.db_path) as claimed:
            self.assertTrue(claimed)

    def test_different_names_do_not_block_each_other(self):
        with single_runner("scan", db_path=self.db_path) as first:
            with single_runner("other", db_path=self.db_path) as second:
                self.assertTrue(first)
                self.assertTrue(second)


if __name__ == "__main__":
    unittest.main()
