"""
Trash visibility coverage for transaction reads.

A trashed transaction should disappear from every user-facing read path while remaining
recoverable. These tests check the main entry points the UI uses — the raw transaction
list and two representative summary endpoints — and also verify that the trash listing
endpoint shows trashed rows while the regular list hides them.
"""

from __future__ import annotations

import tempfile
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path

from backend.db.database import SHARED_OWNER_ID, get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers.transactions import (
    empty_transaction_trash,
    list_transactions,
    list_trashed_transactions,
    monthly_trend,
    restore_transaction,
    spending_by_group,
    trash_transaction,
)


class TrashFilterCoverageTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "trash-filter.db"
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

    def _insert_account(self) -> str:
        account_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    """
                    INSERT INTO account
                      (id, plaid_account_id, plaid_item_id, name, display_name, type, subtype,
                       mask, owner_id, parent_account_id, trashed_at)
                    VALUES (?, ?, ?, 'Test Account', 'Test Account', 'credit', 'credit_card',
                            NULL, ?, NULL, NULL)
                    """,
                    (account_id, f"plaid_{account_id}", "fixture", SHARED_OWNER_ID),
                )
        return account_id

    def _insert_category(self, *, category_type: str = "expense") -> str:
        category_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    """
                    INSERT INTO category (id, parent_id, name, category_type)
                    VALUES (?, NULL, 'Test Group', ?)
                    """,
                    (category_id, category_type),
                )
        return category_id

    def _insert_txn(self, *, account_id: str, category_id: str | None, amount: float, date: str) -> str:
        txn_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    """
                    INSERT INTO txn
                      (id, account_id, owner_id, category_id, amount, merchant_name,
                       display_name, raw_name, date, is_pending, trashed_at)
                    VALUES (?, ?, ?, ?, ?, 'Merchant', 'Merchant', 'Merchant', ?, 0, NULL)
                    """,
                    (txn_id, account_id, SHARED_OWNER_ID, category_id, amount, date),
                )
        return txn_id

    def _seed_two(self):
        """Two expense transactions in the same month and group; the test trashes one."""
        account = self._insert_account()
        group = self._insert_category()
        keep = self._insert_txn(account_id=account, category_id=group, amount=10.00, date="2026-04-10")
        trash = self._insert_txn(account_id=account, category_id=group, amount=25.00, date="2026-04-20")
        return account, group, keep, trash

    def _mark_confirmed_duplicate(self, txn_id: str, *, resolved_by: str) -> None:
        """Soft-delete a row the way the dedupe flow does: trashed + rejection_reason set.
        `resolved_by` is 'auto_merge' (account merge) or 'user' (explicit Reject)."""
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    """
                    UPDATE txn
                    SET    trashed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                           rejection_reason = 'duplicate_confirmed',
                           dedupe_resolved_by = ?
                    WHERE  id = ?
                    """,
                    (resolved_by, txn_id),
                )

    def _txn_exists(self, txn_id: str) -> bool:
        with self._use_db_path():
            with get_db() as conn:
                return conn.execute("SELECT 1 FROM txn WHERE id = ?", (txn_id,)).fetchone() is not None

    # ---- list_transactions ----------------------------------------------

    def test_list_transactions_hides_trashed(self):
        _, _, keep, trash = self._seed_two()
        with self._use_db_path():
            trash_transaction(trash)
            result = list_transactions(
                month=None, date_start=None, date_end=None, import_batch_id=None,
                sort_by="date", sort_dir="desc",
                account_id=None, account_ids=None, category_id=None,
                group_ids=None, category_ids=None, tag_ids=None,
                owner_ids=None, payees=None, direction=None, view=None,
                search=None, quick_filter=None,
                include_trashed=False, limit=200, offset=0,
            )
        ids = [row["id"] for row in result["transactions"]]
        self.assertIn(keep, ids)
        self.assertNotIn(trash, ids)

    def test_list_transactions_include_trashed_flag_returns_them(self):
        _, _, keep, trash = self._seed_two()
        with self._use_db_path():
            trash_transaction(trash)
            result = list_transactions(
                month=None, date_start=None, date_end=None, import_batch_id=None,
                sort_by="date", sort_dir="desc",
                account_id=None, account_ids=None, category_id=None,
                group_ids=None, category_ids=None, tag_ids=None,
                owner_ids=None, payees=None, direction=None, view=None,
                search=None, quick_filter=None,
                include_trashed=True, limit=200, offset=0,
            )
        ids = [row["id"] for row in result["transactions"]]
        self.assertIn(keep, ids)
        self.assertIn(trash, ids)

    # ---- restore round-trip ---------------------------------------------

    def test_restore_brings_row_back_into_normal_listings(self):
        _, _, _, trash = self._seed_two()
        with self._use_db_path():
            trash_transaction(trash)
            restore_transaction(trash)
            result = list_transactions(
                month=None, date_start=None, date_end=None, import_batch_id=None,
                sort_by="date", sort_dir="desc",
                account_id=None, account_ids=None, category_id=None,
                group_ids=None, category_ids=None, tag_ids=None,
                owner_ids=None, payees=None, direction=None, view=None,
                search=None, quick_filter=None,
                include_trashed=False, limit=200, offset=0,
            )
        ids = [row["id"] for row in result["transactions"]]
        self.assertIn(trash, ids)

    # ---- summaries ------------------------------------------------------

    def test_monthly_trend_excludes_trashed_amount_from_totals(self):
        _, _, keep, trash = self._seed_two()
        # The endpoint functions default to FastAPI `Query` objects, which aren't real Python
        # defaults — pass explicit `None` for each so the actual code path runs.
        kwargs = dict(
            category_id=None, payee=None, account_id=None, account_ids=None,
            tag_ids=None, date_start=None, date_end=None, view="cash_flow",
        )
        with self._use_db_path():
            before = monthly_trend(months=120, **kwargs)
            trash_transaction(trash)
            after = monthly_trend(months=120, **kwargs)

        def total_for(rows, month):
            return sum(row["total"] for row in rows if row.get("month") == month)

        # Both rows live in 2026-04. Trashing the 25.00 row should subtract that amount from the
        # April bucket. We don't assume the sign convention; just check the delta is exactly the
        # absolute value of the trashed amount.
        delta = abs(total_for(before, "2026-04") - total_for(after, "2026-04"))
        self.assertAlmostEqual(delta, 25.00, places=2)

    def test_spending_by_group_excludes_trashed(self):
        account, group, keep, trash = self._seed_two()
        kwargs = dict(
            month="2026-04", date_start=None, date_end=None,
            account_id=None, account_ids=None,
            tag_ids=None, owner_ids=None, category_owner_ids=None,
        )
        with self._use_db_path():
            before = spending_by_group(**kwargs)
            trash_transaction(trash)
            after = spending_by_group(**kwargs)

        def total_for(rows, group_id):
            for row in rows:
                if row.get("group_id") == group_id:
                    return row.get("total", 0)
            return 0

        before_total = total_for(before, group)
        after_total = total_for(after, group)
        # Same delta argument as above.
        self.assertAlmostEqual(abs(before_total - after_total), 25.00, places=2)

    # ---- trash listing endpoint -----------------------------------------

    def test_list_trashed_only_shows_trashed_rows(self):
        _, _, keep, trash = self._seed_two()
        with self._use_db_path():
            trash_transaction(trash)
            rows = list_trashed_transactions(limit=200)
        ids = [row["id"] for row in rows]
        self.assertIn(trash, ids)
        self.assertNotIn(keep, ids)

    # ---- confirmed-duplicate exclusion from the manual Trash --------------
    # Confirmed duplicates are soft-deleted by the dedupe flow, not by the user. They are owned
    # by the originating file's duplicate report and stay restorable (account detach for
    # 'auto_merge', "undo reject" for 'user'), so the manual Trash must neither list them nor
    # let an empty-trash permanently delete them.

    def test_list_trashed_hides_confirmed_duplicates(self):
        account, group, keep, user_trash = self._seed_two()
        auto = self._insert_txn(account_id=account, category_id=group, amount=30.00, date="2026-04-25")
        user_dup = self._insert_txn(account_id=account, category_id=group, amount=40.00, date="2026-04-26")
        with self._use_db_path():
            trash_transaction(user_trash)  # ordinary user delete
            self._mark_confirmed_duplicate(auto, resolved_by="auto_merge")
            self._mark_confirmed_duplicate(user_dup, resolved_by="user")
            rows = list_trashed_transactions(limit=200)
        ids = [row["id"] for row in rows]
        self.assertIn(user_trash, ids)        # plain trash still shows
        self.assertNotIn(auto, ids)           # merge-confirmed hidden
        self.assertNotIn(user_dup, ids)       # reject-confirmed hidden
        self.assertNotIn(keep, ids)

    def test_empty_trash_preserves_confirmed_duplicates_but_removes_user_trash(self):
        account, group, _, user_trash = self._seed_two()
        auto = self._insert_txn(account_id=account, category_id=group, amount=30.00, date="2026-04-25")
        user_dup = self._insert_txn(account_id=account, category_id=group, amount=40.00, date="2026-04-26")
        with self._use_db_path():
            trash_transaction(user_trash)
            self._mark_confirmed_duplicate(auto, resolved_by="auto_merge")
            self._mark_confirmed_duplicate(user_dup, resolved_by="user")
            result = empty_transaction_trash()
        # Only the ordinary user-trashed row is purged.
        self.assertEqual(result["removed"], 1)
        self.assertFalse(self._txn_exists(user_trash))
        # Confirmed duplicates survive so detach / undo-reject can still restore them.
        self.assertTrue(self._txn_exists(auto))
        self.assertTrue(self._txn_exists(user_dup))


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
