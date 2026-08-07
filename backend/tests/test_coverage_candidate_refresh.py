"""
Filling in explanations the import could not produce.

The duplicate report **replays a stored answer**: `import_batch_duplicate.matched_transaction_json` is
written once, during the import, and read back forever after. A row rejected as "date covered" that
could not name its twin at the time therefore keeps reading **no specific match** — even after the
lookup that produces that name improves, and even after a later import brings the twin into the ledger.

That is the worst state to leave a row in: it is out of the ledger *and* the report cannot say what
replaced it, which is precisely what someone auditing the rejections needs. So the read path refreshes
the missing half before rendering.

What it must not do is revisit decisions. These tests pin the boundary: it fills in an empty candidate
list and nothing else — never re-points an explanation the user may already have acted on, never touches
the verdict, the reason, or the reviewed state.
"""

from __future__ import annotations

import json
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest import mock

from backend.db.database import SHARED_OWNER_ID, get_db, init_db, reset_current_db_path, set_current_db_path
from backend.services import duplicate_detection
from backend.services.duplicate_detection import refresh_unexplained_coverage_candidates

COVERED_REASON = "Falls within the fully covered date range from an earlier import for this source account"


class CoverageCandidateRefreshTests(unittest.TestCase):
    ACCOUNT = "acct-1"

    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "refresh.db"
        init_db(str(self.db_path))
        with self._db() as conn:
            conn.execute(
                "INSERT INTO account (id, name, display_name, type, owner_id) "
                "VALUES (?, 'Northgate Rewards', 'Northgate Rewards', 'credit', ?)",
                (self.ACCOUNT, SHARED_OWNER_ID),
            )
            for bid, name in (("b-mint", "Mint.csv"), ("b-fidelity", "Fidelity.csv")):
                conn.execute(
                    "INSERT INTO import_batch (id, filename, status) VALUES (?,?, 'completed')", (bid, name)
                )

    def tearDown(self):
        self.tempdir.cleanup()

    @contextmanager
    def _db(self):
        token = set_current_db_path(str(self.db_path))
        try:
            with get_db() as conn:
                yield conn
        finally:
            reset_current_db_path(token)

    # ---- fixtures ------------------------------------------------------

    def _existing(self, txn_id, day, amount, name, *, batch="b-mint", account=None, authorized=None):
        with self._db() as conn:
            conn.execute(
                "INSERT INTO txn (id, account_id, owner_id, amount, merchant_name, display_name,"
                " raw_name, date, authorized_date, is_pending, content_hash, import_batch_id)"
                " VALUES (?,?,?,?,?,?,?,?,?,0,?,?)",
                (txn_id, account or self.ACCOUNT, SHARED_OWNER_ID, amount, name, name, name, day,
                 authorized, f"hash-{txn_id}", batch),
            )

    def _rejected(self, row_number, day, amount, *, reason=COVERED_REASON, candidates=None,
                  account=None, batch="b-fidelity"):
        """A stored coverage rejection, as `save_batch_duplicate_rows` writes one."""
        matched = {
            "covered": {"start_date": "2017-02-10", "end_date": "2023-12-19", "source_batch_id": "b-mint"},
            "candidates": candidates or [],
            "candidate_count": len(candidates or []),
        }
        with self._db() as conn:
            conn.execute(
                "INSERT INTO import_batch_duplicate (batch_id, row_number, reason, values_json,"
                " matched_transaction_json, txn_payload_json) VALUES (?,?,?,?,?,?)",
                (batch, row_number, reason, json.dumps({}), json.dumps(matched),
                 json.dumps({"account_id": account or self.ACCOUNT, "date": day, "amount": amount})),
            )

    def _stored(self, row_number, batch="b-fidelity"):
        with self._db() as conn:
            row = conn.execute(
                "SELECT * FROM import_batch_duplicate WHERE batch_id = ? AND row_number = ?",
                (batch, row_number),
            ).fetchone()
        return dict(row), json.loads(row["matched_transaction_json"])

    def _refresh(self):
        with self._db() as conn:
            return refresh_unexplained_coverage_candidates(conn, "b-fidelity")

    # ---- the reported case ---------------------------------------------

    def test_a_three_day_gap_gains_the_explanation_it_could_not_produce_before(self):
        # TST BLACKBIRD DOUGHNUTS: dated the 17th by one export, the 20th by another, same amount and
        # account. Correctly rejected as covered; wrongly reported as unexplained.
        self._existing("mint-1", "2023-08-20", -4.28, "Blackbird")
        self._rejected(1, "2023-08-17", -4.28)

        self.assertEqual(self._refresh(), 1)

        _, matched = self._stored(1)
        self.assertEqual([c["id"] for c in matched["candidates"]], ["mint-1"])
        self.assertEqual(matched["candidate_count"], 1)
        self.assertEqual(matched["candidates"][0]["day_offset"], 3)

    def test_it_leaves_the_verdict_and_the_reason_exactly_as_they_were(self):
        # It explains a decision; it never revisits one.
        self._existing("mint-1", "2023-08-20", -4.28, "Blackbird")
        self._rejected(1, "2023-08-17", -4.28)
        with self._db() as conn:
            conn.execute(
                "UPDATE import_batch_duplicate SET reviewed_at = '2026-01-01T00:00:00Z'"
                " WHERE batch_id = 'b-fidelity' AND row_number = 1"
            )

        self._refresh()

        row, matched = self._stored(1)
        self.assertEqual(row["reason"], COVERED_REASON)
        self.assertEqual(row["reviewed_at"], "2026-01-01T00:00:00Z")
        self.assertEqual(matched["covered"]["source_batch_id"], "b-mint",
                         "the covering range that caused the rejection must survive untouched")

    def test_an_entry_that_already_named_a_twin_is_never_re_pointed(self):
        # The user may have acted on the existing explanation — enriched from it, or reviewed it. A
        # refresh that silently swapped the named row would invalidate that without saying so.
        self._existing("mint-1", "2023-08-20", -4.28, "Blackbird")
        self._rejected(1, "2023-08-17", -4.28, candidates=[{"id": "old-pick", "date": "2023-08-18"}])

        self.assertEqual(self._refresh(), 0)

        _, matched = self._stored(1)
        self.assertEqual([c["id"] for c in matched["candidates"]], ["old-pick"])

    def test_nothing_to_explain_is_a_no_op(self):
        # The normal case on every report open. Nothing qualifies, nothing is written.
        self._rejected(1, "2023-08-17", -4.28)
        self.assertEqual(self._refresh(), 0)
        _, matched = self._stored(1)
        self.assertEqual(matched["candidates"], [])

    # ---- what it must not touch ----------------------------------------

    def test_a_non_coverage_rejection_is_left_alone(self):
        # Only the coverage rule can reject without naming a row, so only its entries have a missing
        # explanation to fill. An exact-hash rejection carries its match as a top-level `id` and no
        # `covered` block — which is what the guard keys on, rather than the reason text, since the
        # shape is what determines whether a candidate list is even meaningful here.
        self._existing("mint-1", "2023-08-20", -4.28, "Blackbird")
        with self._db() as conn:
            conn.execute(
                "INSERT INTO import_batch_duplicate (batch_id, row_number, reason, values_json,"
                " matched_transaction_json, txn_payload_json) VALUES ('b-fidelity',1,?,?,?,?)",
                ("Matches an existing transaction", json.dumps({}),
                 json.dumps({"id": "mint-1", "date": "2023-08-20", "amount": -4.28}),
                 json.dumps({"account_id": self.ACCOUNT, "date": "2023-08-17", "amount": -4.28})),
            )
        self.assertEqual(self._refresh(), 0)

    def test_a_row_this_same_batch_imported_is_a_valid_explanation(self):
        # The real case this turned up on: one file carried the same charge under two different account
        # labels, so one copy imported and the other was rejected by coverage. The imported copy is the
        # explanation. A rejected row is never inserted, so it can never be offered as its own twin —
        # there is nothing to guard against here, and an earlier version of this pass wrongly excluded
        # same-batch rows, hiding precisely the answer the report exists to give.
        self._existing("same-file-1", "2023-08-20", -4.28, "Blackbird", batch="b-fidelity")
        self._rejected(1, "2023-08-17", -4.28)

        self.assertEqual(self._refresh(), 1)

        _, matched = self._stored(1)
        self.assertEqual([c["id"] for c in matched["candidates"]], ["same-file-1"])

    def test_a_row_on_another_account_is_not_a_same_account_candidate(self):
        with self._db() as conn:
            conn.execute(
                "INSERT INTO account (id, name, display_name, type, owner_id)"
                " VALUES ('acct-other','Other','Other','credit',?)", (SHARED_OWNER_ID,),
            )
        self._existing("mint-1", "2023-08-20", -4.28, "Blackbird", account="acct-other")
        self._rejected(1, "2023-08-17", -4.28)
        self.assertEqual(self._refresh(), 0)

    def test_a_pending_or_trashed_row_is_not_offered_as_the_twin(self):
        self._existing("mint-1", "2023-08-20", -4.28, "Blackbird")
        with self._db() as conn:
            conn.execute("UPDATE txn SET trashed_at = '2026-01-01T00:00:00Z' WHERE id = 'mint-1'")
        self._rejected(1, "2023-08-17", -4.28)
        self.assertEqual(self._refresh(), 0)

    def test_an_entry_with_no_usable_payload_is_skipped_rather_than_guessed_at(self):
        self._existing("mint-1", "2023-08-20", -4.28, "Blackbird")
        with self._db() as conn:
            conn.execute(
                "INSERT INTO import_batch_duplicate (batch_id, row_number, reason, values_json,"
                " matched_transaction_json, txn_payload_json) VALUES ('b-fidelity',9,?,?,?,NULL)",
                (COVERED_REASON, json.dumps({}),
                 json.dumps({"covered": {"start_date": "2017-02-10", "end_date": "2023-12-19"},
                             "candidates": [], "candidate_count": 0})),
            )
        self.assertEqual(self._refresh(), 0)

    # ---- dual dates ----------------------------------------------------

    def test_the_twin_is_found_under_either_of_its_own_dates(self):
        # A stored row is indexed under both its posted and authorized dates, for the same reason the
        # ingestion path does it: the two sources may have filed it under different ones.
        self._existing("mint-1", "2023-08-25", -4.28, "Blackbird", authorized="2023-08-18")
        self._rejected(1, "2023-08-17", -4.28)

        self.assertEqual(self._refresh(), 1)
        _, matched = self._stored(1)
        self.assertEqual([c["id"] for c in matched["candidates"]], ["mint-1"])

    def test_it_does_not_re_run_the_cross_account_transfer_fallback(self):
        # That fallback issues a query PER unexplained entry and was the whole cost of this pass (~250ms
        # on a 60k-row ledger, versus ~22ms without). Re-running it is near-pure waste: an entry only
        # reaches here by having found nothing at import time, when the fallback already ran on the same
        # question with its own ±3 window. Disabled by passing the lookup no connection — a future change
        # that hands it one would silently restore the cost, so this pins it.
        self._existing("mint-1", "2023-08-20", -4.28, "Blackbird")
        self._rejected(1, "2023-08-17", -4.28)
        self._rejected(2, "2023-09-02", -99.99)  # finds nothing → would trigger the fallback

        with mock.patch.object(duplicate_detection, "find_cross_account_transfer_candidates") as fallback:
            self._refresh()
        fallback.assert_not_called()

    def test_running_it_twice_changes_nothing_the_second_time(self):
        self._existing("mint-1", "2023-08-20", -4.28, "Blackbird")
        self._rejected(1, "2023-08-17", -4.28)
        self.assertEqual(self._refresh(), 1)
        self.assertEqual(self._refresh(), 0)


if __name__ == "__main__":
    unittest.main()
