"""
The missing half of terminal-day reconciliation: a row whose **amount** the source revised.

`match_terminal_day_candidate` pairs on exact hash, then on amount alone — so a row whose descriptor
was rewritten between two exports still finds its twin, while a row whose amount moved matches neither
and lands as a second copy of a transaction already held. Measured across seven consecutive aggregator
exports of one ledger, every amount revision was a restaurant or cafe charge settling with its tip
added, 0-2 days inside the trailing window, and each had been imported twice.

The descriptor is all that is left to match on and is far too weak alone — two charges from one
merchant on one day at different amounts are ordinary — so the group is reconciled as a set. These
pin the shape that makes that safe: equal amounts pair off first, and only a lone leftover on each
side is a revision.
"""

from __future__ import annotations

import unittest

from backend.services.duplicate_detection import match_terminal_amount_revision

CAFE = "Citra A Fresh Cafe"


def candidate(amount: float, text: str = CAFE, consumed: bool = False) -> dict:
    return {
        "id": f"txn-{text}-{amount}",
        "date": "2026-08-25",
        "amount": amount,
        "merchant_name": text,
        "match_texts": [text],
        "content_hash": f"hash-{amount}",
        "_consumed": consumed,
    }


class ALoneLeftoverOnEachSideIsARevisionTests(unittest.TestCase):
    def test_the_held_row_is_returned_and_consumed(self):
        held = candidate(9.99)
        match = match_terminal_amount_revision(
            [held], amount=11.99, incoming_amounts=[11.99], incoming_text=CAFE,
        )
        self.assertIs(match, held)
        # Consumed so Rule 5 cannot hand the same row to a later incoming row as well.
        self.assertTrue(held["_consumed"])

    def test_punctuation_and_case_differences_do_not_defeat_the_text_match(self):
        held = candidate(9.99, text="CITRA A FRESH CAFE.")
        self.assertIsNotNone(match_terminal_amount_revision(
            [held], amount=11.99, incoming_amounts=[11.99], incoming_text="citra a fresh cafe",
        ))


class AnAmountThatPairsOffIsNotARevisionTests(unittest.TestCase):
    """The case that makes this safe to do at all: a second same-day charge from the same merchant."""

    def test_an_incoming_row_matching_a_held_amount_claims_nothing(self):
        held = candidate(9.99)
        self.assertIsNone(match_terminal_amount_revision(
            [held], amount=9.99, incoming_amounts=[9.99, 11.99], incoming_text=CAFE,
        ))

    def test_its_neighbour_is_then_genuinely_new_rather_than_a_revision(self):
        # The file carries both the held amount and a new one, so nothing was revised — the 9.99 pairs
        # off and the 11.99 is a second charge that must import. Row-at-a-time matching gets this wrong:
        # whichever row is evaluated first would take the candidate on the text match alone.
        held = candidate(9.99)
        self.assertIsNone(match_terminal_amount_revision(
            [held], amount=11.99, incoming_amounts=[9.99, 11.99], incoming_text=CAFE,
        ))
        self.assertFalse(held["_consumed"])

    def test_two_unpaired_rows_on_each_side_are_ambiguous(self):
        # Two readings exist and nothing chooses between them, so neither is asserted.
        self.assertIsNone(match_terminal_amount_revision(
            [candidate(9.99), candidate(12.50)],
            amount=11.99, incoming_amounts=[11.99, 14.00], incoming_text=CAFE,
        ))

    def test_one_held_row_against_two_arrivals_is_ambiguous(self):
        self.assertIsNone(match_terminal_amount_revision(
            [candidate(9.99)], amount=11.99, incoming_amounts=[11.99, 14.00], incoming_text=CAFE,
        ))


class OnlyTheSameDescriptorIsConsideredTests(unittest.TestCase):
    def test_a_different_merchant_is_not_a_revision(self):
        self.assertIsNone(match_terminal_amount_revision(
            [candidate(9.99, text="Seasons 52")],
            amount=11.99, incoming_amounts=[11.99], incoming_text=CAFE,
        ))

    def test_a_blank_descriptor_matches_nothing(self):
        self.assertIsNone(match_terminal_amount_revision(
            [candidate(9.99)], amount=11.99, incoming_amounts=[11.99], incoming_text="   ",
        ))

    def test_an_already_consumed_candidate_is_out_of_the_pool(self):
        self.assertIsNone(match_terminal_amount_revision(
            [candidate(9.99, consumed=True)],
            amount=11.99, incoming_amounts=[11.99], incoming_text=CAFE,
        ))

    def test_an_empty_pool_is_not_an_error(self):
        self.assertIsNone(match_terminal_amount_revision(
            [], amount=11.99, incoming_amounts=[11.99], incoming_text=CAFE,
        ))


if __name__ == "__main__":
    unittest.main()
