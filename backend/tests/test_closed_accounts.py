"""
Closing an account: what counts as arriving after the close, what the balance totals make of a closed group,
and the flag on a balance a closed account still holds (services/closed_accounts.py). A root's close date
closes its group and a member's closes only that member, which is the property a merge could quietly break.
All data here is fabricated.
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from fastapi import HTTPException

from backend.db.database import get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers.accounts import AccountUpdate, dismiss_closed_balance_flag, list_accounts, update_account
from backend.services.account_balances import current_balances
from backend.services.balance_totals import balance_totals_by_month
from backend.services.closed_accounts import after_close_count
from backend.services.transaction_attributes import attribute_membership
from backend.tests.test_balance_totals import _Ledger


class AfterCloseTests(_Ledger):
    def _close(self, account_id, closed_on):
        self.conn.execute("UPDATE account SET closed_on = ? WHERE id = ?", (closed_on, account_id))

    def _matching(self):
        clause, params = attribute_membership(["after-close"])
        return {r["id"] for r in self.conn.execute(f"SELECT id FROM txn t WHERE {clause}", params)}

    def test_only_rows_dated_after_the_groups_close_count_members_included(self):
        self._account("card", kind="credit")
        self._account("old", kind="credit", parent="card")
        self._account("chk")
        for account_id in ("card", "old", "chk"):
            self._txn(account_id, "2026-06-30", 10.0)
            self._txn(account_id, "2026-07-01", 20.0)
        self._close("card", "2026-06-30")
        self.assertEqual(self._matching(), {"card-2026-07-01-20.0", "old-2026-07-01-20.0"})
        self.assertEqual(after_close_count(self.conn), 2)

    def test_a_member_closes_alone_the_earlier_date_wins_and_trashed_rows_do_not_count(self):
        self._account("card", kind="credit")
        self._account("old", kind="credit", parent="card")
        self._txn("card", "2026-07-01", 10.0)
        self._txn("old", "2026-07-01", 20.0)
        self._close("old", "2026-06-30")
        self.assertEqual(self._matching(), {"old-2026-07-01-20.0"})
        self._close("card", "2026-07-15")
        self.assertEqual(self._matching(), {"old-2026-07-01-20.0"})
        self._close("card", "2026-06-15")
        self.assertEqual(after_close_count(self.conn), 2)
        self.conn.execute("UPDATE txn SET trashed_at = '2026-07-02 00:00:00'")
        self.assertEqual(after_close_count(self.conn), 0)

    def test_the_lens_counts_the_rows_owners(self):
        self._account("card", kind="credit")
        self._txn("card", "2026-07-01", 20.0)
        self._txn("card", "2026-07-02", 30.0)
        self.conn.execute("UPDATE txn SET owner_id = 'sam' WHERE date = '2026-07-02'")
        self.conn.execute("UPDATE txn SET owner_id = 'robin' WHERE date = '2026-07-01'")
        self._close("card", "2026-06-30")
        self.assertEqual(after_close_count(self.conn, ["sam"]), 1)


class ClosedBalanceTotalsTests(_Ledger):
    def setUp(self):
        super().setUp()
        self._account("card", kind="credit")
        self._state("card", "2026-05-31", -300.0)
        self._txn("card", "2026-06-10", -300.0)   # paid off
        self._account("chk")
        self._state("chk", "2026-05-31", 1000.0)
        self.conn.execute("UPDATE account SET closed_on = '2026-06-15' WHERE id = 'card'")

    def test_a_group_closed_in_the_period_ends_it_at_zero(self):
        result = self._on("2026-06-01", "2026-06-30")
        card = next(a for a in result["accounts"] if a["account_id"] == "card")
        self.assertEqual((card["opening"], card["balance"]["amount"]), (-300.0, 0.0))
        self.assertEqual(result["change"], 300.0)

    def test_a_group_closed_before_the_period_is_left_out(self):
        self.assertNotIn("card", {a["account_id"] for a in self._on("2026-07-01", "2026-07-31")["accounts"]})
        self.assertNotIn("card", {a["account_id"] for a in self._on()["accounts"]})

    def test_months_after_the_close_count_it_at_zero_rather_than_uncovered(self):
        # Left owing 50, the totals still count nothing after the close; the account carries the flag.
        self._txn("card", "2026-06-12", 50.0)
        points = {p["month"]: p for p in balance_totals_by_month(self.conn, today=self.TODAY)["points"]}
        self.assertEqual(points["2026-07"]["balances"]["card"], 0.0)
        self.assertEqual(points["2026-07"]["uncovered"], 0)

    def test_a_closed_group_is_never_stale(self):
        self.assertFalse(current_balances(self.conn, today=self.TODAY)["card"]["stale"])
        self.assertTrue(current_balances(self.conn, today=self.TODAY)["chk"]["stale"])


class CloseAccountRouteTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        path = str(Path(self.tempdir.name) / "close.db")
        init_db(path)
        self.token = set_current_db_path(path)
        self.addCleanup(reset_current_db_path, self.token)
        with get_db() as conn:
            conn.execute("INSERT INTO account (id, name, display_name, type) VALUES ('card', 'Card', 'Card', 'credit')")
            conn.execute("INSERT INTO account (id, name, display_name, type, parent_account_id) "
                         "VALUES ('old', 'Card', 'Card', 'credit', 'card')")
            conn.execute("INSERT INTO account_balance (account_id, as_of_date, source, balance, recorded_at) "
                         "VALUES ('card', '2026-05-31', 'manual', -12.5, '2026-06-01 00:00:00')")

    def _row(self, account_id):
        return next(a for a in list_accounts(include_children=True) if a["id"] == account_id)

    def test_a_member_closes_alone_and_each_row_carries_its_own_date(self):
        update_account("old", AccountUpdate(closed_on="2026-06-30"))
        self.assertEqual((self._row("card")["closed_on"], self._row("old")["closed_on"]), (None, "2026-06-30"))
        update_account("card", AccountUpdate(closed_on="2026-07-31"))
        update_account("old", AccountUpdate(closed_on=""))
        self.assertEqual((self._row("card")["closed_on"], self._row("old")["closed_on"]), ("2026-07-31", None))

    def test_a_future_close_date_is_refused(self):
        with self.assertRaises(HTTPException) as refused:
            update_account("card", AccountUpdate(closed_on="2999-01-01"))
        self.assertEqual(refused.exception.status_code, 400)
        self.assertIsNone(self._row("card")["closed_on"])

    def test_a_remaining_balance_is_flagged_until_dismissed_for_that_close_date(self):
        self.assertIsNone(self._row("card")["closed_balance_flag"])
        update_account("card", AccountUpdate(closed_on="2026-06-30"))
        self.assertEqual(self._row("card")["closed_balance_flag"], {"amount": -12.5, "closed_on": "2026-06-30"})
        self.assertIsNone(self._row("old")["closed_balance_flag"])
        dismiss_closed_balance_flag("old")   # a member's id means its group
        self.assertIsNone(self._row("card")["closed_balance_flag"])
        update_account("card", AccountUpdate(closed_on="2026-07-01"))
        self.assertIsNotNone(self._row("card")["closed_balance_flag"])


if __name__ == "__main__":
    unittest.main()
