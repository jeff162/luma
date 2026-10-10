"""
What never reaches the duplicate report: a source restating its own prior import.

Re-exporting with an overlapping window is the commonest thing an import does, and each restated row
was being refused *and recorded* — raw values, the matched transaction, and the payload that would
have inserted it. On a real ledger that was 98.7% of every report row and 99% of its bytes, more than
every transaction put together, and it rode every backup. There is nothing in those records to read:
the transaction each one duplicates is in the ledger, and is the record.

So they are counted and not stored. What makes that safe is the narrowness of the predicate — it is
Rule 1 only, with a real source label, and only where the rejection asks nothing of anyone. These pin
each of those conditions, because widening any one of them would start discarding a refusal somebody
would have wanted to look at.
"""

from __future__ import annotations

import unittest

from backend.services.duplicate_detection import (
    ADVISORY_REVIEW_SUBSTATES,
    coverage_review_substate,
    is_settled_source_restatement,
)


def coverage_match(*, source: str = "Travel Rewards", candidates=None) -> dict:
    return {
        "covered": {"start_date": "2026-08-01", "end_date": "2026-08-20",
                    "source_batch_id": "batch-1", "source_csv_value": source},
        "candidates": candidates if candidates is not None else [{"id": "txn-1", "day_offset": 0}],
        "candidate_count": len(candidates) if candidates is not None else 1,
    }


class WhichRefusalsAreWorthNoRecordTests(unittest.TestCase):
    """`is_settled_source_restatement` — the predicate deciding what never reaches the report."""

    def test_a_settled_hit_on_the_sources_own_coverage_is_a_restatement(self):
        self.assertTrue(is_settled_source_restatement(
            coverage_match(), csv_value="Travel Rewards"))

    def test_another_sources_claim_on_the_same_account_is_not(self):
        # Rule 2: a sibling under the same linked group describing this account. That is a cross-source
        # question and the report keeps it.
        self.assertFalse(is_settled_source_restatement(
            coverage_match(source="Harborline Checking ...8130"), csv_value="Travel Rewards"))

    def test_an_empty_source_label_is_never_a_restatement(self):
        # A single-account import carries no label, and an empty label is never indexed as coverage —
        # so a match wearing one here came from Rule 2, not Rule 1.
        self.assertFalse(is_settled_source_restatement(
            coverage_match(source=""), csv_value=""))

    def test_a_covered_date_that_paired_with_nothing_keeps_its_row(self):
        self.assertFalse(is_settled_source_restatement(
            coverage_match(candidates=[]), csv_value="Travel Rewards"))

    def test_a_twin_two_days_out_keeps_its_row(self):
        self.assertFalse(is_settled_source_restatement(
            coverage_match(candidates=[{"id": "txn-1", "day_offset": 2}]), csv_value="Travel Rewards"))

    def test_candidates_all_on_other_accounts_are_still_a_restatement(self):
        # `transfer_match`. The coverage rule made the verdict and the probe only named a twin on
        # another account, so it asks nothing — which is what the card has always said about it, and
        # the two now read the same list. On a real ledger this was 1,727 further records.
        self.assertTrue(is_settled_source_restatement(
            coverage_match(candidates=[{"id": "txn-1", "day_offset": 0, "cross_account": True}]),
            csv_value="Travel Rewards"))

    def test_the_kept_sub_states_are_exactly_the_ones_the_card_flags(self):
        # The invariant this predicate and the card's "to review" count share: a row the count ignores
        # is a row that never needed storing. Stated here so widening one without the other fails.
        for substate in ADVISORY_REVIEW_SUBSTATES:
            self.assertIn(substate, ("no_match", "matched_near_date"))
        kept = {
            "no_match": coverage_match(candidates=[]),
            "matched_near_date": coverage_match(candidates=[{"id": "txn-1", "day_offset": 2}]),
        }
        for substate, matched in kept.items():
            self.assertEqual(coverage_review_substate(matched), substate)
            self.assertFalse(is_settled_source_restatement(matched, csv_value="Travel Rewards"))

    def test_a_rejection_that_is_not_a_coverage_hit_is_not_a_restatement(self):
        self.assertFalse(is_settled_source_restatement(
            {"id": "txn-1", "amount": 9.99}, csv_value="Travel Rewards"))
        self.assertFalse(is_settled_source_restatement(None, csv_value="Travel Rewards"))


if __name__ == "__main__":
    unittest.main()
