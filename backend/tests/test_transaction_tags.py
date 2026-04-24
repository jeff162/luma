# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: GPL-3.0-or-later

"""
Transaction-tag coverage.

These tests protect the shared tag model across rules, manual transaction edits,
and reporting filters so tags behave like stable cross-cutting labels instead of
becoming a second category system with inconsistent override rules.
"""

from __future__ import annotations

import tempfile
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path

from backend.db.database import SHARED_OWNER_ID, get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers.rules import _apply_rule_to_existing, create_rule, RuleCreate
from backend.routers.transactions import list_transactions, spending_by_group
from backend.services.categorizer import preview_recategorize_count, recategorize_all
from backend.services.transaction_tags import list_visible_transaction_tags, set_manual_transaction_tag


class TransactionTagsTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "transaction-tags.db"
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
                        "fixture_transaction_tags",
                        name,
                        name,
                        "checking",
                        "checking",
                        "1234",
                        SHARED_OWNER_ID,
                    ),
                )
        return account_id

    def _insert_expense_leaf(self, name: str) -> str:
        category_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                expense_group = conn.execute(
                    "SELECT id FROM category WHERE name = 'Food & Drink' AND parent_id IS NULL"
                ).fetchone()
                conn.execute(
                    """
                    INSERT INTO category (id, parent_id, name, category_type, sort_order)
                    VALUES (?, ?, ?, 'expense', 0)
                    """,
                    (category_id, expense_group["id"], name),
                )
        return category_id

    def _insert_tag(self, name: str, color: str) -> str:
        tag_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                sort_order = conn.execute("SELECT COALESCE(MAX(sort_order), -1) + 1 FROM tag").fetchone()[0]
                conn.execute(
                    "INSERT INTO tag (id, name, color, sort_order) VALUES (?, ?, ?, ?)",
                    (tag_id, name, color, sort_order),
                )
        return tag_id

    def _insert_transaction(self, *, account_id: str, merchant_name: str, amount: float = 54.0, date: str = "2026-04-15") -> str:
        txn_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    """
                    INSERT INTO txn
                      (id, account_id, owner_id, category_id, amount, merchant_name, display_name, raw_name, date, is_pending, category_overridden)
                    VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, 0, 0)
                    """,
                    (txn_id, account_id, SHARED_OWNER_ID, amount, merchant_name, merchant_name, merchant_name, date),
                )
        return txn_id

    def _create_rule(self, *, keyword: str, category_id: str | None = None, clean_name: str | None = None, tag_ids: list[str] | None = None) -> str:
        with self._use_db_path():
            result = create_rule(RuleCreate(
                keyword=keyword,
                category_id=category_id,
                clean_name=clean_name,
                tag_ids=tag_ids or [],
            ))
        return result["id"]

    def test_recategorize_unions_tags_and_keeps_first_category_action(self):
        account_id = self._insert_account("Primary Checking")
        groceries_id = self._insert_expense_leaf("Groceries")
        essential_tag_id = self._insert_tag("Essential", "#22c55e")
        grocery_tag_id = self._insert_tag("Groceries Run", "#3b82f6")
        txn_id = self._insert_transaction(account_id=account_id, merchant_name="TAG FIXTURE MART")
        self._create_rule(keyword="fixture mart", category_id=groceries_id, tag_ids=[essential_tag_id])
        self._create_rule(keyword="fixture", clean_name="Fixture Mart", tag_ids=[grocery_tag_id])

        with self._use_db_path():
            with get_db() as conn:
                self.assertEqual(preview_recategorize_count(conn), 1)
                self.assertEqual(recategorize_all(conn), 1)
                txn = conn.execute(
                    "SELECT category_id, display_name FROM txn WHERE id = ?",
                    (txn_id,),
                ).fetchone()
                tags = list_visible_transaction_tags(conn, txn_id)

        self.assertEqual(txn["category_id"], groceries_id)
        self.assertEqual(txn["display_name"], "Fixture Mart")
        self.assertEqual({tag["id"] for tag in tags}, {essential_tag_id, grocery_tag_id})

    def test_manual_remove_blocks_rule_tag_during_recategorize(self):
        account_id = self._insert_account("Primary Checking")
        essential_tag_id = self._insert_tag("Essential", "#22c55e")
        txn_id = self._insert_transaction(account_id=account_id, merchant_name="SAFEWAY")
        self._create_rule(keyword="safeway", tag_ids=[essential_tag_id])

        with self._use_db_path():
            with get_db() as conn:
                self.assertEqual(recategorize_all(conn), 1)
                set_manual_transaction_tag(conn, txn_id, essential_tag_id, present=False)
                self.assertEqual(preview_recategorize_count(conn), 0)
                self.assertEqual(recategorize_all(conn), 0)
                tags = list_visible_transaction_tags(conn, txn_id)

        self.assertEqual(tags, [])

    def test_manual_add_survives_rule_sync(self):
        account_id = self._insert_account("Primary Checking")
        manual_tag_id = self._insert_tag("Budget Watch", "#f97316")
        txn_id = self._insert_transaction(account_id=account_id, merchant_name="Corner Store")

        with self._use_db_path():
            with get_db() as conn:
                set_manual_transaction_tag(conn, txn_id, manual_tag_id, present=True)
                self.assertEqual(preview_recategorize_count(conn), 0)
                self.assertEqual(recategorize_all(conn), 0)
                tags = list_visible_transaction_tags(conn, txn_id)

        self.assertEqual([tag["id"] for tag in tags], [manual_tag_id])

    def test_apply_rule_adds_tags_and_tag_filter_reaches_reporting(self):
        account_id = self._insert_account("Primary Checking")
        spending_group = None
        groceries_id = None
        with self._use_db_path():
            with get_db() as conn:
                groceries = conn.execute(
                    """
                    SELECT c.id, p.id AS group_id
                    FROM category c
                    JOIN category p ON p.id = c.parent_id
                    WHERE c.name = 'Groceries'
                      AND p.name = 'Food & Drink'
                    LIMIT 1
                    """
                ).fetchone()
                groceries_id = groceries["id"]
                spending_group = groceries["group_id"]
        essential_tag_id = self._insert_tag("Essential", "#22c55e")
        other_tag_id = self._insert_tag("Optional", "#a855f7")
        tagged_txn_id = self._insert_transaction(account_id=account_id, merchant_name="TARGET", amount=81.0)
        self._insert_transaction(account_id=account_id, merchant_name="MOVIE", amount=18.0)
        rule_id = self._create_rule(keyword="target", category_id=groceries_id, tag_ids=[essential_tag_id])

        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    """
                    INSERT INTO txn_tag (txn_id, tag_id, rule_present, manual_state)
                    VALUES (?, ?, 0, 1)
                    """,
                    (tagged_txn_id, other_tag_id),
                )
                self.assertEqual(_apply_rule_to_existing(conn, rule_id), 1)
            ledger = list_transactions(
                month=None,
                date_start=None,
                date_end=None,
                import_batch_id=None,
                sort_by="date",
                sort_dir="desc",
                account_id=None,
                account_ids=None,
                category_id=None,
                group_ids=None,
                category_ids=None,
                tag_ids=essential_tag_id,
                owner_ids=None,
                payees=None,
                direction=None,
                search=None,
                quick_filter=None,
                limit=200,
                offset=0,
            )
            grouped = spending_by_group(
                month="2026-04",
                date_start=None,
                date_end=None,
                account_id=None,
                account_ids=None,
                tag_ids=essential_tag_id,
                owner_ids=None,
                category_owner_ids=None,
            )

        self.assertEqual([txn["id"] for txn in ledger["transactions"]], [tagged_txn_id])
        self.assertEqual(len(grouped), 1)
        self.assertEqual(grouped[0]["group_id"], spending_group)
        self.assertEqual(grouped[0]["total"], 81.0)

    def test_tag_only_rule_is_allowed(self):
        tag_id = self._insert_tag("Essential", "#22c55e")
        with self._use_db_path():
            result = create_rule(RuleCreate(keyword="rent", tag_ids=[tag_id]))
        self.assertTrue(result["id"])


if __name__ == "__main__":
    unittest.main()
