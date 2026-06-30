"""
The merged-account report narrows to specific underlying accounts via `source_account_ids`, which must
filter on the row's *original* account (t.account_id) rather than the effective/top-level account the
`account_ids` filter resolves through COALESCE(parent, id). Both run through the one shared builder
(_build_transaction_filter) that the list feed, the bulk "select all matching" resolver, and the
monthly-trend endpoint share, so this guards that the two filters stay distinct SQL.
"""

from __future__ import annotations

import unittest

from backend.routers.transactions import _build_transaction_filter


class SourceAccountFilterTests(unittest.TestCase):
    def test_source_filter_targets_raw_account(self):
        clauses, params = _build_transaction_filter(source_account_ids="child-1,child-2")
        where = " AND ".join(clauses)
        self.assertIn("t.account_id IN (?,?)", where)
        # It must NOT resolve through the parent — that would be the effective-account filter.
        self.assertNotIn("parent_account_id", where)
        self.assertEqual(params, ["child-1", "child-2"])

    def test_effective_filter_resolves_through_parent(self):
        clauses, params = _build_transaction_filter(account_ids="parent-1")
        where = " AND ".join(clauses)
        self.assertIn("parent_account_id", where)
        self.assertEqual(params, ["parent-1"])

    def test_source_and_effective_compose(self):
        # The report passes both: effective = the merged parent, source = the chosen child(ren).
        clauses, params = _build_transaction_filter(account_ids="parent-1", source_account_ids="child-1")
        where = " AND ".join(clauses)
        self.assertIn("parent_account_id", where)
        self.assertIn("t.account_id IN (?)", where)
        self.assertEqual(params, ["parent-1", "child-1"])

    def test_blank_source_filter_emits_nothing(self):
        clauses, _ = _build_transaction_filter(source_account_ids="  , ")
        self.assertNotIn("t.account_id IN", " AND ".join(clauses))


if __name__ == "__main__":
    unittest.main()
