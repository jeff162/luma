# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: GPL-3.0-or-later

"""
Monthly-by-group summary coverage.

The group drill-down shares reporting filters with the top-level grouped chart,
including parent-group metadata like exclude-from-totals. This test protects the
group-specific query shape so it keeps joining parent categories correctly.
"""

from __future__ import annotations

import tempfile
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path

from backend.db.database import SHARED_OWNER_ID, get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers.transactions import monthly_by_group


class MonthlyByGroupTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "monthly-by-group.db"
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
                        "fixture_monthly_group",
                        name,
                        name,
                        "checking",
                        "checking",
                        "1234",
                        SHARED_OWNER_ID,
                    ),
                )
        return account_id

    def _insert_category(self, *, name: str, parent_id: str | None, category_type: str, exclude_from_totals: int = 0) -> str:
        category_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    """
                    INSERT INTO category (id, parent_id, name, category_type, sort_order, exclude_from_totals)
                    VALUES (?, ?, ?, ?, 0, ?)
                    """,
                    (category_id, parent_id, name, category_type, exclude_from_totals),
                )
        return category_id

    def _insert_transaction(self, *, account_id: str, category_id: str, amount: float, date: str) -> None:
        txn_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    """
                    INSERT INTO txn
                      (id, account_id, owner_id, category_id, amount, merchant_name, display_name, raw_name, date, is_pending, category_overridden)
                    VALUES (?, ?, ?, ?, ?, 'Fixture Merchant', 'Fixture Merchant', 'Fixture Merchant', ?, 0, 0)
                    """,
                    (txn_id, account_id, SHARED_OWNER_ID, category_id, amount, date),
                )

    def test_group_drilldown_uses_parent_group_join_for_filters(self):
        account_id = self._insert_account("Primary Checking")
        expense_group_id = self._insert_category(name="Living", parent_id=None, category_type="expense")
        groceries_id = self._insert_category(name="Groceries", parent_id=expense_group_id, category_type="expense")
        ignored_group_id = self._insert_category(name="Ignored", parent_id=None, category_type="expense", exclude_from_totals=1)
        ignored_leaf_id = self._insert_category(name="Ignored Leaf", parent_id=ignored_group_id, category_type="expense")
        self._insert_transaction(account_id=account_id, category_id=groceries_id, amount=42.0, date="2026-04-15")
        self._insert_transaction(account_id=account_id, category_id=ignored_leaf_id, amount=99.0, date="2026-04-20")

        with self._use_db_path():
            rows = monthly_by_group(months=24, account_id=None, account_ids=None, tag_ids=None, group_id=expense_group_id)

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["series_id"], groceries_id)
        self.assertEqual(rows[0]["series_name"], "Groceries")


if __name__ == "__main__":
    unittest.main()
