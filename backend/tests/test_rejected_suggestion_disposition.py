"""
Contract for what happens to the transactions behind a *rejected* rule suggestion.

When a Generate-rules suggestion is rejected, the rows it covered still need a disposition, and the
intent differs by case. `set_rejected_suggestion_disposition` settles them:

  - 'keep' (no category, or the row's own category) -> KEEP AS IMPORTED: leave the row at `import`.
              Keeping the file's category is not an override, so it stays re-derivable and reclaimable by
              a later explicit "apply to existing" (a manual row would be spared by that). Survives an
              automatic Run categorization because import rows are `category_overridden = 1`.
  - 'keep' with a *different* category -> RE-POINT AS MANUAL: a genuine override at the chosen category,
              spared by Run categorization and by an explicit apply.
  - 'clear' -> discard the category to the `cleared` source: rule-eligible again, but the raw
              `imported_category` label is retained and a trust-flag re-toggle must NOT re-apply it.

`cleared` is a distinct `category_source` value (not NULL) precisely so the trust re-derivation can tell
"user discarded this" from "ordinary uncategorized" (which it still fills). These tests pin all three
behaviors, including that the re-derivation actually fires on a control row so the cleared-row guard is
not vacuously passing.
"""

from __future__ import annotations

import tempfile
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path

from backend.db.database import SHARED_OWNER_ID, get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers.import_export.core import _set_batch_imported_category_usage
from backend.routers.transactions import (
    CategorizationRestore,
    CategorizationSnapshot,
    RejectedSuggestionDisposition,
    restore_categorization,
    set_rejected_suggestion_disposition,
)
from backend.services.categorizer import recategorize_all


class RejectedSuggestionDispositionTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "rejected-disposition.db"
        init_db(str(self.db_path))

    def tearDown(self):
        self.tempdir.cleanup()

    @contextmanager
    def _use_db_path(self):
        token = set_current_db_path(str(self.db_path))
        try:
            yield
        finally:
            reset_current_db_path(token)

    def _account(self, name="Primary Checking"):
        account_id = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """INSERT INTO account
                     (id, plaid_account_id, plaid_item_id, name, display_name, type, subtype, mask, owner_id, parent_account_id, trashed_at)
                   VALUES (?, ?, 'fixture', ?, ?, 'checking', 'checking', '1234', ?, NULL, NULL)""",
                (account_id, f"plaid_{account_id}", name, name, SHARED_OWNER_ID),
            )
        return account_id

    def _leaf(self, name):
        category_id = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            group = conn.execute(
                "SELECT id FROM category WHERE category_type = 'expense' AND parent_id IS NULL LIMIT 1"
            ).fetchone()
            conn.execute(
                "INSERT INTO category (id, parent_id, name, category_type, sort_order) VALUES (?, ?, ?, 'expense', 0)",
                (category_id, group["id"], name),
            )
        return category_id

    def _rule(self, *, category_id, keyword):
        rule_id = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """INSERT INTO category_rule
                     (id, category_id, keyword, priority, amount_min, amount_max, debit_credit, clean_name, owner_id, account_id)
                   VALUES (?, ?, ?, 5, NULL, NULL, 'both', NULL, NULL, NULL)""",
                (rule_id, category_id, keyword),
            )
        return rule_id

    def _batch(self):
        batch_id = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """INSERT INTO import_batch
                     (id, filename, imported_at, row_count, skipped_count, deduped_count, config_snapshot, status, use_imported_categories)
                   VALUES (?, 'fixture.csv', '2026-04-27T12:00:00', 0, 0, 0, '{}', 'completed', 1)""",
                (batch_id,),
            )
        return batch_id

    def _import_txn(self, *, account_id, merchant, imported_category, category_id=None,
                    source="import", overridden=1, batch_id=None):
        txn_id = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """INSERT INTO txn
                     (id, account_id, owner_id, category_id, amount, merchant_name, display_name, raw_name,
                      imported_category, date, is_pending, category_overridden, category_source, import_batch_id)
                   VALUES (?, ?, ?, ?, 42.00, ?, ?, ?, ?, '2026-04-23', 0, ?, ?, ?)""",
                (txn_id, account_id, SHARED_OWNER_ID, category_id, merchant, merchant, merchant,
                 imported_category, overridden, source, batch_id),
            )
        return txn_id

    def _get(self, txn_id):
        with self._use_db_path(), get_db() as conn:
            return dict(conn.execute(
                "SELECT category_id, category_source, category_overridden, imported_category FROM txn WHERE id = ?",
                (txn_id,),
            ).fetchone())

    def _recategorize(self):
        with self._use_db_path(), get_db() as conn:
            return recategorize_all(conn)

    def _dispose(self, ids, mode, category_id=None):
        with self._use_db_path():
            return set_rejected_suggestion_disposition(
                RejectedSuggestionDisposition(transaction_ids=ids, mode=mode, category_id=category_id)
            )

    # -- keep -------------------------------------------------------------------------------------

    def test_keep_leaves_import_keeps_category_and_survives_recategorize(self):
        account = self._account()
        membership = self._leaf("Membership")
        # An import-curated annual-fee row the user wants to keep but not build a rule for. Keeping the
        # file's own category is NOT an override, so the row stays `import` (re-derivable and still
        # reclaimable by an explicit "apply to existing" later) rather than becoming a sticky manual lock.
        txn = self._import_txn(account_id=account, merchant="ANNUAL FEE", imported_category="Membership", category_id=membership)
        # A rule that *would* match the merchant — to prove an automatic Run categorization doesn't reclaim it.
        self._rule(category_id=self._leaf("Fees"), keyword="annual fee")

        result = self._dispose([txn], "keep")
        self.assertEqual(result["rows"], [])  # nothing changed, so nothing to snapshot for undo
        row = self._get(txn)
        self.assertEqual(row["category_source"], "import")  # left as imported, not manual
        self.assertEqual(row["category_id"], membership)  # category value unchanged

        self._recategorize()
        row = self._get(txn)
        self.assertEqual(row["category_source"], "import")  # import is skipped by automatic Run categorization
        self.assertEqual(row["category_id"], membership)

    def test_keep_with_same_category_is_not_an_override(self):
        # Re-affirming the row's own category (e.g. an unchanged conflict-set member kept at its imported
        # category) is not an override either: it stays `import`, nothing is snapshotted.
        account = self._account()
        filed = self._leaf("Groceries")
        txn = self._import_txn(account_id=account, merchant="CORNER STORE", imported_category="Groceries", category_id=filed)

        result = self._dispose([txn], "keep", category_id=filed)
        self.assertEqual(result["rows"], [])
        row = self._get(txn)
        self.assertEqual(row["category_source"], "import")
        self.assertEqual(row["category_id"], filed)

    def test_keep_with_category_repoints_to_a_different_category_as_manual(self):
        # The conflict-set card's "keep these, but as a different category": the rows are settled manual
        # AT the chosen category, not the file's, and survive Run categorization there.
        account = self._account()
        filed = self._leaf("Groceries")
        chosen = self._leaf("Household")
        txn = self._import_txn(account_id=account, merchant="CORNER STORE", imported_category="Groceries", category_id=filed)
        # A rule that would otherwise claim the merchant — proves the manual lock wins.
        self._rule(category_id=self._leaf("Snacks"), keyword="corner store")

        result = self._dispose([txn], "keep", category_id=chosen)
        self.assertEqual({row["id"] for row in result["rows"]}, {txn})  # prior snapshot is the pre-change state
        row = self._get(txn)
        self.assertEqual(row["category_source"], "manual")
        self.assertEqual(row["category_overridden"], 1)
        self.assertEqual(row["category_id"], chosen)  # re-pointed, not the filed category

        self._recategorize()
        self.assertEqual(self._get(txn)["category_id"], chosen)  # manual lock survives the rule

    def test_keep_with_category_rejects_group_inactive_and_clear_combo(self):
        from fastapi import HTTPException

        account = self._account()
        filed = self._leaf("Groceries")
        txn = self._import_txn(account_id=account, merchant="CORNER STORE", imported_category="Groceries", category_id=filed)

        with self._use_db_path(), get_db() as conn:
            group_id = conn.execute(
                "SELECT id FROM category WHERE category_type = 'expense' AND parent_id IS NULL LIMIT 1"
            ).fetchone()["id"]
            inactive = self._leaf("Set aside")
            conn.execute("UPDATE category SET is_active = 0 WHERE id = ?", (inactive,))

        with self.assertRaises(HTTPException):
            self._dispose([txn], "keep", category_id=group_id)        # cannot target a group
        with self.assertRaises(HTTPException):
            self._dispose([txn], "keep", category_id=inactive)        # cannot target an inactive leaf
        with self.assertRaises(HTTPException):
            self._dispose([txn], "clear", category_id=filed)          # category_id only valid with keep
        # The row is untouched by the rejected calls.
        self.assertEqual(self._get(txn)["category_source"], "import")

    # -- clear ------------------------------------------------------------------------------------

    def test_clear_marks_cleared_keeps_label_and_is_rule_eligible(self):
        account = self._account()
        membership = self._leaf("Membership")
        txn = self._import_txn(account_id=account, merchant="BIKE SHOP", imported_category="Membership", category_id=membership)

        self._dispose([txn], "clear")
        row = self._get(txn)
        self.assertEqual(row["category_source"], "cleared")
        self.assertIsNone(row["category_id"])              # category discarded
        self.assertEqual(row["category_overridden"], 0)    # rule-eligible
        self.assertEqual(row["imported_category"], "Membership")  # raw label retained for audit

        # With no matching rule, Run categorization leaves the cleared marker intact (not blanked to NULL).
        self._recategorize()
        self.assertEqual(self._get(txn)["category_source"], "cleared")

        # Once a rule covers it, the cleared row is reclaimed like any uncategorized row.
        repairs = self._leaf("Bike repairs")
        self._rule(category_id=repairs, keyword="bike shop")
        self._recategorize()
        row = self._get(txn)
        self.assertEqual(row["category_source"], "rule")
        self.assertEqual(row["category_id"], repairs)

    def test_disposition_returns_prior_rows_and_restore_reverses_it(self):
        # Undo path: the disposition reports the rows it changed with their prior state, and restoring
        # that snapshot returns them exactly (source/category/lock), so undo is lossless.
        account = self._account()
        membership = self._leaf("Membership")
        kept = self._import_txn(account_id=account, merchant="ALREADY MANUAL", imported_category="Membership",
                                category_id=membership, source="manual", overridden=1)
        txn = self._import_txn(account_id=account, merchant="BIKE SHOP", imported_category="Membership", category_id=membership)

        result = self._dispose([kept, txn], "clear")
        # The pre-settled manual row is spared and not reported among the changed rows.
        self.assertEqual({row["id"] for row in result["rows"]}, {txn})
        self.assertEqual(self._get(txn)["category_source"], "cleared")

        with self._use_db_path():
            restore_categorization(CategorizationRestore(rows=[CategorizationSnapshot(**row) for row in result["rows"]]))
        restored = self._get(txn)
        self.assertEqual(restored["category_source"], "import")
        self.assertEqual(restored["category_id"], membership)
        self.assertEqual(restored["category_overridden"], 1)
        self.assertEqual(self._get(kept)["category_source"], "manual")  # untouched throughout

    def test_clear_survives_trust_flag_re_toggle(self):
        account = self._account()
        batch = self._batch()
        # Control: an ordinary uncategorized-but-labeled row the re-derivation SHOULD grab on enable.
        control = self._import_txn(account_id=account, merchant="WHOLE FOODS", imported_category="Groceries",
                                   category_id=None, source=None, overridden=0, batch_id=batch)
        # A cleared row in the same batch — the re-derivation must leave it alone.
        cleared = self._import_txn(account_id=account, merchant="BIKE SHOP", imported_category="Membership",
                                   category_id=None, source="cleared", overridden=0, batch_id=batch)

        with self._use_db_path(), get_db() as conn:
            _set_batch_imported_category_usage(conn, batch, True)

        control_row = self._get(control)
        self.assertEqual(control_row["category_source"], "import")   # proves the re-derivation fired
        self.assertIsNotNone(control_row["category_id"])

        cleared_row = self._get(cleared)
        self.assertEqual(cleared_row["category_source"], "cleared")  # guard: cleared row untouched
        self.assertIsNone(cleared_row["category_id"])
        self.assertEqual(cleared_row["imported_category"], "Membership")


if __name__ == "__main__":
    unittest.main()
