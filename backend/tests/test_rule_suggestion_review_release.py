"""
A deleted transaction leaves every stored rule-suggestion review that names it.

A review entry's count, matching-rows report and undo all work from its `source_row_ids`, so an id whose
transaction is gone makes the card claim rows it cannot show. The deletion paths release the ids as they
delete (`services/rule_suggestion_review.py`), and v75 repairs reviews written before they did.
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from backend.db import database
from backend.services.import_batch_totals import delete_transactions
from backend.services.rule_suggestion_review import (
    RULE_SUGGESTION_REVIEW_KEY,
    SYSTEM_RULE_SUGGESTION_REVIEW_STATE_KEY,
)


def _review() -> dict:
    """Two accepted cards in one conflict group, one wholly and one partly backed by the rows the tests
    delete, plus a cleared set holding only deleted rows."""
    return {
        "suggestions": {
            "gone": {"keyword": "northgate gas", "source_row_ids": ["t1", "t2"], "txn_count": 2,
                     "conflict_group_id": "g", "conflict_group_total_rows": 5},
            "partial": {"keyword": "northgate gas", "source_row_ids": ["t3", "t4", "t5"], "txn_count": 3,
                        "conflict_group_id": "g", "conflict_group_total_rows": 5},
        },
        "statuses": {
            "gone": {"status": "accepted", "rule_id": "r1"},
            "partial": {"status": "accepted", "rule_id": "r2",
                        "accepted_prior_rows": [{"id": "t3"}, {"id": "t4"}, {"id": "t5"}]},
        },
        "trash_sets": [{
            "id": "set-1", "count": 1,
            "suggestions": {"cleared": {"keyword": "riverstone", "source_row_ids": ["t1"], "txn_count": 1}},
            "statuses": {"cleared": {"status": "discarded"}},
        }],
    }


class RuleSuggestionReviewReleaseTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db_path = str(Path(self.tmp.name) / "ledger.db")
        database.init_db(self.db_path)
        review = json.dumps({RULE_SUGGESTION_REVIEW_KEY: _review()})
        with database.get_db(self.db_path) as conn:
            conn.execute("INSERT INTO account (id, name, display_name) VALUES ('acct', 'Harborline Checking', 'Harborline Checking')")
            conn.execute("INSERT INTO csv_import_profile (id, name, column_map) VALUES ('p1', 'Harborline', ?)",
                         (review,))
            conn.execute(
                """INSERT INTO import_batch (id, profile_id, filename, status, row_count, config_snapshot)
                   VALUES ('b1', 'p1', 'harborline.csv', 'completed', 5, ?)""",
                (review,),
            )
            for txn_id in ("t1", "t2", "t3", "t4", "t5"):
                conn.execute(
                    """INSERT INTO txn (id, account_id, date, amount, raw_name, import_batch_id)
                       VALUES (?, 'acct', '2026-08-01', 40, 'NORTHGATE GAS', 'b1')""",
                    (txn_id,),
                )
            database.set_tenant_workflow_state(conn, SYSTEM_RULE_SUGGESTION_REVIEW_STATE_KEY,
                                               {RULE_SUGGESTION_REVIEW_KEY: _review()})

    def tearDown(self):
        self.tmp.cleanup()

    def _stored_reviews(self) -> list[dict]:
        with database.get_db(self.db_path) as conn:
            batch = conn.execute("SELECT config_snapshot FROM import_batch WHERE id = 'b1'").fetchone()[0]
            profile = conn.execute("SELECT column_map FROM csv_import_profile WHERE id = 'p1'").fetchone()[0]
            system = database.get_tenant_workflow_state(conn, SYSTEM_RULE_SUGGESTION_REVIEW_STATE_KEY)
        return [json.loads(batch)[RULE_SUGGESTION_REVIEW_KEY], json.loads(profile)[RULE_SUGGESTION_REVIEW_KEY],
                system[RULE_SUGGESTION_REVIEW_KEY]]

    def _assert_released(self):
        for review in self._stored_reviews():
            self.assertEqual(set(review["suggestions"]), {"partial"})
            self.assertEqual(set(review["statuses"]), {"partial"})
            partial = review["suggestions"]["partial"]
            self.assertEqual(partial["source_row_ids"], ["t5"])
            self.assertEqual(partial["txn_count"], 1)
            self.assertEqual(partial["conflict_group_total_rows"], 1)
            self.assertEqual(review["statuses"]["partial"]["accepted_prior_rows"], [{"id": "t5"}])
            self.assertEqual(review["trash_sets"], [])
            self.assertEqual(review["summary"]["accepted_count"], 1)

    def test_deleting_transactions_releases_them_from_every_review(self):
        with database.get_db(self.db_path) as conn:
            delete_transactions(conn, "id IN ('t1', 't2', 't3', 't4')")
        self._assert_released()

    def test_v75_releases_rows_already_deleted(self):
        with database.get_db(self.db_path) as conn:
            conn.execute("DELETE FROM txn WHERE id IN ('t1', 't2', 't3', 't4')")
            database._release_missing_rule_suggestion_rows(conn)
        self._assert_released()


if __name__ == "__main__":
    unittest.main()
