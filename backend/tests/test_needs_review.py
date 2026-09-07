"""
needs_review lifecycle coverage.

Freshly imported/synced transactions are flagged needs_review = 1 so the user can look them
over; the flag is its own axis (independent of categorization) and is cleared two ways: by a
manual category edit, or by an explicit "mark reviewed" (single/bulk, or the per-batch sweep).
These tests pin that lifecycle at the router level, where regressions would otherwise surface
as either an un-clearable review pool or rows that never enter it.
"""

from __future__ import annotations

import tempfile
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path

from backend.db.database import SHARED_OWNER_ID, get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers.import_export.core import _insert_imported_transaction, mark_batch_reviewed
from backend.routers.transactions import (
    BulkAction,
    BulkSelection,
    BulkUpdateRequest,
    CategoryOverride,
    bulk_update_transactions,
    list_transactions,
    override_category,
)


class NeedsReviewTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "needs-review.db"
        init_db(str(self.db_path))
        self.account = self._insert_account()
        self.group, self.leaf = self._insert_group_and_leaf()
        self.batch = self._insert_batch()

    def tearDown(self):
        self.tempdir.cleanup()

    @contextmanager
    def _use_db_path(self):
        token = set_current_db_path(str(self.db_path))
        try:
            yield
        finally:
            reset_current_db_path(token)

    def _insert_account(self) -> str:
        account_id = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """
                INSERT INTO account
                  (id, external_account_id, provider, name, display_name, type, subtype,
                   mask, owner_id, parent_account_id, trashed_at)
                VALUES (?, ?, ?, 'Checking', 'Checking', 'depository', 'checking',
                        NULL, ?, NULL, NULL)
                """,
                (account_id, f"plaid_{account_id}", "fixture", SHARED_OWNER_ID),
            )
        return account_id

    def _insert_group_and_leaf(self) -> tuple[str, str]:
        group_id = str(uuid.uuid4())
        leaf_id = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                "INSERT INTO category (id, parent_id, name, category_type) VALUES (?, NULL, 'Food', 'expense')",
                (group_id,),
            )
            conn.execute(
                "INSERT INTO category (id, parent_id, name, category_type) VALUES (?, ?, 'Groceries', 'expense')",
                (leaf_id, group_id),
            )
        return group_id, leaf_id

    def _insert_batch(self) -> str:
        batch_id = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                "INSERT INTO import_batch (id, filename, row_count) VALUES (?, 'fixture.csv', 0)",
                (batch_id,),
            )
        return batch_id

    def _import_txn(self, *, date: str = "2026-04-10", amount: float = 12.00) -> str:
        """Insert through the real import helper so the test exercises the flag that path sets."""
        with self._use_db_path(), get_db() as conn:
            return _insert_imported_transaction(
                conn,
                self.batch,
                {
                    "account_id": self.account,
                    "owner_id": SHARED_OWNER_ID,
                    "amount": amount,
                    "merchant_name": "Grocer",
                    "display_name": "Grocer",
                    "raw_name": "Grocer",
                    "date": date,
                },
            )

    def _needs_review(self, txn_id: str) -> int:
        with self._use_db_path(), get_db() as conn:
            return conn.execute("SELECT needs_review FROM txn WHERE id = ?", (txn_id,)).fetchone()[0]

    def _flagged_ids(self) -> list[str]:
        with self._use_db_path():
            result = list_transactions(
                month=None, date_start=None, date_end=None, import_batch_id=None,
                sort_by="date", sort_dir="desc", account_id=None, source_account_ids=None, category_id=None, direction=None, view=None,
                search=None, quick_filter=None, ids=None, needs_review=True,
                include_trashed=False, limit=200, offset=0,
            )
        return [row["id"] for row in result["transactions"]]

    def test_imported_rows_are_flagged_and_isolated_by_filter(self):
        imported = self._import_txn()
        # A hand-inserted (non-import) row defaults to 0 and must stay out of the pool.
        manual = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                "INSERT INTO txn (id, account_id, owner_id, amount, date) VALUES (?, ?, ?, 5.0, '2026-04-11')",
                (manual, self.account, SHARED_OWNER_ID),
            )
        self.assertEqual(self._needs_review(imported), 1)
        self.assertEqual(self._needs_review(manual), 0)
        self.assertEqual(self._flagged_ids(), [imported])

    def test_manual_category_edit_clears_flag(self):
        imported = self._import_txn()
        with self._use_db_path():
            override_category(imported, CategoryOverride(category_id=self.leaf))
        self.assertEqual(self._needs_review(imported), 0)
        self.assertEqual(self._flagged_ids(), [])

    def test_bulk_mark_reviewed_clears_flag(self):
        imported = self._import_txn()
        with self._use_db_path():
            bulk_update_transactions(
                BulkUpdateRequest(
                    selection=BulkSelection(mode="ids", ids=[imported]),
                    actions=[BulkAction(type="mark_reviewed")],
                )
            )
        self.assertEqual(self._needs_review(imported), 0)

    def test_batch_mark_reviewed_clears_whole_file(self):
        a = self._import_txn(date="2026-04-10")
        b = self._import_txn(date="2026-04-12")
        with self._use_db_path():
            result = mark_batch_reviewed(self.batch)
        self.assertEqual(result["updated"], 2)
        self.assertEqual(self._needs_review(a), 0)
        self.assertEqual(self._needs_review(b), 0)
        self.assertEqual(self._flagged_ids(), [])


if __name__ == "__main__":
    unittest.main()
