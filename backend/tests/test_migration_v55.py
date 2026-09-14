"""
Migration v55 — a sync card records its connection's provider itself.

Before v55 a card named its provider only through `connection_id`, which removing the connection nulls, so
every row that connection had synced lost its "Connection" line. v55 adds `import_batch.provider` and copies
it from the connection wherever the connection still exists. A card whose connection is already gone has
nothing to copy from and stays NULL, and so does a CSV card. The copy is also a data-init step, because a
restored older backup brings back cards without the column filled.
"""

from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path

from backend.db import database


class MigrationV55Tests(unittest.TestCase):
    """A database stamped at 54, holding a live connection's card, an orphaned card, and a CSV card."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.conn = sqlite3.connect(str(Path(self.tmp.name) / "v54.db"))
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript("""
            CREATE TABLE connection (id TEXT PRIMARY KEY, provider TEXT NOT NULL, institution TEXT);
            CREATE TABLE import_batch (
                id TEXT PRIMARY KEY, filename TEXT NOT NULL, source_kind TEXT,
                connection_id TEXT REFERENCES connection(id) ON DELETE SET NULL
            );
            CREATE TABLE db_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            INSERT INTO db_meta (key, value) VALUES ('version', '54');
            INSERT INTO connection (id, provider, institution) VALUES ('c1', 'simplefin', 'Northgate');
            INSERT INTO import_batch (id, filename, source_kind, connection_id) VALUES
                ('live',     'Northgate · Initial import',  'connection_sync', 'c1'),
                ('orphaned', 'Riverstone · Initial import', 'connection_sync', NULL),
                ('csv',      'export.csv',                  NULL,              NULL);
        """)
        self.conn.commit()

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def _provider(self, batch_id):
        return self.conn.execute(
            "SELECT provider FROM import_batch WHERE id = ?", (batch_id,)
        ).fetchone()["provider"]

    def test_cards_of_a_present_connection_take_its_provider(self):
        database.run_migrations(self.conn)
        self.conn.commit()

        self.assertEqual(self._provider("live"), "simplefin")
        self.assertIsNone(self._provider("orphaned"))
        self.assertIsNone(self._provider("csv"))
        self.assertEqual(database.get_db_version(self.conn), database.CURRENT_VERSION)

    def test_a_restore_of_an_older_backup_fills_them_again(self):
        database.run_migrations(self.conn)
        # The restored cards arrive without the column filled, so the step has to run after a restore too.
        self.conn.execute("UPDATE import_batch SET provider = NULL")
        database.run_post_restore_data_init(self.conn, 54)
        self.assertEqual(self._provider("live"), "simplefin")
        self.assertIsNone(self._provider("csv"))


if __name__ == "__main__":
    unittest.main()
