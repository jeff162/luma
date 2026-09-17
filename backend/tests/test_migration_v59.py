"""
Migration v59 — a synced charge is dated by when it was made.

Before v59 `txn.date` was the posted date and `authorized_date` the transaction date. v59 renames the column
to `posted_date` and swaps the two wherever a transaction date exists. Pinned: the swap itself, the rows that
must not gain a posted date (a CSV row, a pending charge, a zero timestamp's 1970 date), the content hash
following the date only where it was derived from it, and the held duplicates "Import anyway" would insert.
"""

from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from backend.db import database
from backend.routers.import_export.core import make_hash


class MigrationV59Tests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.conn = sqlite3.connect(str(Path(self.tmp.name) / "v58.db"))
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript("""
            CREATE TABLE txn (
                id TEXT PRIMARY KEY, external_transaction_id TEXT, amount REAL NOT NULL, date TEXT NOT NULL,
                authorized_date TEXT, is_pending INTEGER NOT NULL DEFAULT 0, raw_name TEXT, merchant_name TEXT,
                content_hash TEXT
            );
            CREATE TABLE import_batch_duplicate (
                batch_id TEXT, row_number INTEGER, reason TEXT, values_json TEXT, matched_transaction_json TEXT,
                txn_payload_json TEXT, PRIMARY KEY (batch_id, row_number)
            );
            CREATE TABLE db_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            INSERT INTO db_meta (key, value) VALUES ('version', '58');
        """)
        rows = [
            # id, external id, amount, date, authorized_date, pending, raw_name, hash
            ("posted", "p1", -5.0, "2026-08-03", "2026-07-31", 0, "SHOP", make_hash("2026-08-03", -5.0, "SHOP")),
            ("same-day", "p2", -7.0, "2026-08-04", "2026-08-04", 0, "CAFE", "h-same"),
            ("no-transaction-date", "p3", -8.0, "2026-08-05", None, 0, "GAS", "h-gas"),
            ("pending", "p4", -9.0, "2026-08-06", "2026-08-06", 1, "DELI", "h-deli"),
            ("epoch", "p5", -3.0, "1970-01-01", "2026-08-07", 0, "BAKERY", "h-bakery"),
            ("foreign-hash", "p6", -4.0, "2026-08-09", "2026-08-08", 0, "BOOKS", "not-derived"),
            ("csv", None, -6.0, "2026-08-02", None, 0, "CSV ROW", "h-csv"),
        ]
        self.conn.executemany(
            "INSERT INTO txn (id, external_transaction_id, amount, date, authorized_date, is_pending, raw_name,"
            " content_hash) VALUES (?,?,?,?,?,?,?,?)",
            rows,
        )
        self.conn.execute(
            "INSERT INTO import_batch_duplicate VALUES ('b1', 1, 'covered', ?, NULL, ?)",
            (json.dumps({"Date": "2026-08-03", "Transaction date": "2026-07-31"}),
             json.dumps({"date": "2026-08-03", "authorized_date": "2026-07-31", "amount": -5.0,
                         "raw_name": "SHOP", "content_hash": make_hash("2026-08-03", -5.0, "SHOP")})),
        )
        self.conn.commit()
        database.run_migrations(self.conn)
        self.conn.commit()

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def _row(self, txn_id):
        return self.conn.execute("SELECT * FROM txn WHERE id = ?", (txn_id,)).fetchone()

    def test_the_column_is_renamed(self):
        columns = {r["name"] for r in self.conn.execute("PRAGMA table_info(txn)")}
        self.assertIn("posted_date", columns)
        self.assertNotIn("authorized_date", columns)

    def test_a_synced_row_moves_to_its_transaction_date_and_keeps_the_posting(self):
        row = self._row("posted")
        self.assertEqual((row["date"], row["posted_date"]), ("2026-07-31", "2026-08-03"))
        self.assertEqual(row["content_hash"], make_hash("2026-07-31", -5.0, "SHOP"))

    def test_a_synced_row_with_one_date_records_it_as_the_posting(self):
        same_day = self._row("same-day")
        self.assertEqual((same_day["date"], same_day["posted_date"]), ("2026-08-04", "2026-08-04"))
        row = self._row("no-transaction-date")
        self.assertEqual((row["date"], row["posted_date"]), ("2026-08-05", "2026-08-05"))

    def test_rows_that_have_not_posted_gain_no_posted_date(self):
        pending = self._row("pending")
        self.assertEqual((pending["date"], pending["posted_date"]), ("2026-08-06", None))
        epoch = self._row("epoch")
        self.assertEqual((epoch["date"], epoch["posted_date"]), ("2026-08-07", None))

    def test_a_csv_row_is_untouched(self):
        row = self._row("csv")
        self.assertEqual((row["date"], row["posted_date"], row["content_hash"]), ("2026-08-02", None, "h-csv"))

    def test_a_hash_not_derived_from_the_old_date_is_left_alone(self):
        row = self._row("foreign-hash")
        self.assertEqual((row["date"], row["content_hash"]), ("2026-08-08", "not-derived"))

    def test_a_held_duplicate_would_import_on_its_transaction_date(self):
        held = self.conn.execute("SELECT values_json, txn_payload_json FROM import_batch_duplicate").fetchone()
        self.assertEqual(json.loads(held["values_json"]), {"Date": "2026-07-31", "Posted date": "2026-08-03"})
        payload = json.loads(held["txn_payload_json"])
        self.assertNotIn("authorized_date", payload)
        self.assertEqual((payload["date"], payload["posted_date"]), ("2026-07-31", "2026-08-03"))
        self.assertEqual(payload["content_hash"], make_hash("2026-07-31", -5.0, "SHOP"))


if __name__ == "__main__":
    unittest.main()
