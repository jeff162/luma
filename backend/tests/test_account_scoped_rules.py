"""
Account-scoped rule coverage.

These tests protect the shared rule contract when accounts are grouped. The UI
surfaces and filters grouped transactions through the visible parent account, so
account-scoped rules must match that same effective account id during previews,
explicit apply, and retroactive recategorization.
"""

from __future__ import annotations

import tempfile
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path

from backend.db.database import SHARED_OWNER_ID, get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers.rules import _apply_rule_to_existing
from backend.services.categorizer import preview_recategorize_count, recategorize_all


class AccountScopedRulesTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "account-scoped-rules.db"
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

    def _insert_account(self, name: str, *, parent_account_id: str | None = None) -> str:
        account_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    """
                    INSERT INTO account
                      (id, plaid_account_id, plaid_item_id, name, display_name, type, subtype, mask, owner_id, parent_account_id, trashed_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
                    """,
                    (
                        account_id,
                        f"plaid_{account_id}",
                        "fixture_rules",
                        name,
                        name,
                        "checking",
                        "checking",
                        "1234",
                        SHARED_OWNER_ID,
                        parent_account_id,
                    ),
                )
        return account_id

    def _insert_income_leaf(self, name: str) -> str:
        category_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                income_group = conn.execute(
                    "SELECT id FROM category WHERE name = 'Income' AND parent_id IS NULL"
                ).fetchone()
                conn.execute(
                    """
                    INSERT INTO category (id, parent_id, name, category_type, sort_order)
                    VALUES (?, ?, ?, 'income', 0)
                    """,
                    (category_id, income_group["id"], name),
                )
        return category_id

    def _insert_rule(self, *, category_id: str, account_id: str, keyword: str) -> str:
        rule_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    """
                    INSERT INTO category_rule
                      (id, category_id, keyword, amount_min, amount_max, clean_name, owner_id, account_id)
                    VALUES (?, ?, ?, NULL, NULL, NULL, NULL, ?)
                    """,
                    (rule_id, category_id, keyword, account_id),
                )
        return rule_id

    def _insert_transaction(self, *, account_id: str, merchant_name: str) -> str:
        txn_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    """
                    INSERT INTO txn
                      (id, account_id, owner_id, category_id, amount, merchant_name, display_name, raw_name, date, is_pending, category_overridden)
                    VALUES (?, ?, ?, NULL, -150.00, ?, ?, ?, '2026-04-20', 0, 0)
                    """,
                    (txn_id, account_id, SHARED_OWNER_ID, merchant_name, merchant_name, merchant_name),
                )
        return txn_id

    def test_parent_account_rule_matches_grouped_child_transaction_for_preview_and_recategorize(self):
        parent_account_id = self._insert_account("Personal Checking")
        child_account_id = self._insert_account("Personal Checking Old", parent_account_id=parent_account_id)
        category_id = self._insert_income_leaf("Retirement Income")
        self._insert_rule(category_id=category_id, account_id=parent_account_id, keyword="transfer")
        txn_id = self._insert_transaction(account_id=child_account_id, merchant_name="TRANSFER FROM BROKERAGE")

        with self._use_db_path():
            with get_db() as conn:
                self.assertEqual(preview_recategorize_count(conn), 1)
                self.assertEqual(recategorize_all(conn), 1)
                txn = conn.execute(
                    "SELECT category_id, category_source FROM txn WHERE id = ?",
                    (txn_id,),
                ).fetchone()

        self.assertEqual(txn["category_id"], category_id)
        self.assertEqual(txn["category_source"], "rule")

    def test_explicit_apply_uses_effective_parent_account_scope(self):
        parent_account_id = self._insert_account("Personal Checking")
        child_account_id = self._insert_account("Personal Checking Old", parent_account_id=parent_account_id)
        category_id = self._insert_income_leaf("Retirement Income")
        rule_id = self._insert_rule(category_id=category_id, account_id=parent_account_id, keyword="transfer")
        txn_id = self._insert_transaction(account_id=child_account_id, merchant_name="TRANSFER TO SAVINGS")

        with self._use_db_path():
            with get_db() as conn:
                self.assertEqual(len(_apply_rule_to_existing(conn, rule_id)), 1)
                txn = conn.execute(
                    "SELECT category_id, category_source, category_overridden FROM txn WHERE id = ?",
                    (txn_id,),
                ).fetchone()

        self.assertEqual(txn["category_id"], category_id)
        self.assertEqual(txn["category_source"], "rule")
        self.assertEqual(txn["category_overridden"], 0)

    def test_preserve_manual_apply_reclaims_import_locked_but_not_manual(self):
        # When a merge/replace changes a rule, re-applying with preserve_manual should reclaim the rows
        # the rule should own — including import-locked ones — while leaving a manual edit as the final say.
        account_id = self._insert_account("Personal Checking")
        food = self._insert_income_leaf("Food")
        other = self._insert_income_leaf("Other Spending")
        rule_id = self._insert_rule(category_id=food, account_id=account_id, keyword="doordash")

        import_txn = self._insert_transaction(account_id=account_id, merchant_name="DOORDASH ORDER 1")
        manual_txn = self._insert_transaction(account_id=account_id, merchant_name="DOORDASH ORDER 2")
        uncat_txn = self._insert_transaction(account_id=account_id, merchant_name="DOORDASH ORDER 3")

        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    "UPDATE txn SET category_id = ?, category_overridden = 1, category_source = 'import' WHERE id = ?",
                    (other, import_txn),
                )
                conn.execute(
                    "UPDATE txn SET category_id = ?, category_overridden = 1, category_source = 'manual' WHERE id = ?",
                    (other, manual_txn),
                )

        with self._use_db_path():
            with get_db() as conn:
                updated = _apply_rule_to_existing(conn, rule_id, preserve_manual=True)
                rows = {
                    row["id"]: row
                    for row in conn.execute(
                        "SELECT id, category_id, category_source FROM txn WHERE id IN (?, ?, ?)",
                        (import_txn, manual_txn, uncat_txn),
                    ).fetchall()
                }

        # Import-locked + uncategorized rows reclaimed by the rule; the manual edit is left untouched.
        self.assertEqual(len(updated), 2)
        self.assertEqual(rows[import_txn]["category_id"], food)
        self.assertEqual(rows[import_txn]["category_source"], "rule")
        self.assertEqual(rows[uncat_txn]["category_id"], food)
        self.assertEqual(rows[uncat_txn]["category_source"], "rule")
        self.assertEqual(rows[manual_txn]["category_id"], other)
        self.assertEqual(rows[manual_txn]["category_source"], "manual")


if __name__ == "__main__":
    unittest.main()
