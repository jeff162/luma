"""run_import_core: the import pipeline driven in-process (no HTTP/multipart).

This is the seam the demo loader uses to build real batches, so it pins that a direct call produces the
artifacts the file cards read — the batch, per-account coverage rows, and imported-category creation —
and that a cross-account duplicate across two batches gets flagged by the post-import sweep."""

import sqlite3
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path

from backend.db.database import get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers.import_export.core import run_import_core


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
