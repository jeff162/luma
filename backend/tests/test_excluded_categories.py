"""
The shared excluded-transfers-leaf helper (`services/excluded_categories.py`).

Both the Amazon importer and wallet money-movement suppression put a row into an excluded leaf under the
seeded `Transfers` group. The invariant this guards: a transaction may only be assigned to a *leaf*, never
a group. `Transfers` is a normal (deletable) group, so the helper must recreate it when missing rather
than degrade to a parentless (group-shaped) leaf a transaction couldn't legitimately be assigned to.
"""

from __future__ import annotations

import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path

from backend.db.database import get_db, init_db, reset_current_db_path, set_current_db_path
from backend.services.excluded_categories import TRANSFERS_GROUP, ensure_excluded_transfers_leaf


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


if __name__ == "__main__":
    unittest.main()
