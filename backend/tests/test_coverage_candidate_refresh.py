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
from backend.services.duplicate_detection import (
    coverage_review_substate,
    refresh_unexplained_coverage_candidates,
)

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

    def _existing(self, txn_id, day, amount, name, *, batch="b-covering", account=None, posted=None):
        with self._db() as conn:
            conn.execute(
                "INSERT INTO txn (id, account_id, owner_id, amount, merchant_name, display_name,"
                " raw_name, date, posted_date, is_pending, content_hash, import_batch_id)"
                " VALUES (?,?,?,?,?,?,?,?,?,0,?,?)",
                (txn_id, account or self.ACCOUNT, SHARED_OWNER_ID, amount, name, name, name, day,
                 posted, f"hash-{txn_id}", batch),
            )

    def _rejected(self, row_number, day, amount, *, reason=COVERED_REASON, candidates=None,
                  account=None, batch="b-incoming", name=None):
        """A stored coverage rejection, as `save_batch_duplicate_rows` writes one — sub-state included,
        since that column is written at import rather than derived when the report is read."""
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
                " matched_transaction_json, txn_payload_json, review_substate) VALUES (?,?,?,?,?,?,?)",
                (batch, row_number, reason, json.dumps({}), json.dumps(matched), json.dumps(payload),
                 coverage_review_substate(matched)),
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

    def test_the_sub_state_moves_with_the_candidate_list_it_is_classified_from(self):
        # The sub-state is stored, not re-derived per read, so a refresh that names a twin has to restate
        # it. Left behind, the row would keep reading "no specific match" and the file card would go on
        # counting a rejection that now explains itself — the exact staleness storing it invites.
        self._existing("covering-1", "2023-08-20", -4.28, "Corner Doughnuts")
        self._rejected(1, "2023-08-17", -4.28)
        self.assertEqual(self._stored(1)[0]["review_substate"], "no_match")

        self._refresh()

        # Three days out, so the pair is worth a glance rather than settled.
        self.assertEqual(self._stored(1)[0]["review_substate"], "matched_near_date")

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
        # A stored row is indexed under both its transaction and posted dates, for the same reason the
        # ingestion path does it: the two sources may have filed it under different ones.
        self._existing("covering-1", "2023-08-18", -4.28, "Corner Doughnuts", posted="2023-08-25")
        self._rejected(1, "2023-08-17", -4.28)

        self.assertEqual(self._refresh(), 1)
        _, matched = self._stored(1)
        self.assertEqual([c["id"] for c in matched["candidates"]], ["covering-1"])

    def test_the_transfer_fallback_runs_only_on_what_is_still_unexplained(self):
        # This asserted the fallback never ran at all until 2026-09-20. It issues a query PER entry and
        # was the whole cost of this pass (~250ms on a 60k-row ledger, versus ~22ms without), and an entry
        # only reaches here by having found nothing at import — when the fallback already ran on the same
        # question with the same ±3 window. That reasoning holds for the ledger as it *was* and not for
        # the ledger as it *is*: a twin imported a week after the verdict was stored is invisible to the
        # import and plainly visible now, which is the premise of this whole function.
        #
        # What keeps the cost honest is where it sits. It is a last resort inside the loop, on whatever
        # the same-account and linked-group reach could not explain — so an entry the cheap path settles
        # never pays for it. Hand it to the lookup instead (a connection on the context) and it fires for
        # every pending entry before any of them has been explained, which is the cost this pins against.
        self._existing("covering-1", "2023-08-20", -4.28, "Corner Doughnuts")
        self._rejected(1, "2023-08-17", -4.28)   # explained by the widened reach → never reaches it
        self._rejected(2, "2023-09-02", -99.99)  # nothing on the account → the last resort

        with mock.patch.object(duplicate_detection, "find_cross_account_transfer_candidates",
                               return_value=[]) as fallback:
            self._refresh()
        self.assertEqual([call.args[1:] for call in fallback.call_args_list],
                         [(self.ACCOUNT, "2023-09-02", -99.99)])

    def test_a_transfer_twin_that_arrived_after_the_verdict_is_picked_up(self):
        # The gap this closes, taken from a real ledger: a wallet funding leg was rejected as covered and
        # could name nothing, because the bank side of the same movement was imported a week later. The
        # import cannot see a row that does not exist yet; re-opening the report can, and that is the only
        # reason this pass exists.
        #
        # It is also the card-payment shape the name test is often said to miss — it misses it only when
        # the account's name is not what the other institution prints. Here it is.
        self._unrelated_account()
        self._existing("bank-side", "2023-08-19", 150.00, "AUTOPAY REWARDS CARD PMT", account="acct-unrelated")
        self._rejected(1, "2023-08-17", -150.00)

        self.assertEqual(self._refresh(), 1)
        _, matched = self._stored(1)
        self.assertEqual([c["id"] for c in matched["candidates"]], ["bank-side"])
        self.assertTrue(matched["candidates"][0]["cross_account"])

    def test_the_sub_state_follows_a_twin_found_across_accounts(self):
        # Settled once it can name the other leg, so it drops out of the card's "to review" count — the
        # same rule as any other explanation, and the reason the sub-state is restated on every rewrite.
        self._unrelated_account()
        self._existing("bank-side", "2023-08-19", 150.00, "AUTOPAY REWARDS CARD PMT", account="acct-unrelated")
        self._rejected(1, "2023-08-17", -150.00)
        self.assertEqual(self._stored(1)[0]["review_substate"], "no_match")

        self._refresh()

        self.assertEqual(self._stored(1)[0]["review_substate"], "transfer_match")

    # ---- the linked group ----------------------------------------------

    IN_SCOPE_REASON = "Falls within the fully covered date range from an earlier import in this account scope"

    def _unrelated_account(self):
        """An account in no relation to the rejected row's — what "elsewhere in the ledger" now means,
        since both coverage rules search the linked group and a sibling is no longer elsewhere."""
        with self._db() as conn:
            conn.execute(
                "INSERT INTO account (id, name, display_name, type, owner_id)"
                " VALUES ('acct-unrelated','Unrelated','Unrelated','credit',?)", (SHARED_OWNER_ID,),
            )

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

    def test_a_same_source_reject_reaches_the_sibling_too(self):
        # Inverted with the rule itself (2026-09-20): rule 1 searches the linked group now, so the refresh
        # that re-explains its rejections has to search the same ground. Leaving it account-only would
        # make a re-opened report answer differently from the import that produced it.
        self._sibling_account()
        self._existing("sib-1", "2023-08-17", -4.28, "Corner Doughnuts", account="acct-sibling")
        self._rejected(1, "2023-08-17", -4.28)  # same-source reason

        self.assertEqual(self._refresh(), 1)
        _, matched = self._stored(1)
        self.assertEqual([c["id"] for c in matched["candidates"]], ["sib-1"])

    # ---- the ledger probe, for entries the tiering leaves with nothing ----

    def test_a_named_same_source_reject_is_explained_by_a_corroborating_charge_elsewhere(self):
        # The reported case. A coincidental same-amount charge three days out fills the candidate list,
        # the tiering discards it for sharing no wording, and the entry is left saying "no specific
        # match" — while the real twin, filed by a second source under a sibling account with the same
        # descriptor, was never looked at. This is NOT in tension with the sibling test above: that one
        # pins which rows count as *scope* candidates for a rule whose claim covers one account. This is
        # the separate, merchant-corroborated question the import path asks of the whole ledger, on the
        # entries where a coincidence in the list stopped it being asked. The twin sits on an UNRELATED
        # account: once both coverage rules search the linked group, a sibling's copy is found by the
        # scope lookup and never reaches this probe at all.
        self._unrelated_account()
        self._existing("decoy", "2023-08-20", -4.28, "Riverside Hardware")
        self._existing("far-twin", "2023-08-17", -4.28, "Northgate Annual Fee", account="acct-unrelated")
        self._rejected(1, "2023-08-17", -4.28, name="Northgate Annual Fee")

        self.assertEqual(self._refresh(), 1)
        _, matched = self._stored(1)
        self.assertEqual([c["id"] for c in matched["candidates"]], ["far-twin"])
        self.assertTrue(matched["candidates"][0]["cross_account"],
                        "an off-account explanation has to read as one, not as a same-account match")

    def test_an_explained_entry_never_reaches_the_probe(self):
        # It costs a query per entry, so it runs only where the report would otherwise have nothing to
        # say — the same bound that keeps this pass cheap enough to run on every report open.
        self._existing("covering-1", "2023-08-20", -4.28, "Corner Doughnuts")
        self._rejected(1, "2023-08-17", -4.28, name="Corner Doughnuts")

        with mock.patch.object(duplicate_detection, "find_ledger_payment_match") as probe:
            self.assertEqual(self._refresh(), 1)
        probe.assert_not_called()

    def test_an_unrelated_charge_of_the_same_amount_does_not_become_the_explanation(self):
        # The probe corroborates on a distinctive merchant token, not on amount alone. Without that it
        # would hand back exactly the coincidences the tiering exists to remove, one account over.
        #
        # Both decoys sit outside the exact/±1 band on purpose. Inside it the tiering keeps a candidate
        # regardless of wording — the deliberate exemption for two sources describing one charge in
        # different words — so a same-day sibling row would be accepted as the explanation and this would
        # be testing that exemption rather than the probe.
        self._sibling_account()
        self._existing("decoy", "2023-08-20", -4.28, "Riverside Hardware")
        self._existing("sib-other", "2023-08-13", -4.28, "Lakeshore Cleaners", account="acct-sibling")
        self._rejected(1, "2023-08-17", -4.28, name="Northgate Annual Fee")

        self.assertEqual(self._refresh(), 0)
        _, matched = self._stored(1)
        self.assertEqual(matched["candidates"], [])

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
