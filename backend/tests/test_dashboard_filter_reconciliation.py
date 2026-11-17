"""
Every Dashboard surface reports the same figure under the FilterBar's chips and amount filter, and the drill
list (`/transactions?view=...`) lists the rows behind it.

Two rules are exercised through that check. An include chip that names an `exclude_from_totals` group or
category brings its rows in: totals leave out money movement, but `group: Transfers` is a scope the user
asked for. Only the group and category include facets name a scope, so a tag chip on an excluded row
leaves it out (docs/data-model.md → *Reporting assumptions*). The amount filter's side and bounds narrow
every surface alike, which is what makes "money out of the Reimbursable group" readable as a report.
"""

from __future__ import annotations

import inspect
import tempfile
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path

from fastapi import params as fastapi_params
from pydantic.fields import FieldInfo

from backend.db.database import SHARED_OWNER_ID, get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers.transactions import (
    list_transactions,
    monthly_by_group,
    monthly_cash_flow,
    monthly_trend,
    range_trend,
    spending_by_category,
    spending_by_group,
    spending_by_tag_signature,
)
from backend.services.transaction_facets import AmountFilter, TransactionFacets

MONTH = "2026-05"


def _call(handler, **kwargs):
    """Call a FastAPI handler directly, resolving every unpassed `Query(...)` to its declared default."""
    for name, param in inspect.signature(handler).parameters.items():
        if name in kwargs:
            continue
        default = param.default
        if isinstance(default, fastapi_params.Depends):
            continue
        kwargs[name] = default.default if isinstance(default, FieldInfo) else default
    return handler(**kwargs)


class DashboardFilterReconciliationTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "named-excluded-scope.db"
        init_db(str(self.db_path))
        with self._use_db_path(), get_db() as conn:
            self.account = self._id()
            conn.execute(
                """
                INSERT INTO account (id, external_account_id, provider, name, display_name,
                                     type, subtype, mask, owner_id, parent_account_id, trashed_at)
                VALUES (?, ?, 'fixture', 'Checking', 'Checking', 'checking', 'checking', '1', ?, NULL, NULL)
                """,
                (self.account, f"fixture_{self.account}", SHARED_OWNER_ID),
            )
            # The leaf's own flag is 0: exclusion comes from the group, as for a seeded Transfers leaf.
            self.transfers = self._category(conn, "Moves", None, exclude=1)
            self.card_payment = self._category(conn, "Card Payment", self.transfers, exclude=0)
            self.savings = self._category(conn, "To Savings", self.transfers, exclude=0)
            food = self._category(conn, "Food", None, exclude=0)
            groceries = self._category(conn, "Groceries", food, exclude=0)

            card_txn = self._txn(conn, self.card_payment, 100.0)
            self._txn(conn, self.savings, 40.0)
            self._txn(conn, self.savings, -25.0)
            self._txn(conn, groceries, 30.0)

            self.tag = self._id()
            conn.execute("INSERT INTO tag (id, name, color) VALUES (?, 'Household', '#888888')", (self.tag,))
            conn.execute(
                "INSERT INTO txn_tag (txn_id, tag_id, rule_present, manual_state) VALUES (?, ?, 0, 1)",
                (card_txn, self.tag),
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

    @staticmethod
    def _id() -> str:
        return str(uuid.uuid4())

    def _category(self, conn, name, parent_id, *, exclude) -> str:
        category_id = self._id()
        conn.execute(
            """
            INSERT INTO category (id, parent_id, name, category_type, sort_order, exclude_from_totals)
            VALUES (?, ?, ?, 'expense', 0, ?)
            """,
            (category_id, parent_id, name, exclude),
        )
        return category_id

    def _txn(self, conn, category_id, amount) -> str:
        txn_id = self._id()
        conn.execute(
            """
            INSERT INTO txn (id, account_id, owner_id, category_id, amount, merchant_name,
                             display_name, raw_name, date, is_pending)
            VALUES (?, ?, ?, ?, ?, 'M', 'M', 'M', ?, 0)
            """,
            (txn_id, self.account, SHARED_OWNER_ID, category_id, amount, f"{MONTH}-10"),
        )
        return txn_id

    def _totals(self, facets: TransactionFacets, **amount_kwargs) -> dict:
        """The spending figure each dashboard surface reports for the month under `facets` and an amount filter."""
        amount_values = dict(direction=None, amount_min=None, amount_max=None, amount_min_op=">=", amount_max_op="<=")
        amount_values.update(amount_kwargs)
        amount = AmountFilter(**amount_values)
        window = dict(date_start=f"{MONTH}-01", date_end=f"{MONTH}-31")
        summary = dict(facets=facets, amount=amount)
        with self._use_db_path():
            month_row = lambda rows, key: sum(r[key] for r in rows if r.get("month") == MONTH)  # noqa: E731
            listed = _call(list_transactions, facets=facets, view="spending", limit=0, **amount_values, **window)
            return {
                "by-group": sum(r["total"] for r in _call(spending_by_group, **summary, **window)),
                "by-category": sum(r["total"] for r in _call(spending_by_category, **summary, **window)),
                "by-tag-signature": sum(
                    r["total"] for r in _call(spending_by_tag_signature, **summary, **window)
                ),
                "monthly-trend": month_row(
                    _call(monthly_trend, **summary, view="spending", months=120, **window), "total",
                ),
                "range-trend": sum(
                    r["total"] for r in _call(
                        range_trend, **summary, view="spending", ranges=f"{MONTH}-01:{MONTH}-31",
                    )
                ),
                "monthly-cash-flow": month_row(_call(monthly_cash_flow, **summary, **window), "outflow"),
                "monthly-by-group": month_row(_call(monthly_by_group, **summary, months=240), "total"),
                "drill list": sum(r["amount"] for r in listed["transactions"]),
            }

    def _assert_every_surface(self, facets: TransactionFacets, expected: float, **amount_kwargs):
        totals = self._totals(facets, **amount_kwargs)
        self.assertEqual(totals, {surface: expected for surface in totals})

    def test_unnamed_excluded_group_stays_out(self):
        self._assert_every_surface(TransactionFacets(), 30.0)

    def test_group_chip_brings_its_excluded_rows_in(self):
        self._assert_every_surface(TransactionFacets(group_ids=self.transfers), 115.0)

    def test_category_chip_brings_only_that_leaf_in(self):
        self._assert_every_surface(TransactionFacets(category_ids=self.card_payment), 100.0)

    def test_tag_chip_does_not_name_a_scope(self):
        self._assert_every_surface(TransactionFacets(tag_ids=self.tag), 0.0)

    def test_money_out_drops_the_money_coming_back(self):
        self._assert_every_surface(TransactionFacets(group_ids=self.transfers), 140.0, direction="debit")

    def test_amount_bounds_narrow_every_surface(self):
        self._assert_every_surface(TransactionFacets(group_ids=self.transfers), 100.0, amount_min=50.0)


if __name__ == "__main__":
    unittest.main()


class GroupDrillReconciliationTests(unittest.TestCase):
    """A drilled group's figure, the list under it and its trend bars count the same rows.

    The Unassigned group is the case that splits them: the Categories page shows uncategorized rows under
    it, but the group breakdown gives those rows their own Uncategorized slice, so a drill into either
    one must count only its own rows.
    """

    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "group-drill.db"
        init_db(str(self.db_path))
        with self._use_db_path(), get_db() as conn:
            account = str(uuid.uuid4())
            conn.execute(
                """
                INSERT INTO account (id, external_account_id, provider, name, display_name,
                                     type, subtype, mask, owner_id, parent_account_id, trashed_at)
                VALUES (?, ?, 'fixture', 'Checking', 'Checking', 'checking', 'checking', '1', ?, NULL, NULL)
                """,
                (account, f"fixture_{account}", SHARED_OWNER_ID),
            )
            self.unassigned = conn.execute(
                "SELECT id FROM category WHERE system_key = 'unassigned'"
            ).fetchone()["id"]
            parked = str(uuid.uuid4())
            conn.execute(
                "INSERT INTO category (id, parent_id, name, sort_order) VALUES (?, ?, 'Imported Label', 0)",
                (parked, self.unassigned),
            )
            for category_id, amount in ((parked, 40.0), (None, 200.0)):
                conn.execute(
                    """
                    INSERT INTO txn (id, account_id, owner_id, category_id, amount, merchant_name,
                                     display_name, raw_name, date, is_pending)
                    VALUES (?, ?, ?, ?, ?, 'M', 'M', 'M', ?, 0)
                    """,
                    (str(uuid.uuid4()), account, SHARED_OWNER_ID, category_id, amount, f"{MONTH}-10"),
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

    def _surfaces(self, group_id: str) -> dict:
        window = dict(date_start=f"{MONTH}-01", date_end=f"{MONTH}-31")
        with self._use_db_path():
            figure = next(
                r["total"] for r in _call(spending_by_group, **window) if r["group_id"] == group_id
            )
            listed = _call(list_transactions, group_id=group_id, limit=0, **window)
            trend = _call(monthly_trend, group_id=group_id, view="spending", months=120, **window)
            ranged = _call(range_trend, group_id=group_id, view="spending", ranges=f"{MONTH}-01:{MONTH}-31")
        return {
            "figure": figure,
            "drill list": sum(r["amount"] for r in listed["transactions"]),
            "monthly-trend": sum(r["total"] for r in trend if r["month"] == MONTH),
            "range-trend": sum(r["total"] for r in ranged),
        }

    def test_unassigned_drill_counts_only_its_leaves(self):
        totals = self._surfaces(self.unassigned)
        self.assertEqual(totals, {surface: 40.0 for surface in totals})

    def test_uncategorized_drill_counts_the_bucket(self):
        from backend.services.transaction_facets import UNCATEGORIZED_EXPENSE_CATEGORY_ID
        totals = self._surfaces(UNCATEGORIZED_EXPENSE_CATEGORY_ID)
        self.assertEqual(totals, {surface: 200.0 for surface in totals})
