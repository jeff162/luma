"""
v94 moves the display name from each provider account to the connection: `connection_account.nickname` is
dropped, with the names it held, and `connection.nickname` is added empty. The rest of a mapping row is
untouched. Built like `test_migration_v92.py`: only what the migration reads, stamped at v93.
"""

from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path

from backend.db import database


class NicknameMoveTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.conn = sqlite3.connect(str(Path(self.tmp.name) / "upgrade.db"))
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript("""
            CREATE TABLE connection (id TEXT PRIMARY KEY, provider TEXT NOT NULL, institution TEXT);
            CREATE TABLE connection_account (
                connection_id TEXT NOT NULL, external_account_id TEXT NOT NULL, provider_name TEXT,
                nickname TEXT, PRIMARY KEY (connection_id, external_account_id)
            );
            CREATE TABLE db_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            INSERT INTO db_meta (key, value) VALUES ('version', '93');
            INSERT INTO connection (id, provider, institution) VALUES ('c1', 'plaid', 'Northgate');
            INSERT INTO connection_account (connection_id, external_account_id, provider_name, nickname)
                VALUES ('c1', 'ext-1', 'CHECKING', 'Bills');
        """)
        self.conn.commit()

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def test_the_name_moves_to_the_connection_and_the_mapping_row_is_kept(self):
        database.run_migrations(self.conn)
        account_columns = {r["name"] for r in self.conn.execute("PRAGMA table_info(connection_account)")}
        self.assertNotIn("nickname", account_columns)
        self.assertEqual(
            dict(self.conn.execute("SELECT external_account_id, provider_name FROM connection_account").fetchone()),
            {"external_account_id": "ext-1", "provider_name": "CHECKING"},
        )
        self.assertIsNone(self.conn.execute("SELECT nickname FROM connection WHERE id = 'c1'").fetchone()[0])


if __name__ == "__main__":
    unittest.main()
