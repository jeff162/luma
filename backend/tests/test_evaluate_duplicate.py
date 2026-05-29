# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: GPL-3.0-or-later

"""
Direct unit tests for `evaluate_duplicate`, the per-row dedupe rule evaluator in
`backend/services/duplicate_detection.py`.

These tests construct a `DedupeContext` programmatically (no DB) and drive `evaluate_duplicate`
with specific inputs to pin the behavior of each rule. The CSV-import integration tests cover
the end-to-end flow; these cover individual rules in isolation, which is the layer where rule
preconditions and verdict shapes are easiest to reason about.
"""

from __future__ import annotations

import unittest

from backend.routers.import_export import (
    _candidate_summary,
    _date_in_import_coverage_window,
    _duplicate_amount_key,
    _find_textual_duplicate_candidate,
    _match_terminal_day_candidate,
)
from backend.services.duplicate_detection import (
    DedupeContext,
    DedupeVerdict,
    evaluate_duplicate,
)


def _helpers_dict() -> dict:
    """Same helper-callable shape that import_export.py passes into the live evaluator."""
    return {
        "date_in_window":       _date_in_import_coverage_window,
        "candidate_summary":    _candidate_summary,
        "match_terminal":       _match_terminal_day_candidate,
        "duplicate_amount_key": _duplicate_amount_key,
        "find_textual":         _find_textual_duplicate_candidate,
    }


def _empty_context(**overrides) -> DedupeContext:
    """Build a baseline DedupeContext with sensible empty defaults. Tests override the few
    fields they care about so the intent is visible on the test surface, not buried in setup."""
    base = dict(
        existing_hashes_by_account={},
        existing_hashes_by_effective_account={},
        existing_rows_by_account_amount={},
        existing_rows_by_effective_account_amount={},
        import_coverage_by_csv_value={},
        import_coverage_by_scope_id={},
        terminal_day_candidates_by_csv_day={},
        terminal_day_candidates_by_scope_day={},
        accounts_with_prior_history=set(),
        explicit_alias_csv_values=set(),
        account_duplicate_compare_targets={},
        coverage_strategy_enabled=True,
        text_strategy_enabled=True,
        helpers=_helpers_dict(),
    )
    base.update(overrides)
    return DedupeContext(**base)


class EvaluateDuplicateRuleTests(unittest.TestCase):
    # ---- coverage-window rule ------------------------------------------

    def test_coverage_same_source_with_candidate_produces_specific_match(self):
        # Coverage window from the SAME csv_value, with an existing row on the receiving account
        # that matches by (date, amount). The verdict's matched.candidates should carry that row.
        ctx = _empty_context(
            import_coverage_by_csv_value={
                "Checking": [{
                    "start_date": "2025-10-01", "end_date": "2025-10-31",
                    "csv_value": "Checking", "account_id": "ACCT-1", "batch_id": "BATCH-A",
                }],
            },
            existing_rows_by_account_amount={
                "ACCT-1": {
                    _duplicate_amount_key("2025-10-15", -50.00): [{
                        "id": "TXN-EXISTING",
                        "date": "2025-10-15",
                        "merchant_name": "WHOLEFDS",
                        "amount": -50.00,
                        "account_id": "ACCT-1",
                        "import_batch_id": "BATCH-A",
                    }],
                },
            },
        )

        verdict = evaluate_duplicate(
            context=ctx,
            receiving_account_id="ACCT-1",
            csv_value="Checking",
            content_hash="hash-of-something-different",
            parsed_date="2025-10-15",
            amount=-50.00,
            scope_id="ACCT-1",
            txn_payload={"merchant_name": "WHOLE FOODS", "display_name": "WHOLE FOODS"},
        )

        self.assertTrue(verdict.hard_reject)
        self.assertEqual(verdict.matched["covered"]["start_date"], "2025-10-01")
        self.assertEqual(verdict.matched["covered"]["end_date"], "2025-10-31")
        self.assertEqual(verdict.matched["candidate_count"], 1)
        self.assertEqual(verdict.matched["candidates"][0]["id"], "TXN-EXISTING")

    def test_coverage_same_source_with_no_candidate_produces_zero_match_marker(self):
        # The 'covered date but no specific match' case the UI surfaces with NO SPECIFIC MATCH.
        # Coverage window exists but no row on the receiving account matches by date+amount.
        # The verdict still hard-rejects (current behavior preserved), but the matched dict has
        # an empty candidates list — the unified report renders this as a 'needs manual review'
        # entry instead of pretending to point at a specific transaction.
        ctx = _empty_context(
            import_coverage_by_csv_value={
                "Checking": [{
                    "start_date": "2025-10-01", "end_date": "2025-10-31",
                    "csv_value": "Checking", "account_id": "ACCT-1", "batch_id": "BATCH-A",
                }],
            },
            # No matching rows in existing_rows_by_account_amount for the (date, amount) key.
        )

        verdict = evaluate_duplicate(
            context=ctx,
            receiving_account_id="ACCT-1",
            csv_value="Checking",
            content_hash="hash-of-something-different",
            parsed_date="2025-10-15",
            amount=-50.00,
            scope_id="ACCT-1",
            txn_payload={"merchant_name": "WHOLE FOODS"},
        )

        self.assertTrue(verdict.hard_reject)
        self.assertIn("covered", verdict.matched)
        self.assertEqual(verdict.matched["candidate_count"], 0)
        self.assertEqual(verdict.matched["candidates"], [])
        # No fake amount echoed into matched (that was the bug we're guarding against).
        self.assertNotIn("amount", verdict.matched)

    def test_coverage_in_scope_skipped_when_receiving_account_is_brand_new(self):
        # Phase 1 invariant: a brand-new sibling account in a linked group must NOT inherit
        # hard-dedupe behavior from its siblings via the in-scope coverage rule. The receiving
        # account is absent from accounts_with_prior_history → rule's precondition fails →
        # passthrough verdict so the row reaches the post-batch soft-flag sweep.
        ctx = _empty_context(
            import_coverage_by_scope_id={
                "PARENT-1": [{
                    "start_date": "2025-10-01", "end_date": "2025-10-31",
                    "csv_value": "ChildA",  # different from current csv_value
                    "account_id": "SIBLING-A",  # NOT the receiving account
                    "batch_id": "BATCH-A",
                }],
            },
            # NEW-ACCT is brand-new — not in accounts_with_prior_history.
            accounts_with_prior_history=set(),
            account_duplicate_compare_targets={"ChildC": "PARENT-1"},  # via group_with_account_id
        )

        verdict = evaluate_duplicate(
            context=ctx,
            receiving_account_id="NEW-ACCT",
            csv_value="ChildC",
            content_hash="h",
            parsed_date="2025-10-15",
            amount=-50.00,
            scope_id="PARENT-1",
            txn_payload={"merchant_name": "WHOLE FOODS"},
        )

        # Row passes through to soft-flag review instead of being hard-rejected by coverage.
        self.assertTrue(verdict.passthrough)
        self.assertFalse(verdict.hard_reject)

    def test_coverage_in_scope_fires_when_receiving_account_has_prior_history(self):
        # Same coverage entry, but now the receiving account has prior history — the rule's
        # precondition is satisfied (the user is re-importing the same physical account under
        # a different alias). Hard-reject is correct here.
        ctx = _empty_context(
            import_coverage_by_scope_id={
                "PARENT-1": [{
                    "start_date": "2025-10-01", "end_date": "2025-10-31",
                    "csv_value": "OldAlias",
                    "account_id": "RECEIVING-ACCT",  # matches receiving
                    "batch_id": "BATCH-A",
                }],
            },
            accounts_with_prior_history={"RECEIVING-ACCT"},
        )

        verdict = evaluate_duplicate(
            context=ctx,
            receiving_account_id="RECEIVING-ACCT",
            csv_value="NewAlias",  # different csv_value triggers the in-scope path
            content_hash="h",
            parsed_date="2025-10-15",
            amount=-50.00,
            scope_id="PARENT-1",
            txn_payload={"merchant_name": "WHOLE FOODS"},
        )

        self.assertTrue(verdict.hard_reject)
        self.assertIn("covered", verdict.matched)

    # ---- exact-hash rules ----------------------------------------------

    def test_exact_hash_same_account_dominates_other_rules(self):
        # The high-confidence exact-hash rule fires first and short-circuits the chain — even
        # if a coverage window would also have matched. Confirms rule precedence.
        ctx = _empty_context(
            existing_hashes_by_account={
                "ACCT-1": {
                    "matching-hash": {
                        "id": "EXISTING",
                        "date": "2025-10-15",
                        "merchant_name": "WHOLEFDS",
                        "amount": -50.00,
                        "account_id": "ACCT-1",
                        "import_batch_id": "BATCH-A",
                    },
                },
            },
            import_coverage_by_csv_value={
                "Checking": [{
                    "start_date": "2025-10-01", "end_date": "2025-10-31",
                    "csv_value": "Checking", "account_id": "ACCT-1", "batch_id": "BATCH-A",
                }],
            },
        )

        verdict = evaluate_duplicate(
            context=ctx,
            receiving_account_id="ACCT-1",
            csv_value="Checking",
            content_hash="matching-hash",
            parsed_date="2025-10-15",
            amount=-50.00,
            scope_id="ACCT-1",
            txn_payload={},
        )

        self.assertTrue(verdict.hard_reject)
        self.assertEqual(verdict.reason, "Matches an existing transaction")
        # Specific-row matched, not coverage shape.
        self.assertEqual(verdict.matched["id"], "EXISTING")
        self.assertNotIn("covered", verdict.matched)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
