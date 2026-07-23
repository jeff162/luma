"""
Bulk transaction edit (POST /transactions/bulk).

Covers the two selection modes (explicit ids; filter + exclude_ids for "select all matching") and
each action, including the leaf-only category guard and trash → trashed_at. The endpoint takes a
single Pydantic body, so it's safe to call the router function directly.
"""

from __future__ import annotations

import tempfile
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path

from fastapi import HTTPException

from backend.db.database import SHARED_OWNER_ID, get_db, init_db, reset_current_db_path, set_current_db_path
from backend.routers.transactions import (
    BulkAction,
    BulkSelection,
    BulkUpdateRequest,
    bulk_update_transactions,
)
from backend.services.transaction_tags import list_visible_transaction_tags


class BulkUpdateTransactionTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "bulk-tests.db"
        init_db(str(self.db_path))
        self.account_id = self._insert_account("Checking")
        # leaf under an expense group + a standalone group, so the category guard can be exercised
        self.group_id, self.leaf_id = self._insert_group_and_leaf("Shopping", "Gadgets")
        self.tag_id = self._insert_tag("Reimbursable")

    def tearDown(self):
        self.tempdir.cleanup()

    @contextmanager
    def _use_db_path(self):
        token = set_current_db_path(str(self.db_path))
        try:
            yield
        finally:
            reset_current_db_path(token)

    def _insert_account(self, name):
        account_id = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """
                INSERT INTO account (id, plaid_account_id, plaid_item_id, name, display_name, type, subtype, mask, owner_id, parent_account_id, trashed_at)
                VALUES (?, ?, 'fixture', ?, ?, 'checking', 'checking', '1234', ?, NULL, NULL)
                """,
                (account_id, f"acct_{account_id}", name, name, SHARED_OWNER_ID),
            )
        return account_id

    def _insert_group_and_leaf(self, group_name, leaf_name):
        group_id, leaf_id = str(uuid.uuid4()), str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                "INSERT INTO category (id, parent_id, name, category_type, sort_order) VALUES (?, NULL, ?, 'expense', 0)",
                (group_id, group_name),
            )
            conn.execute(
                "INSERT INTO category (id, parent_id, name, category_type, sort_order) VALUES (?, ?, ?, 'expense', 0)",
                (leaf_id, group_id, leaf_name),
            )
        return group_id, leaf_id

    def _insert_tag(self, name):
        tag_id = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute("INSERT INTO tag (id, name, color, sort_order) VALUES (?, ?, '#fff', 0)", (tag_id, name))
        return tag_id

    def _insert_txn(self, *, merchant="Store", amount=5.0, date="2026-01-02", category_id=None):
        txn_id = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """
                INSERT INTO txn (id, account_id, owner_id, category_id, amount, merchant_name, display_name, raw_name, date, is_pending)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
                """,
                (txn_id, self.account_id, SHARED_OWNER_ID, category_id, amount, merchant, merchant, merchant, date),
            )
        return txn_id

    def _row(self, txn_id):
        with self._use_db_path(), get_db() as conn:
            return dict(conn.execute("SELECT * FROM txn WHERE id = ?", (txn_id,)).fetchone())

    def _bulk(self, selection, actions):
        with self._use_db_path():
            return bulk_update_transactions(BulkUpdateRequest(selection=selection, actions=actions))

    # --- ids mode ---

    def test_ids_mode_set_category_only_touches_selected(self):
        a, b, c = self._insert_txn(), self._insert_txn(), self._insert_txn()
        result = self._bulk(
            BulkSelection(mode="ids", ids=[a, b]),
            [BulkAction(type="set_category", category_id=self.leaf_id)],
        )
        self.assertEqual(result["updated_count"], 2)
        for tid in (a, b):
            row = self._row(tid)
            self.assertEqual(row["category_id"], self.leaf_id)
            self.assertEqual(row["category_overridden"], 1)
            self.assertEqual(row["category_source"], "manual")
        self.assertIsNone(self._row(c)["category_id"])

    def test_set_category_rejects_a_group(self):
        a = self._insert_txn()
        with self.assertRaises(HTTPException) as ctx:
            self._bulk(BulkSelection(mode="ids", ids=[a]), [BulkAction(type="set_category", category_id=self.group_id)])
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIsNone(self._row(a)["category_id"])  # transaction left untouched

    def test_add_then_remove_tags(self):
        a, b = self._insert_txn(), self._insert_txn()
        self._bulk(BulkSelection(mode="ids", ids=[a, b]), [BulkAction(type="add_tags", tag_ids=[self.tag_id])])
        with self._use_db_path(), get_db() as conn:
            self.assertIn(self.tag_id, {t["id"] for t in list_visible_transaction_tags(conn, a)})
        self._bulk(BulkSelection(mode="ids", ids=[a, b]), [BulkAction(type="remove_tags", tag_ids=[self.tag_id])])
        with self._use_db_path(), get_db() as conn:
            self.assertNotIn(self.tag_id, {t["id"] for t in list_visible_transaction_tags(conn, a)})

    def test_set_and_clear_notes_and_merchant(self):
        a = self._insert_txn(merchant="AMZN*123")
        self._bulk(BulkSelection(mode="ids", ids=[a]), [
            BulkAction(type="set_notes", notes="checked"),
            BulkAction(type="set_merchant", merchant="Amazon"),
        ])
        row = self._row(a)
        self.assertEqual(row["notes"], "checked")
        self.assertEqual(row["display_name"], "Amazon")
        self._bulk(BulkSelection(mode="ids", ids=[a]), [BulkAction(type="set_notes", notes="")])
        self.assertIsNone(self._row(a)["notes"])

    def test_set_date_validates_format(self):
        a = self._insert_txn(date="2026-01-02")
        with self.assertRaises(HTTPException) as ctx:
            self._bulk(BulkSelection(mode="ids", ids=[a]), [BulkAction(type="set_date", date="01/02/2026")])
        self.assertEqual(ctx.exception.status_code, 400)
        self._bulk(BulkSelection(mode="ids", ids=[a]), [BulkAction(type="set_date", date="2026-03-15")])
        self.assertEqual(self._row(a)["date"], "2026-03-15")

    def test_set_review_status_both_directions(self):
        a = self._insert_txn()
        self._bulk(BulkSelection(mode="ids", ids=[a]), [BulkAction(type="set_review_status", needs_review=True)])
        self.assertEqual(self._row(a)["needs_review"], 1)
        self._bulk(BulkSelection(mode="ids", ids=[a]), [BulkAction(type="set_review_status", needs_review=False)])
        self.assertEqual(self._row(a)["needs_review"], 0)

    def test_set_review_status_requires_a_value(self):
        a = self._insert_txn()
        with self.assertRaises(HTTPException) as ctx:
            self._bulk(BulkSelection(mode="ids", ids=[a]), [BulkAction(type="set_review_status")])
        self.assertEqual(ctx.exception.status_code, 400)

    def test_trash_sets_trashed_at_and_count(self):
        a, b = self._insert_txn(), self._insert_txn()
        result = self._bulk(BulkSelection(mode="ids", ids=[a, b]), [BulkAction(type="trash")])
        self.assertEqual(result["updated_count"], 2)
        self.assertIsNotNone(self._row(a)["trashed_at"])
        # already-trashed rows are not re-resolved on a second pass
        again = self._bulk(BulkSelection(mode="ids", ids=[a, b]), [BulkAction(type="trash")])
        self.assertEqual(again["updated_count"], 0)

    # --- filter mode ---

    def test_filter_mode_with_exclude(self):
        # two txns in the leaf category, one outside; select the category, exclude one
        x = self._insert_txn(category_id=self.leaf_id, merchant="X")
        y = self._insert_txn(category_id=self.leaf_id, merchant="Y")
        other = self._insert_txn(merchant="Z")  # no category
        result = self._bulk(
            BulkSelection(mode="filter", filter={"category_id": self.leaf_id}, exclude_ids=[y]),
            [BulkAction(type="set_notes", notes="bulk")],
        )
        self.assertEqual(result["updated_count"], 1)
        self.assertEqual(self._row(x)["notes"], "bulk")
        self.assertIsNone(self._row(y)["notes"])     # excluded
        self.assertIsNone(self._row(other)["notes"])  # outside the filter

    def test_filter_mode_select_all_skips_trashed(self):
        a, b = self._insert_txn(), self._insert_txn()
        self._bulk(BulkSelection(mode="ids", ids=[a]), [BulkAction(type="trash")])
        # empty filter == every non-trashed row
        result = self._bulk(BulkSelection(mode="filter", filter={}), [BulkAction(type="add_tags", tag_ids=[self.tag_id])])
        self.assertEqual(result["updated_count"], 1)  # only b (a is trashed)
        with self._use_db_path(), get_db() as conn:
            self.assertNotIn(self.tag_id, {t["id"] for t in list_visible_transaction_tags(conn, a)})
            self.assertIn(self.tag_id, {t["id"] for t in list_visible_transaction_tags(conn, b)})


if __name__ == "__main__":
    unittest.main()
