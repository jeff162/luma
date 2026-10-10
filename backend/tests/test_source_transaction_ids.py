"""
A file source's own transaction ids (`services/source_transaction_ids.py`), driven through the real import.

Each case is a miniature of an aggregator's exports: a month imported once, then a later export of the
same data source overlapping it. What the ids add over the content ladder is pinned case by case — a
revision the ladder cannot see, a second identical charge the ladder would swallow, and the backfill of
ids onto rows imported before the export carried them, including the older-file-in-between case.
"""

from __future__ import annotations

import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path

from backend.db.database import get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers.import_export.core import run_import_core

ACCOUNT = "Harborline Card"
WITH_ID = "Date,Merchant,Account,Amount,Id"
WITHOUT_ID = "Date,Merchant,Account,Amount"


def march(day: int) -> str:
    return f"2026-03-{day:02d}"


def csv_text(rows, *, with_id: bool = True) -> str:
    """`rows` are (date, merchant, amount, id) tuples."""
    lines = [WITH_ID if with_id else WITHOUT_ID]
    for date, merchant, amount, source_id in rows:
        cells = [date, merchant, ACCOUNT, f"{amount:.2f}"]
        if with_id:
            cells.append(source_id)
        lines.append(",".join(cells))
    return "\n".join(lines) + "\n"


def month_of_rows(last_day: int = 31) -> list[tuple]:
    """One distinct charge a day, so every row has exactly one plausible twin."""
    return [(march(day), f"Merchant {day:02d}", -(10 + day + 0.25), f"m{day:02d}") for day in range(1, last_day + 1)]


class SourceTransactionIdTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "ids.db"
        init_db(str(self.db_path))
        with get_db(str(self.db_path)) as conn:
            conn.execute(
                "INSERT INTO account (id, external_account_id, provider, name, display_name, type) "
                "VALUES ('acc-card', NULL, 'manual', ?, ?, 'credit')",
                (ACCOUNT, ACCOUNT),
            )
            for profile_id, name in (("src-agg", "Aggregator"), ("src-other", "Other export")):
                conn.execute(
                    "INSERT INTO csv_import_profile (id, name, column_map, date_format, amount_convention) "
                    "VALUES (?, ?, '{}', '%Y-%m-%d', 'single_signed')",
                    (profile_id, name),
                )

    def tearDown(self):
        self.tempdir.cleanup()

    @contextmanager
    def _use_db_path(self):
        token = set_current_db_path(str(self.db_path))
        try:
            yield
        finally:
            reset_current_db_path(token)

    def _import(self, text: str, *, filename: str, profile_id: str = "src-agg", map_id: bool = True) -> dict:
        column_map = {"date": "Date", "description": "Merchant", "account": "Account", "amount": "Amount"}
        if map_id:
            column_map["transaction_id"] = "Id"
        cfg = {
            "profile_id": profile_id,
            "account_map": {ACCOUNT: "acc-card"},
            "column_map": column_map,
            "date_format": "%Y-%m-%d",
            "amount_convention": "single_signed",
            "apply_categorization": False,
        }
        with self._use_db_path():
            return run_import_core(text, cfg, filename=filename)

    def _ledger(self) -> list[dict]:
        with get_db(str(self.db_path)) as conn:
            return [dict(r) for r in conn.execute(
                "SELECT id, date, raw_name, amount, source_transaction_id, import_batch_id FROM txn "
                "WHERE rejection_reason IS NULL ORDER BY date, raw_name, id"
            ).fetchall()]

    def test_a_revised_amount_deep_inside_the_covered_range_corrects_the_held_row(self):
        # The ladder's own revision tier only reaches the trailing window, and needs the descriptor to have
        # survived; on a covered date it can only reject. The id says it is the same transaction.
        first = self._import(csv_text(month_of_rows()), filename="march.csv")
        revised = [row if row[3] != "m05" else (row[0], row[1], -21.50, row[3]) for row in month_of_rows()]
        later = revised + [("2026-04-02", "Merchant 40", -40.25, "m40")]
        held = next(r for r in self._ledger() if r["source_transaction_id"] == "m05")

        result = self._import(csv_text(later), filename="april.csv")

        self.assertEqual(result["updated"], 1)
        self.assertEqual(result["imported"], 1)
        after = next(r for r in self._ledger() if r["source_transaction_id"] == "m05")
        self.assertEqual(after["id"], held["id"], "corrected in place, keeping the row and its curation")
        self.assertEqual(f"{after['amount']:.2f}", "21.50")
        self.assertEqual(after["import_batch_id"], first["batch_id"], "not re-homed to the correcting import")
        self.assertEqual(len(self._ledger()), 32)

    def test_a_second_identical_charge_on_a_covered_date_imports_when_its_id_differs(self):
        # Two identical coffees on one day, the second reaching the source after the first export. On a
        # covered date the ladder rejects the late one as "covered"; its id says it is another transaction.
        rows = month_of_rows()
        rows[9] = (march(10), "Corner Cafe", -4.50, "coffee-1")
        self._import(csv_text(rows), filename="march.csv")
        later = rows + [(march(10), "Corner Cafe", -4.50, "coffee-2")]

        result = self._import(csv_text(later), filename="march-again.csv")

        self.assertEqual(result["imported"], 1)
        coffees = [r for r in self._ledger() if r["raw_name"] == "Corner Cafe"]
        self.assertEqual(sorted(r["source_transaction_id"] for r in coffees), ["coffee-1", "coffee-2"])

    def test_rows_imported_before_the_column_existed_take_their_ids_and_an_older_file_cannot_undo_it(self):
        rows = month_of_rows()
        # Two identical charges on one day: each held copy must take one id, not both the same one.
        rows[14] = (march(15), "Corner Cafe", -4.50, "coffee-1")
        rows.insert(15, (march(15), "Corner Cafe", -4.50, "coffee-2"))
        self._import(csv_text(rows, with_id=False), filename="march-no-ids.csv", map_id=False)
        self.assertTrue(all(r["source_transaction_id"] is None for r in self._ledger()))

        with_ids = rows + [("2026-04-03", "Merchant 41", -41.25, "m41")]
        result = self._import(csv_text(with_ids), filename="april.csv")

        self.assertEqual(result["imported"], 1)
        ledger = self._ledger()
        self.assertEqual(len(ledger), 33)
        by_name = {r["raw_name"]: r["source_transaction_id"] for r in ledger if r["raw_name"] != "Corner Cafe"}
        self.assertEqual(by_name["Merchant 05"], "m05", "each held row takes the id of the row it duplicates")
        self.assertEqual(by_name["Merchant 30"], "m30", "including rows in the trailing window")
        self.assertEqual(sorted(r["source_transaction_id"] for r in ledger if r["raw_name"] == "Corner Cafe"),
                         ["coffee-1", "coffee-2"])

        # An older export without the column, imported in between, adds nothing and clears nothing ...
        self._import(csv_text(rows[5:], with_id=False), filename="march-tail-no-ids.csv")
        self.assertEqual([r["source_transaction_id"] for r in self._ledger()],
                         [r["source_transaction_id"] for r in ledger])

        # ... and the next export with ids is recognized by them alone.
        newest = with_ids + [("2026-04-09", "Merchant 42", -42.25, "m42")]
        result = self._import(csv_text(newest), filename="april-later.csv")
        self.assertEqual((result["imported"], result["updated"]), (1, 0))
        self.assertEqual(len(self._ledger()), 34)

    def test_an_id_is_matched_only_within_the_data_source_that_issued_it(self):
        self._import(csv_text([(march(3), "Merchant 03", -13.25, "1001")]), filename="agg.csv")

        result = self._import(
            csv_text([(march(20), "Something else", -99.00, "1001")]), filename="other.csv", profile_id="src-other",
        )

        self.assertEqual((result["imported"], result["updated"]), (1, 0))
        amounts = sorted(f"{r['amount']:.2f}" for r in self._ledger())
        self.assertEqual(amounts, ["13.25", "99.00"], "another source's 1001 is a different transaction")


class PaypalTransactionIdTests(unittest.TestCase):
    """A recognized PayPal file reads its Transaction ID whether or not the saved mapping names it."""

    def test_a_recognized_wallet_export_stores_its_transaction_id_unmapped(self):
        with tempfile.TemporaryDirectory() as tempdir:
            db_path = str(Path(tempdir) / "paypal.db")
            init_db(db_path)
            with get_db(db_path) as conn:
                conn.execute(
                    "INSERT INTO account (id, external_account_id, provider, name, display_name, type) "
                    "VALUES ('acc-wallet', NULL, 'manual', 'Wallet', 'Wallet', 'paypal')"
                )
            text = (
                "Date,Time,TimeZone,Name,Type,Status,Currency,Amount,Fees,Total,Receipt ID,Transaction ID\n"
                "03/04/2026,10:00:00,PST,Streaming Service,Subscription Payment,Completed,USD,-15.49,0.00,-15.49,,7XK11\n"
            )
            cfg = {
                "account_id": "acc-wallet",
                "column_map": {"date": "Date", "description": "Name", "amount": "Total"},
                "date_format": "%m/%d/%Y",
                "amount_convention": "single_signed",
                "apply_categorization": False,
            }
            token = set_current_db_path(db_path)
            try:
                run_import_core(text, cfg, filename="paypal.csv")
            finally:
                reset_current_db_path(token)
            with get_db(db_path) as conn:
                stored = conn.execute("SELECT source_transaction_id FROM txn").fetchone()
            self.assertEqual(stored["source_transaction_id"], "7XK11")


if __name__ == "__main__":
    unittest.main()
