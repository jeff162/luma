"""
v101 renames the two account settings behind the Balances view, `exclude_from_net_worth` and
`net_worth_from`, to `exclude_from_balance_totals` and `balance_totals_from`, and a saved Dashboard view of
`net_worth` to `balances`. The settings are the user's choices, so each must arrive with its value; a view
left under the old value would name a view the Dashboard does not have. Replaying the preference step over a
restored backup must give the same result.

Built like `test_migration_v92.py`: only what the migration reads, stamped at v100, taken through the chain.
"""

from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path

from backend.db import database


class BalanceTotalSettingsRenameTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.conn = sqlite3.connect(str(Path(self.tmp.name) / "upgrade.db"))
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript("""
            CREATE TABLE account (
                id TEXT PRIMARY KEY, name TEXT NOT NULL,
                exclude_from_net_worth INTEGER NOT NULL DEFAULT 0, net_worth_from TEXT
            );
            CREATE TABLE ui_preference (
                scope_id TEXT NOT NULL, pref_key TEXT NOT NULL, pref_value TEXT NOT NULL, updated_at TEXT,
                PRIMARY KEY (scope_id, pref_key)
            );
            CREATE TABLE db_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            INSERT INTO db_meta (key, value) VALUES ('version', '100');
            INSERT INTO account (id, name, exclude_from_net_worth, net_worth_from) VALUES
              ('card', 'Rewards Card', 1, NULL),
              ('chk', 'Checking', 0, '2026-04-01');
            INSERT INTO ui_preference (scope_id, pref_key, pref_value) VALUES
              ('user-a', 'ui.dashboard.view', '"net_worth"'),
              ('user-b', 'ui.dashboard.view', '"income"');
        """)
        self.conn.commit()

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def _upgrade(self):
        database.run_migrations(self.conn)
        self.conn.commit()

    def _views(self):
        return dict(self.conn.execute(
            "SELECT scope_id, pref_value FROM ui_preference WHERE pref_key = 'ui.dashboard.view'").fetchall())

    def test_the_settings_arrive_under_the_new_names_with_their_values(self):
        self._upgrade()
        rows = {r["id"]: tuple(r)[1:] for r in self.conn.execute(
            "SELECT id, exclude_from_balance_totals, balance_totals_from FROM account")}
        self.assertEqual(rows, {"card": (1, None), "chk": (0, "2026-04-01")})
        columns = {r["name"] for r in self.conn.execute("PRAGMA table_info(account)")}
        self.assertFalse({"exclude_from_net_worth", "net_worth_from"} & columns)
        self.assertEqual(database.get_db_version(self.conn), database.CURRENT_VERSION)

    def test_a_saved_net_worth_view_becomes_balances_and_no_other_is_touched(self):
        self._upgrade()
        self.assertEqual(self._views(), {"user-a": '"balances"', "user-b": '"income"'})

    def test_replaying_over_a_restored_backup_gives_the_same_result(self):
        self._upgrade()
        self.conn.execute("UPDATE ui_preference SET pref_value = '\"net_worth\"' WHERE scope_id = 'user-a'")
        database.run_post_restore_data_init(self.conn, 100)
        self.assertEqual(self._views(), {"user-a": '"balances"', "user-b": '"income"'})


if __name__ == "__main__":
    unittest.main()
