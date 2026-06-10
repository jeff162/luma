"""
First-class inactive categories.

Set-aside and delete both deactivate a category (soft) instead of hard-deleting it:
the row survives but drops out of the active tree, its transactions are NULLed (or
reassigned to a replacement), and rules targeting it are pruned. Imports of an inactive
label come in uncategorized and never recreate the leaf. Reactivation restores it under
Unassigned. These tests pin that lifecycle, including proving the import-suppression guard
actually fires on a re-import of a previously set-aside label.
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
    m26_category_is_active,
    reset_current_db_path,
    set_current_db_path,
)
from backend.routers.categories import (
    CategoryDelete,
    delete_category,
    list_categories,
    list_inactive_categories,
    reactivate_category,
)
from backend.routers.import_export import run_import


class FakeUploadFile:
    def __init__(self, filename: str, content: str):
        self.filename = filename
        self._content = content.encode("utf-8")

    async def read(self) -> bytes:
        return self._content


def _flatten_tree(roots: list[dict]) -> list[dict]:
    out: list[dict] = []
    for node in roots:
        out.append(node)
        out.extend(_flatten_tree(node.get("children") or []))
    return out


class InactiveCategoryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "inactive-category-tests.db"
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

    # --- fixtures ---------------------------------------------------------------

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

    def _unassigned_group_id(self, conn) -> str:
        return conn.execute("SELECT id FROM category WHERE system_key = 'unassigned'").fetchone()["id"]

    def _insert_leaf(self, name: str) -> str:
        category_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    """
                    INSERT INTO category (id, parent_id, name, category_type, sort_order, exclude_from_totals, system_key, import_source_batch_id, is_active)
                    VALUES (?, ?, ?, NULL, 0, 0, NULL, NULL, 1)
                    """,
                    (category_id, self._unassigned_group_id(conn), name),
                )
        return category_id

    def _insert_txn(self, account_id: str, category_id: str | None, *, source: str | None, imported_category: str | None) -> str:
        txn_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    """
                    INSERT INTO txn
                      (id, account_id, owner_id, category_id, amount, merchant_name, display_name, raw_name, date, is_pending,
                       category_overridden, category_source, imported_category)
                    VALUES (?, ?, ?, ?, 5.0, 'M', 'M', 'M', '2026-01-02', 0, 1, ?, ?)
                    """,
                    (txn_id, account_id, SHARED_OWNER_ID, category_id, source, imported_category),
                )
        return txn_id

    async def _run_import(self, csv_text: str, *, account_map: dict[str, str]) -> dict:
        config = {
            "filename": "fixture.csv",
            "profile_id": None,
            "account_id": None,
            "account_map": account_map,
            "skip_accounts": [],
            "new_accounts": None,
            "column_map": {"date": "Date", "description": "Description", "account": "Account", "amount": "Amount", "category": "Category"},
            "date_format": "%Y-%m-%d",
            "amount_convention": "single_signed",
            "skip_rows": 0,
            "apply_categorization": False,
            "use_imported_categories": True,
        }
        with self._use_db_path():
            return await run_import(file=FakeUploadFile("fixture.csv", csv_text), config=json.dumps(config))

    def _txn(self, txn_id: str) -> dict:
        with self._use_db_path():
            with get_db() as conn:
                return dict(conn.execute(
                    "SELECT category_id, imported_category, category_source, category_overridden FROM txn WHERE id = ?",
                    (txn_id,),
                ).fetchone())

    def _unassigned_children(self) -> list[dict]:
        with self._use_db_path():
            with get_db() as conn:
                rows = conn.execute(
                    """
                    SELECT c.id, c.name, c.is_active
                    FROM   category c
                    JOIN   category p ON p.id = c.parent_id
                    WHERE  p.system_key = 'unassigned'
                    ORDER  BY c.name, c.id
                    """
                ).fetchall()
        return [dict(r) for r in rows]

    # --- migration --------------------------------------------------------------

    def test_fresh_db_has_active_column_index_and_backfill(self):
        with self._use_db_path():
            with get_db() as conn:
                columns = {row["name"] for row in conn.execute("PRAGMA table_info(category)").fetchall()}
                self.assertIn("is_active", columns)
                indexes = {row["name"] for row in conn.execute("PRAGMA index_list(category)").fetchall()}
                self.assertIn("idx_category_active", indexes)
                inactive = conn.execute("SELECT COUNT(*) AS n FROM category WHERE is_active <> 1").fetchone()["n"]
                self.assertEqual(inactive, 0)
                # New rows default to active (the backfill value) without specifying the column.
                cid = str(uuid.uuid4())
                conn.execute(
                    "INSERT INTO category (id, parent_id, name, sort_order, exclude_from_totals) VALUES (?, ?, 'Backfill Probe', 0, 0)",
                    (cid, self._unassigned_group_id(conn)),
                )
                self.assertEqual(conn.execute("SELECT is_active FROM category WHERE id = ?", (cid,)).fetchone()["is_active"], 1)
                # Migration is idempotent when the column already exists.
                m26_category_is_active(conn)

    # --- deactivate / reactivate ------------------------------------------------

    def test_deactivate_without_replacement_nulls_rows_and_hides_from_active(self):
        account_id = self._insert_account("Checking")
        leaf_id = self._insert_leaf("Streaming")
        txn_id = self._insert_txn(account_id, leaf_id, source="import", imported_category="Streaming")

        with self._use_db_path():
            delete_category(leaf_id, CategoryDelete(replacement_category_id=None))
            active_ids = {c["id"] for c in _flatten_tree(list_categories())}
            inactive_ids = {c["id"] for c in list_inactive_categories()}

        self.assertNotIn(leaf_id, active_ids)
        self.assertIn(leaf_id, inactive_ids)
        txn = self._txn(txn_id)
        self.assertIsNone(txn["category_id"])
        self.assertIsNone(txn["category_source"])
        self.assertEqual(txn["category_overridden"], 0)

    def test_deactivate_with_replacement_reassigns_rows(self):
        account_id = self._insert_account("Checking")
        leaf_id = self._insert_leaf("Streaming")
        replacement_id = self._insert_leaf("Entertainment")
        txn_id = self._insert_txn(account_id, leaf_id, source="import", imported_category="Streaming")

        with self._use_db_path():
            delete_category(leaf_id, CategoryDelete(replacement_category_id=replacement_id))

        txn = self._txn(txn_id)
        self.assertEqual(txn["category_id"], replacement_id)
        self.assertEqual(txn["category_overridden"], 0)

    def test_deactivate_prunes_targeting_rules(self):
        leaf_id = self._insert_leaf("Streaming")
        rule_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    "INSERT INTO category_rule (id, category_id, keyword, priority) VALUES (?, ?, 'netflix', 5)",
                    (rule_id, leaf_id),
                )
            delete_category(leaf_id, CategoryDelete(replacement_category_id=None))
            with get_db() as conn:
                remaining = conn.execute("SELECT 1 FROM category_rule WHERE id = ?", (rule_id,)).fetchone()
        self.assertIsNone(remaining)

    def test_reactivate_restores_under_unassigned(self):
        leaf_id = self._insert_leaf("Streaming")
        with self._use_db_path():
            delete_category(leaf_id, CategoryDelete(replacement_category_id=None))
            reactivate_category(leaf_id)
            with get_db() as conn:
                row = dict(conn.execute("SELECT parent_id, is_active FROM category WHERE id = ?", (leaf_id,)).fetchone())
                unassigned_id = self._unassigned_group_id(conn)
        self.assertEqual(row["is_active"], 1)
        self.assertEqual(row["parent_id"], unassigned_id)

    # --- import suppression (prove the guard fires) -----------------------------

    async def test_import_recreates_then_suppresses_after_set_aside(self):
        account_id = self._insert_account("Checking")

        # First import: the label is new, so a real Unassigned leaf is created and the row adopts it.
        await self._run_import(
            "\n".join([
                "Date,Description,Account,Amount,Category",
                "2026-01-02,Video Service,Checking,14.99,Subscription",
            ]),
            account_map={"Checking": account_id},
        )
        children = self._unassigned_children()
        self.assertEqual([c["name"] for c in children], ["Subscription"])
        leaf_id = children[0]["id"]

        # Deactivate the leaf, as "Set aside" / Delete does.
        with self._use_db_path():
            delete_category(leaf_id, CategoryDelete(replacement_category_id=None))

        # Import a *new* row carrying the same set-aside label (distinct date/desc so it is not an
        # exact-duplicate). It must come in uncategorized, keep its label, create no new leaf, and
        # not resurrect the inactive one. The guard would fail if a fresh leaf appeared here.
        result = await self._run_import(
            "\n".join([
                "Date,Description,Account,Amount,Category",
                "2026-02-09,Video Service Renewal,Checking,14.99,Subscription",
            ]),
            account_map={"Checking": account_id},
        )
        self.assertEqual(result["imported"], 1)

        children_after = self._unassigned_children()
        self.assertEqual(len(children_after), 1, "no new leaf should be created for the inactive label")
        self.assertEqual(children_after[0]["id"], leaf_id)
        self.assertEqual(children_after[0]["is_active"], 0, "the leaf stays inactive (not resurrected)")

        with self._use_db_path():
            with get_db() as conn:
                imported_row = dict(conn.execute(
                    "SELECT category_id, category_source, imported_category FROM txn WHERE date = '2026-02-09'"
                ).fetchone())
        self.assertIsNone(imported_row["category_id"])
        self.assertIsNone(imported_row["category_source"])
        self.assertEqual(imported_row["imported_category"], "Subscription")


if __name__ == "__main__":
    unittest.main()
