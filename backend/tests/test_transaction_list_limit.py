"""
Coverage for the transaction list endpoint's paging limit, including the `limit=0` "no limit"
opt-in that returns every matching row (for known-bounded scopes) instead of a capped page.
"""

from __future__ import annotations

import tempfile
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path

from backend.db.database import SHARED_OWNER_ID, get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers.transactions import list_transactions
from backend.services.transaction_facets import split_facets


def _list(**overrides):
    """Call list_transactions with the full explicit kwarg set (defaults are FieldInfo on a direct call)."""
    params = dict(
        month=None, date_start=None, date_end=None, import_batch_id=None,
        sort_by="date", sort_dir="desc",
        account_id=None, category_id=None,
        direction=None, view=None,
        search=None, quick_filter=None,
        include_trashed=False, limit=200, offset=0,
    )
    params.update(overrides)
    facets, rest = split_facets(params)
    return list_transactions(**rest, facets=facets)


class TransactionListLimitTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "list-limit.db"
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

    def _seed(self, n: int) -> str:
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
                for i in range(n):
                    conn.execute(
                        """
                        INSERT INTO txn
                          (id, account_id, owner_id, category_id, amount, merchant_name,
                           display_name, raw_name, date, is_pending, trashed_at)
                        VALUES (?, ?, ?, NULL, ?, 'Merchant', 'Merchant', 'Merchant', ?, 0, NULL)
                        """,
                        (str(uuid.uuid4()), account_id, SHARED_OWNER_ID, 10.0 + i, f"2026-04-{(i % 28) + 1:02d}"),
                    )
        return account_id

    def test_positive_limit_caps_the_page_but_reports_full_total(self):
        self._seed(3)
        with self._use_db_path():
            result = _list(limit=1)
        # The page is capped at 1 row, but `total` still reflects the whole matching set.
        self.assertEqual(len(result["transactions"]), 1)
        self.assertEqual(result["total"], 3)

    def test_limit_zero_returns_all_matching_rows(self):
        self._seed(3)
        with self._use_db_path():
            result = _list(limit=0)
        self.assertEqual(len(result["transactions"]), 3)
        self.assertEqual(result["total"], 3)

    def test_limit_zero_still_honors_offset(self):
        self._seed(3)
        with self._use_db_path():
            result = _list(limit=0, offset=1)
        # limit=0 is "no upper bound", so an offset still skips rows from the front.
        self.assertEqual(len(result["transactions"]), 2)
        self.assertEqual(result["total"], 3)


if __name__ == "__main__":
    unittest.main()
