# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
v64 releases whatever was left in the retired account trash.

The account trash is gone — its endpoints, its Settings view, and the rung that put accounts there.
A row still carrying `trashed_at` would therefore be unreachable forever while its transactions stayed
live in the ledger, which is the one outcome retiring a feature must not produce. The rows come back
instead, as the merged children they were, for the user to remove deliberately or leave alone.

All data here is fabricated.
"""

from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path

from backend.db.database import _restore_trashed_accounts, run_post_restore_data_init


class MigrationV64Tests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.conn = sqlite3.connect(str(Path(self.tmp.name) / "v63.db"))
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript("""
            CREATE TABLE account (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, display_name TEXT,
                parent_account_id TEXT, trashed_at TEXT
            );
            INSERT INTO account (id, name, display_name, parent_account_id, trashed_at) VALUES
                ('parent',  'Harborline Rewards', 'Harborline Rewards', NULL,     NULL),
                ('hidden',  'Harborline Rewards', 'Harborline Rewards', 'parent', '2026-02-11T09:00:00Z'),
                ('visible', 'Riverstone Checking', 'Riverstone Checking', NULL,   NULL);
        """)

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def _account(self, account_id):
        return self.conn.execute("SELECT * FROM account WHERE id = ?", (account_id,)).fetchone()

    def test_a_hidden_child_comes_back_as_the_merged_child_it_was(self):
        _restore_trashed_accounts(self.conn)

        hidden = self._account("hidden")
        self.assertIsNone(hidden["trashed_at"])
        self.assertEqual(hidden["parent_account_id"], "parent")
        self.assertEqual(hidden["display_name"], "Harborline Rewards")

    def test_nothing_else_moves(self):
        _restore_trashed_accounts(self.conn)

        self.assertIsNone(self._account("visible")["parent_account_id"])
        self.assertEqual(
            self.conn.execute("SELECT COUNT(*) n FROM account").fetchone()["n"], 3,
            "releasing the trash must not remove a row",
        )

    def test_running_it_again_changes_nothing(self):
        _restore_trashed_accounts(self.conn)
        before = [dict(r) for r in self.conn.execute("SELECT * FROM account ORDER BY id")]

        _restore_trashed_accounts(self.conn)

        self.assertEqual([dict(r) for r in self.conn.execute("SELECT * FROM account ORDER BY id")], before)

    def test_a_schema_without_the_column_is_left_alone(self):
        # The per-migration tests hand-build a minimal schema and run the whole chain over it, so a
        # step that assumes the full schema fails there rather than anywhere a real database reaches.
        self.conn.executescript("DROP TABLE account; CREATE TABLE account (id TEXT PRIMARY KEY);")

        _restore_trashed_accounts(self.conn)  # must not raise

    def test_restoring_a_pre_retirement_backup_releases_its_trashed_rows(self):
        # A backup taken before the retirement carries `trashed_at` set, and restore loads it straight
        # into the current schema — so the release has to run again on the way back in.
        run_post_restore_data_init(self.conn, 63)

        self.assertIsNone(self._account("hidden")["trashed_at"])


if __name__ == "__main__":
    unittest.main()
