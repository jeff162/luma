"""
`/preview/amounts` — the mapping table's amounts.

The preview used to parse amounts a second time, in the browser, and the two implementations
disagreed in four measured ways: a `single_unsigned` row ignored its direction column (every row
rendered as a credit — the reported bug), a `DR` suffix read as a credit, a `CR` suffix in a
two-column debit cell read as a debit, and a blank/blank two-column row rendered unparseable
instead of zero. The endpoint exists so there is only one parser; these tests pin each divergence
to the *import's* answer, so a future change to `parse_amount` moves the preview with it.

The rest is the endpoint's own contract: positional alignment with the posted rows, `null` for an
unparseable cell or an unmapped convention column, and the row cap.
"""

from __future__ import annotations

import unittest
from contextlib import ExitStack

from backend.routers.import_export.core import AmountColumnMap, parse_amount
from backend.routers.import_export.preview import MAX_PREVIEW_AMOUNT_ROWS

from backend.tests._api_client import api_client


class PreviewAmountsTestCase(unittest.TestCase):
    """One client for the whole class — the endpoint reads no database, so nothing leaks between tests."""

    @classmethod
    def setUpClass(cls):
        cls._stack = ExitStack()
        cls.client, _ = cls._stack.enter_context(api_client())

    @classmethod
    def tearDownClass(cls):
        cls._stack.close()

    def post_amounts(self, rows, convention, column_map, **extra):
        return self.client.post("/api/import-export/preview/amounts", json={
            "rows": rows,
            "amount_convention": convention,
            "column_map": column_map,
            **extra,
        })


class PreviewAmountParityTests(PreviewAmountsTestCase):
    """Each case asserts the endpoint agrees with `parse_amount` — the import's answer — by value."""

    def assert_matches_import(self, rows, convention, column_map, expected, decimal_separator="point"):
        res = self.post_amounts(rows, convention, column_map, decimal_separator=decimal_separator)
        self.assertEqual(res.status_code, 200)
        amounts = res.json()["amounts"]
        self.assertEqual(amounts, expected)
        col_map = AmountColumnMap(**column_map)
        self.assertEqual(
            amounts, [parse_amount(r, convention, col_map, decimal_separator=decimal_separator) for r in rows],
        )

    def test_single_unsigned_honours_direction_column(self):
        # The reported bug: positive amounts with a separate debit/credit column all rendered green.
        rows = [
            {"Amount": "27.52", "Transaction Type": "debit"},
            {"Amount": "100.00", "Transaction Type": "credit"},
            {"Amount": "12.00", "Transaction Type": "Deposit"},
        ]
        self.assert_matches_import(
            rows, "single_unsigned",
            {"amount": "Amount", "direction": "Transaction Type"},
            [27.52, -100.0, -12.0],
        )

    def test_single_signed_flips_the_file_sign(self):
        rows = [{"Amount": "-27.52"}, {"Amount": "100.00"}, {"Amount": "($1,234.56)"}]
        self.assert_matches_import(
            rows, "single_signed", {"amount": "Amount"}, [27.52, -100.0, 1234.56],
        )

    def test_dr_and_cr_suffixes_in_a_single_column(self):
        rows = [{"Amount": "50.00DR"}, {"Amount": "50.00 CR"}]
        self.assert_matches_import(
            rows, "single_signed", {"amount": "Amount"}, [50.0, -50.0],
        )

    def test_cr_suffix_in_a_two_column_debit_cell_is_a_credit(self):
        rows = [{"Debit": "50.00CR", "Credit": ""}]
        self.assert_matches_import(
            rows, "two_column", {"debit": "Debit", "credit": "Credit"}, [-50.0],
        )

    def test_two_column_debit_and_credit_cells(self):
        rows = [
            {"Debit": "40.00", "Credit": ""},
            {"Debit": "", "Credit": "40.00"},
        ]
        self.assert_matches_import(
            rows, "two_column", {"debit": "Debit", "credit": "Credit"}, [40.0, -40.0],
        )

    def test_blank_two_column_row_is_zero_not_unparseable(self):
        # Deliberate: zero is what the import stores for this row, so the preview shows $0.00.
        rows = [{"Debit": "", "Credit": ""}, {"Debit": "   ", "Credit": None}]
        self.assert_matches_import(
            rows, "two_column", {"debit": "Debit", "credit": "Credit"}, [0.0, 0.0],
        )

    def test_the_decimal_separator_is_the_one_posted(self):
        rows = [{"Amount": "-1.234,56"}, {"Amount": "12,50"}]
        self.assert_matches_import(
            rows, "single_signed", {"amount": "Amount"}, [1234.56, -12.5], decimal_separator="comma",
        )
        self.assert_matches_import(rows, "single_signed", {"amount": "Amount"}, [None, None])


class PreviewAmountContractTests(PreviewAmountsTestCase):
    def test_unparseable_cell_is_null(self):
        res = self.post_amounts([{"Amount": "n/a"}, {"Amount": "12.00"}], "single_signed", {"amount": "Amount"})
        self.assertEqual(res.json()["amounts"], [None, -12.0])

    def test_unmapped_amount_column_is_null_for_every_row(self):
        res = self.post_amounts([{"Amount": "12.00"}] * 3, "single_signed", {})
        self.assertEqual(res.json()["amounts"], [None, None, None])

    def test_half_mapped_two_column_is_null_rather_than_zero(self):
        # Without the guard `parse_amount` would read the unmapped side as blank and return 0.0.
        rows = [{"Debit": "40.00", "Credit": ""}]
        res = self.post_amounts(rows, "two_column", {"debit": "Debit"})
        self.assertEqual(res.json()["amounts"], [None])
        self.assertEqual(
            parse_amount(rows[0], "two_column", AmountColumnMap(debit="Debit"), decimal_separator="point"), 40.0,
        )

    def test_single_unsigned_without_a_direction_column_still_parses(self):
        res = self.post_amounts([{"Amount": "27.52"}], "single_unsigned", {"amount": "Amount"})
        self.assertEqual(res.json()["amounts"], [-27.52])

    def test_amounts_are_positionally_aligned_with_rows(self):
        rows = [{"Amount": str(i)} for i in range(10)]
        res = self.post_amounts(rows, "single_signed", {"amount": "Amount"})
        self.assertEqual(res.json()["amounts"], [-float(i) for i in range(10)])

    def test_row_cap_is_enforced(self):
        rows = [{"Amount": "1.00"}] * (MAX_PREVIEW_AMOUNT_ROWS + 1)
        res = self.post_amounts(rows, "single_signed", {"amount": "Amount"})
        self.assertEqual(res.status_code, 400)
        self.assertIn(str(MAX_PREVIEW_AMOUNT_ROWS), res.json()["detail"])

    def test_row_cap_boundary_is_accepted(self):
        rows = [{"Amount": "1.00"}] * MAX_PREVIEW_AMOUNT_ROWS
        res = self.post_amounts(rows, "single_signed", {"amount": "Amount"})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(len(res.json()["amounts"]), MAX_PREVIEW_AMOUNT_ROWS)

    def test_an_unknown_decimal_separator_is_refused(self):
        res = self.post_amounts([{"Amount": "1.00"}], "single_signed", {"amount": "Amount"}, decimal_separator="dot")
        self.assertEqual(res.status_code, 422)

    def test_no_rows_returns_no_amounts(self):
        res = self.post_amounts([], "single_signed", {"amount": "Amount"})
        self.assertEqual(res.json()["amounts"], [])


if __name__ == "__main__":
    unittest.main()
