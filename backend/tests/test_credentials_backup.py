"""
The credentials backup: ciphertext out, re-keyed in.

Versions 1 and 2 exported *decrypted* access tokens and app secrets into a plain zip — an artifact
strictly weaker than the databases it came from, which hold only ciphertext — and producing it was the
only reason the export demanded an unlocked vault. v3 copies the ciphertext instead and carries the
vault's wrapped DEK beside it, so:

  * export needs no vault at all (the reported bug: a locked vault answered 423, and because the button
    was a plain browser navigation the user got a raw JSON page);
  * the file is portable — the ciphertext lives in the data DB and the key that opens it in the control
    DB, so a backup carrying only one half restores nowhere;
  * the passphrase is asked for at *restore*, where re-keying genuinely cannot proceed without it.

The invariant these tests defend is narrow and absolute: **no usable secret ever appears in the file.**
"""

from __future__ import annotations

import json
import unittest

from backend.db.database import get_db
from backend.routers.import_export.backup import _load_json_or_zip_payload
from backend.services import crypto_service as cs
from backend.tests._api_client import api_client

PASSPHRASE = "a-strong-passphrase"
OTHER_PASSPHRASE = "a-different-strong-passphrase"
TOKEN = "access-sandbox-TEST-TOKEN"
APP_SECRET = "app-secret-value"


class CredentialsBackupTests(unittest.TestCase):
    def setUp(self):
        cs.lock_all()

    def tearDown(self):
        cs.lock_all()

    # ---- fixtures -------------------------------------------------------

    def _user_id(self, client) -> str:
        return client.get("/api/auth/status").json()["user"]["id"]

    def _seed(self, client) -> str:
        """A vaulted install holding one connection credential and one app-level provider secret."""
        client.post("/api/auth/vault/set-passphrase", json={"passphrase": PASSPHRASE})
        user_id = self._user_id(client)
        credential, credential_enc = cs.encrypt_connection_credential(
            {"id": user_id}, "plaid", "ext-1", TOKEN,
        )
        with get_db() as conn:
            conn.execute(
                "INSERT INTO connection (id, provider, external_id, credential, credential_enc, institution)"
                " VALUES ('conn-1', 'plaid', 'ext-1', ?, ?, 'Northgate Bank')",
                (credential, credential_enc),
            )
        client.post("/api/providers/plaid/config", json={"client_id": "cid", "secret": APP_SECRET})
        return user_id

    def _export(self, client) -> dict:
        r = client.get("/api/import-export/backup/credentials")
        self.assertEqual(r.status_code, 200, r.text)
        return _load_json_or_zip_payload(r.content, "luma_credentials.zip", "luma_credentials")

    def _stored_secrets(self, user_id) -> tuple[str, str]:
        """What the live DB's credentials decrypt to under THIS install's DEK."""
        with get_db() as conn:
            c = conn.execute("SELECT * FROM connection WHERE external_id = 'ext-1'").fetchone()
            pc = conn.execute("SELECT * FROM provider_config WHERE provider = 'plaid'").fetchone()
        return (
            cs.decrypt_connection_credential({"id": user_id}, "plaid", "ext-1", c["credential"], c["credential_enc"]),
            cs.decrypt_app_credential({"id": user_id}, "plaid", pc["secret"], pc["secret_enc"]),
        )

    # ---- the reported bug -----------------------------------------------

    def test_export_succeeds_with_the_vault_locked(self):
        # The bug, at its source. Nothing here needs the DEK — the export copies ciphertext — so a locked
        # vault must not be an error, and there is no 423 for the UI to mishandle in the first place.
        with api_client() as (client, _):
            self._seed(client)
            client.post("/api/auth/vault/lock")
            payload = self._export(client)

        self.assertEqual(payload["version"], 3)
        self.assertTrue(payload["connections"][0]["credential_enc"])
        self.assertTrue(payload["vault"]["wrapped_dek"])

    def test_no_usable_secret_appears_anywhere_in_the_file(self):
        # The invariant the whole format change exists for. Asserted over the serialized bytes rather
        # than field-by-field, so a secret added to a new field in future still trips it.
        with api_client() as (client, _):
            self._seed(client)
            payload = self._export(client)

        serialized = json.dumps(payload)
        self.assertNotIn(TOKEN, serialized)
        self.assertNotIn(APP_SECRET, serialized)
        self.assertEqual(payload["connections"][0]["credential"], "")
        self.assertEqual(payload["provider_configs"][0]["secret"], "")
        # client_id is semi-public and deliberately stays readable.
        self.assertEqual(payload["provider_configs"][0]["client_id"], "cid")

    # ---- round trips ----------------------------------------------------

    def test_restoring_onto_the_same_install_needs_no_passphrase(self):
        # The common case: your own backup, onto the machine that made it. The ciphertext is already
        # valid against the live DEK, so it goes back verbatim — demanding a passphrase to perform a
        # byte-for-byte copy would be ceremony.
        with api_client() as (client, _):
            user_id = self._seed(client)
            payload = self._export(client)
            with get_db() as conn:
                conn.execute("DELETE FROM connection")
                conn.execute("DELETE FROM provider_config")

            r = client.post("/api/import-export/restore/credentials", json={"data": payload})
            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual(self._stored_secrets(user_id), (TOKEN, APP_SECRET))

    def test_restoring_onto_the_same_install_works_while_locked(self):
        # Verbatim restore touches no plaintext, so it needs no unlock either.
        with api_client() as (client, _):
            user_id = self._seed(client)
            payload = self._export(client)
            with get_db() as conn:
                conn.execute("DELETE FROM connection")
            client.post("/api/auth/vault/lock")

            r = client.post("/api/import-export/restore/credentials", json={"data": payload})
            self.assertEqual(r.status_code, 200, r.text)

            client.post("/api/auth/vault/unlock", json={"passphrase": PASSPHRASE})
            self.assertEqual(self._stored_secrets(user_id)[0], TOKEN)

    def test_restoring_onto_a_foreign_install_re_keys_under_the_local_vault(self):
        # Machine loss, the reason to take one of these at all. A fresh install with its own user id and
        # its own passphrase reopens the backup with the passphrase that *made* it, then re-seals every
        # secret under its own DEK. One DEK per workspace — the backup's slot is never adopted.
        with api_client() as (client, _):
            self._seed(client)
            payload = self._export(client)

        with api_client() as (client, _):
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": OTHER_PASSPHRASE})
            local_user = self._user_id(client)
            local_slot_before = cs.export_vault_slot(local_user)

            r = client.post(
                "/api/import-export/restore/credentials",
                json={"data": payload, "passphrase": PASSPHRASE},
            )
            self.assertEqual(r.status_code, 200, r.text)

            # Readable under the LOCAL dek, and the local vault slot is untouched.
            self.assertEqual(self._stored_secrets(local_user), (TOKEN, APP_SECRET))
            self.assertEqual(cs.export_vault_slot(local_user), local_slot_before)
            with get_db() as conn:
                stored = conn.execute("SELECT credential_enc FROM connection WHERE external_id='ext-1'").fetchone()
            self.assertNotEqual(stored["credential_enc"], payload["connections"][0]["credential_enc"],
                                "re-keyed under this workspace's DEK, not stored as the backup's ciphertext")

    # ---- refusals -------------------------------------------------------

    def test_a_foreign_backup_without_a_passphrase_asks_for_one(self):
        with api_client() as (client, _):
            self._seed(client)
            payload = self._export(client)

        with api_client() as (client, _):
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": OTHER_PASSPHRASE})
            r = client.post("/api/import-export/restore/credentials", json={"data": payload})
            self.assertEqual(r.status_code, 400)
            self.assertEqual(r.json()["detail"]["code"], "backup_passphrase_required")

    def test_a_wrong_backup_passphrase_is_a_clean_refusal(self):
        # The AEAD tag is the verifier, so a wrong passphrase surfaces as a stated refusal rather than
        # as a decrypt traceback.
        with api_client() as (client, _):
            self._seed(client)
            payload = self._export(client)

        with api_client() as (client, _):
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": OTHER_PASSPHRASE})
            r = client.post(
                "/api/import-export/restore/credentials",
                json={"data": payload, "passphrase": "not-the-right-one"},
            )
            self.assertEqual(r.status_code, 400)
            self.assertEqual(r.json()["detail"]["code"], "incorrect_backup_passphrase")

    def test_an_unrecognized_version_is_refused(self):
        with api_client() as (client, _):
            r = client.post("/api/import-export/restore/credentials", json={"data": {"version": 99}})
            self.assertEqual(r.status_code, 400)

    # ---- backwards compatibility ----------------------------------------
    #
    # v1 and v2 files exist on real disks and must keep restoring. Their payloads are plaintext, so they
    # keep the local-vault requirement the old path always had — there is something to encrypt.

    def test_a_v2_plaintext_backup_still_restores(self):
        with api_client() as (client, _):
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": PASSPHRASE})
            user_id = self._user_id(client)
            legacy = {
                "version": 2,
                "connections": [{"id": "c1", "provider": "plaid", "external_id": "ext-1",
                                 "credential": TOKEN, "institution": "Northgate Bank"}],
                "provider_configs": [{"provider": "plaid", "client_id": "cid",
                                      "secret": APP_SECRET, "env": "sandbox"}],
            }
            r = client.post("/api/import-export/restore/credentials", json={"data": legacy})
            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual(self._stored_secrets(user_id), (TOKEN, APP_SECRET))

    def test_a_v1_legacy_plaid_backup_still_restores(self):
        with api_client() as (client, _):
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": PASSPHRASE})
            user_id = self._user_id(client)
            legacy = {
                "version": 1,
                "plaid_items": [{"item_id": "ext-1", "access_token": TOKEN, "institution": "Northgate Bank"}],
            }
            r = client.post("/api/import-export/restore/credentials", json={"data": legacy})
            self.assertEqual(r.status_code, 200, r.text)
            with get_db() as conn:
                row = conn.execute("SELECT * FROM connection WHERE external_id = 'ext-1'").fetchone()
            self.assertEqual(
                cs.decrypt_connection_credential(
                    {"id": user_id}, "plaid", "ext-1", row["credential"], row["credential_enc"]),
                TOKEN,
            )

    def test_a_v2_backup_still_needs_the_local_vault_unlocked(self):
        with api_client() as (client, _):
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": PASSPHRASE})
            client.post("/api/auth/vault/lock")
            r = client.post("/api/import-export/restore/credentials", json={"data": {
                "version": 2,
                "connections": [{"provider": "plaid", "external_id": "ext-1", "credential": TOKEN}],
            }})
            self.assertEqual(r.status_code, 423)
            self.assertEqual(r.json()["detail"]["code"], "vault_locked")


if __name__ == "__main__":
    unittest.main()
