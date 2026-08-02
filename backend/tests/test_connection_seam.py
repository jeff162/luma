"""
Provider-agnostic connection seam (phase 6a): the plaid_item -> connection cutover.

Pins the three edges of the seam that must hold before Teller/SimpleFIN can plug in:
  1. the migration backfill folds legacy plaid_item rows into provider='plaid' connections (idempotently);
  2. the adapter registry resolves a provider and normalizes its SDK dicts to provider-neutral keys;
  3. the credentials backup exports/restores connections (new shape) and still accepts the legacy
     plaid_items shape — all round-tripping the vault-encrypted credential.
"""

from __future__ import annotations

import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest import mock

from backend.db import control_database as cdb
from backend.db import database
from backend.routers.import_export.backup import _load_json_or_zip_payload
from backend.services import crypto_service as cs
from backend.services.providers import PlaidAdapter, UnknownProviderError, get_adapter
from backend.tests._api_client import api_client


@contextmanager
def _isolated_stack():
    tmp = tempfile.TemporaryDirectory()
    data_path = str(Path(tmp.name) / "data.db")
    control_path = str(Path(tmp.name) / "control.db")
    tenant_root = Path(tmp.name) / "tenants"
    originals = (database.DB_PATH, cdb.DB_PATH, cdb.CONTROL_DB_PATH, cdb.TENANT_DATA_ROOT)
    database.DB_PATH = data_path
    cdb.DB_PATH = data_path
    cdb.CONTROL_DB_PATH = control_path
    cdb.TENANT_DATA_ROOT = tenant_root
    database.init_db(data_path)
    cdb.init_control_db()
    try:
        yield data_path
    finally:
        database.DB_PATH, cdb.DB_PATH, cdb.CONTROL_DB_PATH, cdb.TENANT_DATA_ROOT = originals
        tmp.cleanup()


class ConnectionMigrationTests(unittest.TestCase):
    def setUp(self):
        self._stack = _isolated_stack()
        self.data_path = self._stack.__enter__()

    def tearDown(self):
        self._stack.__exit__(None, None, None)

    def _add_legacy_plaid_schema(self, conn):
        # The v18 backfill runs against the pre-v18/v20 shape: a `plaid_item` table (dropped in v20) and an
        # `account.plaid_item_id` column (renamed in v20). init_db builds the *current* schema, so hand-build
        # the legacy bits the migration reads — the "isolated per-migration" pattern this helper documents.
        conn.execute(
            "CREATE TABLE plaid_item (item_id TEXT PRIMARY KEY, access_token TEXT NOT NULL DEFAULT '', access_token_enc TEXT)"
        )
        conn.execute("ALTER TABLE account ADD COLUMN plaid_item_id TEXT")

    def test_backfill_folds_plaid_items_into_connections(self):
        with database.get_db(db_path=self.data_path) as conn:
            self._add_legacy_plaid_schema(conn)
            conn.execute(
                "INSERT INTO plaid_item (item_id, access_token, access_token_enc) VALUES ('item-1', '', 'enc-blob')"
            )
            conn.execute(
                """INSERT INTO account (id, external_account_id, plaid_item_id, name, display_name, institution)
                   VALUES ('a1', 'acct-1', 'item-1', 'Checking', 'Checking', 'Test Bank')"""
            )
            # Fresh init_db already created the (empty) connection table; simulate the upgrade data half.
            database._backfill_connections_from_plaid_items(conn)
            rows = conn.execute(
                "SELECT provider, external_id, credential, credential_enc, institution FROM connection"
            ).fetchall()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["provider"], "plaid")
        self.assertEqual(rows[0]["external_id"], "item-1")
        self.assertEqual(rows[0]["credential_enc"], "enc-blob")  # ciphertext carried verbatim (no re-key)
        self.assertEqual(rows[0]["institution"], "Test Bank")

    def test_v20_relinks_accounts_and_drops_plaid_item(self):
        # v20 makes the account→connection link provider-neutral. Rebuild the pre-v20 account shape (the
        # renamed columns + the plaid_item_id string link) and a plaid_item table, then run the migration and
        # assert: plaid columns are gone, a real item_id relinks to its connection (id + provider), and the
        # csv/manual sentinels become an origin-only provider with a NULL connection.
        with database.get_db(db_path=self.data_path) as conn:
            conn.execute("DROP TABLE account")
            conn.execute("""
                CREATE TABLE account (
                    id TEXT PRIMARY KEY, plaid_account_id TEXT UNIQUE, plaid_item_id TEXT NOT NULL,
                    name TEXT NOT NULL, display_name TEXT NOT NULL, institution TEXT, type TEXT,
                    subtype TEXT, mask TEXT, owner_id TEXT, parent_account_id TEXT, trashed_at TEXT)
            """)
            conn.execute("CREATE TABLE plaid_item (item_id TEXT PRIMARY KEY)")
            conn.execute(
                "INSERT INTO connection (id, provider, external_id, credential) VALUES ('c1', 'plaid', 'item-1', '')"
            )
            for row in (
                ("a1", "acct-1", "item-1", "Bank"),      # linked → connection c1
                ("a2", "csv_abc", "csv_import", "CSV"),  # CSV import → provider 'csv', no connection
                ("a3", None, "manual", "Manual"),        # manual → provider 'manual', no connection
            ):
                conn.execute(
                    "INSERT INTO account (id, plaid_account_id, plaid_item_id, name, display_name) VALUES (?,?,?,?,?)",
                    (*row, row[3]),
                )
            database._account_connection_columns(conn)
            cols = {r["name"] for r in conn.execute("PRAGMA table_info(account)")}
            tables = {r["name"] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            rows = {
                r["id"]: r
                for r in conn.execute("SELECT id, external_account_id, connection_id, provider FROM account")
            }
        self.assertIn("external_account_id", cols)
        self.assertNotIn("plaid_account_id", cols)
        self.assertNotIn("plaid_item_id", cols)
        self.assertNotIn("plaid_item", tables)  # the vestigial table is dropped
        self.assertEqual((rows["a1"]["external_account_id"], rows["a1"]["connection_id"], rows["a1"]["provider"]),
                         ("acct-1", "c1", "plaid"))
        self.assertEqual((rows["a2"]["connection_id"], rows["a2"]["provider"]), (None, "csv"))
        self.assertEqual((rows["a3"]["connection_id"], rows["a3"]["provider"]), (None, "manual"))

    def test_backfill_is_idempotent(self):
        with database.get_db(db_path=self.data_path) as conn:
            self._add_legacy_plaid_schema(conn)
            conn.execute(
                "INSERT INTO plaid_item (item_id, access_token, access_token_enc) VALUES ('item-1', '', 'enc-blob')"
            )
            database._backfill_connections_from_plaid_items(conn)
            database._backfill_connections_from_plaid_items(conn)
            count = conn.execute(
                "SELECT COUNT(*) AS n FROM connection WHERE external_id = 'item-1'"
            ).fetchone()["n"]
        self.assertEqual(count, 1)


class ProviderAdapterTests(unittest.TestCase):
    def test_registry_resolves_plaid_and_rejects_unknown(self):
        self.assertIsInstance(get_adapter("plaid"), PlaidAdapter)
        with self.assertRaises(UnknownProviderError):
            get_adapter("nope")

    def test_adapter_normalizes_to_provider_neutral_keys(self):
        adapter = get_adapter("plaid")
        cfg = {"client_id": "cid", "secret": "sek", "env": "sandbox"}  # app_config threaded through in 6b
        with mock.patch("backend.services.plaid_service.exchange_public_token",
                        return_value={"access_token": "tok-1", "item_id": "item-1"}):
            self.assertEqual(adapter.exchange(cfg, "public-1"), {"external_id": "item-1", "credential": "tok-1"})
        with mock.patch("backend.services.plaid_service.fetch_accounts", return_value=[
            {"plaid_account_id": "acct-1", "name": "Checking", "type": "depository", "subtype": "checking", "mask": "0000"}
        ]):
            self.assertEqual(adapter.fetch_accounts(cfg, "tok-1"), [
                {"external_account_id": "acct-1", "name": "Checking", "type": "depository", "subtype": "checking", "mask": "0000"}
            ])
        with mock.patch("backend.services.plaid_service.fetch_transactions", return_value=[
            {"plaid_transaction_id": "t-1", "plaid_account_id": "acct-1", "amount": 12.5,
             "merchant_name": "Store", "raw_name": "STORE #1", "date": "2026-01-01", "is_pending": False}
        ]):
            self.assertEqual(adapter.fetch_transactions(cfg, "tok-1"), [
                {"external_transaction_id": "t-1", "external_account_id": "acct-1", "amount": 12.5,
                 "merchant_name": "Store", "raw_name": "STORE #1", "date": "2026-01-01", "is_pending": False}
            ])


class CredentialBackupTests(unittest.TestCase):
    def setUp(self):
        cs.lock_all()

    def tearDown(self):
        cs.lock_all()

    def _connect_one(self, client):
        # Exchange now resolves the provider's app credential (phase 6b), so Plaid must be configured
        # first (the vault is unlocked by set-passphrase, so the secret can be vaulted).
        client.post("/api/providers/plaid/config", json={"client_id": "cid-1", "secret": "app-secret-1"})
        with mock.patch("backend.services.plaid_service.exchange_public_token",
                        return_value={"access_token": "access-sandbox-xyz", "item_id": "item-1"}), \
             mock.patch("backend.services.plaid_service.fetch_accounts", return_value=[
                 {"plaid_account_id": "acct-1", "name": "Checking", "type": "depository",
                  "subtype": "checking", "mask": "0000"}
             ]):
            r = client.post("/api/plaid/exchange", json={"public_token": "public-1", "institution_name": "Test Bank"})
        self.assertEqual(r.status_code, 200, r.text)

    def test_disconnect_revokes_at_provider_and_removes_the_connection(self):
        with api_client() as (client, _):
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": "a-strong-passphrase"})
            self._connect_one(client)
            plaid = next(p for p in client.get("/api/providers").json()["providers"] if p["provider"] == "plaid")
            self.assertEqual(len(plaid["connections"]), 1)

            with mock.patch("backend.services.plaid_service.remove_item") as remove_item:
                r = client.post("/api/providers/plaid/disconnect", json={"external_id": "item-1"})
            self.assertEqual(r.status_code, 200, r.text)
            remove_item.assert_called_once()  # revoked provider-side, not just deleted locally

            plaid = next(p for p in client.get("/api/providers").json()["providers"] if p["provider"] == "plaid")
            self.assertEqual(len(plaid["connections"]), 0)

            # The account survives the disconnect (its rows are kept); its connection_id drops to NULL via
            # the account.connection_id → connection(id) ON DELETE SET NULL FK — it's just no longer linked.
            accounts = client.get("/api/accounts").json()
            acct = next(a for a in accounts if a["name"] == "Checking")
            self.assertIsNone(acct["connection_id"])

    def test_exchange_writes_a_connection_and_status_counts_it(self):
        with api_client() as (client, _):
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": "a-strong-passphrase"})
            self._connect_one(client)
            status = client.get("/api/import-export/backup/credentials/status").json()
            self.assertTrue(status["has_credentials"])
            # 1 connection + 1 provider_config (the app credential _connect_one saves): both are vaulted
            # secrets the credentials backup carries.
            self.assertEqual(status["credential_count"], 2)

    def test_repeated_exchange_is_idempotent(self):
        # A user can complete Plaid Link more than once for the same bank (onSuccess double-fire, re-link),
        # which re-exchanges to the same item_id. That must upsert cleanly (200), not 500 on the connection's
        # UNIQUE(provider, external_id) or the account's UNIQUE(external_account_id).
        with api_client() as (client, _):
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": "a-strong-passphrase"})
            self._connect_one(client)
            self._connect_one(client)  # second exchange for the same item — must not raise
            plaid = next(p for p in client.get("/api/providers").json()["providers"] if p["provider"] == "plaid")
            self.assertEqual(len(plaid["connections"]), 1)  # de-duplicated, not a second connection
            checking = [a for a in client.get("/api/accounts").json() if a["name"] == "Checking"]
            self.assertEqual(len(checking), 1)  # account not duplicated either
            self.assertIsNotNone(checking[0]["connection_id"])  # re-stamped to the (single) connection

    def test_reexchange_reattaches_a_disconnected_account(self):
        # Reconnecting a bank whose accounts were left dangling by a prior disconnect (connection_id NULL)
        # re-attaches them: the account upsert re-stamps connection_id on conflict.
        with api_client() as (client, _):
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": "a-strong-passphrase"})
            self._connect_one(client)
            with mock.patch("backend.services.plaid_service.remove_item"):
                client.post("/api/providers/plaid/disconnect", json={"external_id": "item-1"})
            self.assertIsNone(next(a for a in client.get("/api/accounts").json() if a["name"] == "Checking")["connection_id"])
            self._connect_one(client)  # reconnect the same bank
            self.assertIsNotNone(next(a for a in client.get("/api/accounts").json() if a["name"] == "Checking")["connection_id"])

    def test_credentials_export_restore_roundtrip(self):
        with api_client() as (client, _):
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": "a-strong-passphrase"})
            self._connect_one(client)

            exported = client.get("/api/import-export/backup/credentials")
            self.assertEqual(exported.status_code, 200)
            payload = _load_json_or_zip_payload(exported.content, "luma_credentials.zip", "luma_credentials")
            self.assertEqual(payload["version"], 2)
            self.assertEqual(payload["connections"][0]["provider"], "plaid")
            self.assertEqual(payload["connections"][0]["credential"], "access-sandbox-xyz")

            restored = client.post("/api/import-export/restore/credentials", json={"data": payload})
            self.assertEqual(restored.status_code, 200, restored.text)
            self.assertEqual(restored.json()["restored"], 2)  # 1 connection + 1 provider_config
            # Re-export proves the restored credential re-encrypted and still decrypts to the same secret.
            again = _load_json_or_zip_payload(client.get("/api/import-export/backup/credentials").content, "luma_credentials.zip", "luma_credentials")
            self.assertEqual(again["connections"][0]["credential"], "access-sandbox-xyz")

    def test_restore_accepts_legacy_v1_plaid_items(self):
        with api_client() as (client, _):
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": "a-strong-passphrase"})
            # A pre-6a credentials export: version 1, plaid_items shape. The content hash is only verified
            # when present, so a hand-built legacy payload without it restores (matching old exports that
            # predate the hash field).
            legacy = {"version": 1, "plaid_items": [{"item_id": "item-legacy", "access_token": "tok-legacy"}]}
            restored = client.post("/api/import-export/restore/credentials", json={"data": legacy})
            self.assertEqual(restored.status_code, 200, restored.text)
            self.assertEqual(restored.json()["restored"], 1)
            again = _load_json_or_zip_payload(client.get("/api/import-export/backup/credentials").content, "luma_credentials.zip", "luma_credentials")
            self.assertEqual(again["connections"][0]["provider"], "plaid")
            self.assertEqual(again["connections"][0]["external_id"], "item-legacy")
            self.assertEqual(again["connections"][0]["credential"], "tok-legacy")


if __name__ == "__main__":
    unittest.main()
