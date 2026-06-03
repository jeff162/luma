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
