"""
Monthly cash-flow summary coverage.

The frame's defining rule is that a *category's net for the month* is the atom: which side of the
diagram a bucket lands on follows the sign of that net, not the sign of the transactions inside it and
not the bucket's `category_type`. These tests pin that rule, the reconciliation contract with
`/summary/monthly-trend?view=cash_flow` (the two frames must report the same net), and the fact that
`exclude_from_totals` is the only exclusion axis in play. The list endpoint's matching `cash_flow` scope
is covered here too, since a drill that lists rows the diagram did not count is the same defect wearing
a different endpoint.
"""

from __future__ import annotations

import tempfile
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path

from fastapi import HTTPException

from backend.db.database import SHARED_OWNER_ID, get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers.transactions import (
    list_transactions,
    monthly_cash_flow,
    monthly_trend,
    spending_by_category,
)
from backend.services.txn_splits import save_split
from backend.services.transaction_facets import split_facets

# monthly_trend is called directly rather than through FastAPI, so every Query() parameter has to be
# passed explicitly or it arrives as a FieldInfo.
TREND_CASH_FLOW_KWARGS = dict(
    category_id=None, payee=None, account_id=None,
    months=24, date_start=None, date_end=None, anchor=None, view="cash_flow",
)


def _list_kwargs(**overrides):
    # list_transactions is a FastAPI handler; called directly, unset Query params stay FieldInfo objects,
    # so every argument has to be passed explicitly.
    base = dict(
        month=None, date_start=None, date_end=None, import_batch_id=None,
        sort_by="date", sort_dir="desc", account_id=None, category_id=None, direction=None, view=None,
        search=None, quick_filter=None, ids=None, include_trashed=False, limit=200, offset=0,
    )
    base.update(overrides)
    return base


class MonthlyCashFlowTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "monthly-cash-flow.db"
        init_db(str(self.db_path))
        self.account_id = self._insert_account("Everyday Checking")

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
                        f"fixture_{account_id}",
                        "fixture_cash_flow",
                        name,
                        name,
                        "checking",
                        "checking",
                        "0000",
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

    def _insert_transaction(self, *, category_id: str | None, amount: float, date: str,
                            account_id: str | None = None, owner_id: str = SHARED_OWNER_ID,
                            merchant: str = "Fixture Merchant") -> str:
        txn_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    """
                    INSERT INTO txn
                      (id, account_id, owner_id, category_id, amount, merchant_name, display_name, raw_name, date, is_pending, category_overridden)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)
                    """,
                    (txn_id, account_id or self.account_id, owner_id, category_id, amount, merchant, merchant, merchant, date),
                )
        return txn_id

    def _leaf(self, group_name: str, leaf_name: str, category_type: str, *, exclude_from_totals: int = 0) -> str:
        group_id = self._insert_category(
            name=group_name, parent_id=None, category_type=category_type,
            exclude_from_totals=exclude_from_totals,
        )
        return self._insert_category(name=leaf_name, parent_id=group_id, category_type=category_type)

    def _cash_flow(self, **overrides):
        params = dict(months=24, account_id=None, date_start=None, date_end=None, granularity="month")
        params.update(overrides)
        facets, rest = split_facets(params)
        with self._use_db_path():
            return monthly_cash_flow(**rest, facets=facets)

    def _month(self, rows, month):
        matches = [r for r in rows if r["month"] == month]
        self.assertEqual(len(matches), 1, f"expected exactly one row for {month}, got {rows}")
        return matches[0]

    # --- The atom is the category's net, not the transaction's sign ---------------------------

    def test_refund_inside_an_expense_category_reduces_outflow_rather_than_adding_inflow(self):
        # The rule that separates this frame from a gross money-in/money-out reading: $100 spent and $30
        # refunded in the same category is $70 of outflow, not $100 out against $30 in.
        groceries = self._leaf("Living", "Groceries", "expense")
        self._insert_transaction(category_id=groceries, amount=100.0, date="2026-05-04")
        self._insert_transaction(category_id=groceries, amount=-30.0, date="2026-05-18")

        row = self._month(self._cash_flow(), "2026-05")

        self.assertAlmostEqual(row["outflow"], 70.0)
        self.assertAlmostEqual(row["inflow"], 0.0)
        self.assertAlmostEqual(row["net"], -70.0)

    def test_net_refunded_expense_category_lands_on_the_inflow_side(self):
        # Sides follow the sign of the bucket's own net. An expense category that refunded more than it
        # spent moved money *in* that month, so it belongs on the inflow side despite its category_type.
        gear = self._leaf("Shopping", "Equipment", "expense")
        self._insert_transaction(category_id=gear, amount=40.0, date="2026-05-02")
        self._insert_transaction(category_id=gear, amount=-160.0, date="2026-05-22")

        row = self._month(self._cash_flow(), "2026-05")

        self.assertAlmostEqual(row["inflow"], 120.0)
        self.assertAlmostEqual(row["outflow"], 0.0)
        self.assertAlmostEqual(row["net"], 120.0)

    def test_income_category_running_a_deficit_lands_on_the_outflow_side(self):
        # The mirror of the case above: income is stored negative, so a clawback larger than the month's
        # receipts nets positive (money out) and the bucket crosses to the outflow side.
        salary = self._leaf("Earnings", "Salary", "income")
        self._insert_transaction(category_id=salary, amount=-500.0, date="2026-05-01")
        self._insert_transaction(category_id=salary, amount=900.0, date="2026-05-15")

        row = self._month(self._cash_flow(), "2026-05")

        self.assertAlmostEqual(row["outflow"], 400.0)
        self.assertAlmostEqual(row["inflow"], 0.0)
        self.assertAlmostEqual(row["net"], -400.0)

    def test_a_category_changes_sides_between_months(self):
        # The design calls this out as something the diagram must tolerate, so the data has to produce
        # it: the same bucket is an outflow in one month and an inflow in the next.
        gear = self._leaf("Shopping", "Outfitting", "expense")
        self._insert_transaction(category_id=gear, amount=200.0, date="2026-04-10")
        self._insert_transaction(category_id=gear, amount=-200.0, date="2026-05-10")

        rows = self._cash_flow()

        april = self._month(rows, "2026-04")
        may = self._month(rows, "2026-05")
        self.assertAlmostEqual(april["outflow"], 200.0)
        self.assertAlmostEqual(april["inflow"], 0.0)
        self.assertAlmostEqual(may["inflow"], 200.0)
        self.assertAlmostEqual(may["outflow"], 0.0)

    def test_netting_does_not_cross_a_month_boundary(self):
        # Each month nets on its own. Were the netting done over the whole window these two months would
        # cancel to a single empty bucket instead of reporting a spend and a refund.
        groceries = self._leaf("Living", "Provisions", "expense")
        self._insert_transaction(category_id=groceries, amount=75.0, date="2026-04-28")
        self._insert_transaction(category_id=groceries, amount=-75.0, date="2026-05-02")

        rows = self._cash_flow()

        self.assertAlmostEqual(self._month(rows, "2026-04")["outflow"], 75.0)
        self.assertAlmostEqual(self._month(rows, "2026-05")["inflow"], 75.0)

    def test_two_categories_on_opposite_sides_do_not_net_against_each_other(self):
        # Bucketing happens before the sides are summed, so a month with income and spending reports both
        # magnitudes rather than one collapsed figure.
        salary = self._leaf("Earnings", "Wages", "income")
        rent = self._leaf("Housing", "Rent", "expense")
        self._insert_transaction(category_id=salary, amount=-3000.0, date="2026-05-01")
        self._insert_transaction(category_id=rent, amount=1800.0, date="2026-05-03")

        row = self._month(self._cash_flow(), "2026-05")

        self.assertAlmostEqual(row["inflow"], 3000.0)
        self.assertAlmostEqual(row["outflow"], 1800.0)
        self.assertAlmostEqual(row["net"], 1200.0)

    def test_uncategorized_inflow_and_outflow_are_separate_buckets(self):
        # Uncategorized rows split into synthetic income/expense sentinels by sign, so an uncategorized
        # deposit and an uncategorized charge in one month must not net each other away.
        self._insert_transaction(category_id=None, amount=-90.0, date="2026-05-06")
        self._insert_transaction(category_id=None, amount=25.0, date="2026-05-07")

        row = self._month(self._cash_flow(), "2026-05")

        self.assertAlmostEqual(row["inflow"], 90.0)
        self.assertAlmostEqual(row["outflow"], 25.0)
        self.assertAlmostEqual(row["net"], 65.0)

    # --- Exclusion, expansion, and filter parity ----------------------------------------------

    def test_exclude_from_totals_removes_a_bucket_from_both_sides(self):
        # `exclude_from_totals` is the design's only exclusion axis: a transfer group leaves the frame
        # entirely rather than appearing on one side or netting into the total.
        # The excluded rows deliberately do NOT net to zero within their own bucket: an offsetting pair
        # would drop out of the sides on its own arithmetic and the assertion would pass with the
        # exclusion guard removed. A card payment leaving this account is the realistic shape anyway —
        # its opposite leg lives on the card, under a different account.
        rent = self._leaf("Housing", "Rent", "expense")
        transfer = self._leaf("Transfers", "Card Payment", "expense", exclude_from_totals=1)
        self._insert_transaction(category_id=rent, amount=1800.0, date="2026-05-03")
        self._insert_transaction(category_id=transfer, amount=600.0, date="2026-05-04")
        self._insert_transaction(category_id=transfer, amount=250.0, date="2026-05-05")

        row = self._month(self._cash_flow(), "2026-05")

        self.assertAlmostEqual(row["outflow"], 1800.0)
        self.assertAlmostEqual(row["inflow"], 0.0)
        self.assertAlmostEqual(row["net"], -1800.0)

    def test_split_parts_are_bucketed_by_their_own_categories(self):
        # The expansion seam has to reach this endpoint: one purchase split across two categories
        # contributes to each category's net separately, which is what lets a split move one part's
        # bucket across to the other side.
        groceries = self._leaf("Living", "Household", "expense")
        gear = self._leaf("Shopping", "Hardware", "expense")
        txn_id = self._insert_transaction(category_id=groceries, amount=100.0, date="2026-05-09")
        with self._use_db_path():
            with get_db() as conn:
                save_split(conn, txn_id, [
                    {"category_id": groceries, "amount": 40.0},
                    {"category_id": gear, "amount": 60.0},
                ])
        # A refund larger than this purchase's share tips the gear bucket to the inflow side, which can
        # only happen if the part — not the whole transaction — was counted there.
        self._insert_transaction(category_id=gear, amount=-100.0, date="2026-05-20")

        row = self._month(self._cash_flow(), "2026-05")

        self.assertAlmostEqual(row["outflow"], 40.0)
        self.assertAlmostEqual(row["inflow"], 40.0)
        self.assertAlmostEqual(row["net"], 0.0)

    def test_pending_and_trashed_rows_are_excluded(self):
        groceries = self._leaf("Living", "Staples", "expense")
        self._insert_transaction(category_id=groceries, amount=50.0, date="2026-05-11")
        pending_id = self._insert_transaction(category_id=groceries, amount=500.0, date="2026-05-12")
        trashed_id = self._insert_transaction(category_id=groceries, amount=700.0, date="2026-05-13")
        with self._use_db_path():
            with get_db() as conn:
                conn.execute("UPDATE txn SET is_pending = 1 WHERE id = ?", (pending_id,))
                conn.execute("UPDATE txn SET trashed_at = '2026-05-14' WHERE id = ?", (trashed_id,))

        row = self._month(self._cash_flow(), "2026-05")

        self.assertAlmostEqual(row["outflow"], 50.0)

    def test_owner_filter_narrows_both_sides(self):
        # Proves the shared summary-filter helpers are actually wired in, rather than the endpoint
        # having its own filter surface that silently ignores a facet.
        salary = self._leaf("Earnings", "Stipend", "income")
        rent = self._leaf("Housing", "Utilities", "expense")
        alice = self._insert_owner("Alice")
        bob = self._insert_owner("Bob")
        self._insert_transaction(category_id=salary, amount=-1000.0, date="2026-05-01", owner_id=alice)
        self._insert_transaction(category_id=salary, amount=-400.0, date="2026-05-01", owner_id=bob)
        self._insert_transaction(category_id=rent, amount=300.0, date="2026-05-02", owner_id=alice)
        self._insert_transaction(category_id=rent, amount=100.0, date="2026-05-02", owner_id=bob)

        row = self._month(self._cash_flow(owner_ids=alice), "2026-05")

        self.assertAlmostEqual(row["inflow"], 1000.0)
        self.assertAlmostEqual(row["outflow"], 300.0)

    def test_date_range_replaces_the_rolling_window(self):
        groceries = self._leaf("Living", "Sundries", "expense")
        self._insert_transaction(category_id=groceries, amount=10.0, date="2026-04-15")
        self._insert_transaction(category_id=groceries, amount=20.0, date="2026-05-15")

        rows = self._cash_flow(date_start="2026-05-01", date_end="2026-05-31")

        self.assertEqual([r["month"] for r in rows], ["2026-05"])
        self.assertAlmostEqual(rows[0]["outflow"], 20.0)

    def test_list_view_cash_flow_keeps_both_directions_but_drops_excluded_categories(self):
        # A node's drill has to resolve exactly the rows behind its figure. `cash_flow` therefore takes
        # no category-type clause — both directions count — while still honouring the one exclusion the
        # frame applies, which is what separates it from passing no view at all.
        salary = self._leaf("Earnings", "Payslip", "income")
        rent = self._leaf("Housing", "Lease", "expense")
        transfer = self._leaf("Transfers", "Card Payment", "expense", exclude_from_totals=1)
        self._insert_transaction(category_id=salary, amount=-3000.0, date="2026-05-01")
        self._insert_transaction(category_id=rent, amount=1500.0, date="2026-05-02")
        self._insert_transaction(category_id=transfer, amount=600.0, date="2026-05-03")

        with self._use_db_path():
            cash_flow = list_transactions(**_list_kwargs(view="cash_flow"))
            spending = list_transactions(**_list_kwargs(view="spending"))
            unscoped = list_transactions(**_list_kwargs(view=None))

        cash_flow_amounts = sorted(r["amount"] for r in cash_flow["transactions"])
        self.assertEqual(cash_flow_amounts, [-3000.0, 1500.0])
        # The contrast that makes each half of the claim mean something.
        self.assertEqual(sorted(r["amount"] for r in spending["transactions"]), [1500.0])
        self.assertEqual(sorted(r["amount"] for r in unscoped["transactions"]), [-3000.0, 600.0, 1500.0])

    def test_by_category_keeps_the_two_uncategorized_sentinels_apart(self):
        # Uncategorized rows have no category to group on, so the summary splits them into synthetic
        # income and expense buckets by sign. That split only survives if the query groups on the
        # sentinel *expression*: the row source carries its own `category_id` column, and a bare
        # `GROUP BY category_id` binds to that column instead of the alias, merging both sentinels into
        # one bucket labelled and signed by whichever member the engine happened to pick. The cash-flow
        # frame is the first caller to ask for both directions at once, which is what makes it visible.
        self._insert_transaction(category_id=None, amount=-500.0, date="2026-05-04")
        self._insert_transaction(category_id=None, amount=120.0, date="2026-05-06")

        with self._use_db_path():
            rows = spending_by_category(
                month="2026-05", date_start=None, date_end=None, account_id=None, exclude_income=False, exclude_expense=False,
            )

        by_type = {r["category_type"]: r for r in rows}
        self.assertEqual(len(rows), 2, f"expected one bucket per direction, got {rows}")
        # Signed for each bucket's own scope, which is what the frame then re-projects onto its axis.
        self.assertAlmostEqual(by_type["income"]["total"], 500.0)
        self.assertAlmostEqual(by_type["expense"]["total"], 120.0)

    def test_cash_flow_sides_match_the_by_category_breakdown_they_are_drawn_beside(self):
        # The promise the two forms of this frame make to each other: a month's bars are the sums of that
        # month's diagram sides, not merely the same net. Both directions of uncategorized activity are
        # in the fixture because that is the case where the two queries' bucketing can diverge.
        salary = self._leaf("Earnings", "Payroll", "income")
        rent = self._leaf("Housing", "Mortgage", "expense")
        gear = self._leaf("Shopping", "Supplies", "expense")
        self._insert_transaction(category_id=salary, amount=-3000.0, date="2026-05-01")
        self._insert_transaction(category_id=rent, amount=1500.0, date="2026-05-03")
        self._insert_transaction(category_id=gear, amount=90.0, date="2026-05-08")
        self._insert_transaction(category_id=gear, amount=-260.0, date="2026-05-19")
        self._insert_transaction(category_id=None, amount=-500.0, date="2026-05-04")
        self._insert_transaction(category_id=None, amount=120.0, date="2026-05-06")

        with self._use_db_path():
            cats = spending_by_category(
                month="2026-05", date_start=None, date_end=None, account_id=None, exclude_income=False, exclude_expense=False,
            )
        row = self._month(self._cash_flow(), "2026-05")

        # The frontend's cashValueOf: undo the per-scope negation, then put money-in positive.
        def cash(r):
            return r["total"] if r["category_type"] == "income" else -r["total"]

        self.assertAlmostEqual(sum(c for c in map(cash, cats) if c > 0), row["inflow"])
        self.assertAlmostEqual(-sum(c for c in map(cash, cats) if c < 0), row["outflow"])

    # --- Yearly rows ---------------------------------------------------------------------------

    def test_a_year_nets_each_category_over_the_whole_year(self):
        # The yearly bars must equal a year's diagram, so the atom is a category's net for the *year*. A
        # category that nets money out in one month and back in the next sits on both sides of the
        # monthly rows and on neither side of the year's — which is why the yearly sides cannot be had
        # by summing months, while the net agrees either way.
        salary = self._leaf("Earnings", "Payroll", "income")
        gear = self._leaf("Shopping", "Supplies", "expense")
        self._insert_transaction(category_id=salary, amount=-3000.0, date="2026-03-01")
        self._insert_transaction(category_id=gear, amount=400.0, date="2026-03-10")
        self._insert_transaction(category_id=gear, amount=-400.0, date="2026-04-02")
        self._insert_transaction(category_id=gear, amount=150.0, date="2025-12-20")

        years = {r["year"]: r for r in self._cash_flow(granularity="year")}
        months = self._cash_flow()
        self.assertEqual(sorted(years), ["2025", "2026"])
        self.assertAlmostEqual(years["2026"]["inflow"], 3000.0)
        self.assertAlmostEqual(years["2026"]["outflow"], 0.0)
        self.assertAlmostEqual(sum(r["inflow"] for r in months if r["month"].startswith("2026")), 3400.0)
        self.assertAlmostEqual(sum(r["outflow"] for r in months if r["month"].startswith("2026")), 400.0)
        for year, row in years.items():
            monthly_net = sum(r["net"] for r in months if r["month"].startswith(year))
            self.assertAlmostEqual(row["net"], monthly_net, places=6, msg=year)
        self.assertNotIn("month", years["2026"])

    def test_an_unknown_granularity_is_refused(self):
        with self.assertRaises(HTTPException) as caught:
            self._cash_flow(granularity="week")
        self.assertEqual(caught.exception.status_code, 400)

    # --- The contract with the other frame -----------------------------------------------------

    def test_net_reconciles_with_the_cash_flow_monthly_trend(self):
        # The stated contract between the two cash-flow frames: netting per bucket and re-summing is the
        # same arithmetic as summing the month, so the trend's net line and the endpoint that draws its
        # bars can never disagree. The fixture deliberately mixes every shape that could break it —
        # income, expense, refunds on both sides, an excluded transfer pair, uncategorized rows of both
        # signs, and a split — because a fixture smaller than the claim would not test it.
        salary = self._leaf("Earnings", "Payroll", "income")
        refunded_income = self._leaf("Earnings", "Bonus", "income")
        rent = self._leaf("Housing", "Mortgage", "expense")
        gear = self._leaf("Shopping", "Supplies", "expense")
        transfer = self._leaf("Transfers", "Between Accounts", "expense", exclude_from_totals=1)

        self._insert_transaction(category_id=salary, amount=-3000.0, date="2026-04-01")
        self._insert_transaction(category_id=refunded_income, amount=-200.0, date="2026-04-03")
        self._insert_transaction(category_id=refunded_income, amount=500.0, date="2026-04-19")
        self._insert_transaction(category_id=rent, amount=1500.0, date="2026-04-05")
        self._insert_transaction(category_id=gear, amount=120.0, date="2026-04-08")
        self._insert_transaction(category_id=gear, amount=-300.0, date="2026-04-24")
        # Non-offsetting on purpose, so dropping the exclusion guard on either endpoint would move its
        # net and break the reconciliation rather than cancelling itself out.
        self._insert_transaction(category_id=transfer, amount=800.0, date="2026-04-09")
        self._insert_transaction(category_id=transfer, amount=-350.0, date="2026-04-10")
        self._insert_transaction(category_id=None, amount=-45.0, date="2026-04-11")
        self._insert_transaction(category_id=None, amount=65.0, date="2026-04-12")

        self._insert_transaction(category_id=salary, amount=-3000.0, date="2026-05-01")
        self._insert_transaction(category_id=rent, amount=1500.0, date="2026-05-05")
        split_id = self._insert_transaction(category_id=gear, amount=250.0, date="2026-05-07")
        with self._use_db_path():
            with get_db() as conn:
                save_split(conn, split_id, [
                    {"category_id": gear, "amount": 100.0},
                    {"category_id": rent, "amount": 150.0},
                ])
        self._insert_transaction(category_id=None, amount=-20.0, date="2026-05-11")

        cash_flow_rows = self._cash_flow()
        with self._use_db_path():
            trend_rows = monthly_trend(**TREND_CASH_FLOW_KWARGS)

        cash_flow_net = {r["month"]: r["net"] for r in cash_flow_rows}
        trend_net = {r["month"]: r["total"] for r in trend_rows}
        self.assertEqual(sorted(cash_flow_net), sorted(trend_net))
        for month, net in cash_flow_net.items():
            self.assertAlmostEqual(net, trend_net[month], places=6, msg=f"net disagreed for {month}")
            # ...and the two sides are what produce that net, rather than being reported independently.
            row = self._month(cash_flow_rows, month)
            self.assertAlmostEqual(row["inflow"] - row["outflow"], net, places=6)
            self.assertGreaterEqual(row["inflow"], 0.0)
            self.assertGreaterEqual(row["outflow"], 0.0)


if __name__ == "__main__":
    unittest.main()
