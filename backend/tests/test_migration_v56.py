"""
Migration v56 — a connection's sync log rows are deleted with the connection.

Before v56 `connection_sync_log.connection_id` was `ON DELETE SET NULL`, so a disconnect left the rows
behind with no id. Every disconnected connection's rows then shared one id-less group, which the log offered
as a single filter pill that could not filter. v56 rebuilds the table with `NOT NULL … ON DELETE CASCADE`,
and the rebuild copies only rows whose connection still exists — dropping the ones the old rule stranded,
including any whose id points at a connection that is gone without having been nulled.
"""

from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path

from backend.db import database


class MigrationV56Tests(unittest.TestCase):
    """A database stamped at 55, holding a live connection's row, a nulled row, and a dangling one."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.conn = sqlite3.connect(str(Path(self.tmp.name) / "v55.db"))
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript("""
            CREATE TABLE connection (id TEXT PRIMARY KEY, provider TEXT NOT NULL, institution TEXT);
            CREATE TABLE connection_sync_log (
                id            TEXT PRIMARY KEY,
                connection_id TEXT REFERENCES connection(id) ON DELETE SET NULL,
                provider      TEXT,
                institution   TEXT,
                started_at    TEXT NOT NULL,
                added         INTEGER NOT NULL DEFAULT 0,
                warnings      TEXT
            );
            CREATE INDEX idx_connection_sync_log_started ON connection_sync_log(started_at);
            CREATE TABLE db_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            INSERT INTO db_meta (key, value) VALUES ('version', '55');
            INSERT INTO connection (id, provider, institution) VALUES ('c1', 'simplefin', 'Northgate');
            INSERT INTO connection_sync_log (id, connection_id, provider, institution, started_at, added, warnings)
            VALUES
                ('live',     'c1',   'simplefin', 'Northgate',  '2026-09-01T10:00:00Z', 4, '["a warning"]'),
                ('nulled',   NULL,   'plaid',     'Riverstone', '2026-08-09T01:10:12Z', 0, NULL),
                ('dangling', 'gone', 'simplefin', 'Harborline', '2026-08-09T00:28:16Z', 2, NULL);
        """)
        self.conn.commit()

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def _upgrade(self):
        database.run_migrations(self.conn)
        self.conn.commit()

    def _row_ids(self):
        return [r["id"] for r in self.conn.execute("SELECT id FROM connection_sync_log ORDER BY id")]

    def test_only_rows_of_a_present_connection_survive_with_their_values(self):
        self._upgrade()

        self.assertEqual(self._row_ids(), ["live"])
        row = self.conn.execute("SELECT * FROM connection_sync_log WHERE id = 'live'").fetchone()
        self.assertEqual(
            (row["connection_id"], row["institution"], row["started_at"], row["added"], row["warnings"]),
            ("c1", "Northgate", "2026-09-01T10:00:00Z", 4, '["a warning"]'),
        )
        # A column the old shape lacked arrives with its default rather than failing the copy.
        self.assertEqual(row["pages"], 0)
        self.assertEqual(database.get_db_version(self.conn), database.CURRENT_VERSION)

    def test_the_rebuilt_table_cascades_and_keeps_its_index(self):
        self._upgrade()

        fks = self.conn.execute("PRAGMA foreign_key_list(connection_sync_log)").fetchall()
        self.assertEqual([(fk["from"], fk["table"], fk["on_delete"]) for fk in fks],
                         [("connection_id", "connection", "CASCADE")])
        not_null = {r["name"]: r["notnull"] for r in self.conn.execute("PRAGMA table_info(connection_sync_log)")}
        self.assertEqual(not_null["connection_id"], 1)
        self.assertIsNotNone(self.conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_connection_sync_log_started'"
        ).fetchone())

        # The point of it: removing the connection now takes its rows along.
        self.conn.execute("PRAGMA foreign_keys = ON")
        self.conn.execute("DELETE FROM connection WHERE id = 'c1'")
        self.assertEqual(self._row_ids(), [])

    def test_running_it_again_changes_nothing(self):
        self._upgrade()
        database.MIGRATIONS[56](self.conn)
        self.assertEqual(self._row_ids(), ["live"])


if __name__ == "__main__":
    unittest.main()
