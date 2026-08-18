"""
App-level provider credentials in the vault (phase 6b-1): the Plaid client_id/secret/env move out of
`.env` into the vaulted `provider_config` table.

Pins the edges: only the secret is vaulted (client_id/env plaintext, secret never returned by status);
the saved row is the only source, so environment credentials are ignored; saving a secret needs an
unlocked vault while client_id/env alone do not; the Configure endpoints round-trip; the Production gate
holds; and app credentials ride the credentials backup.
"""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest import mock

from backend.db import control_database as cdb
from backend.db import database
from backend.routers.import_export.backup import _load_json_or_zip_payload
from backend.services import crypto_service as cs
from backend.services.providers import config as provider_config
from backend.services.providers import resolve_app_config
from backend.tests._api_client import STRONG_PASSPHRASE, api_client


@contextmanager
def _isolated_stack():
    tmp = tempfile.TemporaryDirectory()
    data_path = str(Path(tmp.name) / "data.db")
    control_path = str(Path(tmp.name) / "control.db")
    originals = (database.DB_PATH, cdb.DB_PATH, cdb.CONTROL_DB_PATH)
    database.DB_PATH = data_path
    cdb.DB_PATH = data_path
    cdb.CONTROL_DB_PATH = control_path
    database.init_db(data_path)
    cdb.init_control_db()
    try:
        yield data_path
    finally:
        database.DB_PATH, cdb.DB_PATH, cdb.CONTROL_DB_PATH = originals
        tmp.cleanup()


class AppCredentialCryptoTests(unittest.TestCase):
    def setUp(self):
        self._stack = _isolated_stack()
        self._stack.__enter__()
        cs.lock_all()
        self.alice = cdb.create_local_identity("alice")["id"]

    def tearDown(self):
        cs.lock_all()
        self._stack.__exit__(None, None, None)

    def test_roundtrip_when_unlocked(self):
        cs.set_passphrase(self.alice, "correct horse battery")
        user = {"id": self.alice}
        stored, enc = cs.encrypt_app_credential(user, "plaid", "app-secret")
        self.assertEqual(stored, "")
        self.assertTrue(enc)
        self.assertEqual(cs.decrypt_app_credential(user, "plaid", stored, enc), "app-secret")

    def test_encrypt_requires_unlock(self):
        cs.set_passphrase(self.alice, "correct horse battery")
        cs.lock(self.alice)
        with self.assertRaises(cs.VaultLocked):
            cs.encrypt_app_credential({"id": self.alice}, "plaid", "x")

    def test_secret_bound_to_provider(self):
        cs.set_passphrase(self.alice, "correct horse battery")
        user = {"id": self.alice}
        _, enc = cs.encrypt_app_credential(user, "plaid", "x")
        with self.assertRaises(cs.VaultDecryptError):
            cs.decrypt_app_credential(user, "teller", "", enc)


class ProviderConfigServiceTests(unittest.TestCase):
    def setUp(self):
        self._stack = _isolated_stack()
        self._stack.__enter__()
        cs.lock_all()
        self.alice = cdb.create_local_identity("alice")["id"]
        cs.set_passphrase(self.alice, STRONG_PASSPHRASE)  # configures + unlocks
        self.user = {"id": self.alice}

    def tearDown(self):
        cs.lock_all()
        self._stack.__exit__(None, None, None)

    def test_status_never_returns_the_secret(self):
        provider_config.set_provider_config(self.user, "plaid", client_id="cid", secret="sek", env="sandbox")
        status = provider_config.get_provider_config_status("plaid")
        self.assertTrue(status["configured"])
        self.assertEqual(status["source"], "vault")
        self.assertEqual(status["client_id"], "cid")
        self.assertTrue(status["has_secret"])
        self.assertNotIn("secret", status)

    def test_resolve_returns_decrypted_secret(self):
        provider_config.set_provider_config(self.user, "plaid", client_id="cid", secret="sek", env="sandbox")
        self.assertEqual(
            resolve_app_config(self.user, "plaid"),
            {"client_id": "cid", "secret": "sek", "env": "sandbox"},
        )

    def test_client_id_only_saves_while_locked(self):
        cs.lock(self.alice)
        provider_config.set_provider_config(self.user, "plaid", client_id="cid", env="sandbox")
        status = provider_config.get_provider_config_status("plaid")
        self.assertEqual(status["client_id"], "cid")
        self.assertFalse(status["has_secret"])

    def test_saving_a_secret_requires_unlock(self):
        cs.lock(self.alice)
        with self.assertRaises(cs.VaultLocked):
            provider_config.set_provider_config(self.user, "plaid", secret="sek")

    def test_the_saved_row_is_the_only_source(self):
        # The `.env` bootstrap (PLAID_*) is gone: environment credentials are ignored outright, so a
        # plaintext secret sitting in a file can never stand in for the vaulted one.
        with mock.patch.dict(os.environ, {"PLAID_CLIENT_ID": "envcid", "PLAID_SECRET": "envsek", "PLAID_ENV": "sandbox"}):
            self.assertIsNone(resolve_app_config(self.user, "plaid"))
            status = provider_config.get_provider_config_status("plaid")
            self.assertFalse(status["configured"])
            self.assertIsNone(status["source"])

            provider_config.set_provider_config(self.user, "plaid", client_id="dbcid", secret="dbsek", env="sandbox")
            self.assertEqual(resolve_app_config(self.user, "plaid")["secret"], "dbsek")
            self.assertEqual(provider_config.get_provider_config_status("plaid")["source"], "vault")


class ProviderConfigEndpointTests(unittest.TestCase):
    def setUp(self):
        cs.lock_all()

    def tearDown(self):
        cs.lock_all()

    def test_list_and_get_unconfigured(self):
        with api_client() as (client, _):
            listing = client.get("/api/providers").json()["providers"]
            plaid = next(p for p in listing if p["provider"] == "plaid")
            self.assertFalse(plaid["configured"])
            self.assertFalse(client.get("/api/providers/plaid/config").json()["configured"])

    def test_unknown_provider_is_404(self):
        with api_client() as (client, _):
            self.assertEqual(client.get("/api/providers/nope/config").status_code, 404)

    def test_saving_a_secret_needs_a_vault(self):
        with api_client() as (client, _):
            r = client.post("/api/providers/plaid/config", json={"client_id": "cid", "secret": "sek"})
            self.assertEqual(r.status_code, 423)
            self.assertEqual(r.json()["detail"]["code"], "vault_locked")

    def test_save_and_get_roundtrip(self):
        with api_client() as (client, _):
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": STRONG_PASSPHRASE})
            saved = client.post("/api/providers/plaid/config", json={"client_id": "cid", "secret": "sek", "env": "sandbox"})
            self.assertEqual(saved.status_code, 200, saved.text)
            self.assertTrue(saved.json()["has_secret"])
            got = client.get("/api/providers/plaid/config").json()
            self.assertEqual(got["client_id"], "cid")
            self.assertEqual(got["source"], "vault")
            self.assertNotIn("secret", got)

    def test_the_environment_no_longer_governs_the_passphrase(self):
        # This endpoint used to refuse `env: production` under a weak vault, because Sandbox accepted one.
        # With the weak tier gone that check could only ever pass, and keeping it would go on telling the
        # user their environment decides their passphrase — the model this change exists to remove.
        with api_client() as (client, _):
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": STRONG_PASSPHRASE})
            for env in ("sandbox", "production"):
                r = client.post("/api/providers/plaid/config",
                                json={"client_id": "cid", "secret": "sek", "env": env})
                self.assertEqual(r.status_code, 200, f"{env}: {r.text}")

    # ---- revealing the stored secret (the Configure dialog's Show) ----------
    #
    # The one read path for a stored app secret. It is a deliberate, narrow exception to the write-only
    # rule everywhere else, so each edge is pinned: the vault gates it, an unlocked vault is sufficient
    # (no second challenge), a `.env` secret needs no unlock because nothing is encrypted, and the
    # status payload it sits beside still never carries the value.

    def test_reveal_returns_the_stored_secret_when_unlocked(self):
        with api_client() as (client, _):
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": STRONG_PASSPHRASE})
            client.post("/api/providers/plaid/config", json={"client_id": "cid", "secret": "sek"})
            r = client.get("/api/providers/plaid/secret")
            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual(r.json()["secret"], "sek")
            self.assertEqual(r.json()["source"], "vault")

    def test_reveal_needs_the_vault_unlocked(self):
        with api_client() as (client, _):
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": STRONG_PASSPHRASE})
            client.post("/api/providers/plaid/config", json={"client_id": "cid", "secret": "sek"})
            cs.lock_all()
            r = client.get("/api/providers/plaid/secret")
            self.assertEqual(r.status_code, 423)
            self.assertEqual(r.json()["detail"]["code"], "vault_locked")

    def test_reveal_without_a_secret_on_file_is_409(self):
        with api_client() as (client, _):
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": STRONG_PASSPHRASE})
            client.post("/api/providers/plaid/config", json={"client_id": "cid"})  # client_id only
            r = client.get("/api/providers/plaid/secret")
            self.assertEqual(r.status_code, 409)
            self.assertEqual(r.json()["detail"]["code"], "no_secret")

    def test_reveal_ignores_environment_credentials(self):
        # There is no unlock-free path to a secret any more: with the bootstrap gone, a locked vault has
        # nothing to fall back to, so PLAID_* in the environment cannot produce one.
        with api_client() as (client, _), \
                mock.patch.dict(os.environ, {"PLAID_CLIENT_ID": "envcid", "PLAID_SECRET": "envsek"}):
            cs.lock_all()
            r = client.get("/api/providers/plaid/secret")
            self.assertEqual(r.status_code, 409)
            self.assertEqual(r.json()["detail"]["code"], "no_secret")

    def test_reveal_of_an_unknown_provider_is_404(self):
        with api_client() as (client, _):
            self.assertEqual(client.get("/api/providers/nope/secret").status_code, 404)

    def test_app_credential_rides_the_credentials_backup(self):
        with api_client() as (client, _):
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": STRONG_PASSPHRASE})
            client.post("/api/providers/plaid/config", json={"client_id": "cid", "secret": "app-secret"})
            payload = _load_json_or_zip_payload(
                client.get("/api/import-export/backup/credentials").content, "luma_credentials.zip", "luma_credentials"
            )
            pc = next(p for p in payload["provider_configs"] if p["provider"] == "plaid")
            self.assertEqual(pc["client_id"], "cid")
            # The app secret rides as CIPHERTEXT. `client_id` is semi-public and stays readable; the
            # secret itself must never appear in the file in a usable form (v3 — see export_credentials).
            self.assertEqual(pc["secret"], "")
            self.assertTrue(pc["secret_enc"])
            self.assertNotIn("app-secret", json.dumps(payload))

            restored = client.post("/api/import-export/restore/credentials", json={"data": payload})
            self.assertEqual(restored.status_code, 200, restored.text)
            again = client.get("/api/providers/plaid/config").json()
            self.assertEqual(again["client_id"], "cid")
            self.assertTrue(again["has_secret"])


if __name__ == "__main__":
    unittest.main()
