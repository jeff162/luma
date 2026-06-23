"""Regression coverage for owner deletion.

Deleting a personal owner must (a) unassign that owner's own accounts/transactions through the
ON DELETE SET NULL foreign keys, and (b) when the household collapses back to a single personal
owner, clear the now-meaningless "Shared" assignments. The collapse branch referenced a
`category.owner_id` column that the schema no longer defines and raised
`sqlite3.OperationalError: no such column: owner_id`, turning a routine delete into a 500. This
exercises that exact branch so the dead reference can't come back.
"""

from __future__ import annotations

import tempfile
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path

from backend.db.database import (
    SHARED_OWNER_ID,
    get_db,
    init_db,
    reset_current_db_path,
    set_current_db_path,
)
from backend.routers.owners import delete_owner


class DeleteOwnerTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tempdir.name) / "owners.db"
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

    def _insert_owner(self, name):
        owner_id = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute("INSERT INTO owner (id, name, color) VALUES (?, ?, '#6366f1')", (owner_id, name))
        return owner_id

    def _insert_account(self, owner_id):
        account_id = str(uuid.uuid4())
        with self._use_db_path(), get_db() as conn:
            conn.execute(
                """
                INSERT INTO account
                  (id, plaid_account_id, plaid_item_id, name, display_name, type, subtype,
                   mask, owner_id, parent_account_id, trashed_at)
                VALUES (?, ?, 'fixture', 'Acct', 'Acct', 'credit', 'credit_card', NULL, ?, NULL, NULL)
                """,
                (account_id, f"plaid_{account_id}", owner_id),
            )
        return account_id

    def _account_owner(self, account_id):
        with self._use_db_path(), get_db() as conn:
            return conn.execute("SELECT owner_id FROM account WHERE id = ?", (account_id,)).fetchone()["owner_id"]

    def test_delete_owner_unassigns_accounts_and_collapses_shared(self):
        alice = self._insert_owner("Alice")
        bob = self._insert_owner("Bob")
        alice_account = self._insert_account(alice)
        shared_account = self._insert_account(SHARED_OWNER_ID)

        # Deleting Alice leaves a single personal owner (Bob), which triggers the "Shared" collapse —
        # the branch whose stale category.owner_id UPDATE 500-ed the delete.
        with self._use_db_path():
            result = delete_owner(alice)
        self.assertEqual(result, {"ok": True})

        # Alice's account is unassigned by the FK cascade; the shared account by the collapse branch.
        self.assertIsNone(self._account_owner(alice_account))
        self.assertIsNone(self._account_owner(shared_account))

        with self._use_db_path(), get_db() as conn:
            self.assertIsNone(conn.execute("SELECT id FROM owner WHERE id = ?", (alice,)).fetchone())
            self.assertIsNotNone(conn.execute("SELECT id FROM owner WHERE id = ?", (bob,)).fetchone())


if __name__ == "__main__":
    unittest.main()
