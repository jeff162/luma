"""
`list_transactions` exposes a per-row `excluded_from_totals` flag.

The account-activity panel lists every row but its total (and the chart) omit categories in an
`exclude_from_totals` group (transfers, card payments). The UI marks those rows from this flag, so
it must reflect the COALESCE(parent-group, leaf, 0) precedence — a leaf is excluded when its parent
group is, even if the leaf's own flag is 0 (the real "Credit Card Payment under Transfers" case).
"""

from __future__ import annotations

import tempfile
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path

from backend.db.database import SHARED_OWNER_ID, get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers.transactions import list_transactions


def _list_kwargs(**overrides):
    # list_transactions is a FastAPI handler; called directly, unset Query params stay FieldInfo
    # objects, so every argument must be passed explicitly.
    base = dict(
        month=None, date_start=None, date_end=None, import_batch_id=None,
        sort_by="date", sort_dir="desc", account_id=None, account_ids=None,
        source_account_ids=None, category_id=None, group_ids=None, category_ids=None,
        tag_ids=None, owner_ids=None, payees=None, direction=None, view=None,
        search=None, quick_filter=None, ids=None, include_trashed=False, limit=200, offset=0,
    )
    base.update(overrides)
    return base


class ExcludedFromTotalsFlagTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "excluded-flag.db"
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
                    INSERT INTO account (id, external_account_id, provider, name, display_name,
                                         type, subtype, mask, owner_id, parent_account_id, trashed_at)
                    VALUES (?, ?, 'fixture', 'Card', 'Card', 'credit', 'credit_card', '1', ?, NULL, NULL)
                    """,
                    (account_id, f"plaid_{account_id}", SHARED_OWNER_ID),
                )
        return account_id

    def _insert_category(self, *, name, parent_id, exclude_from_totals) -> str:
        category_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    """
                    INSERT INTO category (id, parent_id, name, category_type, sort_order, exclude_from_totals)
                    VALUES (?, ?, ?, 'expense', 0, ?)
                    """,
                    (category_id, parent_id, name, exclude_from_totals),
                )
        return category_id

    def _insert_txn(self, *, account_id, category_id, amount) -> str:
        txn_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    """
                    INSERT INTO txn (id, account_id, owner_id, category_id, amount, merchant_name,
                                     display_name, raw_name, date, is_pending)
                    VALUES (?, ?, ?, ?, ?, 'M', 'M', 'M', '2026-05-10', 0)
                    """,
                    (txn_id, account_id, SHARED_OWNER_ID, category_id, amount),
                )
        return txn_id

    def test_flag_reflects_parent_group_exclusion(self):
        account = self._insert_account()
        # Transfers group excluded; its "Credit Card Payment" leaf carries exclude_from_totals = 0 itself,
        # so the flag must come from the parent. A normal Household/Newspaper pair is not excluded.
        transfers = self._insert_category(name="Transfers", parent_id=None, exclude_from_totals=1)
        card_payment = self._insert_category(name="Credit Card Payment", parent_id=transfers, exclude_from_totals=0)
        household = self._insert_category(name="Household", parent_id=None, exclude_from_totals=0)
        newspaper = self._insert_category(name="Newspaper", parent_id=household, exclude_from_totals=0)

        payment = self._insert_txn(account_id=account, category_id=card_payment, amount=-24.0)
        expense = self._insert_txn(account_id=account, category_id=newspaper, amount=24.0)

        with self._use_db_path():
            result = list_transactions(**_list_kwargs(account_id=account))

        flags = {row["id"]: row["excluded_from_totals"] for row in result["transactions"]}
        self.assertEqual(flags[payment], 1, "leaf under an excluded group must read as excluded")
        self.assertEqual(flags[expense], 0, "leaf under a normal group must not read as excluded")
