"""
v72 removes from every duplicate report the rows an import stopped writing at v69: a source's settled
restatement of its own prior import.

What it must not take is the point of the test — a row still flagged for review, another source's claim
on the same account, and the record an enrichment is undone from all stay — and the card's counts move
so it reads as though the file had been imported today. Built on a real `init_db` schema stamped back to
v71, because the remover reads the card's snapshot and the report's stored cells as the import wrote them.
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from backend.db import database

SOURCE = "Rewards Card"


class StoredSourceRestatementRemovalTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db_path = str(Path(self.tmp.name) / "upgrade.db")
        database.init_db(self.db_path)
        with database.get_db(self.db_path) as conn:
            conn.execute(
                """
                INSERT INTO import_batch (id, filename, file_content_hash, status, row_count,
                                          skipped_count, deduped_count, config_snapshot)
                VALUES ('mapped', 'rewards-2026.csv', 'hash-mapped', 'completed', 5, 0, 5,
                        '{"column_map": {"account": "Account"}}'),
                       ('single', 'harborline.csv', 'hash-single', 'completed', 1, 0, 1, '{}')
                """
            )
            rows = [
                ("mapped", 1, SOURCE, None, [{"id": "t1", "day_offset": 0}], None),
                ("mapped", 2, SOURCE, "no_match", [], None),
                ("mapped", 3, "Harborline Checking", None, [{"id": "t3", "day_offset": 0}], None),
                ("mapped", 4, SOURCE, None, [{"id": "t4", "day_offset": 0}], "2026-01-01 00:00:00"),
                ("mapped", 5, SOURCE, None, [{"id": "t5", "day_offset": 0}], None),
                # No account column to read the row's source from, so it cannot be told apart.
                ("single", 1, SOURCE, None, [{"id": "t6", "day_offset": 0}], None),
            ]
            for batch_id, row_number, source, substate, candidates, enriched_at in rows:
                matched = {
                    "covered": {"start_date": "2026-08-01", "end_date": "2026-08-20",
                                "source_batch_id": "earlier", "source_csv_value": source},
                    "candidates": candidates,
                }
                conn.execute(
                    """
                    INSERT INTO import_batch_duplicate
                      (batch_id, row_number, reason, values_json, matched_transaction_json,
                       txn_payload_json, review_substate, enriched_at)
                    VALUES (?, ?, 'Falls within the fully covered date range', ?, ?, '{}', ?, ?)
                    """,
                    (batch_id, row_number, json.dumps({"Account": SOURCE}), json.dumps(matched),
                     substate, enriched_at),
                )
            database.set_db_version(conn, 71)

    def tearDown(self):
        self.tmp.cleanup()

    def _report(self, conn) -> dict:
        return {
            batch_id: [r["row_number"] for r in conn.execute(
                "SELECT row_number FROM import_batch_duplicate WHERE batch_id = ? ORDER BY row_number",
                (batch_id,),
            )]
            for batch_id in ("mapped", "single")
        }

    def test_an_upgrade_keeps_only_the_rows_that_hold_something(self):
        database.init_db(self.db_path)
        with database.get_db(self.db_path) as conn:
            self.assertEqual(self._report(conn), {"mapped": [2, 3, 4], "single": [1]})
            card = conn.execute(
                "SELECT deduped_count, ignored_count FROM import_batch WHERE id = 'mapped'"
            ).fetchone()
        self.assertEqual((card["deduped_count"], card["ignored_count"]), (3, 2))

    def test_restoring_an_older_backup_removes_them_again(self):
        with database.get_db(self.db_path) as conn:
            database.run_post_restore_data_init(conn, 71)
            self.assertEqual(self._report(conn), {"mapped": [2, 3, 4], "single": [1]})


if __name__ == "__main__":
    unittest.main()
