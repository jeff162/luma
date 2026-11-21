"""
A file's balance column: each date's closing balance, as the household's position, recorded against the
import that stated it.

The reading is what is worth pinning. A file's order and its sign convention are inferred from the file,
and a wrong guess raises nothing; it stores a card's debt as money held, or a day's opening as its close.
"""

from __future__ import annotations

import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path

from backend.db.database import get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers.import_export.core import parse_balance_cell, run_import_core, undo_batch
from backend.services.account_balances import balances_from_column


class BalancesFromColumnTests(unittest.TestCase):
    """`(date, amount, balance)` rows in file order; amount positive is money out."""

    def test_an_oldest_first_file_closes_each_day_on_its_last_row(self):
        rows = [("2026-03-01", 20.0, 980.0), ("2026-03-01", 30.0, 950.0), ("2026-03-02", -100.0, 1050.0)]
        self.assertEqual(balances_from_column(rows, "depository"),
                         ({"2026-03-01": 950.0, "2026-03-02": 1050.0}, None))

    def test_a_newest_first_file_closes_each_day_on_its_first_row(self):
        rows = [("2026-03-02", -100.0, 1050.0), ("2026-03-01", 30.0, 950.0), ("2026-03-01", 20.0, 980.0)]
        self.assertEqual(balances_from_column(rows, "depository"),
                         ({"2026-03-01": 950.0, "2026-03-02": 1050.0}, None))

    def test_a_balance_stated_as_owed_is_stored_as_a_negative_position(self):
        # A card export: purchases raise the balance, a payment lowers it.
        rows = [("2026-03-01", 40.0, 240.0), ("2026-03-02", -200.0, 40.0), ("2026-03-03", 15.0, 55.0)]
        closing, reason = balances_from_column(rows, "depository")
        self.assertIsNone(reason)
        self.assertEqual(closing, {"2026-03-01": -240.0, "2026-03-02": -40.0, "2026-03-03": -55.0})

    def test_one_day_in_one_row_takes_its_sign_from_the_account_type(self):
        self.assertEqual(balances_from_column([("2026-03-01", 40.0, 240.0)], "credit"),
                         ({"2026-03-01": -240.0}, None))
        self.assertEqual(balances_from_column([("2026-03-01", 40.0, 240.0)], "depository"),
                         ({"2026-03-01": 240.0}, None))

    def test_a_column_that_does_not_follow_the_amounts_is_refused(self):
        rows = [("2026-03-01", 20.0, 5.0), ("2026-03-02", 30.0, 71.0), ("2026-03-03", -10.0, 12.0)]
        self.assertEqual(balances_from_column(rows, "depository"),
                         ({}, "the balance column does not follow the amounts"))

    def test_an_unreadable_closing_cell_leaves_its_day_without_a_balance(self):
        rows = [("2026-03-01", 20.0, 980.0), ("2026-03-01", 30.0, None), ("2026-03-02", -100.0, 1050.0),
                ("2026-03-03", 50.0, 1000.0)]
        self.assertEqual(balances_from_column(rows, "depository"),
                         ({"2026-03-02": 1050.0, "2026-03-03": 1000.0}, None))

    def test_a_cell_marked_dr_or_cr_names_its_side(self):
        self.assertEqual(parse_balance_cell("1,250.00 DR", "point"), -1250.0)
        self.assertEqual(parse_balance_cell("$80.10 CR", "point"), 80.1)
        self.assertIsNone(parse_balance_cell("", "point"))


BANK_CSV = (
    "Date,Description,Amount,Status,Balance\n"
    "2026-03-03,Grocer,-30.00,Pending,\n"
    "2026-03-02,Payroll,100.00,Posted,1050.00\n"
    "2026-03-01,Cafe,-30.00,Posted,950.00\n"
    "2026-03-01,Bakery,-20.00,Posted,980.00\n"
)


class ImportedBalanceTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.db_path = str(Path(self.tempdir.name) / "balances.db")
        init_db(self.db_path)
        with get_db(self.db_path) as conn:
            conn.execute(
                "INSERT INTO account (id, provider, name, display_name, type) "
                "VALUES ('chk', 'manual', 'Checking', 'Checking', 'depository')")

    @contextmanager
    def _use_db(self):
        token = set_current_db_path(self.db_path)
        try:
            yield
        finally:
            reset_current_db_path(token)

    def _import(self):
        cfg = {
            "account_id": "chk",
            "column_map": {"date": "Date", "amount": "Amount", "description": "Description",
                           "pending": "Status", "balance": "Balance"},
            "date_format": "%Y-%m-%d",
            "amount_convention": "single_signed",
            "apply_categorization": False,
        }
        with self._use_db():
            return run_import_core(BANK_CSV, cfg, filename="bank.csv")

    def _balances(self):
        with get_db(self.db_path) as conn:
            return [tuple(r) for r in conn.execute(
                "SELECT as_of_date, source, balance, import_batch_id FROM account_balance ORDER BY as_of_date")]

    def test_each_dates_close_is_recorded_against_the_import_and_goes_when_it_is_undone(self):
        result = self._import()
        batch_id = result["batch_id"]
        # The pending row's day has no closing figure of its own.
        self.assertEqual(self._balances(), [("2026-03-01", "import", 950.0, batch_id),
                                            ("2026-03-02", "import", 1050.0, batch_id)])
        with self._use_db():
            undo_batch(batch_id, force=True)
        self.assertEqual(self._balances(), [])


if __name__ == "__main__":
    unittest.main()
