"""
`parse_amount` — what an amount cell means.

One parser serves both the import and the mapping preview, so this is the single place the meaning
of a cell is pinned. Stored convention: **positive = debit (money out), negative = credit**.

The subtlety worth stating, because getting it wrong is what these tests were written for: a cell
carries at most one of two direction signals, and they point opposite ways. A bare sign is in the
*file's* convention (positive = money in), so it is inverted on the way to storage; a `DR`/`CR`
suffix names the direction outright and must not be inverted. Reading a suffix as if it were a bare
sign is what made `50.00 CR` — a credit, in the notation's own terms — import as a debit.
"""

from __future__ import annotations

import unittest

from backend.routers.import_export.core import AmountColumnMap, parse_amount

SINGLE = AmountColumnMap(amount="Amount")
SINGLE_WITH_DIRECTION = AmountColumnMap(amount="Amount", direction="Type")
TWO_COLUMN = AmountColumnMap(debit="Debit", credit="Credit")


def single(cell, convention="single_signed", col_map=SINGLE, **extra):
    return parse_amount({"Amount": cell, **extra}, convention, col_map)


def two_column(debit="", credit=""):
    return parse_amount({"Debit": debit, "Credit": credit}, "two_column", TWO_COLUMN)


class SignedAmountColumnTests(unittest.TestCase):
    """A single column whose sign is the file's: money out is written negative."""

    def test_the_file_sign_is_inverted_into_stored_convention(self):
        self.assertEqual(single("-50.00"), 50.0)     # money out → debit
        self.assertEqual(single("50.00"), -50.0)     # money in  → credit

    def test_accounting_parentheses_are_a_negative(self):
        self.assertEqual(single("(50.00)"), 50.0)

    def test_currency_symbols_and_thousands_separators_are_ignored(self):
        self.assertEqual(single("$1,234.56"), -1234.56)
        self.assertEqual(single(" -$1,234.56 "), 1234.56)

    def test_an_unparseable_cell_is_none(self):
        self.assertIsNone(single("n/a"))
        self.assertIsNone(single(""))

    def test_a_missing_column_is_none(self):
        self.assertIsNone(parse_amount({"Other": "50.00"}, "single_signed", SINGLE))


class DirectionMarkerTests(unittest.TestCase):
    """`DR`/`CR` state the direction, so they are read as written rather than inverted."""

    def test_dr_is_a_debit_and_cr_is_a_credit(self):
        self.assertEqual(single("50.00DR"), 50.0)
        self.assertEqual(single("50.00 CR"), -50.0)

    def test_the_marker_is_case_insensitive_and_survives_formatting(self):
        self.assertEqual(single("$1,234.56 cr"), -1234.56)
        self.assertEqual(single("1234.56dr"), 1234.56)

    def test_the_marker_overrides_the_cell_sign(self):
        # A source that writes both says the same thing twice; the explicit half wins either way.
        self.assertEqual(single("-50.00CR"), -50.0)
        self.assertEqual(single("-50.00DR"), 50.0)

    def test_a_marker_in_a_two_column_cell_overrides_its_column(self):
        self.assertEqual(two_column(debit="50.00CR"), -50.0)
        self.assertEqual(two_column(credit="50.00DR"), 50.0)

    def test_a_mapped_direction_column_outranks_a_marker(self):
        # The user picked that column to say which way the row goes; a stray suffix doesn't overrule it.
        self.assertEqual(
            single("50.00CR", "single_unsigned", SINGLE_WITH_DIRECTION, Type="debit"), 50.0,
        )


class UnsignedWithDirectionColumnTests(unittest.TestCase):
    def test_the_direction_column_decides(self):
        for word in ("credit", "CR", "Deposit", "income"):
            self.assertEqual(
                single("27.52", "single_unsigned", SINGLE_WITH_DIRECTION, Type=word), -27.52, word,
            )
        for word in ("debit", "withdrawal", ""):
            self.assertEqual(
                single("27.52", "single_unsigned", SINGLE_WITH_DIRECTION, Type=word), 27.52, word,
            )

    def test_without_a_mapped_direction_column_the_cell_is_read_as_signed(self):
        self.assertEqual(single("27.52", "single_unsigned"), -27.52)


class TwoColumnTests(unittest.TestCase):
    def test_the_column_supplies_the_direction(self):
        self.assertEqual(two_column(debit="40.00"), 40.0)
        self.assertEqual(two_column(credit="40.00"), -40.0)

    def test_a_negative_cell_reverses_its_column(self):
        # A parenthesized or negative debit is a reversal — money back in — and reads as a credit.
        self.assertEqual(two_column(debit="(40.00)"), -40.0)
        self.assertEqual(two_column(debit="-40.00"), -40.0)
        self.assertEqual(two_column(credit="(40.00)"), 40.0)

    def test_the_debit_cell_wins_when_both_are_filled(self):
        self.assertEqual(two_column(debit="40.00", credit="10.00"), 40.0)

    def test_a_blank_pair_is_zero_not_unparseable(self):
        # Zero is a real transaction (a fully-refunded charge), so a blank row imports rather than
        # being rejected — and prints as a plain 0.0, never -0.0.
        for debit, credit in [("", ""), ("   ", ""), ("", None)]:
            self.assertEqual(two_column(debit=debit, credit=credit), 0.0)
            self.assertEqual(str(two_column(debit=debit, credit=credit)), "0.0")

    def test_an_unparseable_cell_is_none(self):
        self.assertIsNone(two_column(debit="n/a"))


if __name__ == "__main__":
    unittest.main()
