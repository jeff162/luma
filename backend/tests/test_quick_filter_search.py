"""The ledger quick filter against a real database: what a search finds, and what it marks.

`test_quick_filter.py` pins the parsing as pure functions. This covers what only exists once the SQL runs:
that a renamed row is still found by the text its bank sent, that an import's memo column is searchable,
that a row found through text not on screen is marked as such, that a typed sign means what a person means
by it, and that a malformed stored value cannot take the search down with it.
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from backend.db.database import get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers.transactions import list_transactions

UTILITY_EVIDENCE = json.dumps({
    "description": {"header": "Description", "value": "RIVERSTONE UTILITIES WEB PMT"},
    "extra_text_fields": [
        {"header": "Memo", "value": "meter reading 7781"},
        {"header": "Type", "value": "Bill Payment", "role": "categorical"},
    ],
})
# Valid JSON in the wrong shape: a description that is a bare string and extras that are not objects. The
# rule matcher skips both, and the search has to skip them the same way rather than raise.
ODD_SHAPE_EVIDENCE = json.dumps({"description": "loose description", "extra_text_fields": ["loose extra", 7]})


class QuickFilterSearchTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.db_path = str(Path(self.tempdir.name) / "quick-filter-search.db")
        init_db(self.db_path)
        token = set_current_db_path(self.db_path)
        self.addCleanup(reset_current_db_path, token)
        with get_db() as conn:
            conn.execute("INSERT INTO account (id, name, display_name) VALUES ('acct', 'Everyday', 'Everyday')")
            for txn_id, display, merchant, raw, amount, evidence in (
                # Renamed by a rule: the bank's text is on the row but not on screen. Money out is positive.
                ("txn-utility", "City Water", "RIVERSTONE UTILITIES", "RIVERSTONE UTILITIES 0412", 42.10,
                 UTILITY_EVIDENCE),
                # The same amount the other way: money received.
                ("txn-refund", "Harborline Hardware", "Harborline Hardware", "HARBORLINE HARDWARE", -42.10, None),
                ("txn-bakery", "Corner Bakery", "Corner Bakery", "CORNER BAKERY", 7.00, "{not json"),
                ("txn-books", "Northgate Books", "Northgate Books", "NORTHGATE BOOKS", 12.00, ODD_SHAPE_EVIDENCE),
                ("txn-outfitters", "Nantucket Outfitters", "Nantucket Outfitters", "NANTUCKET OUTFITTERS", 60.00,
                 None),
            ):
                conn.execute(
                    "INSERT INTO txn (id, account_id, amount, date, merchant_name, display_name, raw_name, "
                    "import_evidence_json) VALUES (?, 'acct', ?, '2026-03-14', ?, ?, ?, ?)",
                    (txn_id, amount, merchant, display, raw, evidence),
                )

    def _rows(self, value):
        return list_transactions(
            month=None, date_start=None, date_end=None, import_batch_id=None,
            sort_by="date", sort_dir="desc", account_id=None, category_id=None,
            direction=None, view=None, search=None, quick_filter=value,
            include_trashed=False, limit=50, offset=0,
        )["transactions"]

    def found(self, value):
        return sorted(row["id"] for row in self._rows(value))

    def marked(self, value):
        return sorted(row["id"] for row in self._rows(value) if row.get("matched_hidden_text"))


class NameAndImportedTextTests(QuickFilterSearchTests):
    def test_a_renamed_row_is_found_by_the_name_its_bank_sent(self):
        # The reported case: the row shows "City Water", and a search for the bank's own wording found nothing.
        self.assertEqual(self.found("riverstone"), ["txn-utility"])
        self.assertEqual(self.marked("riverstone"), ["txn-utility"])

    def test_imported_free_text_is_searchable_and_marked(self):
        self.assertEqual(self.found("meter reading"), ["txn-utility"])
        self.assertEqual(self.marked("meter reading"), ["txn-utility"])
        self.assertEqual(self.found("web pmt"), ["txn-utility"])

    def test_a_marked_row_carries_the_text_searched_for(self):
        # The hover that shows the hidden text highlights this, so it is the value after any keyword.
        [row] = self._rows("merchant:riverstone")
        self.assertEqual(row["matched_search_text"], "riverstone")
        [row] = self._rows("city water")
        self.assertNotIn("matched_search_text", row)

    def test_a_match_on_the_visible_name_is_not_marked(self):
        # The name on screen already explains it, so flagging it would send the reader looking elsewhere.
        self.assertEqual(self.found("city water"), ["txn-utility"])
        self.assertEqual(self.marked("city water"), [])

    def test_merchant_keyword_searches_names_but_not_imported_text(self):
        self.assertEqual(self.found("merchant:riverstone"), ["txn-utility"])
        self.assertEqual(self.marked("merchant:riverstone"), ["txn-utility"])
        self.assertEqual(self.found("merchant:meter reading"), [])

    def test_raw_keyword_searches_imported_text_but_not_names_given_since(self):
        # The bank's wording and the captured memo column are imported text...
        self.assertEqual(self.found("raw:riverstone utilities 0412"), ["txn-utility"])
        self.assertEqual(self.found("raw:meter reading"), ["txn-utility"])
        self.assertEqual(self.marked("raw:meter reading"), ["txn-utility"])
        # ...the rename is not, and neither is the cleaned name when the raw text does not contain it.
        self.assertEqual(self.found("raw:city water"), [])
        with get_db() as conn:
            conn.execute("UPDATE txn SET merchant_name = 'Riverstone Water Co' WHERE id = 'txn-utility'")
        self.assertEqual(self.found("raw:water co"), [])
        self.assertEqual(self.found("merchant:water co"), ["txn-utility"])

    def test_raw_keyword_finds_a_row_whose_visible_name_is_the_raw_one_without_marking_it(self):
        # No rename and no cleaned name: the raw text is on screen, so it explains the match itself.
        with get_db() as conn:
            conn.execute("UPDATE txn SET display_name = NULL, merchant_name = NULL WHERE id = 'txn-bakery'")
        self.assertEqual(self.found("raw:corner bakery"), ["txn-bakery"])
        self.assertEqual(self.marked("raw:corner bakery"), [])

    def test_the_keyword_value_is_the_whole_rest_of_the_box(self):
        self.assertEqual(self.found("merchant:city water"), ["txn-utility"])
        # A keyword later in the box is not a keyword: this is one piece of text, not an amount and a name.
        self.assertEqual(self.found("+42.10 merchant:city water"), [])

    def test_other_keywords_carry_no_hidden_text_flag(self):
        rows = self._rows("amount:42.10")
        self.assertEqual(sorted(row["id"] for row in rows), ["txn-refund", "txn-utility"])
        self.assertTrue(all("matched_hidden_text" not in row for row in rows))

    def test_a_term_json_would_escape_still_finds_imported_text(self):
        # The stored-string pre-check is skipped for such terms; were it applied, the escaped form in the
        # stored JSON would hide this row.
        with get_db() as conn:
            conn.execute(
                "UPDATE txn SET import_evidence_json = ? WHERE id = 'txn-refund'",
                (json.dumps({"extra_text_fields": [{"header": "Memo", "value": 'Café "north" till'}]}),),
            )
        self.assertEqual(self.found("café"), ["txn-refund"])
        self.assertEqual(self.found('"north"'), ["txn-refund"])

    def test_malformed_or_odd_evidence_does_not_break_the_search(self):
        # One unparseable stored value used to be able to fail the whole list query.
        self.assertEqual(self.found("bakery"), ["txn-bakery"])
        self.assertEqual(self.found("meter"), ["txn-utility"])
        self.assertEqual(self.found("loose"), [])


class AmountSignTests(QuickFilterSearchTests):
    def test_a_bare_amount_matches_either_direction(self):
        self.assertEqual(self.found("42.10"), ["txn-refund", "txn-utility"])

    def test_a_minus_means_money_paid_out(self):
        self.assertEqual(self.found("-42.10"), ["txn-utility"])
        self.assertEqual(self.found("(42.10)"), ["txn-utility"])
        self.assertEqual(self.found("-$42.10"), ["txn-utility"])
        self.assertEqual(self.found("amount:-42.10"), ["txn-utility"])

    def test_a_plus_means_money_received(self):
        self.assertEqual(self.found("+42.10"), ["txn-refund"])
        self.assertEqual(self.found("amount:+42.10"), ["txn-refund"])

    def test_words_that_decimal_would_read_as_numbers_search_as_text(self):
        # `Decimal` accepts "nan" and "inf", which raised out of the query while a name was being typed.
        self.assertEqual(self.found("nan"), ["txn-outfitters"])
        self.assertEqual(self.found("inf"), [])


class AmountAsTypedTests(QuickFilterSearchTests):
    """The dollars are exact and the cents narrow only as far as they have been typed.

    Matching to the cent found nothing until the last digit was in, so a $77.35 charge stayed hidden at "77"
    while a $77.00 one showed. Searched with `amount:` so a digit in some row's free text cannot join in.
    """

    def setUp(self):
        super().setUp()
        with get_db() as conn:
            for txn_id, amount in (
                ("txn-77-00", 77.00), ("txn-77-35", 77.35), ("txn-77-40", 77.40), ("txn-77-45", 77.45),
                ("txn-77-49", 77.49), ("txn-770", 770.00),
                # Money received, stored negative.
                ("txn-in-77-20", -77.20),
            ):
                conn.execute(
                    "INSERT INTO txn (id, account_id, amount, date, merchant_name, display_name, raw_name) "
                    "VALUES (?, 'acct', ?, '2026-03-14', 'Payee', 'Payee', 'PAYEE')",
                    (txn_id, amount),
                )

    def test_whole_dollars_match_every_cent_of_them(self):
        self.assertEqual(
            self.found("amount:77"),
            ["txn-77-00", "txn-77-35", "txn-77-40", "txn-77-45", "txn-77-49", "txn-in-77-20"],
        )
        self.assertEqual(self.found("amount:77."), self.found("amount:77"))

    def test_the_dollars_are_not_a_prefix(self):
        self.assertEqual(self.found("amount:7"), ["txn-bakery"])
        self.assertEqual(self.found("amount:770"), ["txn-770"])

    def test_a_typed_tenth_narrows_to_its_cents(self):
        self.assertEqual(self.found("amount:77.4"), ["txn-77-40", "txn-77-45", "txn-77-49"])

    def test_two_decimals_are_exact(self):
        self.assertEqual(self.found("amount:77.45"), ["txn-77-45"])

    def test_the_sign_still_picks_a_direction(self):
        self.assertEqual(
            self.found("amount:-77"),
            ["txn-77-00", "txn-77-35", "txn-77-40", "txn-77-45", "txn-77-49"],
        )
        self.assertEqual(self.found("amount:+77"), ["txn-in-77-20"])


if __name__ == "__main__":
    unittest.main()
