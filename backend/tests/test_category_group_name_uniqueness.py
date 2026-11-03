"""
Category/group naming + leaf-only assignment invariants.

Names are unique *within a kind* (no two groups, no two leaves), but a leaf and a
group may share a name. That relaxation is only safe because nothing ever resolves a
bare name to a *group* as an assignable target: the assignment API rejects group ids
and imports resolve a label to a leaf (creating one under Unassigned) rather than
adopting a same-named group. These tests pin both halves so the relaxation can't drift
back into assigning transactions to a group.
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
from backend.routers.categories import CategoryCreate, create_category
from backend.routers.transactions import CategoryOverride, override_category
from backend.routers.import_export import run_import


class FakeUploadFile:
    def __init__(self, filename: str, content: str):
        self.filename = filename
        self._content = content.encode("utf-8")

    async def read(self, size: int = -1) -> bytes:
        return self._content


class CategoryGroupNameUniquenessTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "category-name-tests.db"
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

    def _group_id(self, name: str) -> str:
        with self._use_db_path():
            with get_db() as conn:
                row = conn.execute(
                    "SELECT id FROM category WHERE name = ? AND parent_id IS NULL", (name,)
                ).fetchone()
        self.assertIsNotNone(row, f"expected seeded group {name!r}")
        return row["id"]

    def _insert_account(self, name: str) -> str:
        account_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    """
                    INSERT INTO account
                      (id, external_account_id, provider, name, display_name, type, subtype, mask, owner_id, parent_account_id, trashed_at)
                    VALUES (?, ?, 'fixture', ?, ?, 'checking', 'checking', '1234', ?, NULL, NULL)
                    """,
                    (account_id, f"test_{account_id}", name, name, SHARED_OWNER_ID),
                )
        return account_id

    def _insert_txn(self, account_id: str) -> str:
        txn_id = str(uuid.uuid4())
        with self._use_db_path():
            with get_db() as conn:
                conn.execute(
                    """
                    INSERT INTO txn
                      (id, account_id, owner_id, category_id, amount, merchant_name, display_name, raw_name, date, is_pending)
                    VALUES (?, ?, ?, NULL, 5.00, 'Merchant', 'Merchant', 'Merchant', '2026-01-02', 0)
                    """,
                    (txn_id, account_id, SHARED_OWNER_ID),
                )
        return txn_id

    def test_leaf_may_share_name_with_a_group(self):
        # "Miscellaneous" is a seeded expense group; a leaf of the same name under another group is allowed.
        shopping = self._group_id("Shopping")
        with self._use_db_path():
            create_category(CategoryCreate(name="Miscellaneous", parent_id=shopping))
            with get_db() as conn:
                rows = conn.execute(
                    "SELECT parent_id FROM category WHERE name = 'Miscellaneous' ORDER BY parent_id IS NULL"
                ).fetchall()
        kinds = sorted("group" if r["parent_id"] is None else "leaf" for r in rows)
        self.assertEqual(kinds, ["group", "leaf"])

    def test_duplicate_group_name_rejected(self):
        with self._use_db_path():
            with self.assertRaises(HTTPException) as ctx:
                create_category(CategoryCreate(name="Miscellaneous"))  # second top-level group
        self.assertEqual(ctx.exception.status_code, 400)

    def test_duplicate_leaf_name_rejected(self):
        shopping = self._group_id("Shopping")
        food = self._group_id("Food & Drink")
        with self._use_db_path():
            create_category(CategoryCreate(name="Doodad", parent_id=shopping))
            with self.assertRaises(HTTPException) as ctx:
                create_category(CategoryCreate(name="Doodad", parent_id=food))  # same leaf name, different group
        self.assertEqual(ctx.exception.status_code, 400)

    def test_cannot_assign_transaction_to_a_group(self):
        account_id = self._insert_account("Checking")
        txn_id = self._insert_txn(account_id)
        misc_group = self._group_id("Miscellaneous")
        shopping = self._group_id("Shopping")
        with self._use_db_path():
            with self.assertRaises(HTTPException) as ctx:
                override_category(txn_id, CategoryOverride(category_id=misc_group))
            self.assertEqual(ctx.exception.status_code, 400)

            # A real leaf still works, confirming only the group case is blocked.
            leaf = create_category(CategoryCreate(name="Widgets", parent_id=shopping))
            override_category(txn_id, CategoryOverride(category_id=leaf["id"]))
            with get_db() as conn:
                row = conn.execute("SELECT category_id FROM txn WHERE id = ?", (txn_id,)).fetchone()
        self.assertEqual(row["category_id"], leaf["id"])

    async def test_import_label_matching_a_group_creates_a_leaf(self):
        account_id = self._insert_account("Checking")
        misc_group = self._group_id("Miscellaneous")

        upload = FakeUploadFile("fixture.csv", "\n".join([
            "Date,Description,Account,Amount,Category",
            "2026-01-02,Corner Store,Checking,4.50,Miscellaneous",
        ]))
        config = {
            "filename": "fixture.csv", "profile_id": None, "account_id": None,
            "account_map": {"Checking": account_id}, "skip_accounts": [], "new_accounts": None,
            "column_map": {"date": "Date", "description": "Description", "account": "Account", "amount": "Amount", "category": "Category"},
            "date_format": "%Y-%m-%d", "amount_convention": "single_signed", "skip_rows": 0,
            "apply_categorization": False, "use_imported_categories": True,
        }
        with self._use_db_path():
            await run_import(file=upload, config=json.dumps(config))
            with get_db() as conn:
                txn = conn.execute("SELECT category_id FROM txn").fetchone()
                cat = conn.execute(
                    "SELECT c.name, c.parent_id, p.system_key AS parent_system_key "
                    "FROM category c LEFT JOIN category p ON p.id = c.parent_id WHERE c.id = ?",
                    (txn["category_id"],),
                ).fetchone()

        self.assertIsNotNone(txn["category_id"])
        self.assertNotEqual(txn["category_id"], misc_group, "imported label must not adopt the same-named group")
        self.assertEqual(cat["name"], "Miscellaneous")
        self.assertEqual(cat["parent_system_key"], "unassigned", "new imported leaf belongs under Unassigned")


if __name__ == "__main__":
    unittest.main()
