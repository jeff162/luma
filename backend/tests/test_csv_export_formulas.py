"""
Text written by others must not reach a spreadsheet as a formula (`backup.spreadsheet_safe`).

A merchant name or a PayPal note opening with `=`, `+`, `-` or `@` is exported as text; numbers, including
negative amounts, and the split marker the export writes itself are left as they are.
"""

from __future__ import annotations

import unittest

from backend.routers.import_export.backup import SPLIT_EXPORT_MARKER, spreadsheet_safe


class SpreadsheetSafeTest(unittest.TestCase):
    def test_text_opening_a_formula_is_exported_as_text(self):
        for value in ('=HYPERLINK("http://x.invalid","pay")', "+1+1", "-2+3", "@SUM(A1)", "\tTAB", "\rCR"):
            with self.subTest(value=value):
                self.assertEqual(spreadsheet_safe(value), f"'{value}")

    def test_ordinary_text_numbers_and_the_split_marker_are_unchanged(self):
        for value in ("Coffee Shop", "2026-01-02", -17.99, 0, None, SPLIT_EXPORT_MARKER):
            with self.subTest(value=value):
                self.assertEqual(spreadsheet_safe(value), value)


if __name__ == "__main__":
    unittest.main()
