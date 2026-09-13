"""
Migration v54 — a trusted import's category is no longer locked against the rules.

Before v54 a row that took its file's category carried `category_overridden = 1`, the manual lock, so
Run categorization never let a later rule reach it. Writers now store `import` unlocked; v54 clears the
bit on the rows written before that, and is registered as a data-init step because restoring an older
backup brings the old bit back. It must touch nothing but `import` rows — a manual edit, a split, and a
legacy locked row with no source recorded all keep their lock.
"""

from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path

from backend.db import database


class MigrationV54Tests(unittest.TestCase):
    """A database stamped at 53, holding locked trusted-import rows beside rows that must stay locked."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.conn = sqlite3.connect(str(Path(self.tmp.name) / "v53.db"))
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript("""
            CREATE TABLE txn (
                id TEXT PRIMARY KEY, category_source TEXT,
                category_overridden INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE db_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            INSERT INTO db_meta (key, value) VALUES ('version', '53');
            INSERT INTO txn (id, category_source, category_overridden) VALUES
                ('imported', 'import', 1),
                ('manual',   'manual', 1),
                ('split',    'split',  1),
                ('legacy',   NULL,     1),
                ('ruled',    'rule',   0);
        """)
        self.conn.commit()

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def _lock(self, txn_id):
        return self.conn.execute(
            "SELECT category_overridden FROM txn WHERE id = ?", (txn_id,)
        ).fetchone()["category_overridden"]

    def test_only_trusted_import_rows_are_unlocked(self):
        database.run_migrations(self.conn)
        self.conn.commit()

        self.assertEqual(self._lock("imported"), 0)
        for still_locked in ("manual", "split", "legacy"):
            self.assertEqual(self._lock(still_locked), 1, still_locked)
        self.assertEqual(self._lock("ruled"), 0)
        self.assertEqual(database.get_db_version(self.conn), database.CURRENT_VERSION)

    def test_a_restore_of_an_older_backup_unlocks_them_again(self):
        # The restored rows carry the pre-v54 bit, so the step has to run after a restore too.
        database.run_post_restore_data_init(self.conn, 53)
        self.assertEqual(self._lock("imported"), 0)
        self.assertEqual(self._lock("manual"), 1)


if __name__ == "__main__":
    unittest.main()
