"""
v88 turns the shared saved tag reports and saved filters into per-user preferences.

Each was one list every user saw. Every user of the ledger gets their own copy, so nobody loses a report,
and the shared copy goes so nothing reads a stale one. The users are the preference scopes present; the
reserved ledger scope is not a person and gets nothing. A user who already has the per-user list keeps it,
which is what makes restoring an old backup over this safe to replay.

Built like `test_migration_v80.py`: only what the migration reads, stamped at v87, taken through the chain.
Fabricated fixtures only.
"""

from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from backend.db import database

REPORTS = [{"id": "tr_1", "name": "Per person", "tagIds": ["t1", "t2"]}]
FILTERS = [{"id": "sf_1", "name": "Card this year", "date": None, "selections": [], "amount": None}]
OWN_REPORTS = [{"id": "tr_9", "name": "Mine", "tagIds": ["t3"]}]


class SharedViewsToUsersTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.conn = sqlite3.connect(str(Path(self.tmp.name) / "upgrade.db"))
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript("""
            CREATE TABLE import_workflow_state (key TEXT PRIMARY KEY, payload_json TEXT NOT NULL);
            CREATE TABLE ui_preference (
                scope_id TEXT NOT NULL, pref_key TEXT NOT NULL, pref_value TEXT NOT NULL, updated_at TEXT,
                PRIMARY KEY (scope_id, pref_key)
            );
            CREATE TABLE db_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            INSERT INTO db_meta (key, value) VALUES ('version', '87');
            INSERT INTO ui_preference (scope_id, pref_key, pref_value) VALUES
              ('user-a', 'ui.startupRoute', '"/"'),
              ('user-b', 'ui.dashboard.view', '"spending"'),
              ('__ledger__', 'currency', '"USD"');
        """)
        self.conn.execute("INSERT INTO import_workflow_state VALUES (?, ?)",
                          ("system_dashboard_tag_reports", json.dumps({"reports": REPORTS})))
        self.conn.execute("INSERT INTO import_workflow_state VALUES (?, ?)",
                          ("system_saved_filters", json.dumps({"filters": FILTERS})))
        self.conn.execute("INSERT INTO import_workflow_state VALUES (?, ?)",
                          ("system_category_workspace_draft", json.dumps({"draft": {}})))
        self.conn.commit()

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def _pref(self, scope, key):
        row = self.conn.execute(
            "SELECT pref_value FROM ui_preference WHERE scope_id = ? AND pref_key = ?", (scope, key)).fetchone()
        return json.loads(row[0]) if row else None

    def _state_keys(self):
        return {row[0] for row in self.conn.execute("SELECT key FROM import_workflow_state")}

    def test_every_user_gets_a_copy_and_the_shared_lists_go(self):
        database.run_migrations(self.conn)
        for user in ("user-a", "user-b"):
            self.assertEqual(self._pref(user, "ui.dashboard.tagReports"), REPORTS)
            self.assertEqual(self._pref(user, "ui.filterBar.savedFilters"), FILTERS)
        self.assertIsNone(self._pref("__ledger__", "ui.dashboard.tagReports"))
        self.assertEqual(self._state_keys(), {"system_category_workspace_draft"})

    def test_a_user_s_own_list_is_kept(self):
        self.conn.execute("INSERT INTO ui_preference (scope_id, pref_key, pref_value) VALUES (?, ?, ?)",
                          ("user-b", "ui.dashboard.tagReports", json.dumps(OWN_REPORTS)))
        database.run_post_restore_data_init(self.conn, 87)
        self.assertEqual(self._pref("user-a", "ui.dashboard.tagReports"), REPORTS)
        self.assertEqual(self._pref("user-b", "ui.dashboard.tagReports"), OWN_REPORTS)


if __name__ == "__main__":
    unittest.main()
