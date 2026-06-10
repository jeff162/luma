"""
Batch-listing contract.

The "Save as data source" flow only auto-adopts the most-recent profileless batch into a new
source when that batch's file shape matches the source. That guard runs client-side, so it
depends on `GET /batches` exposing each batch's `header_fingerprint`. This pins that field so a
future payload trim can't silently reintroduce the bug where an unrelated earlier import got
filed under a freshly-created data source.
"""

from __future__ import annotations

import json
import tempfile
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path

from backend.db.database import (
    SHARED_OWNER_ID,
    get_db,
    init_db,
    reset_current_db_path,
    set_current_db_path,
)
from backend.routers.import_export import run_import
from backend.routers.import_export.core import list_batches


class FakeUploadFile:
    def __init__(self, filename: str, content: str):
        self.filename = filename
        self._content = content.encode("utf-8")

    async def read(self) -> bytes:
        return self._content


class ImportBatchListingTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "batch-listing-tests.db"
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

    def _insert_account(self, name: str) -> str:
        account_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    """
                    INSERT INTO account
                      (id, plaid_account_id, plaid_item_id, name, display_name, type, subtype, mask, owner_id, parent_account_id, trashed_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
                    """,
                    (account_id, f"test_{account_id}", "fixture_import", name, name, "checking", "checking", "1234", SHARED_OWNER_ID),
                )
        return account_id

    async def test_batch_listing_exposes_header_fingerprint(self):
        account_id = self._insert_account("Checking")
        config = {
            "filename": "fixture.csv",
            "profile_id": None,
            "account_id": None,
            "account_map": {"Checking": account_id},
            "skip_accounts": [],
            "new_accounts": None,
            "column_map": {"date": "Date", "description": "Description", "account": "Account", "amount": "Amount"},
            "date_format": "%Y-%m-%d",
            "amount_convention": "single_signed",
            "skip_rows": 0,
            "apply_categorization": False,
            "use_imported_categories": False,
        }
        with self._use_db_path():
            await run_import(
                file=FakeUploadFile("fixture.csv", "Date,Description,Account,Amount\n2026-01-02,Coffee,Checking,4.50"),
                config=json.dumps(config),
            )
            batches = list_batches()

        self.assertEqual(len(batches), 1)
        # The fingerprint is the pipe-joined header row — what the client compares against a new
        # data source's fingerprint before adopting the batch.
        self.assertEqual(batches[0]["header_fingerprint"], "Date|Description|Account|Amount")


if __name__ == "__main__":
    unittest.main()
