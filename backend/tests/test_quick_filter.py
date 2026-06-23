# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: GPL-3.0-or-later

"""
Quick-filter parsing for the transaction list (shared by the Transactions page and the import
file-ledger drawer). Pure functions — no DB. Covers the date jumps (year / month / day) and amount
matching, plus the bare-year addition.
"""

from __future__ import annotations

import unittest

from backend.routers.transactions import (
    _build_quick_filter_clause,
    _parse_quick_filter_amount,
    _parse_quick_filter_date,
    _parse_quick_filter_month,
    _parse_quick_filter_month_day,
    _parse_quick_filter_year,
    _parse_quick_filter_year_month,
)


class QuickFilterParsingTests(unittest.TestCase):
    def test_bare_year(self):
        self.assertEqual(_parse_quick_filter_year("2023"), "2023")
        self.assertEqual(_parse_quick_filter_year("1999"), "1999")
        self.assertIsNone(_parse_quick_filter_year("99"))
        self.assertIsNone(_parse_quick_filter_year("03/2023"))
        self.assertIsNone(_parse_quick_filter_year("20235"))

    def test_year_month(self):
        self.assertEqual(_parse_quick_filter_year_month("03/2023"), "2023-03")
        self.assertEqual(_parse_quick_filter_year_month("2023-03"), "2023-03")
        self.assertIsNone(_parse_quick_filter_year_month("2023"))

    def test_full_date(self):
        self.assertEqual(_parse_quick_filter_date("03/15/2023"), "2023-03-15")
        self.assertEqual(_parse_quick_filter_date("2023-03-15"), "2023-03-15")
        self.assertIsNone(_parse_quick_filter_date("03/2023"))

    def test_month_day_no_year(self):
        # mm/dd or mm-dd with no year -> "MM-DD" for an any-year match.
        self.assertEqual(_parse_quick_filter_month_day("9/29"), "09-29")
        self.assertEqual(_parse_quick_filter_month_day("03-15"), "03-15")
        self.assertEqual(_parse_quick_filter_month_day("2/29"), "02-29")  # leap day not rejected
        self.assertIsNone(_parse_quick_filter_month_day("13/15"))         # month out of range
        self.assertIsNone(_parse_quick_filter_month_day("03/15/2023"))    # full date is not month/day
        self.assertIsNone(_parse_quick_filter_month_day("03/2023"))       # year-month is not month/day

    def test_bare_month(self):
        self.assertEqual(_parse_quick_filter_month("9"), "09")
        self.assertEqual(_parse_quick_filter_month("12"), "12")
        self.assertIsNone(_parse_quick_filter_month("13"))    # out of month range
        self.assertIsNone(_parse_quick_filter_month("0"))
        self.assertIsNone(_parse_quick_filter_month("2023"))  # a year, not a month

    def test_month_day_builds_any_year_clause(self):
        # "9/29" jumps to Sept 29 in every year (LIKE '%-09-29'); no amount/merchant OR (not a number).
        clause, params = _build_quick_filter_clause("9/29")
        self.assertIn("t.date LIKE ?", clause)
        self.assertIn("%-09-29", params)

    def test_bare_month_builds_any_year_clause(self):
        # "9" matches every September (LIKE '%-09-%') and also ORs the $9.00 amount match.
        clause, params = _build_quick_filter_clause("9")
        self.assertIn("%-09-%", params)
        self.assertIn(9.0, params)

    def test_amount(self):
        self.assertEqual(str(_parse_quick_filter_amount("68")), "68.00")
        self.assertEqual(str(_parse_quick_filter_amount("$1,234.5")), "1234.50")
        self.assertEqual(str(_parse_quick_filter_amount("(20.22)")), "-20.22")
        self.assertIsNone(_parse_quick_filter_amount("not-a-number"))

    def test_bare_year_builds_date_year_clause(self):
        clause, params = _build_quick_filter_clause("2023")
        self.assertIn("t.date LIKE ?", clause)
        self.assertIn("2023-%", params)   # year jump
        self.assertIn(2023.0, params)      # also ORs the amount match ($2023.00)

    def test_field_prefix_restricts(self):
        # date:2023 restricts to the date-year clause only — no merchant/amount OR.
        clause, params = _build_quick_filter_clause("date:2023")
        self.assertIn("t.date LIKE ?", clause)
        self.assertIn("2023-%", params)
        self.assertNotIn("display_name", clause)


if __name__ == "__main__":
    unittest.main()
