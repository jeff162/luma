"""
Migration v60 — the sync log becomes the log of every data-connection operation.

Two of those operations cannot live under the foreign key v56 added: a connect that fails has no connection
to reference, and a disconnect keeps its own row after its connection is deleted. v60 rebuilds the table
with `connection_id` nullable and unreferenced, and adds `event`/`detail`. Every row that already exists is a
sync, and must arrive as one with its values intact.
"""

from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path

from backend.db import database


class MigrationV60Tests(unittest.TestCase):
    """A database stamped at 59, whose log is in v56's shape and holds one sync row."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.conn = sqlite3.connect(str(Path(self.tmp.name) / "v59.db"))
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript("""
            CREATE TABLE connection (id TEXT PRIMARY KEY, provider TEXT NOT NULL, institution TEXT);
            CREATE TABLE connection_sync_log (
                id            TEXT PRIMARY KEY,
                connection_id TEXT NOT NULL REFERENCES connection(id) ON DELETE CASCADE,
                provider      TEXT,
                institution   TEXT,
                started_at    TEXT NOT NULL,
                added         INTEGER NOT NULL DEFAULT 0,
                error         TEXT
            );
            CREATE INDEX idx_connection_sync_log_started ON connection_sync_log(started_at);
            CREATE TABLE db_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            INSERT INTO db_meta (key, value) VALUES ('version', '59');
            INSERT INTO connection (id, provider, institution) VALUES ('c1', 'simplefin', 'Northgate');
            INSERT INTO connection_sync_log (id, connection_id, provider, institution, started_at, added, error)
            VALUES ('s1', 'c1', 'simplefin', 'Northgate', '2026-09-01T10:00:00Z', 4, NULL);
        """)
        self.conn.commit()

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def _upgrade(self):
        database.run_migrations(self.conn)
        self.conn.commit()

    def test_an_existing_row_arrives_as_a_sync_with_its_values(self):
        self._upgrade()
        row = self.conn.execute("SELECT * FROM connection_sync_log WHERE id = 's1'").fetchone()
        self.assertEqual(
            (row["event"], row["connection_id"], row["institution"], row["started_at"], row["added"], row["detail"]),
            ("sync", "c1", "Northgate", "2026-09-01T10:00:00Z", 4, None),
        )
        self.assertEqual(database.get_db_version(self.conn), database.CURRENT_VERSION)

    def test_a_row_can_outlive_its_connection_and_exist_without_one(self):
        self._upgrade()
        self.assertEqual(self.conn.execute("PRAGMA foreign_key_list(connection_sync_log)").fetchall(), [])
        self.conn.execute("PRAGMA foreign_keys = ON")
        self.conn.execute("DELETE FROM connection WHERE id = 'c1'")
        self.conn.execute(
            "INSERT INTO connection_sync_log (id, connection_id, provider, event, started_at) "
            "VALUES ('failed-connect', NULL, 'plaid', 'connect', '2026-09-02T10:00:00Z')"
        )
        ids = [r["id"] for r in self.conn.execute("SELECT id FROM connection_sync_log ORDER BY id")]
        self.assertEqual(ids, ["failed-connect", "s1"])
        self.assertIsNotNone(self.conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_connection_sync_log_started'"
        ).fetchone())

    def test_running_it_again_changes_nothing(self):
        self._upgrade()
        database.MIGRATIONS[60](self.conn)
        self.assertEqual([r["id"] for r in self.conn.execute("SELECT id FROM connection_sync_log")], ["s1"])


if __name__ == "__main__":
    unittest.main()
