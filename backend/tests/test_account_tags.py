"""
Account-tag effective resolution.

Account tags resolve through the *effective* (top-level) account: a top-level account's tags
apply to its own and its children's transactions, while a child account's own tags stay dormant
while it is merged (and reactivate when it is detached). These tests pin that — inheritance down to
children, dormancy of a child's own tags, restore on detach, and that tag filtering reaches all of
them — since the whole point of the feature is which transactions a tag reaches.
"""

from __future__ import annotations

import tempfile
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path

from backend.db.database import SHARED_OWNER_ID, get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers.accounts import AccountTagsUpdate, set_account_tags
from backend.routers.transactions import list_transactions
from backend.services.transaction_tags import list_visible_transaction_tags


class AccountTagTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "account-tag-tests.db"
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

    def _insert_account(self, name: str, *, parent_account_id: str | None = None) -> str:
        account_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    """
                    INSERT INTO account
                      (id, plaid_account_id, plaid_item_id, name, display_name, type, subtype, mask, owner_id, parent_account_id, trashed_at)
                    VALUES (?, ?, ?, ?, ?, 'checking', 'checking', '1234', ?, ?, NULL)
                    """,
                    (account_id, f"plaid_{account_id}", "fixture_account_tags", name, name, SHARED_OWNER_ID, parent_account_id),
                )
        return account_id

    def _insert_tag(self, name: str) -> str:
        tag_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute("INSERT INTO tag (id, name, color, sort_order) VALUES (?, ?, '#22c55e', 0)", (tag_id, name))
        return tag_id

    def _insert_txn(self, *, account_id: str, merchant: str, amount: float = 25.0) -> str:
        txn_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    """
                    INSERT INTO txn
                      (id, account_id, owner_id, category_id, amount, merchant_name, display_name, raw_name, date, is_pending, category_overridden)
                    VALUES (?, ?, ?, NULL, ?, ?, ?, ?, '2026-04-15', 0, 0)
                    """,
                    (txn_id, account_id, SHARED_OWNER_ID, amount, merchant, merchant, merchant),
                )
        return txn_id

    def _set_tags(self, account_id: str, tag_ids: list[str]) -> None:
        with self._use_db_path():
            set_account_tags(account_id, AccountTagsUpdate(tag_ids=tag_ids))

    def _visible_tags(self, txn_id: str) -> list[dict]:
        with self._use_db_path():
            with get_db() as conn:
                return list_visible_transaction_tags(conn, txn_id)

    def _ledger_ids_for_tag(self, tag_id: str) -> list[str]:
        with self._use_db_path():
            ledger = list_transactions(
                month=None, date_start=None, date_end=None, import_batch_id=None,
                sort_by="date", sort_dir="desc", account_id=None, account_ids=None,
                category_id=None, group_ids=None, category_ids=None, tag_ids=tag_id,
                owner_ids=None, payees=None, direction=None, search=None,
                quick_filter=None, limit=200, offset=0,
            )
        return [txn["id"] for txn in ledger["transactions"]]

    def test_account_tag_is_effective_on_its_transactions(self):
        account_id = self._insert_account("Checking")
        tag_id = self._insert_tag("Joint")
        txn_id = self._insert_txn(account_id=account_id, merchant="Cafe")
        self._set_tags(account_id, [tag_id])

        tags = self._visible_tags(txn_id)
        self.assertEqual([(t["id"], t["source"]) for t in tags], [(tag_id, "account")])

    def test_child_inherits_parent_account_tag(self):
        parent_id = self._insert_account("Chase")
        child_id = self._insert_account("Chase 4321", parent_account_id=parent_id)
        tag_id = self._insert_tag("Joint")
        child_txn = self._insert_txn(account_id=child_id, merchant="Cafe")
        self._set_tags(parent_id, [tag_id])

        tags = self._visible_tags(child_txn)
        self.assertEqual([t["id"] for t in tags], [tag_id])

    def test_child_own_tag_is_dormant_then_restored_on_detach(self):
        parent_id = self._insert_account("Chase")
        child_id = self._insert_account("Chase 4321", parent_account_id=parent_id)
        tag_id = self._insert_tag("Personal")
        child_txn = self._insert_txn(account_id=child_id, merchant="Cafe")
        self._set_tags(child_id, [tag_id])

        # Dormant while merged: the child's own tag resolves through the parent, which has none.
        self.assertEqual(self._visible_tags(child_txn), [])

        # Detach restores it: the child is top-level again, so its own tag is effective.
        with self._use_db_path():
            with get_db() as conn:
                conn.execute("UPDATE account SET parent_account_id = NULL WHERE id = ?", (child_id,))
        self.assertEqual([t["id"] for t in self._visible_tags(child_txn)], [tag_id])

    def test_tag_filter_matches_account_and_inheriting_children(self):
        parent_id = self._insert_account("Chase")
        child_id = self._insert_account("Chase 4321", parent_account_id=parent_id)
        other_id = self._insert_account("Riverstone")
        tag_id = self._insert_tag("Joint")
        parent_txn = self._insert_txn(account_id=parent_id, merchant="Parent buy")
        child_txn = self._insert_txn(account_id=child_id, merchant="Child buy")
        self._insert_txn(account_id=other_id, merchant="Unrelated")
        self._set_tags(parent_id, [tag_id])

        self.assertEqual(sorted(self._ledger_ids_for_tag(tag_id)), sorted([parent_txn, child_txn]))


if __name__ == "__main__":
    unittest.main()
