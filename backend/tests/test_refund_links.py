"""Pairing a refund with the payment it returns (`services/refund_links.py`).

The PayPal statement path is exercised end to end in `test_paypal_statement.py`. What is pinned here is
the part that is *not* PayPal-specific: **a stated reference is what qualifies a row**, and a captured
`Type` is only ever a veto.

That is worth its own file because the two halves fail in opposite directions and both fail silently.
Requiring a refund-ish `Type` makes an ordinary CSV — which has a `Reference Txn ID` column and no
`Type` column at all — pair nothing, leaving money back sitting outside the category it offsets.
Dropping the veto makes a deposit or withdrawal that names its counterpart in the same field read as a
refund of it, which is wallet funding-leg suppression's row, not this mechanism's
(`docs/mechanism-index.md`). Neither shows up as an error; both show up as a wrong category total.
"""

from __future__ import annotations

import json
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path

from backend.db.database import get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers.import_export.core import run_import_core
from backend.services.refund_links import pair_stated_refunds

ACCOUNT = "Cashback Card"
HEADERS = "Date,Merchant,Account,Amount,Txn Id,Reference Txn Id,Type"


def csv_text(rows, *, with_type: bool = False) -> str:
    """`rows` are (date, merchant, amount, txn_id, reference[, type]) tuples. A source with no `Type`
    column is the ordinary case — most files have nothing to corroborate a reference with.

    `amount` is stated as the **ledger** signs it (positive is money out), and written into the cell
    negated, because a bare sign in a file is in the file's convention and the import inverts it."""
    header = HEADERS if with_type else HEADERS.rsplit(",", 1)[0]
    lines = [header]
    for row in rows:
        date, merchant, amount, txn_id, reference = row[:5]
        cells = [date, merchant, ACCOUNT, f"{-amount:.2f}", txn_id, reference]
        if with_type:
            cells.append(row[5])
        lines.append(",".join(cells))
    return "\n".join(lines) + "\n"


class RefundPairingTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "refunds.db"
        init_db(str(self.db_path))
        with get_db(str(self.db_path)) as conn:
            conn.execute(
                "INSERT INTO account (id, name, display_name, type) VALUES ('acc', ?, ?, 'credit')",
                (ACCOUNT, ACCOUNT),
            )
            conn.execute(
                "INSERT INTO csv_import_profile (id, name, column_map, date_format, amount_convention) "
                "VALUES ('src', 'Card export', '{}', '%Y-%m-%d', 'single_signed')"
            )
            conn.execute("INSERT INTO category (id, name, parent_id) VALUES ('grp', 'Shopping', NULL)")
            conn.execute("INSERT INTO category (id, name, parent_id) VALUES ('books', 'Books', 'grp')")
            conn.execute("INSERT INTO category (id, name, parent_id) VALUES ('gifts', 'Gifts', 'grp')")

    def tearDown(self):
        self.tempdir.cleanup()

    @contextmanager
    def _use_db_path(self):
        token = set_current_db_path(str(self.db_path))
        try:
            yield
        finally:
            reset_current_db_path(token)

    def _import(self, text: str, *, filename: str, with_type: bool) -> dict:
        evidence = ["Reference Txn Id"] + (["Type"] if with_type else [])
        cfg = {
            "profile_id": "src",
            "account_map": {ACCOUNT: "acc"},
            "column_map": {
                "date": "Date", "description": "Merchant", "account": "Account",
                "amount": "Amount", "transaction_id": "Txn Id",
                "evidence_columns": evidence,
            },
            "date_format": "%Y-%m-%d",
            "amount_convention": "single_signed",
            "apply_categorization": False,
        }
        with self._use_db_path():
            return run_import_core(text, cfg, filename=filename)

    def _categorize(self, txn_id: str, category_id: str) -> None:
        with get_db(str(self.db_path)) as conn:
            conn.execute(
                "UPDATE txn SET category_id = ?, category_source = 'manual', category_overridden = 1 "
                "WHERE id = ?",
                (category_id, txn_id),
            )

    def _pair(self) -> dict:
        with get_db(str(self.db_path)) as conn:
            return pair_stated_refunds(conn)

    def _rows_by_amount(self) -> dict:
        with get_db(str(self.db_path)) as conn:
            return {
                round(float(r["amount"]), 2): dict(r)
                for r in conn.execute(
                    "SELECT id, amount, category_id, category_source FROM txn WHERE trashed_at IS NULL"
                )
            }

    def _links(self) -> set:
        with get_db(str(self.db_path)) as conn:
            return {
                (r["kind"], r["role"], r["txn_id"])
                for r in conn.execute(
                    "SELECT l.kind, m.role, m.txn_id FROM txn_link l "
                    "JOIN txn_link_member m ON m.link_id = l.id"
                )
            }

    def _evidence_headers(self, txn_id: str) -> set:
        with get_db(str(self.db_path)) as conn:
            raw = conn.execute(
                "SELECT import_evidence_json FROM txn WHERE id = ?", (txn_id,)
            ).fetchone()[0]
        fields = (json.loads(raw) or {}).get("extra_text_fields") or []
        return {str(f.get("header")) for f in fields}

    # --- a file with no Type column at all: the documented CSV case -------------------------------

    def test_a_stated_reference_pairs_a_refund_from_a_source_that_captures_no_type(self):
        self._import(
            csv_text([("2026-04-01", "Bookshop", 40.0, "TX-1", "")], with_type=False),
            filename="april.csv", with_type=False,
        )
        payment = self._rows_by_amount()[40.0]["id"]
        self._categorize(payment, "books")

        self._import(
            csv_text([("2026-04-10", "Bookshop", -40.0, "TX-9", "TX-1")], with_type=False),
            filename="may.csv", with_type=False,
        )
        refund = self._rows_by_amount()[-40.0]["id"]
        # The reference really is the only signal the row carries — nothing named a `Type`.
        self.assertEqual(self._evidence_headers(refund), {"Reference Txn Id"})

        self.assertEqual(self._links(), {("refund", "payment", payment), ("refund", "refund", refund)})
        self.assertEqual(
            (self._rows_by_amount()[-40.0]["category_id"], self._rows_by_amount()[-40.0]["category_source"]),
            ("books", "refund"),
            "money back belongs in the category it offsets",
        )

    def test_a_word_the_paypal_vocabulary_does_not_know_still_pairs(self):
        # "Return" is what a card export calls it. The vocabulary is PayPal's, and a source outside it
        # must not have to speak PayPal to be understood.
        self._import(
            csv_text([("2026-04-01", "Bookshop", 40.0, "TX-1", "", "Purchase")], with_type=True),
            filename="april.csv", with_type=True,
        )
        payment = self._rows_by_amount()[40.0]["id"]
        self._categorize(payment, "books")
        self._import(
            csv_text([("2026-04-10", "Bookshop", -40.0, "TX-9", "TX-1", "Return")], with_type=True),
            filename="may.csv", with_type=True,
        )
        self.assertEqual(self._rows_by_amount()[-40.0]["category_source"], "refund")

    # --- the veto -------------------------------------------------------------------------------

    def test_a_type_naming_money_movement_is_not_a_refund_however_it_references(self):
        # A deposit funding the payment it paid for references it in the same field, and is the wallet
        # funding leg's row. Taking it as a refund would move it into the payment's category and count
        # the purchase against that category twice over.
        self._import(
            csv_text([("2026-04-01", "Bookshop", 40.0, "TX-1", "", "Purchase")], with_type=True),
            filename="april.csv", with_type=True,
        )
        payment = self._rows_by_amount()[40.0]["id"]
        self._categorize(payment, "books")
        self._import(
            csv_text([("2026-04-02", "", -40.0, "TX-5", "TX-1", "General Withdrawal")], with_type=True),
            filename="may.csv", with_type=True,
        )
        self.assertEqual(self._pair()["paired"], 0)
        self.assertNotIn(("refund", "refund", self._rows_by_amount()[-40.0]["id"]), self._links())

    def test_add_money_from_a_card_is_vetoed_although_the_money_movement_list_omits_it(self):
        # `is_money_movement_type` alone answers False here — the exact vocabulary carries only "Add
        # Money from a Bank Account" and the fragment list has no "add money". It is the wallet-funding
        # vocabulary that catches it, which is why the veto is the union of the three.
        from backend.services.money_movement import is_money_movement_type, states_money_movement

        self.assertFalse(is_money_movement_type("Add Money from a Card"))
        self.assertTrue(states_money_movement("Add Money from a Card"))

    # --- the structural conditions still apply ----------------------------------------------------

    def test_a_reference_naming_nothing_held_pairs_nothing(self):
        self._import(
            csv_text([("2026-04-10", "Bookshop", -40.0, "TX-9", "TX-404")], with_type=False),
            filename="may.csv", with_type=False,
        )
        self.assertEqual(self._pair()["paired"], 0)
        self.assertEqual(self._links(), set())

    def test_a_reference_to_a_smaller_payment_pairs_nothing(self):
        # "no more than was paid" is what separates a refund from an unrelated credit that happens to
        # name a transaction.
        self._import(
            csv_text([("2026-04-01", "Bookshop", 15.0, "TX-1", "")], with_type=False),
            filename="april.csv", with_type=False,
        )
        self._import(
            csv_text([("2026-04-10", "Bookshop", -40.0, "TX-9", "TX-1")], with_type=False),
            filename="may.csv", with_type=False,
        )
        self.assertEqual(self._pair()["paired"], 0)

    def test_a_same_direction_reference_pairs_nothing(self):
        self._import(
            csv_text([("2026-04-01", "Bookshop", 40.0, "TX-1", "")], with_type=False),
            filename="april.csv", with_type=False,
        )
        self._import(
            csv_text([("2026-04-10", "Bookshop", 25.0, "TX-9", "TX-1")], with_type=False),
            filename="may.csv", with_type=False,
        )
        self.assertEqual(self._pair()["paired"], 0)


if __name__ == "__main__":
    unittest.main()
