"""
v80 records on each Amazon card which Amazon account it imported into.

The import history groups a vendor's cards by account, and before this the account was nowhere on the
card — only on its rows. Backfilling from the rows is exact (every order in a drop lands in the one
chosen account), but a card may legitimately have none: an items-only card holds parked item detail and
creates no transactions. Those stay unattributed rather than guessed at, which is the claim worth
pinning — a wrong guess files one person's order history under another's account.

Built like `test_migration_v71.py`: only what the migration reads, stamped at v79, taken through the
chain. Fabricated fixtures only.
"""

from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from backend.db import database


class AmazonBatchAccountBackfillTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.conn = sqlite3.connect(str(Path(self.tmp.name) / "upgrade.db"))
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript("""
            CREATE TABLE import_batch (id TEXT PRIMARY KEY, source_kind TEXT, config_snapshot TEXT);
            CREATE TABLE txn (id TEXT PRIMARY KEY, account_id TEXT, import_batch_id TEXT);
            CREATE TABLE db_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            INSERT INTO db_meta (key, value) VALUES ('version', '79');
            INSERT INTO import_batch (id, source_kind, config_snapshot) VALUES
              ('orders-a',  'marketplace:amazon', '{"import_summary": {"orders_imported": 2}}'),
              ('orders-b',  'marketplace:amazon', '{"import_summary": {"orders_imported": 1}}'),
              -- An items-only card: parked detail, no rows, so nothing to read an account from.
              ('items-only','marketplace:amazon', '{"import_summary": {"items_discarded": 1}}'),
              -- No snapshot at all is the shape of the oldest cards.
              ('bare',      'marketplace:amazon', NULL),
              ('a-csv-file', NULL,                '{"header_fingerprint": "Date|Amount"}');
            INSERT INTO txn (id, account_id, import_batch_id) VALUES
              ('t1', 'acc-amazon-one', 'orders-a'),
              ('t2', 'acc-amazon-one', 'orders-a'),
              ('t3', 'acc-amazon-two', 'orders-b'),
              ('t4', 'acc-checking',   'a-csv-file');
        """)
        self.conn.commit()

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def _accounts(self) -> dict:
        out = {}
        for row in self.conn.execute("SELECT id, config_snapshot FROM import_batch"):
            snapshot = json.loads(row["config_snapshot"]) if row["config_snapshot"] else {}
            out[row["id"]] = snapshot.get("amazon_account_id")
        return out

    def test_each_card_takes_the_account_its_rows_are_in_and_a_card_with_none_is_left_alone(self):
        database.run_migrations(self.conn)
        self.assertEqual(self._accounts(), {
            "orders-a": "acc-amazon-one",
            "orders-b": "acc-amazon-two",
            "items-only": None,
            "bare": None,
            "a-csv-file": None,
        })

    def test_it_keeps_the_rest_of_a_card_s_snapshot(self):
        database.run_migrations(self.conn)
        snapshot = json.loads(self.conn.execute(
            "SELECT config_snapshot FROM import_batch WHERE id = 'orders-a'").fetchone()[0])
        self.assertEqual(snapshot["import_summary"], {"orders_imported": 2})

    def test_replaying_it_after_a_restore_changes_nothing(self):
        database.run_migrations(self.conn)
        before = self._accounts()
        database.run_post_restore_data_init(self.conn, 79)
        self.assertEqual(self._accounts(), before)


if __name__ == "__main__":
    unittest.main()
