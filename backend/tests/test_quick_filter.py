"""
Quick-filter parsing for the transaction list (shared by the Transactions page and the import
file-ledger drawer). Pure functions — no DB. Covers the date jumps (year / month / day) and amount
matching, plus the bare-year addition.
"""

from __future__ import annotations

import unittest

from backend.routers.transactions import (
    _build_quick_filter_clause,
    _fts_date_phrases,
    _parse_quick_filter_amount,
    _parse_quick_filter_date,
    _parse_quick_filter_month,
    _parse_quick_filter_month_day,
    _parse_quick_filter_year,
    _parse_quick_filter_year_month,
)
from backend.services.input_format import InputFormat


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
        # "9" matches every September (LIKE '%-09-%') and also ORs the $9.00–$9.99 amount match.
        clause, params = _build_quick_filter_clause("9")
        self.assertIn("%-09-%", params)
        self.assertIn(900, params)
        self.assertIn(999, params)

    def test_amount(self):
        def parsed(value):
            result = _parse_quick_filter_amount(value)
            return result

        # The dollars are exact; the cents narrow only as far as they have been typed.
        self.assertEqual(parsed("68"), (6800, 6899, None))
        self.assertEqual(parsed("68."), (6800, 6899, None))
        self.assertEqual(parsed("7"), (700, 799, None))            # never $70 or $700
        self.assertEqual(parsed("77.4"), (7740, 7749, None))
        self.assertEqual(parsed("77.45"), (7745, 7745, None))
        self.assertEqual(parsed("77.456"), (7746, 7746, None))     # past the cent, rounded to it
        self.assertEqual(parsed("$1,234.5"), (123450, 123459, None))
        self.assertEqual(parsed(".5"), (50, 59, None))
        # The sign as a person writes it: minus is money paid out, plus is money received.
        self.assertEqual(parsed("-20.22"), (2022, 2022, "out"))
        self.assertEqual(parsed("-$20.22"), (2022, 2022, "out"))
        self.assertEqual(parsed("(20.22)"), (2022, 2022, "out"))
        self.assertEqual(parsed("+20"), (2000, 2099, "in"))
        self.assertIsNone(parsed("(-20.22)"))
        self.assertIsNone(parsed("not-a-number"))
        # `Decimal` reads all three of these; none of them is an amount anyone typed.
        self.assertIsNone(parsed("inf"))
        self.assertIsNone(parsed("nan"))
        self.assertIsNone(parsed("1e3"))

    def test_signed_amount_flips_to_the_stored_sign(self):
        # Stored money out is positive, so a typed "-" compares the stored amount as it is and a typed "+"
        # compares it negated; no sign compares the magnitude.
        clause, params = _build_quick_filter_clause("amount:-20.22")
        self.assertEqual(clause, "(CAST(ROUND(t.amount * 100) AS INTEGER) BETWEEN ? AND ?)")
        self.assertEqual(params, [2022, 2022])
        clause, params = _build_quick_filter_clause("amount:+20.22")
        self.assertEqual(clause, "(CAST(ROUND(-t.amount * 100) AS INTEGER) BETWEEN ? AND ?)")
        clause, params = _build_quick_filter_clause("amount:20.22")
        self.assertEqual(clause, "(CAST(ROUND(ABS(t.amount) * 100) AS INTEGER) BETWEEN ? AND ?)")

    def test_bare_year_builds_date_year_clause(self):
        clause, params = _build_quick_filter_clause("2023")
        self.assertIn("t.date LIKE ?", clause)
        self.assertIn("2023-%", params)   # year jump
        self.assertIn(202300, params)      # also ORs the amount match ($2,023.00–$2,023.99)
        self.assertIn(202399, params)

    def test_field_prefix_restricts(self):
        # date:2023 restricts to the date-year clause only — no merchant/amount OR.
        clause, params = _build_quick_filter_clause("date:2023")
        self.assertIn("t.date LIKE ?", clause)
        self.assertIn("2023-%", params)
        self.assertNotIn("display_name", clause)


if __name__ == "__main__":
    unittest.main()


class InputFormatParsingTests(unittest.TestCase):
    """The quick filter reads dates and amounts in the searcher's chosen format. `01/02/2026` and `1.234`
    each mean two different things, and reading them in the wrong convention finds the wrong rows without
    a word."""

    def test_a_numeric_date_follows_the_date_order(self):
        self.assertEqual(_parse_quick_filter_date("01/02/2026", "mdy"), "2026-01-02")
        self.assertEqual(_parse_quick_filter_date("01/02/2026", "dmy"), "2026-02-01")
        self.assertEqual(_parse_quick_filter_date("31.01.2026", "dmy"), "2026-01-31")
        self.assertEqual(_parse_quick_filter_date("2026/02/01", "ymd"), "2026-02-01")
        self.assertIsNone(_parse_quick_filter_date("31/01/2026", "mdy"))

    def test_iso_and_a_named_month_read_the_same_in_every_order(self):
        for order in ("mdy", "dmy", "ymd"):
            self.assertEqual(_parse_quick_filter_date("2026-02-01", order), "2026-02-01")
            self.assertEqual(_parse_quick_filter_date("1 Feb 2026", order), "2026-02-01")
            self.assertEqual(_parse_quick_filter_date("Feb 1, 2026", order), "2026-02-01")

    def test_a_month_and_day_follow_the_date_order(self):
        self.assertEqual(_parse_quick_filter_month_day("01/02", "mdy"), "01-02")
        self.assertEqual(_parse_quick_filter_month_day("01/02", "dmy"), "02-01")
        self.assertIsNone(_parse_quick_filter_month_day("25/12", "mdy"))
        self.assertEqual(_parse_quick_filter_month_day("25/12", "dmy"), "12-25")

    def test_an_amount_follows_the_decimal_separator(self):
        self.assertEqual(_parse_quick_filter_amount("1.234,56", "comma"), (123456, 123456, None))
        self.assertIsNone(_parse_quick_filter_amount("1.234,56", "point"))
        # The same text, a different number in each convention.
        self.assertEqual(_parse_quick_filter_amount("1.234", "point"), (123, 123, None))
        self.assertEqual(_parse_quick_filter_amount("1.234", "comma"), (123400, 123499, None))
        self.assertEqual(_parse_quick_filter_amount("12,5", "comma"), (1250, 1259, None))
        self.assertEqual(_parse_quick_filter_amount("-1 234,56 €", "comma"), (123456, 123456, "out"))

    def test_a_receipt_date_is_searched_in_the_date_order(self):
        self.assertIn("1 2 2026", _fts_date_phrases("01/02/2026", "dmy"))  # day first, as typed
        self.assertNotIn("2 1 2026", _fts_date_phrases("01/02/2026", "dmy"))
        self.assertIn("2 1 2026", _fts_date_phrases("02/01/2026", "mdy"))
        self.assertIn("2026 2 1", _fts_date_phrases("2026-02-01", "ymd"))

    def test_the_clause_reads_in_the_format_it_is_given(self):
        _, params = _build_quick_filter_clause("date:01/02/2026", input_format=InputFormat(date_order="dmy"))
        self.assertIn("2026-02-01", params)
        _, params = _build_quick_filter_clause("date:01/02/2026")
        self.assertIn("2026-01-02", params)
