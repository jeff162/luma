"""
Coverage for the Tasks "uncategorized transactions" count.

The count is meant to mirror the work the user can actually act on in the Transactions list:
real, settled, live rows that lack a category. So it excludes pending transactions (the rest
of the product keeps them out of categorization chores) and trashed rows (they no longer
appear in any list the task links to). These tests pin those exclusions so the count can't
drift back to over-reporting work that can never reach zero.
"""

from __future__ import annotations

import tempfile
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path

from backend.db.database import SHARED_OWNER_ID, get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers.tasks import get_tasks


class TasksUncategorizedCountTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "tasks.db"
        init_db(str(self.db_path))
        self.account = self._insert_account()
        self.group = self._insert_category()

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
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    """
                    INSERT INTO account
                      (id, external_account_id, provider, name, display_name, type, subtype,
                       mask, owner_id, parent_account_id, trashed_at)
                    VALUES (?, ?, ?, 'Test Account', 'Test Account', 'credit', 'credit_card',
                            NULL, ?, NULL, NULL)
                    """,
                    (account_id, f"plaid_{account_id}", "fixture", SHARED_OWNER_ID),
                )
        return account_id

    def _insert_category(self) -> str:
        category_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    "INSERT INTO category (id, parent_id, name, category_type) VALUES (?, NULL, 'Test Group', 'expense')",
                    (category_id,),
                )
        return category_id

    def _insert_txn(self, *, category_id: str | None, is_pending: int = 0, trashed_at: str | None = None) -> str:
        txn_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    """
                    INSERT INTO txn
                      (id, account_id, owner_id, category_id, amount, merchant_name,
                       display_name, raw_name, date, is_pending, trashed_at)
                    VALUES (?, ?, ?, ?, 12.00, 'Merchant', 'Merchant', 'Merchant', '2026-04-10', ?, ?)
                    """,
                    (txn_id, self.account, SHARED_OWNER_ID, category_id, is_pending, trashed_at),
                )
        return txn_id

    def _uncategorized_count(self) -> int:
        with self._use_db_path():
            result = get_tasks()
        for task in result["tasks"]:
            if task["id"] == "uncategorized_txns":
                return task["count"]
        return 0

    def test_counts_only_live_settled_uncategorized_rows(self):
        # Should count: one settled, non-trashed, uncategorized row.
        self._insert_txn(category_id=None)
        # Should NOT count: categorized.
        self._insert_txn(category_id=self.group)
        # Should NOT count: pending (settles later; excluded from categorization chores).
        self._insert_txn(category_id=None, is_pending=1)
        # Should NOT count: trashed (no longer appears in the list the task links to).
        self._insert_txn(category_id=None, trashed_at="2026-05-01T00:00:00Z")

        self.assertEqual(self._uncategorized_count(), 1)

    def test_trashed_uncategorized_rows_are_excluded(self):
        live = self._insert_txn(category_id=None)
        self.assertEqual(self._uncategorized_count(), 1)
        # Trashing the only uncategorized row should drop the count to zero (no task surfaced),
        # not leave it stranded at a number the user can never act down.
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    "UPDATE txn SET trashed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
                    (live,),
                )
        self.assertEqual(self._uncategorized_count(), 0)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
