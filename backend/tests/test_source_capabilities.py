"""
The per-source capability declarations, and the guarantee that every source actually makes one.

These are cheap tests guarding an expensive failure mode. The declarations exist so that ingesting code
never branches on which source it is holding, which only works while every source has stated an answer —
and a source that quietly acquires a default is exactly the bug the no-default design is meant to make
impossible. The behavioural halves live with the code that honours each policy — `test_sync_period_cards`
(both branches on the sync path, and the card report), `test_connection_scenarios` (SimpleFIN end to end),
`test_run_import_core` (CSV), and `test_amazon_import`'s zero-dollar order cases (Amazon keeps them, so
there is no filter to test — only that such orders still flow). What is pinned here is the contract.
"""

from __future__ import annotations

import unittest

from backend.services.providers.plaid import PlaidAdapter
from backend.services.providers.simplefin import SimpleFinAdapter
from backend.services.source_capabilities import (
    KEEP_ZERO_AMOUNT,
    REJECT_ZERO_AMOUNT,
    SOURCE_AMAZON,
    SOURCE_CSV,
    rejects_zero_amount,
    zero_amount_policy_for_source,
)


class ZeroAmountPolicyTests(unittest.TestCase):
    def test_every_adapter_declares_a_policy(self):
        # The base class supplies no default on purpose, so a new adapter that has not thought about $0
        # rows raises here rather than silently inheriting whichever answer happened to be written first.
        for adapter in (PlaidAdapter(), SimpleFinAdapter()):
            with self.subTest(provider=adapter.provider):
                self.assertIn(adapter.zero_amount_rows, (KEEP_ZERO_AMOUNT, REJECT_ZERO_AMOUNT),
                              f"{adapter.provider} declares no zero-amount policy")

    def test_the_declared_policies_are_the_ones_the_reasoning_supports(self):
        # Stated as values rather than left implicit: each is a claim about the provider, and flipping one
        # should have to be a deliberate edit to a test that says why.
        self.assertEqual(PlaidAdapter().zero_amount_rows, KEEP_ZERO_AMOUNT,
                         "Plaid revises rows in place, so a $0 placeholder is what a settlement lands on")
        self.assertEqual(SimpleFinAdapter().zero_amount_rows, REJECT_ZERO_AMOUNT,
                         "SimpleFIN has no change feed and no pending pointer, so nothing can ever settle "
                         "a $0 row it published")
        self.assertEqual(zero_amount_policy_for_source(SOURCE_CSV), REJECT_ZERO_AMOUNT,
                         "a CSV carries no identity between files, so the placeholder is unreachable")
        self.assertEqual(zero_amount_policy_for_source(SOURCE_AMAZON), KEEP_ZERO_AMOUNT,
                         "a $0 Amazon order is a finished record, not a placeholder")

    def test_an_undeclared_source_is_an_error_rather_than_a_guess(self):
        with self.assertRaises(ValueError):
            zero_amount_policy_for_source("some-new-importer")

    def test_an_unknown_policy_value_is_refused(self):
        # `rejects_zero_amount` is the single predicate every call site goes through precisely so a typo
        # cannot read as "keep" at one of them and "reject" at another.
        with self.assertRaises(ValueError):
            rejects_zero_amount("Reject")

    def test_the_predicate_answers_both_policies(self):
        self.assertTrue(rejects_zero_amount(REJECT_ZERO_AMOUNT))
        self.assertFalse(rejects_zero_amount(KEEP_ZERO_AMOUNT))


if __name__ == "__main__":
    unittest.main()
