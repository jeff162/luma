# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Every summary bucket carries the real first and last transaction date inside it.

The Dashboard's "average per month / per year" figures divide by elapsed days rather than by how many
buckets were drawn (`frontend/src/lib/periodAverage.js`), and a bucket *key* cannot supply those days:
on a yearly chart whose first year holds one December transaction, the key says "2024" and the truth is
one month. So each of the three summary endpoints that feeds an average returns `first_date` /
`last_date` beside the totals, and these pin that they are the dates of actual rows and not the
bucket's own boundaries.

All data here is fabricated.
"""

from __future__ import annotations

import tempfile
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path

from backend.db.database import SHARED_OWNER_ID, get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers.transactions import monthly_by_group, monthly_cash_flow, monthly_trend
from backend.services.transaction_facets import TransactionFacets


class SummaryBucketDateTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "bucket-dates.db"
        init_db(str(self.db_path))
        self.account_id = self._insert_account("Riverstone Checking")
        self.group_id = self._insert_category("Household", None, "expense")
        self.leaf_id = self._insert_category("Groceries", self.group_id, "expense")

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
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """INSERT INTO account (id, external_account_id, provider, name, display_name, type, owner_id)
                   VALUES (?, ?, 'fixture', ?, ?, 'checking', ?)""",
                (account_id, f"acct_{account_id}", name, name, SHARED_OWNER_ID),
            )
        return account_id

    def _insert_category(self, name, parent_id, category_type) -> str:
        category_id = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """INSERT INTO category (id, parent_id, name, category_type, sort_order)
                   VALUES (?, ?, ?, ?, 0)""",
                (category_id, parent_id, name, category_type),
            )
        return category_id

    def _insert_txn(self, *, date: str, amount: float = 25.0):
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """INSERT INTO txn
                     (id, account_id, owner_id, category_id, amount, merchant_name, display_name,
                      raw_name, date, is_pending, category_overridden)
                   VALUES (?, ?, ?, ?, ?, 'Fablemart', 'Fablemart', 'Fablemart', ?, 0, 0)""",
                (str(uuid.uuid4()), self.account_id, SHARED_OWNER_ID, self.leaf_id, amount, date),
            )

    # The month holds rows on the 11th and the 25th, so a bucket-boundary answer (the 1st and the 31st)
    # is distinguishable from the right one in every assertion below.
    def _seed_one_month(self):
        for day in ("11", "19", "25"):
            self._insert_txn(date=f"2026-03-{day}")

    def test_monthly_trend_dates_the_rows_not_the_month(self):
        self._seed_one_month()
        with self._use_db_path():
            rows = monthly_trend(category_id=None, payee=None, account_id=None, facets=None,
                                 months=24, date_start=None, date_end=None,
                                 anchor=None, view="cash_flow")

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["first_date"], "2026-03-11")
        self.assertEqual(rows[0]["last_date"], "2026-03-25")

    def test_monthly_cash_flow_carries_the_dates_out_of_its_inner_aggregate(self):
        # The cash-flow query groups by period *and* category bucket before regrouping by period, so the
        # dates have to climb back out of the inner aggregate rather than being read off the outer one.
        self._seed_one_month()
        other_leaf = self._insert_category("Utilities", self.group_id, "expense")
        # The insert's own `get_db()` block has to close before the endpoint opens its connection:
        # `get_db()` commits on exit, and an uncommitted write is invisible to the next connection.
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """INSERT INTO txn
                     (id, account_id, owner_id, category_id, amount, merchant_name, display_name,
                      raw_name, date, is_pending, category_overridden)
                   VALUES (?, ?, ?, ?, 40.0, 'Fablepower', 'Fablepower', 'Fablepower', '2026-03-04', 0, 0)""",
                (str(uuid.uuid4()), self.account_id, SHARED_OWNER_ID, other_leaf),
            )
        with self._use_db_path():
            rows = monthly_cash_flow(months=24, account_id=None, facets=TransactionFacets(),
                                     date_start=None, date_end=None,
                                     granularity="month")

        self.assertEqual(len(rows), 1)
        # The 4th is in a different category bucket from the 11th–25th; the row's span covers both.
        self.assertEqual(rows[0]["first_date"], "2026-03-04")
        self.assertEqual(rows[0]["last_date"], "2026-03-25")

    def test_yearly_cash_flow_spans_the_year_as_the_rows_actually_fall(self):
        self._insert_txn(date="2026-02-07")
        self._insert_txn(date="2026-10-02")
        with self._use_db_path():
            rows = monthly_cash_flow(months=240, account_id=None, facets=TransactionFacets(),
                                     date_start=None, date_end=None,
                                     granularity="year")

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["year"], "2026")
        # Not 2026-01-01/2026-12-31: ten of those months hold nothing, and an average that divided by
        # the whole year would be reporting time the ledger never covered.
        self.assertEqual(rows[0]["first_date"], "2026-02-07")
        self.assertEqual(rows[0]["last_date"], "2026-10-02")

    def test_monthly_by_group_dates_each_series_bucket(self):
        self._seed_one_month()
        with self._use_db_path():
            rows = monthly_by_group(months=24, account_id=None, facets=TransactionFacets(), group_id=None)

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["first_date"], "2026-03-11")
        self.assertEqual(rows[0]["last_date"], "2026-03-25")


if __name__ == "__main__":
    unittest.main()
