"""
The shared excluded-transfers-leaf helper (`services/excluded_categories.py`).

Both the Amazon importer and wallet money-movement suppression put a row into an excluded leaf under the
seeded `Transfers` group. The invariant this guards: a transaction may only be assigned to a *leaf*, never
a group, so the helper must recreate a missing group rather than degrade to a parentless (group-shaped)
leaf a transaction couldn't legitimately be assigned to. The API refuses to delete the group, but the
helper still recreates it: a database predating the key, or a direct edit, can still arrive without one.

The group carries a `system_key`, so a rename cannot lose it. Its exclusion is deliberately *not* locked
the way `Reimbursable`'s is — see `routers/categories.py`.
"""

from __future__ import annotations

import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path

from backend.db.database import get_db, init_db, reset_current_db_path, set_current_db_path
from backend.services.excluded_categories import (
    TRANSFERS_GROUP,
    TRANSFERS_SYSTEM_KEY,
    ensure_excluded_transfers_leaf,
    find_transfers_group_id,
)


class TransferCategoriesTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "transfers.db"
        init_db(str(self.db_path))

    def tearDown(self):
        self.tempdir.cleanup()

    @contextmanager
    def _use_db(self):
        token = set_current_db_path(str(self.db_path))
        try:
            with get_db() as conn:
                yield conn
        finally:
            reset_current_db_path(token)

    def _row(self, conn, leaf_id):
        return conn.execute(
            "SELECT parent_id, exclude_from_totals FROM category WHERE id = ?", (leaf_id,)
        ).fetchone()

    def test_leaf_is_created_under_the_transfers_group(self):
        with self._use_db() as conn:
            leaf_id = ensure_excluded_transfers_leaf(conn, "Money movement")
            row = self._row(conn, leaf_id)
            group = conn.execute("SELECT id FROM category WHERE name = ? AND parent_id IS NULL", (TRANSFERS_GROUP,)).fetchone()
        self.assertIsNotNone(row["parent_id"], "the leaf must have a group parent, not be top-level")
        self.assertEqual(row["parent_id"], group["id"])
        self.assertEqual(row["exclude_from_totals"], 1)

    def test_idempotent(self):
        with self._use_db() as conn:
            first = ensure_excluded_transfers_leaf(conn, "Money movement")
            second = ensure_excluded_transfers_leaf(conn, "Money movement")
        self.assertEqual(first, second)

    def test_recreates_the_group_if_the_user_deleted_it(self):
        # Delete the seeded Transfers group; the helper must recreate it and still parent the leaf under a
        # real group — never create the excluded category as a parentless (group-shaped) row.
        with self._use_db() as conn:
            conn.execute("DELETE FROM category WHERE name = ? AND parent_id IS NULL", (TRANSFERS_GROUP,))
            self.assertIsNone(conn.execute("SELECT 1 FROM category WHERE name = ? AND parent_id IS NULL", (TRANSFERS_GROUP,)).fetchone())
            leaf_id = ensure_excluded_transfers_leaf(conn, "Amazon purchase")
            row = self._row(conn, leaf_id)
            group = conn.execute("SELECT id, exclude_from_totals FROM category WHERE name = ? AND parent_id IS NULL", (TRANSFERS_GROUP,)).fetchone()
        self.assertIsNotNone(group, "the group must be recreated")
        self.assertEqual(group["exclude_from_totals"], 1)
        self.assertEqual(row["parent_id"], group["id"], "the leaf must parent under the recreated group")


class TransfersGroupIdentityTests(unittest.TestCase):
    """The group is found by key, not by name. Before the key, renaming it was silently destructive:
    the next import could not see the renamed group, built a second `Transfers` beside it, and filed new
    money-movement leaves there while the old ones stayed behind. Both groups were excluded, so no total
    ever looked wrong — which is why this is a test rather than a note."""

    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "transfers-identity.db"
        init_db(str(self.db_path))

    def tearDown(self):
        self.tempdir.cleanup()

    @contextmanager
    def _use_db(self):
        token = set_current_db_path(str(self.db_path))
        try:
            with get_db() as conn:
                yield conn
        finally:
            reset_current_db_path(token)

    def _top_level_groups(self, conn):
        return conn.execute(
            """SELECT id, name FROM category
               WHERE parent_id IS NULL AND (system_key = ? OR name = ?)""",
            (TRANSFERS_SYSTEM_KEY, TRANSFERS_GROUP),
        ).fetchall()

    def test_the_group_is_seeded_with_a_system_key_and_excluded(self):
        with self._use_db() as conn:
            row = conn.execute(
                "SELECT name, parent_id, exclude_from_totals FROM category WHERE system_key = ?",
                (TRANSFERS_SYSTEM_KEY,),
            ).fetchone()
        self.assertEqual(row["name"], TRANSFERS_GROUP)
        self.assertIsNone(row["parent_id"])
        self.assertEqual(row["exclude_from_totals"], 1)

    def test_a_renamed_group_still_takes_the_leaves(self):
        with self._use_db() as conn:
            original = find_transfers_group_id(conn)
            conn.execute(
                "UPDATE category SET name = 'Money moves' WHERE system_key = ?", (TRANSFERS_SYSTEM_KEY,)
            )
            leaf_id = ensure_excluded_transfers_leaf(conn, "Money movement")
            parent_id = conn.execute(
                "SELECT parent_id FROM category WHERE id = ?", (leaf_id,)
            ).fetchone()["parent_id"]
            groups = self._top_level_groups(conn)
            self.assertEqual(find_transfers_group_id(conn), original, "the key must survive a rename")
        self.assertEqual(parent_id, original, "the leaf belongs to the renamed group, not a new one")
        self.assertEqual(len(groups), 1, "a rename must not produce a second Transfers group")

    def test_an_unkeyed_group_is_adopted_rather_than_duplicated(self):
        # What an existing database looks like before migration 53 stamps the key. Adoption is by name,
        # so the group the user already has is the one the helper keeps using.
        with self._use_db() as conn:
            conn.execute("UPDATE category SET system_key = NULL WHERE system_key = ?", (TRANSFERS_SYSTEM_KEY,))
            existing = conn.execute(
                "SELECT id FROM category WHERE name = ? AND parent_id IS NULL", (TRANSFERS_GROUP,)
            ).fetchone()["id"]
            leaf_id = ensure_excluded_transfers_leaf(conn, "Money movement")
            parent_id = conn.execute(
                "SELECT parent_id FROM category WHERE id = ?", (leaf_id,)
            ).fetchone()["parent_id"]
            groups = self._top_level_groups(conn)
        self.assertEqual(parent_id, existing)
        self.assertEqual(len(groups), 1)


class TransfersGroupGuardTests(unittest.TestCase):
    """What the API refuses, and what it deliberately allows. The group has to stay findable and stay a
    group; what it is *called* and whether it counts toward totals are the user's to choose."""

    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "transfers-guards.db"
        init_db(str(self.db_path))

    def tearDown(self):
        self.tempdir.cleanup()

    @contextmanager
    def _use_db(self):
        token = set_current_db_path(str(self.db_path))
        try:
            with get_db() as conn:
                yield conn
        finally:
            reset_current_db_path(token)

    def _group_id(self):
        with self._use_db() as conn:
            return find_transfers_group_id(conn)

    def test_the_group_cannot_be_deleted(self):
        from fastapi import HTTPException

        from backend.routers.categories import delete_category

        token = set_current_db_path(str(self.db_path))
        try:
            with self.assertRaises(HTTPException) as caught:
                delete_category(self._group_id(), None)
        finally:
            reset_current_db_path(token)
        self.assertEqual(caught.exception.status_code, 400)
        self.assertIn("cannot be deleted", caught.exception.detail)

    def test_the_group_cannot_be_moved_inside_another_group(self):
        from fastapi import HTTPException

        from backend.routers.categories import CategoryUpdate, update_category

        token = set_current_db_path(str(self.db_path))
        try:
            with get_db() as conn:
                other = conn.execute(
                    """SELECT id FROM category
                       WHERE parent_id IS NULL AND system_key IS NULL AND name != ? LIMIT 1""",
                    (TRANSFERS_GROUP,),
                ).fetchone()["id"]
            with self.assertRaises(HTTPException) as caught:
                update_category(self._group_id(), CategoryUpdate(parent_id=other))
        finally:
            reset_current_db_path(token)
        self.assertEqual(caught.exception.status_code, 400)

    def test_renaming_and_counting_it_toward_totals_stay_open(self):
        # The deliberate difference from Reimbursable: filing money movement is a convention, not
        # machinery, so seeing it in the totals is a view the user is entitled to.
        from backend.routers.categories import CategoryUpdate, update_category

        group_id = self._group_id()
        token = set_current_db_path(str(self.db_path))
        try:
            update_category(group_id, CategoryUpdate(exclude_from_totals=0))
            update_category(group_id, CategoryUpdate(name="Money moves"))
        finally:
            reset_current_db_path(token)
        with self._use_db() as conn:
            row = conn.execute(
                "SELECT name, exclude_from_totals FROM category WHERE system_key = ?",
                (TRANSFERS_SYSTEM_KEY,),
            ).fetchone()
            self.assertEqual(find_transfers_group_id(conn), group_id)
        self.assertEqual(row["exclude_from_totals"], 0)
        self.assertEqual(row["name"], "Money moves")


if __name__ == "__main__":
    unittest.main()
