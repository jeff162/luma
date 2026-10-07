"""
`/summary/range-trend` coverage.

The endpoint is `monthly-trend` with time cut by caller-supplied day ranges instead of calendar months,
and its contract is exactly that: over a range that *is* a calendar month it must give that month's
`monthly-trend` total in every frame, and over any other range it must count precisely the days inside
it. The first half is what lets the single-period chart mix the two endpoints without its bars meaning
different things; the second is the reason the endpoint exists.
"""

from __future__ import annotations

import tempfile
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path

from fastapi import HTTPException

from backend.db.database import SHARED_OWNER_ID, get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers.transactions import RANGE_TREND_MAX_RANGES, monthly_trend, range_trend
from backend.services.transaction_facets import TransactionFacets
from backend.services.txn_splits import save_split

# Both handlers are called directly rather than through FastAPI, so every Query() parameter has to be
# passed explicitly or it arrives as a FieldInfo.
SCOPE_KWARGS = dict(category_id=None, payee=None, account_id=None, source_account_ids=None,
                    facets=TransactionFacets())
TREND_KWARGS = dict(SCOPE_KWARGS, months=120, date_start="2000-01-01", date_end=None, anchor=None)


class RangeTrendTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "range-trend.db"
        init_db(str(self.db_path))
        self.account_id = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """
                INSERT INTO account
                  (id, external_account_id, provider, name, display_name, type, subtype, mask, owner_id, parent_account_id, trashed_at)
                VALUES (?, ?, 'fixture_range_trend', 'Everyday Checking', 'Everyday Checking', 'checking', 'checking', '0000', ?, NULL, NULL)
                """,
                (self.account_id, f"fixture_{self.account_id}", SHARED_OWNER_ID),
            )

    def tearDown(self):
        self.tempdir.cleanup()

    @contextmanager
    def _use_db_path(self):
        token = set_current_db_path(str(self.db_path))
        try:
            yield
        finally:
            reset_current_db_path(token)

    def _leaf(self, group_name: str, leaf_name: str, category_type: str, *, exclude_from_totals: int = 0) -> str:
        group_id, leaf_id = str(uuid.uuid4()), str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                "INSERT INTO category (id, parent_id, name, category_type, sort_order, exclude_from_totals) VALUES (?, NULL, ?, ?, 0, ?)",
                (group_id, group_name, category_type, exclude_from_totals),
            )
            conn.execute(
                "INSERT INTO category (id, parent_id, name, category_type, sort_order, exclude_from_totals) VALUES (?, ?, ?, ?, 0, 0)",
                (leaf_id, group_id, leaf_name, category_type),
            )
        return leaf_id

    def _txn(self, category_id: str | None, amount: float, date: str, *, pending: int = 0) -> str:
        txn_id = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """
                INSERT INTO txn
                  (id, account_id, owner_id, category_id, amount, merchant_name, display_name, raw_name, date, is_pending, category_overridden)
                VALUES (?, ?, ?, ?, ?, 'Fixture Merchant', 'Fixture Merchant', 'Fixture Merchant', ?, ?, 0)
                """,
                (txn_id, self.account_id, SHARED_OWNER_ID, category_id, amount, date, pending),
            )
        return txn_id

    def _ledger(self):
        # Every shape the shared population rule treats specially: both category types, refunds against
        # each, an excluded transfer, uncategorized rows of both signs, a pending row, and a split whose
        # parts land in different categories. Spread over three months with rows on the first and last
        # day of a month, which is where an off-by-one in a range bound would show.
        salary = self._leaf("Earnings", "Payroll", "income")
        rent = self._leaf("Housing", "Mortgage", "expense")
        gear = self._leaf("Shopping", "Supplies", "expense")
        transfer = self._leaf("Transfers", "Between Accounts", "expense", exclude_from_totals=1)
        self._txn(salary, -3000.0, "2026-03-01")
        self._txn(rent, 1500.0, "2026-03-05")
        self._txn(gear, 120.0, "2026-03-31")
        self._txn(transfer, 800.0, "2026-03-09")
        self._txn(None, -45.0, "2026-03-11")
        self._txn(salary, -3000.0, "2026-04-01")
        self._txn(salary, 200.0, "2026-04-03")
        self._txn(gear, -60.0, "2026-04-07")
        self._txn(gear, 90.0, "2026-04-08")
        self._txn(None, 65.0, "2026-04-30")
        self._txn(gear, 400.0, "2026-04-15", pending=1)
        split_id = self._txn(gear, 250.0, "2026-05-07")
        with self._use_db_path(), get_db() as conn:
            save_split(conn, split_id, [
                {"category_id": gear, "amount": 100.0},
                {"category_id": rent, "amount": 150.0},
            ])
        self._txn(rent, 1500.0, "2026-05-31")

    def _range_trend(self, ranges: str, view: str):
        with self._use_db_path():
            return range_trend(ranges=ranges, view=view, **SCOPE_KWARGS)

    def test_a_calendar_month_range_equals_that_months_trend_in_every_frame(self):
        self._ledger()
        months = {"2026-03": "2026-03-01:2026-03-31", "2026-04": "2026-04-01:2026-04-30",
                  "2026-05": "2026-05-01:2026-05-31"}
        for view in ("spending", "income", "cash_flow"):
            with self.subTest(view=view):
                with self._use_db_path():
                    by_month = {r["month"]: r for r in monthly_trend(view=view, **TREND_KWARGS)}
                rows = self._range_trend(",".join(months.values()), view)
                for (month, _), row in zip(months.items(), rows):
                    expected = by_month.get(month, {"total": 0, "count": 0})
                    self.assertAlmostEqual(row["total"], expected["total"], places=6, msg=month)
                    self.assertEqual(row["count"], expected["count"], msg=month)

    def test_a_range_counts_exactly_the_days_inside_it(self):
        self._ledger()
        # Apr 1 – Apr 7 holds the salary, its reversal and the refund, and not the Apr 8 purchase; both
        # bounds are inclusive. Cash flow is positive for money in.
        [first_week, last_day_only] = self._range_trend("2026-04-01:2026-04-07,2026-03-31:2026-03-31", "cash_flow")
        self.assertAlmostEqual(first_week["total"], 3000.0 - 200.0 + 60.0)
        self.assertEqual(first_week["count"], 3)
        self.assertAlmostEqual(last_day_only["total"], -120.0)
        self.assertEqual(last_day_only["count"], 1)

    def test_rows_come_back_in_request_order_with_empty_and_overlapping_ranges(self):
        self._ledger()
        rows = self._range_trend("2026-05-01:2026-05-31,2025-01-01:2025-01-31,2026-05-07:2026-05-07", "spending")
        self.assertEqual([(r["start"], r["end"]) for r in rows], [
            ("2026-05-01", "2026-05-31"), ("2025-01-01", "2025-01-31"), ("2026-05-07", "2026-05-07"),
        ])
        self.assertAlmostEqual(rows[0]["total"], 1750.0)
        # A range nothing fell in is answered, not dropped — the caller asked about it.
        self.assertEqual((rows[1]["total"], rows[1]["count"]), (0, 0))
        # The split day sits inside the first range too, and counts in both.
        self.assertAlmostEqual(rows[2]["total"], 250.0)
        self.assertEqual(rows[2]["count"], 1)

    def test_malformed_ranges_are_refused(self):
        too_many = ",".join(["2026-01-01:2026-01-02"] * (RANGE_TREND_MAX_RANGES + 1))
        for ranges in ("", "2026-01-01", "2026-02-31:2026-03-01", "2026-03-02:2026-03-01", too_many):
            with self.subTest(ranges=ranges[:40]):
                with self.assertRaises(HTTPException) as caught:
                    self._range_trend(ranges, "spending")
                self.assertEqual(caught.exception.status_code, 400)


if __name__ == "__main__":
    unittest.main()
