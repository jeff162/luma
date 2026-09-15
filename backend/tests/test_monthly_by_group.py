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
from backend.routers.transactions import list_transactions, monthly_by_group, monthly_trend
from backend.services.transaction_facets import TransactionFacets


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
                      (id, external_account_id, provider, name, display_name, type, subtype, mask, owner_id, parent_account_id, trashed_at)
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

    def _insert_owner(self, name: str) -> str:
        owner_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute("INSERT INTO owner (id, name) VALUES (?, ?)", (owner_id, name))
        return owner_id

    def _insert_transaction(self, *, account_id: str, category_id: str | None, amount: float, date: str, owner_id: str = SHARED_OWNER_ID, merchant: str = "Fixture Merchant", is_pending: int = 0) -> None:
        txn_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    """
                    INSERT INTO txn
                      (id, account_id, owner_id, category_id, amount, merchant_name, display_name, raw_name, date, is_pending, category_overridden)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
                    """,
                    (txn_id, account_id, owner_id, category_id, amount, merchant, merchant, merchant, date, is_pending),
                )

    def _report_sum(self, *, view: str, date_start: str, date_end: str, facets: TransactionFacets) -> float:
        # What the Trends drill-through (PeriodDetail) shows as its total. Called as a plain function, so
        # every Query param is passed explicitly — an unset one would arrive as a FieldInfo.
        result = list_transactions(
            month=None, date_start=date_start, date_end=date_end, import_batch_id=None,
            sort_by="date", sort_dir="desc", account_id=None, facets=facets, source_account_ids=None,
            category_id=None, require_all_tag_ids=None, require_all_attribute_ids=None, direction=None,
            view=view, search=None, quick_filter=None, ids=None, sync_connection_id=None,
            recurring_series_id=None, recurring_only=False, recurring_excluded_series_id=None,
            amount_min=None, amount_max=None, amount_min_op=">=", amount_max_op="<=", account_type=None,
            import_evidence_type=None, needs_review=False, include_trashed=False, limit=0, offset=0,
        )
        return result["sum_amount"]

    def test_trends_drill_through_lists_exactly_the_rows_behind_each_figure(self):
        # The Trends tab's figures come from this endpoint; its drill-throughs open the transaction list
        # scoped by the same window, frame and filters plus the row's category (a category row's ↗) or the
        # drilled group (a "Total per month" bar). Each must total what the figure it came from said. The
        # ledger carries every row a summary leaves out, so a list that kept any of them would disagree:
        # a pending charge, an excluded-from-totals category, another owner's spend, a row outside the
        # window, and a sibling category in the same group.
        account_id = self._insert_account("Checking")
        living = self._insert_category(name="LivingZ", parent_id=None, category_type="expense")
        groceries = self._insert_category(name="GroceriesZ", parent_id=living, category_type="expense")
        dining = self._insert_category(name="DiningZ", parent_id=living, category_type="expense")
        transfers = self._insert_category(name="TransfersZ", parent_id=None, category_type="expense", exclude_from_totals=1)
        card_payment = self._insert_category(name="Card PaymentZ", parent_id=transfers, category_type="expense")
        alice = self._insert_owner("AliceZ")
        bob = self._insert_owner("BobZ")
        self._insert_transaction(account_id=account_id, category_id=groceries, amount=80.0, date="2026-03-04", owner_id=alice)
        self._insert_transaction(account_id=account_id, category_id=groceries, amount=-15.0, date="2026-03-09", owner_id=alice)
        self._insert_transaction(account_id=account_id, category_id=groceries, amount=55.0, date="2026-04-18", owner_id=alice)
        self._insert_transaction(account_id=account_id, category_id=groceries, amount=33.0, date="2026-04-20", owner_id=alice, is_pending=1)
        self._insert_transaction(account_id=account_id, category_id=groceries, amount=21.0, date="2026-04-21", owner_id=bob)
        self._insert_transaction(account_id=account_id, category_id=groceries, amount=64.0, date="2025-12-30", owner_id=alice)
        self._insert_transaction(account_id=account_id, category_id=dining, amount=40.0, date="2026-04-02", owner_id=alice)
        self._insert_transaction(account_id=account_id, category_id=card_payment, amount=500.0, date="2026-04-05", owner_id=alice)
        # Uncategorized spend gets its own series and its own sentinel id, which the list must accept too.
        self._insert_transaction(account_id=account_id, category_id=None, amount=12.0, date="2026-04-06", owner_id=alice)
        self._insert_transaction(account_id=account_id, category_id=None, amount=9.0, date="2026-04-07", owner_id=alice, is_pending=1)

        window = dict(date_start="2026-01-01", date_end="2026-12-31")
        with self._use_db_path():
            by_category = monthly_by_group(months=240, account_id=None, group_id=living, facets=TransactionFacets(owner_ids=alice))
            by_group = monthly_by_group(months=240, account_id=None, group_id=None, facets=TransactionFacets(owner_ids=alice))

            def figure(rows, series_id):
                return sum(r["total"] for r in rows if r["series_id"] == series_id and r["month"].startswith("2026"))

            groceries_report = self._report_sum(view="spending", facets=TransactionFacets(owner_ids=alice, category_ids=groceries), **window)
            april_living_report = self._report_sum(
                view="spending", date_start="2026-04-01", date_end="2026-04-30",
                facets=TransactionFacets(owner_ids=alice, group_ids=living),
            )
            uncategorized_id = next(r["series_id"] for r in by_group if r["series_id"].startswith("__uncategorized"))
            uncategorized_report = self._report_sum(
                view="spending", facets=TransactionFacets(owner_ids=alice, category_ids=uncategorized_id), **window,
            )

        self.assertEqual(figure(by_category, groceries), 120.0)
        self.assertEqual(groceries_report, 120.0)
        april_living = sum(r["total"] for r in by_category if r["month"] == "2026-04")
        self.assertEqual(april_living, 95.0)
        self.assertEqual(april_living_report, 95.0)
        self.assertEqual(figure(by_group, uncategorized_id), 12.0)
        self.assertEqual(uncategorized_report, 12.0)

    def test_group_drilldown_uses_parent_group_join_for_filters(self):
        account_id = self._insert_account("Primary Checking")
        expense_group_id = self._insert_category(name="Living", parent_id=None, category_type="expense")
        groceries_id = self._insert_category(name="Groceries", parent_id=expense_group_id, category_type="expense")
        ignored_group_id = self._insert_category(name="Ignored", parent_id=None, category_type="expense", exclude_from_totals=1)
        ignored_leaf_id = self._insert_category(name="Ignored Leaf", parent_id=ignored_group_id, category_type="expense")
        self._insert_transaction(account_id=account_id, category_id=groceries_id, amount=42.0, date="2026-04-15")
        self._insert_transaction(account_id=account_id, category_id=ignored_leaf_id, amount=99.0, date="2026-04-20")

        with self._use_db_path():
            rows = monthly_by_group(months=24, account_id=None, group_id=expense_group_id)

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["series_id"], groceries_id)
        self.assertEqual(rows[0]["series_name"], "Groceries")

    def test_owner_filter_restricts_monthly_by_group(self):
        account_id = self._insert_account("Checking")
        group_id = self._insert_category(name="LivingX", parent_id=None, category_type="expense")
        leaf_id = self._insert_category(name="GroceriesX", parent_id=group_id, category_type="expense")
        alice = self._insert_owner("AliceX")
        bob = self._insert_owner("BobX")
        self._insert_transaction(account_id=account_id, category_id=leaf_id, amount=40.0, date="2026-05-15", owner_id=alice)
        self._insert_transaction(account_id=account_id, category_id=leaf_id, amount=10.0, date="2026-05-16", owner_id=bob)

        with self._use_db_path():
            all_rows = monthly_by_group(months=24, account_id=None, group_id=group_id)
            alice_rows = monthly_by_group(months=24, account_id=None, group_id=group_id, facets=TransactionFacets(owner_ids=alice))

        self.assertEqual(sum(r["total"] for r in all_rows), 50.0)
        self.assertEqual(sum(r["total"] for r in alice_rows), 40.0)

    def test_owner_filter_restricts_monthly_trend(self):
        account_id = self._insert_account("Checking")
        group_id = self._insert_category(name="LivingY", parent_id=None, category_type="expense")
        leaf_id = self._insert_category(name="GroceriesY", parent_id=group_id, category_type="expense")
        alice = self._insert_owner("AliceY")
        bob = self._insert_owner("BobY")
        self._insert_transaction(account_id=account_id, category_id=leaf_id, amount=40.0, date="2026-05-15", owner_id=alice)
        self._insert_transaction(account_id=account_id, category_id=leaf_id, amount=10.0, date="2026-05-16", owner_id=bob)

        # Called directly (not via FastAPI), so every param must be passed to avoid Query() defaults.
        trend_kwargs = dict(category_id=None, payee=None, account_id=None, months=24, date_start=None, date_end=None, view="spending")
        with self._use_db_path():
            all_rows = monthly_trend(**trend_kwargs)
            alice_rows = monthly_trend(facets=TransactionFacets(owner_ids=alice), **trend_kwargs)

        self.assertEqual(sum(r["total"] for r in all_rows), 50.0)
        self.assertEqual(sum(r["total"] for r in alice_rows), 40.0)

    def test_group_ids_filter_restricts_to_selected_group(self):
        account_id = self._insert_account("Checking")
        group_a = self._insert_category(name="GroupA", parent_id=None, category_type="expense")
        leaf_a = self._insert_category(name="LeafA", parent_id=group_a, category_type="expense")
        group_b = self._insert_category(name="GroupB", parent_id=None, category_type="expense")
        leaf_b = self._insert_category(name="LeafB", parent_id=group_b, category_type="expense")
        self._insert_transaction(account_id=account_id, category_id=leaf_a, amount=40.0, date="2026-05-15")
        self._insert_transaction(account_id=account_id, category_id=leaf_b, amount=10.0, date="2026-05-16")

        with self._use_db_path():
            rows = monthly_by_group(months=24, account_id=None, group_id=None, facets=TransactionFacets(group_ids=group_a))

        self.assertEqual(sum(r["total"] for r in rows), 40.0)
        self.assertTrue(all(r["series_id"] == group_a for r in rows))

    def test_category_ids_filter_restricts_to_selected_category(self):
        account_id = self._insert_account("Checking")
        group_id = self._insert_category(name="GroupC", parent_id=None, category_type="expense")
        leaf_1 = self._insert_category(name="LeafC1", parent_id=group_id, category_type="expense")
        leaf_2 = self._insert_category(name="LeafC2", parent_id=group_id, category_type="expense")
        self._insert_transaction(account_id=account_id, category_id=leaf_1, amount=40.0, date="2026-05-15")
        self._insert_transaction(account_id=account_id, category_id=leaf_2, amount=10.0, date="2026-05-16")

        with self._use_db_path():
            rows = monthly_by_group(months=24, account_id=None, group_id=group_id, facets=TransactionFacets(category_ids=leaf_1))

        self.assertEqual(sum(r["total"] for r in rows), 40.0)
        self.assertTrue(all(r["series_id"] == leaf_1 for r in rows))

    def test_net_refund_expense_group_reads_negative_and_reconciles_with_trend(self):
        # A month where an expense group's refunds outweigh its spend nets negative. by-group must report
        # that signed net (not ABS), so it reduces the month's total exactly like the single-period trend.
        account_id = self._insert_account("Checking")
        group_id = self._insert_category(name="LivingRefund", parent_id=None, category_type="expense")
        leaf_id = self._insert_category(name="GroceriesRefund", parent_id=group_id, category_type="expense")
        self._insert_transaction(account_id=account_id, category_id=leaf_id, amount=100.0, date="2026-05-10")
        self._insert_transaction(account_id=account_id, category_id=leaf_id, amount=-160.0, date="2026-05-20")

        trend_kwargs = dict(category_id=None, payee=None, account_id=None, months=24, date_start=None, date_end=None,
                            view="spending")
        with self._use_db_path():
            group_rows = monthly_by_group(months=24, account_id=None, group_id=group_id)
            trend_rows = monthly_trend(**trend_kwargs)

        self.assertEqual(sum(r["total"] for r in group_rows), -60.0)
        # The net-refund month reconciles between the two endpoints, which was the whole point of the fix.
        self.assertEqual(sum(r["total"] for r in trend_rows), -60.0)

    def test_income_group_total_reads_positive(self):
        # Income is stored as negative amounts; by-group negates income-type series so received income
        # reads as a positive bar (mirroring monthly-trend's income sign convention).
        account_id = self._insert_account("Checking")
        group_id = self._insert_category(name="Paycheck", parent_id=None, category_type="income")
        leaf_id = self._insert_category(name="Salary", parent_id=group_id, category_type="income")
        self._insert_transaction(account_id=account_id, category_id=leaf_id, amount=-500.0, date="2026-05-15")

        with self._use_db_path():
            rows = monthly_by_group(months=24, account_id=None, group_id=group_id)

        self.assertEqual(sum(r["total"] for r in rows), 500.0)

    def test_payees_filter_restricts_to_selected_merchant(self):
        account_id = self._insert_account("Checking")
        group_id = self._insert_category(name="GroupD", parent_id=None, category_type="expense")
        leaf_id = self._insert_category(name="LeafD", parent_id=group_id, category_type="expense")
        self._insert_transaction(account_id=account_id, category_id=leaf_id, amount=40.0, date="2026-05-15", merchant="AlphaMerch")
        self._insert_transaction(account_id=account_id, category_id=leaf_id, amount=10.0, date="2026-05-16", merchant="BetaMerch")

        with self._use_db_path():
            rows = monthly_by_group(months=24, account_id=None, group_id=group_id, facets=TransactionFacets(payees="AlphaMerch"))

        self.assertEqual(sum(r["total"] for r in rows), 40.0)


if __name__ == "__main__":
    unittest.main()
