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
from backend.routers.import_export.core import get_batch_removed_duplicates, list_batches
from backend.services.duplicate_detection import restore_rejected_duplicate


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

    async def test_rows_removed_after_import_are_counted_on_the_card_and_uncounted_by_restore(self):
        # A card whose duplicates were all decided after its import — here, another file's Replace removed
        # this file's older copy — had no duplicates pill, so its report and that report's Restore were
        # unreachable from the card. The count must name exactly the rows the report lists.
        batch_id = self._insert_completed_batch("harborline-march.csv", "2026-03-31T09:00:00")
        account_id = self._insert_account("Harborline Checking")
        with self._use_db_path(), get_db() as conn:
            def txn(txn_id, *, batch=None, removed_in_favor_of=None):
                conn.execute(
                    """
                    INSERT INTO txn (id, account_id, owner_id, amount, merchant_name, raw_name, date, is_pending,
                                     import_batch_id, suspect_duplicate_of, trashed_at, rejection_reason,
                                     dedupe_resolved_by)
                    VALUES (?, ?, ?, 12.5, 'Corner Cafe', 'Corner Cafe', '2026-03-14', 0, ?, ?, ?, ?, ?)
                    """,
                    (txn_id, account_id, SHARED_OWNER_ID, batch, removed_in_favor_of,
                     "2026-04-01T00:00:00Z" if removed_in_favor_of else None,
                     "duplicate_confirmed" if removed_in_favor_of else None,
                     "user" if removed_in_favor_of else None),
                )
            txn("kept")                                              # the other file's copy that replaced it
            txn("removed", batch=batch_id, removed_in_favor_of="kept")
            txn("untouched", batch=batch_id)
        with self._use_db_path():
            card = next(b for b in list_batches() if b["id"] == batch_id)
            self.assertEqual(card["removed_duplicate_count"], 1)
            self.assertEqual(get_batch_removed_duplicates(batch_id)["count"], 1)
            with get_db() as conn:
                restore_rejected_duplicate(conn, "removed")
            card = next(b for b in list_batches() if b["id"] == batch_id)
            self.assertEqual(card["removed_duplicate_count"], 0, "a restored row is an ordinary transaction again")


if __name__ == "__main__":
    unittest.main()
