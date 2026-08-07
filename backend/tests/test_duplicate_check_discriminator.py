"""
Check-number discriminator for duplicate detection.

Two genuinely different checks can share date+amount+description ("Check"), so they collide on the
content hash AND on the terminal-day rule's amount fallback. The discriminator rescues that case by
treating rows with explicit, differing check numbers as not-the-same. It is deliberately
conservative — a number must be present on both sides — so rows predating check capture still dedupe
as before. These tests pin the helper and the terminal-day matcher (the spot a first/last-day
overlap actually routes through, where a content-hash change alone wouldn't help).
"""

from __future__ import annotations

import unittest

from backend.services.duplicate_detection import are_distinct_checks, explicit_check_number
from backend.services.duplicate_detection import match_terminal_day_candidate


class CheckDiscriminatorHelperTests(unittest.TestCase):
    def test_explicit_check_number_extraction(self):
        self.assertEqual(explicit_check_number("Check #1042"), "1042")
        self.assertEqual(explicit_check_number("Check"), None)
        self.assertEqual(explicit_check_number(None), None)

    def test_are_distinct_checks(self):
        self.assertTrue(are_distinct_checks("Check #1042", "Check #1099"))   # different numbers
        self.assertFalse(are_distinct_checks("Check #1042", "Check #1042"))  # same number
        self.assertFalse(are_distinct_checks("Check #1042", "Check"))        # one side has none
        self.assertFalse(are_distinct_checks("Check", "Check"))              # neither has a number


class TerminalDayCheckDiscriminatorTests(unittest.TestCase):
    def _candidate(self, **over):
        row = {"id": "c1", "content_hash": "H", "amount": 120.0, "merchant_name": "Check #1042"}
        row.update(over)
        return row

    def test_different_check_is_not_matched_or_consumed(self):
        candidate = self._candidate()
        # Same content hash + amount, but a different check number -> must not match (and so the
        # candidate stays available/unconsumed for a genuine match).
        result = match_terminal_day_candidate(
            [candidate], content_hash="H", amount=120.0, incoming_merchant="Check #1099"
        )
        self.assertIsNone(result)
        self.assertNotIn("_consumed", candidate)

    def test_same_check_still_matches(self):
        candidate = self._candidate()
        result = match_terminal_day_candidate(
            [candidate], content_hash="H", amount=120.0, incoming_merchant="Check #1042"
        )
        self.assertIs(result, candidate)
        self.assertTrue(candidate.get("_consumed"))

    def test_non_check_amount_fallback_is_unaffected(self):
        # The amount-only fallback (different hash, same amount) must keep working for non-checks.
        candidate = self._candidate(content_hash="H1", merchant_name="Coffee Shop")
        result = match_terminal_day_candidate(
            [candidate], content_hash="H2", amount=120.0, incoming_merchant="Coffee Shop"
        )
        self.assertIs(result, candidate)

    def test_backward_compatible_without_incoming_merchant(self):
        candidate = self._candidate()
        result = match_terminal_day_candidate([candidate], content_hash="H", amount=120.0)
        self.assertIs(result, candidate)


if __name__ == "__main__":
    unittest.main()
