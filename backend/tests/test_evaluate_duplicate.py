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
from unittest import mock

from backend.services import duplicate_detection

from backend.services.duplicate_detection import (
    DedupeContext,
    duplicate_amount_key as _duplicate_amount_key,
    evaluate_duplicate,
    row_match_texts,
)


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

    # ---- coverage rescue of genuinely-new named payments ---------------
    # A named payment (not a nameless money-movement leg) that coverage would reject with no
    # same-account/transfer candidate is only a duplicate when a corroborating charge exists elsewhere
    # in the ledger (find_payment_match). Otherwise it is genuinely new — a balance-funded payment the
    # covering import never saw — and must import.

    def _coverage_ctx(self):
        # `conn` only has to be non-None for the evaluator to consult the ledger fallbacks; the
        # lookup itself is patched per test, so no database is involved.
        return _empty_context(
            import_coverage_by_csv_value={
                "PayPal": [{
                    "start_date": "2025-10-01", "end_date": "2025-10-31",
                    "csv_value": "PayPal", "account_id": "ACCT-1", "batch_id": "BATCH-A",
                }],
            },
            conn=object(),
        )

    def _eval_covered_payment(self, payment_match, merchant):
        # Both ledger fallbacks are stubbed: the transfer lookup runs first and must find nothing for
        # the payment-corroboration branch (the one under test) to be reached at all.
        with mock.patch.object(duplicate_detection, "find_cross_account_transfer_candidates",
                               return_value=[]), \
             mock.patch.object(duplicate_detection, "find_ledger_payment_match",
                               return_value=payment_match):
            return evaluate_duplicate(
                context=self._coverage_ctx(), receiving_account_id="ACCT-1", csv_value="PayPal",
                content_hash="unique-hash", parsed_date="2025-10-15", amount=-10.00,
                scope_id="ACCT-1", txn_payload={"merchant_name": merchant, "display_name": merchant},
            )

    def test_covered_named_payment_with_no_ledger_charge_imports(self):
        # No corroborating charge (find_ledger_payment_match -> None): genuinely new, so it passes through.
        verdict = self._eval_covered_payment(None, "VeloViewer Ltd")
        self.assertTrue(verdict.passthrough)
        self.assertFalse(verdict.hard_reject)

    def test_covered_named_payment_with_a_ledger_charge_stays_rejected(self):
        # A matching card charge exists (find_payment_match -> a candidate): a real duplicate, kept
        # rejected, and the corroborating charge is surfaced in the report.
        charge = {"id": "CARD-CHARGE", "date": "2025-10-16", "merchant_name": "PAYPAL RANDONNEURS",
                  "amount": -10.00, "account_id": "ACCT-CARD", "account_name": "Northgate", "cross_account": True}
        verdict = self._eval_covered_payment(charge, "RANDONNEURS USA")
        self.assertTrue(verdict.hard_reject)
        self.assertEqual(verdict.matched["candidate_count"], 1)
        self.assertEqual(verdict.matched["candidates"][0]["id"], "CARD-CHARGE")

    def test_covered_nameless_money_movement_leg_stays_rejected(self):
        # A nameless money-movement leg is never rescued (the payment path gates on a merchant name),
        # even with the helper wired — it keeps the 'covered, no specific match' hard-reject.
        verdict = self._eval_covered_payment(None, "")
        self.assertTrue(verdict.hard_reject)
        self.assertEqual(verdict.matched["candidate_count"], 0)

    # ---- naming the match when every same-account candidate is a coincidence ----
    # The candidate lookup finds rows by amount and date alone, so an unrelated same-amount charge can
    # occupy the list on its own. The tiering then discards it for having no text in common, and the row
    # reports "no specific match" — while the ledger probe, the only step that looks at other accounts,
    # never ran at all, because a candidate existed. These pin the second, display-side probe that fixes
    # that, and pin that it stays display-side.

    def _decoy_ctx(self):
        """The reported shape: one unrelated charge of the same amount, five days out, sharing no text
        with the incoming row — enough to fill the candidate list, not enough to survive the tiering."""
        ctx = self._coverage_ctx()
        ctx.existing_rows_by_account_amount = {
            "ACCT-1": {_duplicate_amount_key("2025-10-10", -10.00): [{
                "id": "COINCIDENCE", "date": "2025-10-10", "amount": -10.00, "account_id": "ACCT-1",
                "merchant_name": "Northgate Parks & Recreation", "import_batch_id": "BATCH-A",
                "source_texts": row_match_texts(
                    "Northgate Parks & Recreation", "NORTHGATE PARKS AND RECREATION", None),
            }]},
        }
        return ctx

    # The twin as a second source filed it: a sibling account, the same signed amount, the same day.
    _TWIN = {"id": "TWIN", "date": "2025-10-15", "merchant_name": "Annual Membership Fee",
             "amount": -10.00, "account_id": "ACCT-SIBLING", "account_name": "Harborline Rewards 2741",
             "cross_account": True, "payment_match": True}

    def _eval_named_row(self, payment_match, ctx=None, merchant="Annual Membership Fee"):
        with mock.patch.object(duplicate_detection, "find_cross_account_transfer_candidates",
                               return_value=[]), \
             mock.patch.object(duplicate_detection, "find_ledger_payment_match",
                               return_value=payment_match) as probe:
            verdict = evaluate_duplicate(
                context=ctx if ctx is not None else self._decoy_ctx(),
                receiving_account_id="ACCT-1", csv_value="PayPal", content_hash="unique-hash",
                parsed_date="2025-10-15", amount=-10.00, scope_id="ACCT-1",
                txn_payload={"merchant_name": merchant, "raw_name": merchant.upper()},
            )
        return verdict, probe

    def test_a_coincidental_candidate_no_longer_buries_the_real_match(self):
        # The whole point: the report names the corroborating charge instead of reading NO SPECIFIC
        # MATCH, and the coincidence that was standing in its place is gone from the list.
        verdict, probe = self._eval_named_row(self._TWIN)
        self.assertTrue(verdict.hard_reject)
        self.assertEqual([c["id"] for c in verdict.matched["candidates"]], ["TWIN"])
        self.assertEqual(verdict.matched["candidate_count"], 1)
        self.assertEqual(probe.call_count, 1, "one probe per row — the empty-list branch did not also run")

    def test_the_display_probe_never_turns_a_rejection_into_an_import(self):
        # Nothing corroborates, so the row keeps exactly the verdict it had before this branch existed.
        # The escape hatch that DOES let a named row import is the empty-candidate one, and a coincidence
        # in the list means it already declined to fire — this branch must not reopen that decision.
        verdict, _ = self._eval_named_row(None)
        self.assertTrue(verdict.hard_reject)
        self.assertFalse(verdict.passthrough)
        self.assertEqual(verdict.matched["candidates"], [])

    def test_a_candidate_worth_showing_leaves_the_ledger_unprobed(self):
        # A displayable same-account match is the better explanation and the cheaper one; the probe is
        # for the case where the report would otherwise have nothing to say.
        ctx = self._coverage_ctx()
        ctx.existing_rows_by_account_amount = {
            "ACCT-1": {_duplicate_amount_key("2025-10-15", -10.00): [{
                "id": "SAME-DAY", "date": "2025-10-15", "amount": -10.00, "account_id": "ACCT-1",
                "merchant_name": "Annual Membership Fee",
                "source_texts": row_match_texts("Annual Membership Fee", "ANNUAL MEMBERSHIP FEE", None),
            }]},
        }
        verdict, probe = self._eval_named_row(self._TWIN, ctx=ctx)
        self.assertEqual([c["id"] for c in verdict.matched["candidates"]], ["SAME-DAY"])
        self.assertEqual(probe.call_count, 0)

    def test_a_nameless_leg_keeps_its_candidate_and_never_reaches_the_probe(self):
        # Why the branch can be gated on a merchant name without losing cases: with no text on the
        # incoming side there is no disagreement to hide a candidate for, so the tiering never empties
        # the list of a money-movement leg in the first place.
        verdict, probe = self._eval_named_row(self._TWIN, merchant="")
        self.assertEqual([c["id"] for c in verdict.matched["candidates"]], ["COINCIDENCE"])
        self.assertEqual(probe.call_count, 0)

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

    def test_covered_range_label_wins_over_exact_hash(self):
        # Coverage runs before the exact-hash rules. When a row is BOTH an exact content-hash match
        # and inside an already-imported date range, both are hard-rejects, so the order only decides
        # the reported reason — and the broader covered-range label is the one we surface.
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
        self.assertEqual(
            verdict.reason,
            "Falls within the fully covered date range from an earlier import for this source account",
        )
        # Coverage shape (the covered range + any candidates), not the single-row exact-match payload.
        self.assertIn("covered", verdict.matched)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
