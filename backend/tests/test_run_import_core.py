"""run_import_core: the import pipeline driven in-process (no HTTP/multipart).

This is the seam the demo loader uses to build real batches, so it pins that a direct call produces the
artifacts the file cards read — the batch, per-account coverage rows, and imported-category creation —
and that a cross-account duplicate across two batches gets flagged by the post-import sweep."""

import json
import sqlite3
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path

from backend.db.database import get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers.import_export.core import (
    BatchDuplicateImportRequest, import_batch_duplicates, run_import_core,
)


def _account_sql(account_id, name, acct_type):
    return (
        """INSERT INTO account (id, external_account_id, provider, name, display_name, type)
           VALUES (?, NULL, 'manual', ?, ?, ?)""",
        (account_id, name, name, acct_type),
    )


class RunImportCoreTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "core.db"
        init_db(str(self.db_path))

    def tearDown(self):
        self.tempdir.cleanup()

    @contextmanager
    def _use_db_path(self):
        token = set_current_db_path(str(self.db_path))
        try:
            yield
        finally:
            reset_current_db_path(token)

    def _cfg(self, account_map, *, use_imported_categories, category_header=None):
        column_map = {"date": "Date", "amount": "Amount", "description": "Description", "account": "Account"}
        if category_header:
            column_map["category"] = category_header
        return {
            "account_map": account_map,
            "column_map": column_map,
            "date_format": "%Y-%m-%d",
            "amount_convention": "single_signed",
            "apply_categorization": False,   # isolate the imported-category path from rules
            "use_imported_categories": use_imported_categories,
        }

    def test_core_produces_batch_coverage_and_imported_categories(self):
        with get_db(str(self.db_path)) as conn:
            conn.execute(*_account_sql("acc-chk", "Checking", "depository"))
        csv = (
            "Date,Description,Amount,Category,Account\n"
            "2026-01-05,Whole Foods,54.20,Groceries,Checking\n"
            "2026-01-06,Shell,40.00,Fuel,Checking\n"
        )
        with self._use_db_path():
            result = run_import_core(
                csv,
                self._cfg({"Checking": "acc-chk"}, use_imported_categories=True, category_header="Category"),
                filename="bank.csv",
            )
        self.assertEqual(result.get("imported"), 2)

        with get_db(str(self.db_path)) as conn:
            batch = conn.execute("SELECT id FROM import_batch WHERE filename = 'bank.csv'").fetchone()
            self.assertIsNotNone(batch)
            coverage = conn.execute(
                "SELECT csv_value, row_count FROM import_batch_account WHERE batch_id = ?", (batch["id"],)
            ).fetchall()
            self.assertEqual({(r["csv_value"], r["row_count"]) for r in coverage}, {("Checking", 2)})
            # Imported categories created the leaves (none existed on a fresh DB) and stuck as 'import'.
            cats = {r["name"] for r in conn.execute("SELECT name FROM category WHERE parent_id IS NOT NULL")}
            self.assertIn("Groceries", cats)
            self.assertIn("Fuel", cats)
            sources = {r[0] for r in conn.execute("SELECT DISTINCT category_source FROM txn")}
            self.assertEqual(sources, {"import"})

    def test_a_forced_duplicate_is_not_handed_straight_back_as_a_suspect(self):
        """"Import anyway" is an answer; the post-import sweep must not put the question back.

        The row the user forces in is byte-identical to the one it was rejected against and lands on the
        same account from a different batch — which is exactly the shape the cross-source sweep pairs. So
        without excluding the pair the user just settled, forcing a duplicate in returns it immediately as
        a soft-flagged suspect awaiting review, and the user is asked the same question twice.
        """
        with get_db(str(self.db_path)) as conn:
            conn.execute(*_account_sql("acc-chk", "Checking", "depository"))
        row = "2026-03-04,Corner Market,25.00,Checking\n"
        header = "Date,Description,Amount,Account\n"
        cfg = self._cfg({"Checking": "acc-chk"}, use_imported_categories=False)
        with self._use_db_path():
            run_import_core(header + row, cfg, filename="march.csv")
            # A second file carrying the same transaction: rejected as a duplicate rather than imported.
            second = run_import_core(header + row + "2026-03-05,Bakery,8.00,Checking\n",
                                     cfg, filename="march-again.csv")
            self.assertEqual(second["deduped"], 1, "the repeated row should be held back as a duplicate")

            forced = import_batch_duplicates(second["batch_id"],
                                             BatchDuplicateImportRequest(import_all=True))
        self.assertEqual(forced["imported_count"], 1)

        with get_db(str(self.db_path)) as conn:
            rows = conn.execute(
                "SELECT id, suspect_duplicate_of, trashed_at FROM txn WHERE merchant_name = 'Corner Market'"
                " OR raw_name = 'Corner Market'"
            ).fetchall()
            self.assertEqual(len(rows), 2, "the forced row should be in the ledger beside the original")
            self.assertTrue(all(r["trashed_at"] is None for r in rows),
                            "forcing a duplicate in must not end with it trashed")
            self.assertTrue(all(r["suspect_duplicate_of"] is None for r in rows),
                            "the pair the user overruled must not come back as review work")

    def test_cross_account_duplicate_is_flagged(self):
        with get_db(str(self.db_path)) as conn:
            conn.execute(*_account_sql("acc-a", "Card A", "credit"))
            conn.execute(*_account_sql("acc-b", "Card B", "credit"))
        # Same date + amount + payee on two different accounts, imported as two separate batches.
        row = "2026-02-10,Acme Store,99.99,"
        with self._use_db_path():
            run_import_core(
                "Date,Description,Amount,Account\n" + row + "Card A\n",
                self._cfg({"Card A": "acc-a"}, use_imported_categories=False),
                filename="card-a.csv",
            )
            run_import_core(
                "Date,Description,Amount,Account\n" + row + "Card B\n",
                self._cfg({"Card B": "acc-b"}, use_imported_categories=False),
                filename="card-b.csv",
            )
        with get_db(str(self.db_path)) as conn:
            flagged = conn.execute(
                "SELECT COUNT(*) FROM txn WHERE suspect_duplicate_of IS NOT NULL"
            ).fetchone()[0]
        self.assertGreater(flagged, 0)


    def test_a_zero_amount_row_is_refused_and_reported(self):
        # CSV declares `zero_amount_rows = "reject"` (see services/source_capabilities.py): a $0 line is a
        # pending charge published before it settled, and nothing carries identity between files, so the
        # settled charge arrives later as its own row while the placeholder would linger forever as a
        # same-date/payee near-miss for duplicate detection. Behaviour as old as the importer and, until
        # now, pinned by nothing — a refusal is only acceptable while it stays visible on the card.
        with get_db(str(self.db_path)) as conn:
            conn.execute(*_account_sql("acc-chk", "Checking", "depository"))
        csv = (
            "Date,Description,Amount,Account\n"
            "2026-01-05,Whole Foods,54.20,Checking\n"
            "2026-01-06,Pending Authorization,0.00,Checking\n"
        )
        with self._use_db_path():
            result = run_import_core(
                csv, self._cfg({"Checking": "acc-chk"}, use_imported_categories=False),
                filename="bank.csv",
            )
        self.assertEqual(result.get("imported"), 1)
        summary = result["import_summary"]
        self.assertEqual(summary["zero_amount_count"], 1)
        self.assertEqual(summary["rejected_count"], 1)
        self.assertEqual([r["kind"] for r in result["rejected_rows"]], ["zero_amount"])
        self.assertEqual(result["rejected_rows"][0]["reason"], "Zero amount")
        with get_db(str(self.db_path)) as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM txn").fetchone()[0], 1)
            # The file is gone once the upload ends, so the refusal is only visible later if the row
            # itself was kept — the count alone cannot say which line was dropped.
            stored = conn.execute(
                "SELECT kind, reason, description, amount FROM import_batch_rejected_row WHERE batch_id = ?",
                (result["batch_id"],),
            ).fetchall()
        self.assertEqual([(r["kind"], r["reason"], r["description"], r["amount"]) for r in stored],
                         [("zero_amount", "Zero amount", "Pending Authorization", 0.0)])

    def test_a_row_in_another_currency_is_refused_and_reported(self):
        # A wallet export can hold one foreign charge among dollar ones. The ledger stores bare amounts, so
        # a £10 row imported as it stands would be $10 in every total. A blank cell states nothing and the
        # matching code imports normally; only a stated mismatch is refused, and it is listed on the card.
        with get_db(str(self.db_path)) as conn:
            conn.execute(*_account_sql("acc-wallet", "Wallet", "depository"))
        csv = (
            "Date,Description,Amount,Currency,Account\n"
            "2026-05-09,Subscription,-10.00,GBP,Wallet\n"
            "2026-05-09,Card top-up,14.21,USD,Wallet\n"
            "2026-05-10,Coffee,-4.50,,Wallet\n"
        )
        cfg = self._cfg({"Wallet": "acc-wallet"}, use_imported_categories=False)
        cfg["column_map"]["currency"] = "Currency"
        with self._use_db_path():
            result = run_import_core(csv, cfg, filename="wallet.csv")
        self.assertEqual(result.get("imported"), 2)
        summary = result["import_summary"]
        self.assertEqual(summary["currency_rejected_count"], 1)
        self.assertEqual(summary["rejected_count"], 1)
        self.assertEqual([r["kind"] for r in result["rejected_rows"]], ["currency"])
        self.assertIn("GBP", result["rejected_rows"][0]["reason"])
        with get_db(str(self.db_path)) as conn:
            stored = conn.execute(
                "SELECT kind, values_json FROM import_batch_rejected_row WHERE batch_id = ?",
                (result["batch_id"],),
            ).fetchall()
        self.assertEqual([r["kind"] for r in stored], ["currency"])
        # The whole row as written, not just the cells the mapping used: what makes a refused row
        # diagnosable is usually the column nobody mapped.
        self.assertEqual(json.loads(stored[0]["values_json"])["Currency"], "GBP")
        with get_db(str(self.db_path)) as conn:
            amounts = sorted(r[0] for r in conn.execute("SELECT raw_name FROM txn"))
        self.assertEqual(amounts, ["Card top-up", "Coffee"])

    def test_an_unmapped_currency_column_changes_nothing(self):
        # Nearly every export states no currency, and one that does but was not mapped is the user saying
        # the whole file is in the ledger's currency. Nothing is refused on a column nobody chose.
        with get_db(str(self.db_path)) as conn:
            conn.execute(*_account_sql("acc-wallet", "Wallet", "depository"))
        csv = "Date,Description,Amount,Currency,Account\n2026-05-09,Subscription,-10.00,GBP,Wallet\n"
        with self._use_db_path():
            result = run_import_core(
                csv, self._cfg({"Wallet": "acc-wallet"}, use_imported_categories=False), filename="wallet.csv",
            )
        self.assertEqual(result.get("imported"), 1)
        self.assertEqual(result["import_summary"]["currency_rejected_count"], 0)

    def test_caller_conn_owns_the_commit(self):
        # A caller-supplied connection makes the import part of THAT transaction — run_import_core must
        # not commit on its own. This is what lets the demo loader build everything atomically; if the
        # core committed independently, a rollback couldn't undo it and a mid-build failure would leak.
        with get_db(str(self.db_path)) as conn:
            conn.execute(*_account_sql("acc-x", "Checking", "depository"))
        conn_a = sqlite3.connect(str(self.db_path))
        conn_a.row_factory = sqlite3.Row
        conn_a.execute("PRAGMA foreign_keys=ON")
        try:
            run_import_core(
                "Date,Description,Amount,Account\n2026-03-01,Acme Store,10.00,Checking\n",
                self._cfg({"Checking": "acc-x"}, use_imported_categories=False),
                filename="x.csv",
                conn=conn_a,
            )
            self.assertEqual(conn_a.execute("SELECT COUNT(*) FROM txn").fetchone()[0], 1)  # visible in-txn
            conn_a.rollback()  # the caller decides not to keep it
        finally:
            conn_a.close()
        # Nothing was independently committed, so the rollback discarded the entire import.
        with get_db(str(self.db_path)) as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM txn").fetchone()[0], 0)
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM import_batch").fetchone()[0], 0)


if __name__ == "__main__":
    unittest.main()
