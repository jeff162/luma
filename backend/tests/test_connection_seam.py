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

    def test_backfill_folds_plaid_items_into_connections(self):
        with database.get_db(db_path=self.data_path) as conn:
            conn.execute(
                "INSERT INTO plaid_item (item_id, access_token, access_token_enc) VALUES ('item-1', '', 'enc-blob')"
            )
            conn.execute(
                """INSERT INTO account (id, plaid_account_id, plaid_item_id, name, display_name, institution)
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

    def test_backfill_is_idempotent(self):
        with database.get_db(db_path=self.data_path) as conn:
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

    def test_exchange_writes_a_connection_and_status_counts_it(self):
        with api_client() as (client, _):
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": "a-strong-passphrase"})
            self._connect_one(client)
            status = client.get("/api/import-export/backup/credentials/status").json()
            self.assertTrue(status["has_credentials"])
            # 1 connection + 1 provider_config (the app credential _connect_one saves): both are vaulted
            # secrets the credentials backup carries.
            self.assertEqual(status["credential_count"], 2)

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
