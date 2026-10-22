"""
CSV import: pending → posted reconciliation preserves user edits.

When a later import brings the posted version of a row imported earlier as pending (matched by account +
date + source text), the pending row is converted in place rather than deleted and re-inserted, so any
category / rename / tag / note edits the user made on the pending row survive the transition. This path
had no prior coverage (real pending CSVs are rare), so these tests pin both the reconciliation and the
edit preservation.
"""

from __future__ import annotations

import io
import json
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path

from fastapi import UploadFile

from backend.db.database import SHARED_OWNER_ID, get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers.import_export import run_import


class ImportPendingReconciliationTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "pending.db"
        init_db(str(self.db_path))
        self.account_id = "acct-1"
        self.category_id = "cat-1"
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """
                INSERT INTO account
                  (id, external_account_id, provider, name, display_name, type, subtype, mask,
                   owner_id, parent_account_id, trashed_at)
                VALUES (?, NULL, 'csv', 'Checking', 'Checking', 'depository', 'checking', NULL, ?, NULL, NULL)
                """,
                (self.account_id, SHARED_OWNER_ID),
            )
            conn.execute(
                "INSERT INTO category (id, parent_id, name, category_type) VALUES (?, NULL, 'Dining', 'expense')",
                (self.category_id,),
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

    def _config(self):
        return {
            "filename": "fixture.csv",
            "profile_id": None,
            "account_id": None,
            "single_account_new": None,
            "account_map": {"Checking": self.account_id},
            "skip_accounts": [],
            "new_accounts": None,
            "column_map": {
                "date": "Date", "description": "Description", "account": "Account",
                "amount": "Amount", "pending": "Pending",
            },
            "date_format": "%Y-%m-%d",
            "amount_convention": "single_signed",
            "skip_rows": 0,
            "apply_categorization": False,
            "use_imported_categories": False,
        }

    async def _import(self, csv_text: str) -> dict:
        upload = UploadFile(filename="fixture.csv", file=io.BytesIO(csv_text.encode("utf-8")))
        with self._use_db_path():
            return await run_import(file=upload, config=json.dumps(self._config()))

    def _row(self, **cols):
        with self._use_db_path(), get_db() as conn:
            where = " AND ".join(f"{k} = ?" for k in cols)
            return conn.execute(
                f"SELECT id, amount, is_pending, display_name, display_name_source, category_id, trashed_at "
                f"FROM txn WHERE {where}",
                tuple(cols.values()),
            ).fetchall()

    async def test_posted_import_converts_pending_row_preserving_edits(self):
        # Import a pending row.
        res1 = await self._import(
            "Date,Description,Account,Amount,Pending\n"
            "2026-08-01,Coffee Shop,Checking,10.00,pending\n"
        )
        self.assertEqual(res1["imported"], 1)
        rows = self._row(raw_name="Coffee Shop")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["is_pending"], 1)
        pk = rows[0]["id"]

        # User edits the pending row: manual rename + category.
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                "UPDATE txn SET display_name = 'My Coffee', display_name_source = 'manual', "
                "category_id = ?, category_overridden = 1 WHERE id = ?",
                (self.category_id, pk),
            )

        # Import the posted version (same account+date+text, posted, revised amount).
        res2 = await self._import(
            "Date,Description,Account,Amount,Pending\n"
            "2026-08-01,Coffee Shop,Checking,10.50,posted\n"
        )
        self.assertEqual(res2["imported"], 1)
        self.assertEqual(res2["deduped"], 0)

        rows = self._row(raw_name="Coffee Shop")
        self.assertEqual(len(rows), 1, "no duplicate row — the pending row was converted in place")
        row = rows[0]
        self.assertEqual(row["id"], pk, "same row identity")
        self.assertEqual(row["is_pending"], 0)
        self.assertEqual(abs(row["amount"]), 10.50)             # posted amount applied (was 10.00 pending)
        self.assertEqual(row["display_name"], "My Coffee")      # rename preserved
        self.assertEqual(row["display_name_source"], "manual")
        self.assertEqual(row["category_id"], self.category_id)  # category preserved
        self.assertIsNone(row["trashed_at"])

    async def test_a_posted_row_from_another_source_settles_a_held_pending_row(self):
        # The pending copy came from a data connection and names the charge differently, so the same-source
        # conversion above cannot see it, and the ladder skips pending rows. The posted copy is imported
        # and flagged against it, and the finalize sweep keeps the posted one, taking the user's rename.
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                "INSERT INTO import_batch (id, filename, status, source_kind)"
                " VALUES ('card-sync', 'sync card', 'completed', 'connection_sync')")
            conn.execute(
                "INSERT INTO txn (id, account_id, owner_id, amount, merchant_name, display_name,"
                " display_name_source, raw_name, date, is_pending, content_hash, import_batch_id)"
                " VALUES ('held-pending', ?, ?, -10.0, 'Corner Cafe', 'Morning coffee', 'manual',"
                " 'SQ *CORNER CAFE', '2026-08-01', 1, 'hash-held', 'card-sync')",
                (self.account_id, SHARED_OWNER_ID),
            )

        res = await self._import(
            "Date,Description,Account,Amount,Pending\n"
            "2026-08-01,Corner Cafe,Checking,10.00,posted\n"
        )
        self.assertEqual((res["imported"], res["deduped"]), (1, 0))
        pending = self._row(id="held-pending")[0]
        posted = self._row(raw_name="Corner Cafe")[0]
        self.assertIsNotNone(pending["trashed_at"])
        self.assertIsNone(posted["trashed_at"])
        self.assertEqual(posted["is_pending"], 0)
        self.assertEqual(posted["display_name"], "Morning coffee")


if __name__ == "__main__":
    unittest.main()
