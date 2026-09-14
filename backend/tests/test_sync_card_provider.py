"""
A synced row keeps naming its connection after the connection is removed.

The origin hover's "Connection" line used to be read through `import_batch.connection_id`, which removing
the connection nulls, so the line vanished from every row that connection had synced. The provider is now
written onto the card when the card is created. Driven through the transactions endpoint, because the
contract that matters is what the hover receives, not what the column holds.
"""

from __future__ import annotations

import sqlite3
import unittest
from datetime import date

from backend.db.database import SHARED_OWNER_ID
from backend.routers.sync import resolve_initial_sync_batch, resolve_sync_period_batch
from backend.tests._api_client import api_client


def _connect(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


class SyncCardProviderTests(unittest.TestCase):
    def _seed(self, path):
        conn = _connect(path)
        conn.execute(
            "INSERT INTO connection (id, provider, external_id, institution) "
            "VALUES ('c1', 'plaid', 'item-1', 'Northgate')"
        )
        conn.execute(
            "INSERT INTO account (id, external_account_id, connection_id, provider, name, display_name, type, owner_id) "
            "VALUES ('a1', 'ext-1', 'c1', 'plaid', 'Card', 'Card', 'credit', ?)",
            (SHARED_OWNER_ID,),
        )
        connection = conn.execute("SELECT * FROM connection WHERE id = 'c1'").fetchone()
        initial = resolve_initial_sync_batch(conn, connection)
        period = resolve_sync_period_batch(conn, connection, date(2026, 5, 15))
        for txn_id, batch_id in (("t-initial", initial), ("t-period", period)):
            conn.execute(
                "INSERT INTO txn (id, account_id, amount, date, merchant_name, raw_name, import_batch_id, owner_id) "
                "VALUES (?, 'a1', 20.0, '2026-05-15', 'Store', 'STORE', ?, ?)",
                (txn_id, batch_id, SHARED_OWNER_ID),
            )
        conn.commit()
        conn.close()
        return initial, period

    def _origin(self, client, txn_id):
        rows = {r["id"]: r for r in client.get("/api/transactions").json()["transactions"]}
        row = rows[txn_id]
        return row["import_batch_provider"], row["import_batch_connection_removed"]

    def test_both_kinds_of_card_record_the_provider(self):
        with api_client() as (_client, path):
            initial, period = self._seed(path)
            conn = _connect(path)
            providers = {r["id"]: r["provider"] for r in conn.execute("SELECT id, provider FROM import_batch")}
            conn.close()
        self.assertEqual(providers[initial], "plaid")
        self.assertEqual(providers[period], "plaid")

    def test_the_connection_line_survives_removing_the_connection(self):
        with api_client() as (client, path):
            self._seed(path)
            self.assertEqual(self._origin(client, "t-initial"), ("plaid", 0))

            conn = _connect(path)
            conn.execute("DELETE FROM connection WHERE id = 'c1'")
            conn.commit()
            conn.close()

            self.assertEqual(self._origin(client, "t-initial"), ("plaid", 1))
            self.assertEqual(self._origin(client, "t-period"), ("plaid", 1))


if __name__ == "__main__":
    unittest.main()
