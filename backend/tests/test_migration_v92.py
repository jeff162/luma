"""
v92 widens the PayPal pairing to every wallet account.

Each wallet gets the match text its bank and card rows are found by: PayPal's for a PayPal account, the
account's own name for a payment app. The pairing's stored links, its saved review layout and its Tasks
dismissal move to the wallet names, since a link left under an old kind would stop being read and the
exclusion it applied would have nothing behind it. Replaying the step over a restored backup must give the
same result.

Built like `test_migration_v88.py`: only what the migration reads, stamped at v91, taken through the chain.
Fabricated fixtures only.
"""

from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from backend.db import database


class WalletPairAdoptionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.conn = sqlite3.connect(str(Path(self.tmp.name) / "upgrade.db"))
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript("""
            CREATE TABLE account (id TEXT PRIMARY KEY, name TEXT NOT NULL, institution TEXT, type TEXT);
            CREATE TABLE txn_link (id TEXT PRIMARY KEY, kind TEXT NOT NULL, metadata_json TEXT);
            CREATE TABLE txn_link_member (link_id TEXT NOT NULL, txn_id TEXT NOT NULL, role TEXT);
            CREATE TABLE ui_preference (
                scope_id TEXT NOT NULL, pref_key TEXT NOT NULL, pref_value TEXT NOT NULL, updated_at TEXT,
                PRIMARY KEY (scope_id, pref_key)
            );
            CREATE TABLE db_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            INSERT INTO db_meta (key, value) VALUES ('version', '91'), ('paypal_funding_cards', '{}');
            INSERT INTO account (id, name, institution, type) VALUES
              ('pp', 'Household PayPal', 'PayPal', 'paypal'),
              ('app', 'Pocketpay', 'Pocketpay - Personal', 'p2p'),
              ('chk', 'Riverstone Checking', 'Riverstone', 'depository');
            INSERT INTO txn_link (id, kind) VALUES
              ('pair', 'paypal_funding'), ('no', 'paypal_funding_declined'), ('ok', 'paypal_funding_reviewed'),
              ('order', 'amazon_order');
            INSERT INTO txn_link_member (link_id, txn_id, role) VALUES
              ('pair', 't1', 'paypal'), ('pair', 't2', 'counterpart'),
              ('no', 't1', 'paypal'), ('no', 't3', 'counterpart'),
              ('ok', 't4', 'row'),
              ('order', 't5', 'order');
            INSERT INTO ui_preference (scope_id, pref_key, pref_value) VALUES
              ('user-a', 'ui.import.paypalFunding.columns', '["date"]'),
              ('user-a', 'ui.tasks.dismissed', '{"paypal_funding": 3, "backup_due:1": 1}'),
              ('user-a', 'ui.tasks.muted', '["paypal_funding"]');
        """)
        self.conn.commit()

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def _pref(self, key):
        row = self.conn.execute(
            "SELECT pref_value FROM ui_preference WHERE scope_id = 'user-a' AND pref_key = ?", (key,)).fetchone()
        return json.loads(row[0]) if row else None

    def _check_adopted(self):
        texts = {r["id"]: r["wallet_match_text"] for r in self.conn.execute("SELECT id, wallet_match_text FROM account")}
        self.assertEqual(texts, {"pp": "PayPal", "app": "Pocketpay", "chk": None})
        kinds = {r["id"]: r["kind"] for r in self.conn.execute("SELECT id, kind FROM txn_link")}
        self.assertEqual(kinds, {"pair": "wallet_pair", "no": "wallet_pair_declined", "ok": "wallet_pair_reviewed",
                                 "order": "amazon_order"})
        roles = {(r["link_id"], r["role"]) for r in self.conn.execute("SELECT link_id, role FROM txn_link_member")}
        self.assertEqual(roles, {("pair", "wallet"), ("pair", "counterpart"), ("no", "wallet"), ("no", "counterpart"),
                                 ("ok", "row"), ("order", "order")})
        self.assertEqual(self._pref("ui.import.walletPairs.columns"), ["date"])
        self.assertIsNone(self._pref("ui.import.paypalFunding.columns"))
        self.assertEqual(self._pref("ui.tasks.dismissed"), {"wallet_pairs": 3, "backup_due:1": 1})
        self.assertEqual(self._pref("ui.tasks.muted"), ["wallet_pairs"])
        self.assertIsNone(self.conn.execute("SELECT 1 FROM db_meta WHERE key = 'paypal_funding_cards'").fetchone())

    def test_the_pairing_comes_across_under_the_wallet_names(self):
        database.run_migrations(self.conn)
        self._check_adopted()

    def test_replaying_over_a_restored_backup_gives_the_same_result(self):
        database.run_migrations(self.conn)
        database.run_post_restore_data_init(self.conn, 91)
        self._check_adopted()

    def test_text_the_user_set_is_kept(self):
        self.conn.execute("ALTER TABLE account ADD COLUMN wallet_match_text TEXT")
        self.conn.execute("UPDATE account SET wallet_match_text = '' WHERE id = 'app'")
        database.run_post_restore_data_init(self.conn, 91)
        self.assertEqual(self.conn.execute("SELECT wallet_match_text FROM account WHERE id = 'app'").fetchone()[0], "")


if __name__ == "__main__":
    unittest.main()
