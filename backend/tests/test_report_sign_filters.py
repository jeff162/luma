"""
Report sign-filter coverage.

These tests protect the reporting contract that category and dashboard summaries
must not silently drop transactions just because their sign is unusual for the
category tree branch they live in.
"""

from __future__ import annotations

import tempfile
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path

from backend.db.database import SHARED_OWNER_ID, get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers.transactions import (
    UNCATEGORIZED_EXPENSE_CATEGORY_ID,
    UNCATEGORIZED_INCOME_CATEGORY_ID,
    monthly_trend,
    spending_by_category_in_group,
    spending_by_group,
)


class ReportSignFiltersTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "report-sign-filters.db"
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
                      (id, external_account_id, provider, name, display_name, type, subtype, mask, owner_id, parent_account_id, trashed_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
                    """,
                    (
                        account_id,
                        f"plaid_{account_id}",
                        "fixture_report_sign_filters",
                        name,
                        name,
                        "checking",
                        "checking",
                        "1234",
                        SHARED_OWNER_ID,
                    ),
                )
        return account_id

    def _insert_category(self, *, name: str, parent_id: str | None, category_type: str) -> str:
        category_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    """
                    INSERT INTO category (id, parent_id, name, category_type, sort_order)
                    VALUES (?, ?, ?, ?, 0)
                    """,
                    (category_id, parent_id, name, category_type),
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

    def _insert_uncategorized_transaction(self, *, account_id: str, amount: float, date: str) -> None:
        txn_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    """
                    INSERT INTO txn
                      (id, account_id, owner_id, category_id, amount, merchant_name, display_name, raw_name, date, is_pending, category_overridden)
                    VALUES (?, ?, ?, NULL, ?, 'Fixture Merchant', 'Fixture Merchant', 'Fixture Merchant', ?, 0, 0)
                    """,
                    (txn_id, account_id, SHARED_OWNER_ID, amount, date),
                )

    def test_income_category_monthly_trend_keeps_both_credits_and_debits(self):
        account_id = self._insert_account("Checking")
        income_group_id = self._insert_category(name="Income Fixture", parent_id=None, category_type="income")
        other_income_id = self._insert_category(name="Other Income Fixture", parent_id=income_group_id, category_type="income")
        self._insert_transaction(account_id=account_id, category_id=other_income_id, amount=-500.0, date="2026-04-10")
        self._insert_transaction(account_id=account_id, category_id=other_income_id, amount=75.0, date="2026-04-14")

        with self._use_db_path():
            rows = monthly_trend(
                category_id=other_income_id,
                payee=None,
                account_id=None,
                account_ids=None,
                tag_ids=None,
                months=18,
                date_start="2026-04-01",
                date_end="2026-04-30",
            )

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["month"], "2026-04")
        self.assertEqual(rows[0]["count"], 2)
        self.assertEqual(rows[0]["total"], 425.0)

    def test_group_summaries_use_net_amount_without_sign_filtering(self):
        account_id = self._insert_account("Checking")
        expense_group_id = self._insert_category(name="Food Fixture", parent_id=None, category_type="expense")
        groceries_id = self._insert_category(name="Groceries Fixture", parent_id=expense_group_id, category_type="expense")
        self._insert_transaction(account_id=account_id, category_id=groceries_id, amount=100.0, date="2026-04-05")
        self._insert_transaction(account_id=account_id, category_id=groceries_id, amount=-30.0, date="2026-04-12")

        with self._use_db_path():
            group_rows = spending_by_group(
                month="2026-04",
                date_start=None,
                date_end=None,
                account_id=None,
                account_ids=None,
                tag_ids=None,
                owner_ids=None,
                category_owner_ids=None,
            )
            category_rows = spending_by_category_in_group(
                month="2026-04",
                date_start=None,
                date_end=None,
                group_id=expense_group_id,
                account_id=None,
                account_ids=None,
                tag_ids=None,
                owner_ids=None,
            )

        self.assertEqual(group_rows[0]["group_id"], expense_group_id)
        self.assertEqual(group_rows[0]["count"], 2)
        self.assertEqual(group_rows[0]["total"], 70.0)
        self.assertEqual(category_rows[0]["category_id"], groceries_id)
        self.assertEqual(category_rows[0]["count"], 2)
        self.assertEqual(category_rows[0]["total"], 70.0)

    def test_net_refund_expense_bucket_reads_negative_not_absed(self):
        # A period where an expense bucket's refunds outweigh its spend nets negative. The summaries must
        # report that signed net (previously ABS(SUM) flipped it to a positive magnitude, inflating the
        # total and hiding the refund). This is the whole point of dropping ABS.
        account_id = self._insert_account("Checking")
        expense_group_id = self._insert_category(name="Shopping Fixture", parent_id=None, category_type="expense")
        returns_id = self._insert_category(name="Returns Fixture", parent_id=expense_group_id, category_type="expense")
        self._insert_transaction(account_id=account_id, category_id=returns_id, amount=40.0, date="2026-04-05")
        self._insert_transaction(account_id=account_id, category_id=returns_id, amount=-100.0, date="2026-04-12")

        with self._use_db_path():
            group_rows = spending_by_group(
                month="2026-04", date_start=None, date_end=None, account_id=None,
                account_ids=None, tag_ids=None, owner_ids=None, category_owner_ids=None,
            )
            category_rows = spending_by_category_in_group(
                month="2026-04", date_start=None, date_end=None, group_id=expense_group_id,
                account_id=None, account_ids=None, tag_ids=None, owner_ids=None,
            )

        self.assertEqual(group_rows[0]["total"], -60.0)
        self.assertEqual(category_rows[0]["total"], -60.0)

    def test_uncategorized_summaries_split_income_from_expense(self):
        account_id = self._insert_account("Checking")
        self._insert_uncategorized_transaction(account_id=account_id, amount=90.0, date="2026-04-03")
        self._insert_uncategorized_transaction(account_id=account_id, amount=-35.0, date="2026-04-11")

        with self._use_db_path():
            group_rows = spending_by_group(
                month="2026-04",
                date_start=None,
                date_end=None,
                account_id=None,
                account_ids=None,
                tag_ids=None,
                owner_ids=None,
                category_owner_ids=None,
            )
            income_rows = spending_by_category_in_group(
                month="2026-04",
                date_start=None,
                date_end=None,
                group_id=UNCATEGORIZED_INCOME_CATEGORY_ID,
                account_id=None,
                account_ids=None,
                tag_ids=None,
                owner_ids=None,
            )
            income_trend = monthly_trend(
                category_id=UNCATEGORIZED_INCOME_CATEGORY_ID,
                payee=None,
                account_id=None,
                account_ids=None,
                tag_ids=None,
                months=18,
                date_start="2026-04-01",
                date_end="2026-04-30",
            )

        group_map = {row["group_id"]: row for row in group_rows}
        self.assertEqual(group_map[UNCATEGORIZED_EXPENSE_CATEGORY_ID]["group_name"], "Uncategorized")
        self.assertEqual(group_map[UNCATEGORIZED_EXPENSE_CATEGORY_ID]["category_type"], "expense")
        self.assertEqual(group_map[UNCATEGORIZED_EXPENSE_CATEGORY_ID]["count"], 1)
        self.assertEqual(group_map[UNCATEGORIZED_EXPENSE_CATEGORY_ID]["total"], 90.0)
        self.assertEqual(group_map[UNCATEGORIZED_INCOME_CATEGORY_ID]["group_name"], "Other Income")
        self.assertEqual(group_map[UNCATEGORIZED_INCOME_CATEGORY_ID]["category_type"], "income")
        self.assertEqual(group_map[UNCATEGORIZED_INCOME_CATEGORY_ID]["count"], 1)
        self.assertEqual(group_map[UNCATEGORIZED_INCOME_CATEGORY_ID]["total"], 35.0)

        self.assertEqual(len(income_rows), 1)
        self.assertEqual(income_rows[0]["category_id"], UNCATEGORIZED_INCOME_CATEGORY_ID)
        self.assertEqual(income_rows[0]["category_name"], "Other Income")
        self.assertEqual(income_rows[0]["count"], 1)
        self.assertEqual(income_rows[0]["total"], 35.0)

        self.assertEqual(len(income_trend), 1)
        self.assertEqual(income_trend[0]["count"], 1)
        self.assertEqual(income_trend[0]["total"], 35.0)


if __name__ == "__main__":
    unittest.main()
