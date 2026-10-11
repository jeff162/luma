"""
v71 moves Plaid's stored transaction ids under the `plaid:` prefix its adapter now writes.

The column is every synced row's idempotency key, looked up unscoped by every sync, so a row the migration
misses reads as new to the next sync and is added a second time, and a row it relabels wrongly is orphaned
the same way. Built like `test_migrations_after_v25.py`: only what the migration reads, stamped at v70,
taken through the chain.
"""

from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from backend.db import database


class PlaidTransactionIdNamespaceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.conn = sqlite3.connect(str(Path(self.tmp.name) / "upgrade.db"))
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript("""
            CREATE TABLE import_batch (id TEXT PRIMARY KEY, provider TEXT);
            CREATE TABLE txn (id TEXT PRIMARY KEY, external_transaction_id TEXT UNIQUE, import_batch_id TEXT);
            CREATE TABLE import_batch_duplicate (batch_id TEXT, row_number INTEGER, txn_payload_json TEXT);
            CREATE TABLE db_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            INSERT INTO db_meta (key, value) VALUES ('version', '70');
            INSERT INTO import_batch (id, provider) VALUES
              ('card-plaid', 'plaid'), ('card-gone', NULL), ('card-simplefin', 'simplefin');
            INSERT INTO txn (id, external_transaction_id, import_batch_id) VALUES
              ('plaid-row', 'lPNjeW1nR6CDn5okmGQ6hEpMo4lLNoSrzqDje', 'card-plaid'),
              -- A card whose connection was removed names no provider; a bare id there is still Plaid's.
              ('orphan-row', 'Zq7TmW2pLx9VbN4cR8dKs1HyGf3JuE6oAi5Ye', 'card-gone'),
              ('simplefin-row', 'simplefin:ACT-1:TRN-9', 'card-simplefin'),
              -- The one early build that stored SimpleFIN ids bare: its card says whose they are.
              ('early-simplefin-row', 'TRN-7', 'card-simplefin'),
              ('already', 'plaid:abc', 'card-plaid'),
              ('file-row', NULL, NULL);
        """)
        self.conn.execute(
            "INSERT INTO import_batch_duplicate VALUES ('card-plaid', 3, ?), ('card-plaid', 4, ?)",
            (json.dumps({"external_transaction_id": "held-1", "amount": 5}), json.dumps({"amount": 6})),
        )
        self.conn.commit()

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def _ids(self) -> dict:
        return {r["id"]: r["external_transaction_id"] for r in self.conn.execute("SELECT * FROM txn")}

    def test_every_bare_plaid_id_takes_the_prefix_and_nothing_else_moves(self):
        database.run_migrations(self.conn)
        self.assertEqual(self._ids(), {
            "plaid-row": "plaid:lPNjeW1nR6CDn5okmGQ6hEpMo4lLNoSrzqDje",
            "orphan-row": "plaid:Zq7TmW2pLx9VbN4cR8dKs1HyGf3JuE6oAi5Ye",
            "simplefin-row": "simplefin:ACT-1:TRN-9",
            "early-simplefin-row": "TRN-7",
            "already": "plaid:abc",
            "file-row": None,
        })
        payloads = [json.loads(r[0]) for r in self.conn.execute(
            "SELECT txn_payload_json FROM import_batch_duplicate ORDER BY row_number")]
        self.assertEqual(payloads, [{"external_transaction_id": "plaid:held-1", "amount": 5}, {"amount": 6}])

    def test_replaying_it_after_a_restore_does_not_prefix_twice(self):
        database.run_migrations(self.conn)
        before = self._ids()
        database.run_post_restore_data_init(self.conn, 70)
        self.assertEqual(self._ids(), before)


if __name__ == "__main__":
    unittest.main()
