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
                      (id, external_account_id, provider, name, display_name, type, subtype, mask, owner_id, parent_account_id, trashed_at)
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

    def _insert_completed_batch(self, filename: str, imported_at: str) -> str:
        batch_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    "INSERT INTO import_batch (id, filename, imported_at, status) VALUES (?, ?, ?, 'completed')",
                    (batch_id, filename, imported_at),
                )
        return batch_id

    async def test_batch_listing_is_not_capped_at_fifty(self):
        # Regression: the listing used to `LIMIT 50` globally, so a heavy importer silently lost older
        # cards (and an actively-fed source could crowd another source's history out of the window
        # entirely). The full completed history must come back. See the per-source archive backlog item.
        count = 60
        for i in range(count):
            # Zero-padded month/day so lexical imported_at order matches chronological order.
            self._insert_completed_batch(f"file-{i:03d}.csv", f"2026-01-01T00:{i // 60:02d}:{i % 60:02d}")
        with self._use_db_path():
            batches = list_batches()
        self.assertEqual(len(batches), count)


if __name__ == "__main__":
    unittest.main()
