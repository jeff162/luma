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
                "VALUES (?, 'Rewards Card', 'Rewards Card', 'credit', ?)",
                (self.ACCOUNT, SHARED_OWNER_ID),
            )
            for bid, name in (("b-covering", "aggregator-export.csv"), ("b-incoming", "bank-export.csv")):
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

    def _existing(self, txn_id, day, amount, name, *, batch="b-covering", account=None, authorized=None):
        with self._db() as conn:
            conn.execute(
                "INSERT INTO txn (id, account_id, owner_id, amount, merchant_name, display_name,"
                " raw_name, date, authorized_date, is_pending, content_hash, import_batch_id)"
                " VALUES (?,?,?,?,?,?,?,?,?,0,?,?)",
                (txn_id, account or self.ACCOUNT, SHARED_OWNER_ID, amount, name, name, name, day,
                 authorized, f"hash-{txn_id}", batch),
            )

    def _rejected(self, row_number, day, amount, *, reason=COVERED_REASON, candidates=None,
                  account=None, batch="b-incoming", name=None):
        """A stored coverage rejection, as `save_batch_duplicate_rows` writes one."""
        matched = {
            "covered": {"start_date": "2017-02-10", "end_date": "2023-12-19", "source_batch_id": "b-covering"},
            "candidates": candidates or [],
            "candidate_count": len(candidates or []),
        }
        payload = {"account_id": account or self.ACCOUNT, "date": day, "amount": amount}
        if name:
            # The descriptor the refresh tiers candidates against, exactly as the import stored it.
            payload.update({"merchant_name": name, "raw_name": name})
        with self._db() as conn:
            conn.execute(
                "INSERT INTO import_batch_duplicate (batch_id, row_number, reason, values_json,"
                " matched_transaction_json, txn_payload_json) VALUES (?,?,?,?,?,?)",
                (batch, row_number, reason, json.dumps({}), json.dumps(matched), json.dumps(payload)),
            )

    def _stored(self, row_number, batch="b-incoming"):
        with self._db() as conn:
            row = conn.execute(
                "SELECT * FROM import_batch_duplicate WHERE batch_id = ? AND row_number = ?",
                (batch, row_number),
            ).fetchone()
        return dict(row), json.loads(row["matched_transaction_json"])

    def _refresh(self):
        with self._db() as conn:
            return refresh_unexplained_coverage_candidates(conn, "b-incoming")

    # ---- the reported case ---------------------------------------------

    def test_a_three_day_gap_gains_the_explanation_it_could_not_produce_before(self):
        # One charge dated the 17th by one export and the 20th by another, same amount and account.
        # Correctly rejected as covered; wrongly reported as unexplained.
        self._existing("covering-1", "2023-08-20", -4.28, "Corner Doughnuts")
        self._rejected(1, "2023-08-17", -4.28)

        self.assertEqual(self._refresh(), 1)

        _, matched = self._stored(1)
        self.assertEqual([c["id"] for c in matched["candidates"]], ["covering-1"])
        self.assertEqual(matched["candidate_count"], 1)
        self.assertEqual(matched["candidates"][0]["day_offset"], 3)

    def test_it_leaves_the_verdict_and_the_reason_exactly_as_they_were(self):
        # It explains a decision; it never revisits one.
        self._existing("covering-1", "2023-08-20", -4.28, "Corner Doughnuts")
        self._rejected(1, "2023-08-17", -4.28)
        with self._db() as conn:
            conn.execute(
                "UPDATE import_batch_duplicate SET reviewed_at = '2026-01-01T00:00:00Z'"
                " WHERE batch_id = 'b-incoming' AND row_number = 1"
            )

        self._refresh()

        row, matched = self._stored(1)
        self.assertEqual(row["reason"], COVERED_REASON)
        self.assertEqual(row["reviewed_at"], "2026-01-01T00:00:00Z")
        self.assertEqual(matched["covered"]["source_batch_id"], "b-covering",
                         "the covering range that caused the rejection must survive untouched")

    def test_an_entry_that_already_named_a_twin_is_never_re_pointed(self):
        # The user may have acted on the existing explanation — enriched from it, or reviewed it. A
        # refresh that silently swapped the named row would invalidate that without saying so.
        self._existing("covering-1", "2023-08-20", -4.28, "Corner Doughnuts")
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
        self._existing("covering-1", "2023-08-20", -4.28, "Corner Doughnuts")
        with self._db() as conn:
            conn.execute(
                "INSERT INTO import_batch_duplicate (batch_id, row_number, reason, values_json,"
                " matched_transaction_json, txn_payload_json) VALUES ('b-incoming',1,?,?,?,?)",
                ("Matches an existing transaction", json.dumps({}),
                 json.dumps({"id": "covering-1", "date": "2023-08-20", "amount": -4.28}),
                 json.dumps({"account_id": self.ACCOUNT, "date": "2023-08-17", "amount": -4.28})),
            )
        self.assertEqual(self._refresh(), 0)

    def test_a_row_this_same_batch_imported_is_a_valid_explanation(self):
        # The real case this turned up on: one file carried the same charge under two different account
        # labels, so one copy imported and the other was rejected by coverage. The imported copy is the
        # explanation. A rejected row is never inserted, so it can never be offered as its own twin —
        # there is nothing to guard against here, and an earlier version of this pass wrongly excluded
        # same-batch rows, hiding precisely the answer the report exists to give.
        self._existing("same-file-1", "2023-08-20", -4.28, "Corner Doughnuts", batch="b-incoming")
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
        self._existing("covering-1", "2023-08-20", -4.28, "Corner Doughnuts", account="acct-other")
        self._rejected(1, "2023-08-17", -4.28)
        self.assertEqual(self._refresh(), 0)

    def test_a_pending_or_trashed_row_is_not_offered_as_the_twin(self):
        self._existing("covering-1", "2023-08-20", -4.28, "Corner Doughnuts")
        with self._db() as conn:
            conn.execute("UPDATE txn SET trashed_at = '2026-01-01T00:00:00Z' WHERE id = 'covering-1'")
        self._rejected(1, "2023-08-17", -4.28)
        self.assertEqual(self._refresh(), 0)

    def test_an_entry_with_no_usable_payload_is_skipped_rather_than_guessed_at(self):
        self._existing("covering-1", "2023-08-20", -4.28, "Corner Doughnuts")
        with self._db() as conn:
            conn.execute(
                "INSERT INTO import_batch_duplicate (batch_id, row_number, reason, values_json,"
                " matched_transaction_json, txn_payload_json) VALUES ('b-incoming',9,?,?,?,NULL)",
                (COVERED_REASON, json.dumps({}),
                 json.dumps({"covered": {"start_date": "2017-02-10", "end_date": "2023-12-19"},
                             "candidates": [], "candidate_count": 0})),
            )
        self.assertEqual(self._refresh(), 0)

    # ---- dual dates ----------------------------------------------------

    def test_the_twin_is_found_under_either_of_its_own_dates(self):
        # A stored row is indexed under both its posted and authorized dates, for the same reason the
        # ingestion path does it: the two sources may have filed it under different ones.
        self._existing("covering-1", "2023-08-25", -4.28, "Corner Doughnuts", authorized="2023-08-18")
        self._rejected(1, "2023-08-17", -4.28)

        self.assertEqual(self._refresh(), 1)
        _, matched = self._stored(1)
        self.assertEqual([c["id"] for c in matched["candidates"]], ["covering-1"])

    def test_it_does_not_re_run_the_cross_account_transfer_fallback(self):
        # That fallback issues a query PER unexplained entry and was the whole cost of this pass (~250ms
        # on a 60k-row ledger, versus ~22ms without). Re-running it is near-pure waste: an entry only
        # reaches here by having found nothing at import time, when the fallback already ran on the same
        # question with its own ±3 window. Disabled by passing the lookup no connection — a future change
        # that hands it one would silently restore the cost, so this pins it.
        self._existing("covering-1", "2023-08-20", -4.28, "Corner Doughnuts")
        self._rejected(1, "2023-08-17", -4.28)
        self._rejected(2, "2023-09-02", -99.99)  # finds nothing → would trigger the fallback

        with mock.patch.object(duplicate_detection, "find_cross_account_transfer_candidates") as fallback:
            self._refresh()
        fallback.assert_not_called()

    # ---- the linked group ----------------------------------------------

    IN_SCOPE_REASON = "Falls within the fully covered date range from an earlier import in this account scope"

    def _sibling_account(self):
        with self._db() as conn:
            conn.execute(
                "INSERT INTO account (id, name, display_name, type, owner_id, parent_account_id)"
                " VALUES ('acct-sibling','Sibling','Sibling','credit',?,?)",
                (SHARED_OWNER_ID, self.ACCOUNT),
            )

    def test_an_in_scope_reject_is_explained_by_a_siblings_copy(self):
        # In-scope coverage rejects on a whole linked group's claim, so the twin is routinely the
        # sibling's copy of the charge. Filtering the refresh on the rejected row's own account rebuilt
        # the very blind spot that left the entry unexplained at import time.
        self._sibling_account()
        self._existing("sib-1", "2023-08-17", -4.28, "Corner Doughnuts", account="acct-sibling")
        self._rejected(1, "2023-08-17", -4.28, reason=self.IN_SCOPE_REASON)

        self.assertEqual(self._refresh(), 1)
        _, matched = self._stored(1)
        self.assertEqual([c["id"] for c in matched["candidates"]], ["sib-1"])

    def test_a_same_source_reject_still_ignores_the_sibling(self):
        # Rule 1's claim covers one account, not the group, so its explanation must stay there too.
        self._sibling_account()
        self._existing("sib-1", "2023-08-17", -4.28, "Corner Doughnuts", account="acct-sibling")
        self._rejected(1, "2023-08-17", -4.28)  # same-source reason

        self.assertEqual(self._refresh(), 0)

    # ---- the text tiering the import applies -----------------------------

    def test_it_does_not_hand_back_a_row_the_import_filtered_out(self):
        # This pass runs on every report open. Without the same text test the import applied, it would
        # re-add the coincidental same-amount rows the import had just excluded — the report would fix
        # itself on import and un-fix itself the moment someone looked at it.
        self._existing("covering-1", "2023-08-20", -4.28, "Corner Doughnuts")
        self._rejected(1, "2023-08-17", -4.28, name="Riverside Hardware")

        self.assertEqual(self._refresh(), 0)
        _, matched = self._stored(1)
        self.assertEqual(matched["candidates"], [])

    def test_it_still_explains_a_row_whose_twin_agrees_on_wording(self):
        # The other side of the same test — tiering narrows the list, it does not disable the pass.
        self._existing("covering-1", "2023-08-20", -4.28, "Corner Doughnuts")
        self._rejected(1, "2023-08-17", -4.28, name="Corner Doughnuts")

        self.assertEqual(self._refresh(), 1)
        _, matched = self._stored(1)
        self.assertEqual([c["id"] for c in matched["candidates"]], ["covering-1"])
        self.assertEqual(matched["candidates"][0]["text_relation"], "exact")

    def test_an_entry_with_no_descriptor_is_still_explained(self):
        # A nameless money-movement leg has nothing to compare, and the filter must not read that
        # silence as disagreement — this is the pre-existing payload shape, with no name at all.
        self._existing("covering-1", "2023-08-20", -4.28, "Corner Doughnuts")
        self._rejected(1, "2023-08-17", -4.28)

        self.assertEqual(self._refresh(), 1)
        _, matched = self._stored(1)
        self.assertEqual([c["id"] for c in matched["candidates"]], ["covering-1"])

    def test_running_it_twice_changes_nothing_the_second_time(self):
        self._existing("covering-1", "2023-08-20", -4.28, "Corner Doughnuts")
        self._rejected(1, "2023-08-17", -4.28)
        self.assertEqual(self._refresh(), 1)
        self.assertEqual(self._refresh(), 0)


if __name__ == "__main__":
    unittest.main()
