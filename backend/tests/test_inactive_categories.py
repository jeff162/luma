"""
Inactive categories and the distinct "set aside" (parked-but-active) state.

Delete deactivates a category (soft) instead of hard-deleting it: the row survives but drops out
of the active tree, its transactions are NULLed (or reassigned to a replacement), rules targeting
it are pruned, and imports of that label come in uncategorized and never recreate the leaf.
Reactivation restores it under Unassigned with the set-aside flag cleared.

Set aside is deliberately NOT a deletion: the category stays active (set_aside = 1), keeps its
transactions, stays in the active tree, and future imports of the label still categorize to it.
It only parks the label out of the "still needs sorting" pool. These tests pin both lifecycles,
including proving the delete import-suppression guard fires while set-aside does not suppress.
"""

from __future__ import annotations

import json
import tempfile
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path

from fastapi import HTTPException

from backend.db.database import (
    SHARED_OWNER_ID,
    get_db,
    init_db,
    reset_current_db_path,
    set_current_db_path,
)
from backend.routers.categories import (
    CategoryDelete,
    CategoryUpdate,
    delete_category,
    empty_cleanup,
    empty_cleanup_preview,
    hard_delete_category,
    list_categories,
    list_inactive_categories,
    reactivate_category,
    restore_category_to_pool,
    set_category_aside,
    update_category,
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

    def _category_row(self, category_id: str) -> dict:
        with self._use_db_path():
            with get_db() as conn:
                return dict(conn.execute(
                    "SELECT is_active, set_aside, import_pending, parent_id FROM category WHERE id = ?",
                    (category_id,),
                ).fetchone())

    def _insert_group(self, name: str, category_type: str = "expense") -> str:
        group_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    "INSERT INTO category (id, parent_id, name, category_type, sort_order, exclude_from_totals, is_active) VALUES (?, NULL, ?, ?, 0, 0, 1)",
                    (group_id, name, category_type),
                )
        return group_id

    def _insert_leaf_under(self, group_id: str, name: str) -> str:
        category_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    "INSERT INTO category (id, parent_id, name, category_type, sort_order, exclude_from_totals, is_active) VALUES (?, ?, ?, 'expense', 0, 0, 1)",
                    (category_id, group_id, name),
                )
        return category_id

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

    # --- fresh schema -----------------------------------------------------------

    def test_fresh_db_has_active_columns_index_and_defaults(self):
        with self._use_db_path():
            with get_db() as conn:
                columns = {row["name"] for row in conn.execute("PRAGMA table_info(category)").fetchall()}
                self.assertIn("is_active", columns)
                self.assertIn("set_aside", columns)
                self.assertIn("import_pending", columns)
                indexes = {row["name"] for row in conn.execute("PRAGMA index_list(category)").fetchall()}
                self.assertIn("idx_category_active", indexes)
                inactive = conn.execute("SELECT COUNT(*) AS n FROM category WHERE is_active <> 1").fetchone()["n"]
                self.assertEqual(inactive, 0)
                parked = conn.execute("SELECT COUNT(*) AS n FROM category WHERE set_aside <> 0").fetchone()["n"]
                self.assertEqual(parked, 0)
                # New rows default to active without specifying the column.
                cid = str(uuid.uuid4())
                conn.execute(
                    "INSERT INTO category (id, parent_id, name, sort_order, exclude_from_totals) VALUES (?, ?, 'Default Probe', 0, 0)",
                    (cid, self._unassigned_group_id(conn)),
                )
                self.assertEqual(conn.execute("SELECT is_active FROM category WHERE id = ?", (cid,)).fetchone()["is_active"], 1)
                self.assertEqual(conn.execute("SELECT set_aside FROM category WHERE id = ?", (cid,)).fetchone()["set_aside"], 0)
                self.assertEqual(conn.execute("SELECT import_pending FROM category WHERE id = ?", (cid,)).fetchone()["import_pending"], 0)

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

    def test_deleting_group_removes_group_and_sends_children_to_inactive(self):
        account_id = self._insert_account("Checking")
        group_id, leaf_id = str(uuid.uuid4()), str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    "INSERT INTO category (id, parent_id, name, category_type, sort_order, exclude_from_totals, is_active) VALUES (?, NULL, 'Travel', 'expense', 0, 0, 1)",
                    (group_id,),
                )
                conn.execute(
                    "INSERT INTO category (id, parent_id, name, category_type, sort_order, exclude_from_totals, is_active) VALUES (?, ?, 'Flights', 'expense', 0, 0, 1)",
                    (leaf_id, group_id),
                )
        txn_id = self._insert_txn(account_id, leaf_id, source="manual", imported_category=None)

        with self._use_db_path():
            delete_category(group_id, CategoryDelete(replacement_category_id=None))
            active_ids = {c["id"] for c in _flatten_tree(list_categories())}
            inactive_ids = {c["id"] for c in list_inactive_categories()}
            with get_db() as conn:
                group_still_exists = conn.execute(
                    "SELECT 1 FROM category WHERE id = ?", (group_id,)
                ).fetchone()

        # A group is a container, not an import label: it is removed outright rather than parked in
        # the Inactive list. Its child leaf goes inactive (recoverable), its transaction is cleared,
        # and the leaf's parent_id is nulled (the group is gone) so recovery falls back to Unassigned.
        self.assertIsNone(group_still_exists, "the group row is deleted, not deactivated")
        self.assertNotIn(group_id, inactive_ids, "groups never appear in the Inactive list")
        self.assertNotIn(group_id, active_ids)
        self.assertNotIn(leaf_id, active_ids)
        self.assertIn(leaf_id, inactive_ids)
        self.assertIsNone(self._category_row(leaf_id)["parent_id"])
        self.assertIsNone(self._txn(txn_id)["category_id"])

    def test_reactivate_clears_set_aside_flag(self):
        leaf_id = self._insert_leaf("Streaming")
        with self._use_db_path():
            set_category_aside(leaf_id)
            delete_category(leaf_id, CategoryDelete(replacement_category_id=None))
            reactivate_category(leaf_id)
            with get_db() as conn:
                row = dict(conn.execute("SELECT is_active, set_aside FROM category WHERE id = ?", (leaf_id,)).fetchone())
        self.assertEqual(row["is_active"], 1)
        self.assertEqual(row["set_aside"], 0)

    # --- set aside (parked but active) ------------------------------------------

    def test_set_aside_keeps_category_active_and_visible(self):
        account_id = self._insert_account("Checking")
        leaf_id = self._insert_leaf("Streaming")
        txn_id = self._insert_txn(account_id, leaf_id, source="import", imported_category="Streaming")

        with self._use_db_path():
            set_category_aside(leaf_id)
            active_ids = {c["id"] for c in _flatten_tree(list_categories())}
            inactive_ids = {c["id"] for c in list_inactive_categories()}
            with get_db() as conn:
                row = dict(conn.execute("SELECT is_active, set_aside FROM category WHERE id = ?", (leaf_id,)).fetchone())

        # Parked, not deleted: still active and flagged, still in the active tree, never in the
        # inactive recovery list, and its transaction keeps the category.
        self.assertEqual(row["is_active"], 1)
        self.assertEqual(row["set_aside"], 1)
        self.assertIn(leaf_id, active_ids)
        self.assertNotIn(leaf_id, inactive_ids)
        self.assertEqual(self._txn(txn_id)["category_id"], leaf_id)

    def test_restore_to_pool_clears_set_aside_flag(self):
        leaf_id = self._insert_leaf("Streaming")
        with self._use_db_path():
            set_category_aside(leaf_id)
            restore_category_to_pool(leaf_id)
            with get_db() as conn:
                row = dict(conn.execute("SELECT set_aside FROM category WHERE id = ?", (leaf_id,)).fetchone())
        self.assertEqual(row["set_aside"], 0)

    def test_cannot_set_aside_a_deleted_category(self):
        leaf_id = self._insert_leaf("Streaming")
        with self._use_db_path():
            delete_category(leaf_id, CategoryDelete(replacement_category_id=None))
            with self.assertRaises(HTTPException):
                set_category_aside(leaf_id)

    async def test_set_aside_does_not_suppress_future_imports(self):
        account_id = self._insert_account("Checking")

        await self._run_import(
            "\n".join([
                "Date,Description,Account,Amount,Category",
                "2026-01-02,Video Service,Checking,14.99,Subscription",
            ]),
            account_map={"Checking": account_id},
        )
        leaf_id = self._unassigned_children()[0]["id"]

        # Park the label (active). Unlike Delete, a later import of the same label must still
        # categorize to this leaf rather than coming in uncategorized.
        with self._use_db_path():
            set_category_aside(leaf_id)

        await self._run_import(
            "\n".join([
                "Date,Description,Account,Amount,Category",
                "2026-02-09,Video Service Renewal,Checking,14.99,Subscription",
            ]),
            account_map={"Checking": account_id},
        )

        children_after = self._unassigned_children()
        self.assertEqual(len(children_after), 1, "no new leaf: the set-aside leaf is reused")
        self.assertEqual(children_after[0]["id"], leaf_id)
        self.assertEqual(children_after[0]["is_active"], 1)
        with self._use_db_path():
            with get_db() as conn:
                imported_row = dict(conn.execute(
                    "SELECT category_id, category_source FROM txn WHERE date = '2026-02-09'"
                ).fetchone())
        self.assertEqual(imported_row["category_id"], leaf_id)
        self.assertEqual(imported_row["category_source"], "import")

    # --- import_pending: the workspace landing spot is for pending imports only ---

    async def test_imported_leaf_is_pending_then_leaves_on_delete_and_recover(self):
        account_id = self._insert_account("Checking")
        await self._run_import(
            "\n".join([
                "Date,Description,Account,Amount,Category",
                "2026-01-02,Video,Checking,9.99,Streaming",
            ]),
            account_map={"Checking": account_id},
        )
        leaf_id = self._unassigned_children()[0]["id"]
        # Imported → pending (shows in the workspace).
        self.assertEqual(self._category_row(leaf_id)["import_pending"], 1)
        # Delete → leaves the workspace (pending cleared) and goes inactive.
        with self._use_db_path():
            delete_category(leaf_id, CategoryDelete(replacement_category_id=None))
        self.assertEqual(self._category_row(leaf_id)["import_pending"], 0)
        # Recover → active again, still not pending, lands under Unassigned (never re-enters workspace).
        with self._use_db_path():
            reactivate_category(leaf_id)
            unassigned_id = None
            with get_db() as conn:
                unassigned_id = self._unassigned_group_id(conn)
        row = self._category_row(leaf_id)
        self.assertEqual(row["is_active"], 1)
        self.assertEqual(row["import_pending"], 0)
        self.assertEqual(row["parent_id"], unassigned_id)

    def test_user_created_category_never_enters_workspace(self):
        # A category created directly (not via import) defaults to import_pending = 0 and must stay
        # out of the workspace through a delete/recover round trip.
        leaf_id = self._insert_leaf("My Custom Category")
        self.assertEqual(self._category_row(leaf_id)["import_pending"], 0)
        with self._use_db_path():
            delete_category(leaf_id, CategoryDelete(replacement_category_id=None))
            reactivate_category(leaf_id)
        self.assertEqual(self._category_row(leaf_id)["import_pending"], 0)

    def test_recover_restores_to_original_group(self):
        group_id = self._insert_group("Entertainment")
        leaf_id = self._insert_leaf_under(group_id, "Concerts")
        with self._use_db_path():
            delete_category(leaf_id, CategoryDelete(replacement_category_id=None))
            reactivate_category(leaf_id)
        self.assertEqual(self._category_row(leaf_id)["parent_id"], group_id)

    def test_recover_falls_back_to_unassigned_when_group_gone(self):
        group_id = self._insert_group("Entertainment")
        leaf_id = self._insert_leaf_under(group_id, "Concerts")
        with self._use_db_path():
            delete_category(leaf_id, CategoryDelete(replacement_category_id=None))
            delete_category(group_id, CategoryDelete(replacement_category_id=None))
            reactivate_category(leaf_id)
            with get_db() as conn:
                unassigned_id = self._unassigned_group_id(conn)
        self.assertEqual(self._category_row(leaf_id)["parent_id"], unassigned_id)

    async def test_organizing_into_group_clears_pending(self):
        account_id = self._insert_account("Checking")
        await self._run_import(
            "\n".join([
                "Date,Description,Account,Amount,Category",
                "2026-01-02,Video,Checking,9.99,Streaming",
            ]),
            account_map={"Checking": account_id},
        )
        leaf_id = self._unassigned_children()[0]["id"]
        group_id = self._insert_group("Entertainment")
        with self._use_db_path():
            update_category(leaf_id, CategoryUpdate(parent_id=group_id))
        row = self._category_row(leaf_id)
        self.assertEqual(row["import_pending"], 0, "organizing into a group leaves the workspace")
        self.assertEqual(row["parent_id"], group_id)

    # --- import suppression after DELETE (prove the guard fires) ----------------

    async def test_import_suppressed_after_delete(self):
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

        # Delete the leaf (deactivate) — this, unlike Set aside, suppresses the label.
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


    def test_hard_delete_rejects_active_category(self):
        # The guard that keeps hard delete safe: only an inactive (referentially empty) category may
        # be purged. An active one could still have live transactions (txn.category_id is SET NULL on
        # delete), so dropping it would silently uncategorize them.
        leaf_id = self._insert_leaf("Streaming")
        with self._use_db_path():
            with self.assertRaises(HTTPException) as ctx:
                hard_delete_category(leaf_id)
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertEqual(self._category_row(leaf_id)["is_active"], 1, "the category is untouched")

    async def test_hard_delete_removes_inactive_leaf_and_lifts_suppression(self):
        account_id = self._insert_account("Checking")

        # Import the label so a real leaf exists and a transaction adopts it.
        await self._run_import(
            "\n".join([
                "Date,Description,Account,Amount,Category",
                "2026-01-02,Video Service,Checking,14.99,Subscription",
            ]),
            account_map={"Checking": account_id},
        )
        leaf_id = self._unassigned_children()[0]["id"]

        # Soft delete (suppresses the label), then hard delete (purges the row entirely).
        with self._use_db_path():
            delete_category(leaf_id, CategoryDelete(replacement_category_id=None))
            hard_delete_category(leaf_id)
            with get_db() as conn:
                self.assertIsNone(
                    conn.execute("SELECT 1 FROM category WHERE id = ?", (leaf_id,)).fetchone(),
                    "the row is gone for good",
                )
                # The original transaction survives with its imported_category text intact.
                original = dict(conn.execute(
                    "SELECT category_id, imported_category FROM txn WHERE date = '2026-01-02'"
                ).fetchone())
        self.assertIsNone(original["category_id"])
        self.assertEqual(original["imported_category"], "Subscription")

        # Suppression is lifted: re-importing the label now creates a fresh leaf (contrast with
        # test_import_suppressed_after_delete, where the still-present inactive row suppresses it).
        await self._run_import(
            "\n".join([
                "Date,Description,Account,Amount,Category",
                "2026-02-09,Video Service Renewal,Checking,14.99,Subscription",
            ]),
            account_map={"Checking": account_id},
        )
        children_after = self._unassigned_children()
        self.assertEqual([c["name"] for c in children_after], ["Subscription"])
        self.assertNotEqual(children_after[0]["id"], leaf_id, "a brand-new leaf, not the purged one")
        self.assertEqual(children_after[0]["is_active"], 1)

    def test_hard_delete_purges_legacy_inactive_group_branch(self):
        # New deletes remove a group outright, so groups no longer enter the Inactive list. But a
        # database from before that change can still hold an inactive group with inactive children;
        # hard delete must purge the whole branch in one shot. Construct that legacy shape directly.
        group_id, leaf_id = str(uuid.uuid4()), str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    "INSERT INTO category (id, parent_id, name, category_type, sort_order, exclude_from_totals, is_active) VALUES (?, NULL, 'Travel', 'expense', 0, 0, 0)",
                    (group_id,),
                )
                conn.execute(
                    "INSERT INTO category (id, parent_id, name, category_type, sort_order, exclude_from_totals, is_active) VALUES (?, ?, 'Flights', 'expense', 0, 0, 0)",
                    (leaf_id, group_id),
                )
            hard_delete_category(group_id)
            with get_db() as conn:
                remaining = conn.execute(
                    "SELECT 1 FROM category WHERE id IN (?, ?)", (group_id, leaf_id)
                ).fetchall()
        self.assertEqual(remaining, [], "both the group and its child leaf are gone")


    # --- empty-category/group cleanup -------------------------------------------

    def _category_exists(self, category_id: str) -> bool:
        with self._use_db_path():
            with get_db() as conn:
                return conn.execute(
                    "SELECT 1 FROM category WHERE id = ?", (category_id,)
                ).fetchone() is not None

    def test_empty_cleanup_removes_empties_and_keeps_used(self):
        # A fresh DB also seeds default categories (which the sweep treats as empty), so assert on
        # our own ids rather than global counts.
        account_id = self._insert_account("Checking")
        keep_group = self._insert_group("Keepers")
        used_leaf = self._insert_leaf_under(keep_group, "Groceries")
        self._insert_txn(account_id, used_leaf, source="manual", imported_category=None)
        sibling_empty_leaf = self._insert_leaf_under(keep_group, "Snacks")  # 0 txns/rules
        empty_group = self._insert_group("Voyages")
        empty_group_leaf = self._insert_leaf_under(empty_group, "Flights")  # 0 txns/rules
        childless_group = self._insert_group("Sundries")  # no children at all

        with self._use_db_path():
            empty_cleanup()

        # Used leaf and its group survive; removing the empty sibling does not orphan the group.
        self.assertTrue(self._category_exists(used_leaf))
        self.assertTrue(self._category_exists(keep_group))
        # Everything empty is gone outright (not parked in Inactive).
        self.assertFalse(self._category_exists(sibling_empty_leaf))
        self.assertFalse(self._category_exists(empty_group))
        self.assertFalse(self._category_exists(empty_group_leaf))
        self.assertFalse(self._category_exists(childless_group))
        with self._use_db_path():
            inactive_ids = {c["id"] for c in list_inactive_categories()}
        self.assertEqual(
            inactive_ids & {sibling_empty_leaf, empty_group, empty_group_leaf, childless_group},
            set(),
            "cleanup removes empties outright, it does not park them in Inactive",
        )

    def test_empty_cleanup_keeps_rule_targets(self):
        # A category that is a rule target is configured-but-unused, not clutter: keep it (and its
        # parent group). The guard fails if a rule-targeted leaf is swept.
        group_id = self._insert_group("Coffee Shops")
        leaf_id = self._insert_leaf_under(group_id, "Coffee")
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    "INSERT INTO category_rule (id, category_id, keyword, priority) VALUES (?, ?, 'starbucks', 100)",
                    (str(uuid.uuid4()), leaf_id),
                )
            preview = empty_cleanup_preview()
            empty_cleanup()
        self.assertNotIn(leaf_id, {c["id"] for c in preview["categories"]})
        self.assertTrue(self._category_exists(leaf_id))
        self.assertTrue(self._category_exists(group_id))

    def test_empty_cleanup_excludes_pending_labels_and_system_group(self):
        pending_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                unassigned_id = self._unassigned_group_id(conn)
                conn.execute(
                    """
                    INSERT INTO category (id, parent_id, name, category_type, sort_order, exclude_from_totals, system_key, is_active, import_pending)
                    VALUES (?, ?, 'Streaming', NULL, 0, 0, NULL, 1, 1)
                    """,
                    (pending_id, unassigned_id),
                )
            preview = empty_cleanup_preview()
            empty_cleanup()
        self.assertNotIn(pending_id, {c["id"] for c in preview["categories"]})
        self.assertNotIn(unassigned_id, {g["id"] for g in preview["groups"]})
        self.assertTrue(self._category_exists(pending_id), "an import-workspace pending label is left alone")
        self.assertTrue(self._category_exists(unassigned_id), "the Unassigned system group is never swept")


if __name__ == "__main__":
    unittest.main()
