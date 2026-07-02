"""
Debit/credit-scoped rule coverage.

The amount chip lets users scope a rule to debits, credits, or both while still
comparing the absolute amount range. These tests protect that contract across
the shared categorizer and the explicit "apply rule now" path.
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


class RuleDebitCreditScopeTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "rule-debit-credit-scope.db"
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

    def _insert_account(self, name: str) -> str:
        account_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    """
                    INSERT INTO account
                      (id, plaid_account_id, plaid_item_id, name, display_name, type, subtype, mask, owner_id, parent_account_id, trashed_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
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

    def _insert_rule(self, *, category_id: str, keyword: str, debit_credit: str) -> str:
        rule_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    """
                    INSERT INTO category_rule
                      (id, category_id, keyword, amount_min, amount_max, debit_credit, clean_name, owner_id, account_id)
                    VALUES (?, ?, ?, 100.0, NULL, ?, NULL, NULL, NULL)
                    """,
                    (rule_id, category_id, keyword, debit_credit),
                )
        return rule_id

    def _insert_transaction(self, *, account_id: str, merchant_name: str, amount: float) -> str:
        txn_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    """
                    INSERT INTO txn
                      (id, account_id, owner_id, category_id, amount, merchant_name, display_name, raw_name, date, is_pending, category_overridden)
                    VALUES (?, ?, ?, NULL, ?, ?, ?, ?, '2026-04-23', 0, 0)
                    """,
                    (txn_id, account_id, SHARED_OWNER_ID, amount, merchant_name, merchant_name, merchant_name),
                )
        return txn_id

    def test_credit_scoped_rule_only_matches_negative_transactions(self):
        account_id = self._insert_account("Primary Checking")
        category_id = self._insert_income_leaf("Brokerage Transfer")
        self._insert_rule(category_id=category_id, keyword="transfer", debit_credit="credit")
        credit_txn_id = self._insert_transaction(account_id=account_id, merchant_name="TRANSFER FROM BROKERAGE", amount=-125.00)
        debit_txn_id = self._insert_transaction(account_id=account_id, merchant_name="TRANSFER TO SAVINGS", amount=125.00)

        with self._use_db_path():
            with get_db() as conn:
                self.assertEqual(preview_recategorize_count(conn), 1)
                self.assertEqual(recategorize_all(conn), 1)
                txns = conn.execute(
                    "SELECT id, category_id, category_source FROM txn ORDER BY id"
                ).fetchall()

        by_id = {txn["id"]: txn for txn in txns}
        self.assertEqual(by_id[credit_txn_id]["category_id"], category_id)
        self.assertEqual(by_id[credit_txn_id]["category_source"], "rule")
        self.assertIsNone(by_id[debit_txn_id]["category_id"])
        self.assertIsNone(by_id[debit_txn_id]["category_source"])

    def test_explicit_apply_honors_debit_credit_scope(self):
        account_id = self._insert_account("Primary Checking")
        category_id = self._insert_income_leaf("Brokerage Transfer")
        rule_id = self._insert_rule(category_id=category_id, keyword="transfer", debit_credit="debit")
        debit_txn_id = self._insert_transaction(account_id=account_id, merchant_name="TRANSFER TO SAVINGS", amount=220.00)
        credit_txn_id = self._insert_transaction(account_id=account_id, merchant_name="TRANSFER FROM BROKERAGE", amount=-220.00)

        with self._use_db_path():
            with get_db() as conn:
                self.assertEqual(len(_apply_rule_to_existing(conn, rule_id)), 1)
                txns = conn.execute(
                    "SELECT id, category_id, category_source FROM txn ORDER BY id"
                ).fetchall()

        by_id = {txn["id"]: txn for txn in txns}
        self.assertEqual(by_id[debit_txn_id]["category_id"], category_id)
        self.assertEqual(by_id[debit_txn_id]["category_source"], "rule")
        self.assertIsNone(by_id[credit_txn_id]["category_id"])
        self.assertIsNone(by_id[credit_txn_id]["category_source"])


if __name__ == "__main__":
    unittest.main()
