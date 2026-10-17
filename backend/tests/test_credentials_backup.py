"""
The credentials backup: ciphertext out, re-keyed in.

Versions 1 and 2 exported *decrypted* access tokens and app secrets into a plain zip — an artifact
strictly weaker than the databases it came from, which hold only ciphertext — and producing it was the
only reason the export demanded an unlocked vault. v3 copies the ciphertext instead and carries the
exporting vault's own key material beside it (v4 the same, for keypair slots), so:

  * export needs no vault at all (the reported bug: a locked vault answered 423, and because the button
    was a plain browser navigation the user got a raw JSON page);
  * the file is portable — the ciphertext lives in the data DB and the key that opens it in the control
    DB, so a backup carrying only one half restores nowhere;
  * the passphrase is asked for at *restore*, where re-keying genuinely cannot proceed without it.

The invariant these tests defend is narrow and absolute: **no usable secret ever appears in the file.**

The standalone file is no longer written: every backup carries the same credentials and slots in its
accounts part (`services/accounts_backup.py`), and these tests read them out of it. Files written before that still
restore through `/restore/credentials`, which is what the restore tests here exercise.
"""

from __future__ import annotations

import io
import json
import base64
import unittest
import zipfile

from backend.db.database import get_db
from backend.routers.import_export.backup import (
    ACCOUNTS_CREDENTIALS_MEMBER, CONTENT_HASH_FIELD, _stamp_content_hash, _zip_json_bytes,
)
from backend.services import crypto_service as cs
from backend.tests._api_client import STRONG_PASSPHRASE, api_client, exported_credentials, in_browser_session

PASSPHRASE = STRONG_PASSPHRASE
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
        with in_browser_session(client):
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
        """A standalone credentials file as the last version of it was written: the credentials and slots
        a backup carries, under the header the standalone file had."""
        return _stamp_content_hash({
            "kind": "credentials", "version": 5, "exported_at": "2026-01-01T00:00:00Z",
            **exported_credentials(client),
        })

    def _stored_secrets(self, client, user_id) -> tuple[str, str]:
        """What the live DB's credentials decrypt to under THIS install's DEK, read as that browser."""
        with get_db() as conn:
            c = conn.execute("SELECT * FROM connection WHERE external_id = 'ext-1'").fetchone()
            pc = conn.execute("SELECT * FROM provider_config WHERE provider = 'plaid'").fetchone()
        with in_browser_session(client):
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

        self.assertEqual(payload["version"], 5)
        self.assertTrue(payload["connections"][0]["credential_enc"])
        self.assertTrue(payload["vault_slots"][0]["wrapped_private_key"])
        self.assertTrue(payload["vault_slots"][0]["sealed_dek"])

    # ---- knowing which backups a passphrase change would strand ----------

    def test_an_export_is_recorded_against_the_wrapping_it_carried(self):
        # A credentials backup outlives the app's memory of it: change the passphrase and the DEK is
        # rewrapped, leaving the file restorable only with the old passphrase, permanently. The record is
        # what lets the change dialog name the file by date rather than issue a caution about backups
        # in general.
        with api_client() as (client, _):
            self._seed(client)
            self.assertEqual(client.get("/api/auth/vault/credentials-backups").json()["backups"], [],
                             "nothing is at stake before an export is taken")
            self._export(client)
            backups = client.get("/api/auth/vault/credentials-backups").json()["backups"]
        self.assertEqual(len(backups), 1)
        self.assertTrue(backups[0]["exported_at"])

    def test_changing_the_passphrase_drops_the_backup_out_of_the_at_stake_list(self):
        # The other side of the same fact, and the reason the lookup matches on the fingerprint rather
        # than listing every export: once the change has happened, that file is already stranded, and
        # warning about it at the *next* change would be noise at the moment a decision is being weighed.
        with api_client() as (client, _):
            self._seed(client)
            self._export(client)
            r = client.post("/api/auth/vault/change-passphrase",
                            json={"old_passphrase": PASSPHRASE, "new_passphrase": OTHER_PASSPHRASE})
            self.assertEqual(r.status_code, 200, r.text)
            backups = client.get("/api/auth/vault/credentials-backups").json()["backups"]
        self.assertEqual(backups, [])

    def test_the_record_holds_no_key_material(self):
        # It only ever answers "same wrapping?", so it must not be a place the wrap, the DEK or the
        # passphrase can be read back out of.
        with api_client() as (client, _):
            self._seed(client)
            payload = self._export(client)
            user_id = self._user_id(client)
            fingerprint = cs.current_wrapped_dek_fingerprint(user_id)
        self.assertEqual(fingerprint, cs.exported_slots_fingerprint(payload["vault_slots"]))
        self.assertNotIn(payload["vault_slots"][0]["wrapped_private_key"], fingerprint)
        self.assertNotIn(PASSPHRASE, fingerprint)

    def test_the_fingerprint_tracks_the_wrapping_a_change_replaces(self):
        # Which field it is taken over is load-bearing, and the two candidates disagree exactly here:
        # a passphrase change rewraps the slot's private key and leaves the DEK's seal byte-identical.
        # Fingerprinting the seal would report "nothing changed" after precisely the event this record
        # exists to detect, silently keeping stranded backups on the at-stake list forever.
        with api_client() as (client, _):
            self._seed(client)
            before = self._export(client)
            client.post("/api/auth/vault/change-passphrase",
                        json={"old_passphrase": PASSPHRASE, "new_passphrase": OTHER_PASSPHRASE})
            after = self._export(client)
        self.assertEqual(before["vault_slots"][0]["sealed_dek"], after["vault_slots"][0]["sealed_dek"])
        self.assertNotEqual(
            cs.exported_slots_fingerprint(before["vault_slots"]),
            cs.exported_slots_fingerprint(after["vault_slots"]),
        )

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
            self.assertEqual(self._stored_secrets(client, user_id), (TOKEN, APP_SECRET))

    def test_a_backup_predating_a_passphrase_change_still_restores_here(self):
        # Changing a passphrase re-wraps the SAME workspace DEK and leaves stored ciphertext untouched, so
        # an older backup's secrets are still valid on this install. It was never stranded here — only on
        # a different install — and asking for the old passphrase to copy bytes the live key already opens
        # is ceremony for a secret the user may no longer have.
        with api_client() as (client, _):
            user_id = self._seed(client)
            payload = self._export(client)
            changed = client.post("/api/auth/vault/change-passphrase", json={
                "old_passphrase": PASSPHRASE, "new_passphrase": PASSPHRASE + "-rotated",
            })
            self.assertEqual(changed.status_code, 200, changed.text)
            with get_db() as conn:
                conn.execute("DELETE FROM connection")
                conn.execute("DELETE FROM provider_config")

            r = client.post("/api/import-export/restore/credentials", json={"data": payload})

            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual(self._stored_secrets(client, user_id), (TOKEN, APP_SECRET))

    def test_another_members_backup_restores_without_their_passphrase(self):
        # Every member's slot seals the same workspace DEK, so whether a restore is a byte copy is a
        # property of the workspace, not of who exported the file. Rewriting the slot's owner stands in for
        # a colleague's export: it is the identity mismatch that used to make this look foreign.
        with api_client() as (client, _):
            user_id = self._seed(client)
            payload = self._export(client)
            for slot in payload["vault_slots"]:
                slot["user_id"] = "some-other-member"
            payload.pop(CONTENT_HASH_FIELD, None)
            with get_db() as conn:
                conn.execute("DELETE FROM connection")

            r = client.post("/api/import-export/restore/credentials", json={"data": _stamp_content_hash(payload)})

            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual(self._stored_secrets(client, user_id)[0], TOKEN)

    def test_a_genuinely_foreign_backup_still_asks_and_says_whose_passphrase(self):
        # The DEK does not open it, so a passphrase really is needed — and the message has to say *which*,
        # because "the one it was created with" leaves someone guessing among their own.
        with api_client() as (client, _):
            self._seed(client)
            payload = self._export(client)
            for slot in payload["vault_slots"]:
                slot["user_id"] = "someone-elsewhere"
            payload["connections"][0]["credential_enc"] = base64.urlsafe_b64encode(b"not-our-ciphertext").decode()
            payload.pop(CONTENT_HASH_FIELD, None)

            r = client.post("/api/import-export/restore/credentials", json={"data": _stamp_content_hash(payload)})

            self.assertEqual(r.status_code, 400, r.text)
            detail = r.json()["detail"]
            self.assertEqual(detail["code"], "backup_secret_required")
            self.assertIn("another install", detail["message"])

    def test_restoring_the_downloaded_file_through_the_upload_endpoint(self):
        # Every other restore test here posts a parsed payload, but the app uploads the *file* — a
        # separate endpoint, and the one that identifies what was chosen before restoring it. Exercise
        # the round trip the user actually performs: download the file, hand that file back.
        with api_client() as (client, _):
            user_id = self._seed(client)
            exported = _zip_json_bytes("luma_credentials.json", self._export(client))
            with get_db() as conn:
                conn.execute("DELETE FROM connection")
                conn.execute("DELETE FROM provider_config")

            r = client.post(
                "/api/import-export/restore/credentials-file",
                files={"file": ("luma_credentials-2026-08-23.zip", exported, "application/zip")},
            )
            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual(self._stored_secrets(client, user_id), (TOKEN, APP_SECRET))

    def test_a_backup_uploaded_here_is_named_for_what_it_is(self):
        # The complaint that started this: picking the wrong one of the two backups answered with a
        # remark about the names of members inside a ZIP. Both directions must say what the file is.
        with api_client() as (client, _):
            self._seed(client)
            data_backup = client.get("/api/import-export/backup")
            self.assertEqual(data_backup.status_code, 200)

            r = client.post(
                "/api/import-export/restore/credentials-file",
                files={"file": ("luma_backup-2026-08-23.zip", data_backup.content, "application/zip")},
            )
            self.assertEqual(r.status_code, 400)
            self.assertEqual(r.json()["detail"], "This is a full backup, not a credentials backup.")

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
            self.assertEqual(self._stored_secrets(client, user_id)[0], TOKEN)

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
            local_slots_before = cs.export_vault_slots(local_user)

            r = client.post(
                "/api/import-export/restore/credentials",
                json={"data": payload, "passphrase": PASSPHRASE},
            )
            self.assertEqual(r.status_code, 200, r.text)

            # Readable under the LOCAL dek, and the local vault slot is untouched.
            self.assertEqual(self._stored_secrets(client, local_user), (TOKEN, APP_SECRET))
            self.assertEqual(
                [{k: v for k, v in s.items() if k != "site"} for s in cs.export_vault_slots(local_user)],
                [{k: v for k, v in s.items() if k != "site"} for s in local_slots_before],
            )
            with get_db() as conn:
                stored = conn.execute("SELECT credential_enc FROM connection WHERE external_id='ext-1'").fetchone()
            self.assertNotEqual(stored["credential_enc"], payload["connections"][0]["credential_enc"],
                                "re-keyed under this workspace's DEK, not stored as the backup's ciphertext")

    def test_a_version_3_file_from_before_keypair_slots_still_restores(self):
        # Files already sitting in people's backup folders were written against directly-wrapped slots.
        # A credentials backup is kept precisely for the day the machine is gone, so the reader has to
        # keep understanding the older shape — the version bump exists to route it, not to retire it.
        import os
        import uuid

        foreign_user = str(uuid.uuid4())
        dek = os.urandom(cs.DEK_BYTES)
        salt = os.urandom(16)
        kdf = {"kdf_algo": "scrypt", "kdf_salt": cs._b64e(salt), "kdf_n": 2 ** 15, "kdf_r": 8, "kdf_p": 1}
        kek = cs._derive_kek(PASSPHRASE, kdf)
        payload = _stamp_content_hash({
            "version":     3,
            "exported_at": "2026-01-01T00:00:00Z",
            "connections": [{
                "id": "conn-1", "provider": "plaid", "external_id": "ext-1", "credential": "",
                "credential_enc": cs.encrypt_secret(dek, TOKEN, aad=cs._connection_aad("plaid", "ext-1")),
                "institution": "Northgate Bank",
            }],
            "provider_configs": [{
                "provider": "plaid", "client_id": "cid", "secret": "",
                "secret_enc": cs.encrypt_secret(dek, APP_SECRET, aad=cs._app_credential_aad("plaid")),
                "env": "sandbox",
            }],
            "vault": {
                "user_id": foreign_user, "method": "passphrase",
                "wrapped_dek": cs._wrap(kek, dek, aad=cs._slot_aad(foreign_user)),
                **kdf,
                "meets_production_min": True,
            },
        })

        with api_client() as (client, _):
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": OTHER_PASSPHRASE})
            local_user = self._user_id(client)
            r = client.post(
                "/api/import-export/restore/credentials",
                json={"data": payload, "passphrase": PASSPHRASE},
            )
            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual(self._stored_secrets(client, local_user), (TOKEN, APP_SECRET))

    # ---- every way the exporter opens the vault -------------------------
    #
    # A file carries the exporting member's passphrase, recovery code and passkey slots, so whichever of
    # those secrets survives the loss of the machine reopens it. None of them weakens the file: the code
    # is 160 random bits and a passkey's secret never leaves its authenticator.

    SITE = "https://luma.local"
    PRF = base64.b64encode(b"\x5a" * 32).decode()

    def _seed_with_every_method(self, client) -> str:
        """The usual seed, plus a recovery code and a passkey registered at `SITE`. Returns the code."""
        self._seed(client)
        code = client.post("/api/auth/vault/recovery-code").json()["recovery_code"]
        r = client.post("/api/auth/vault/passkey/register", json={
            "credential_id": "cred-1", "prf_output": self.PRF, "prf_salt": "c2FsdA==", "label": "Laptop",
        })
        self.assertEqual(r.status_code, 200, r.text)
        return code

    def test_the_file_carries_the_exporters_recovery_code_and_passkeys(self):
        with api_client(base_url=self.SITE) as (client, _):
            self._seed_with_every_method(client)
            payload = self._export(client)
        methods = [s["method"] for s in payload["vault_slots"]]
        self.assertEqual(methods, ["passphrase", "recovery", "passkey"])
        recovery, passkey = payload["vault_slots"][1], payload["vault_slots"][2]
        self.assertTrue(recovery["issued_at"], "so a restore can say which kept code opens it")
        self.assertTrue(cs.exported_site_matches(passkey, "luma.local"))
        self.assertFalse(cs.exported_site_matches(passkey, "elsewhere.local"))
        self.assertNotIn("luma.local", json.dumps(passkey), "the host is carried as a digest, not by name")

    def test_a_foreign_install_offers_what_the_file_carries_and_where_a_passkey_works(self):
        with api_client(base_url=self.SITE) as (client, _):
            self._seed_with_every_method(client)
            payload = self._export(client)

        for site, expect_passkey in ((self.SITE, True), ("https://elsewhere.local", False)):
            with api_client(base_url=site) as (client, _):
                client.post("/api/auth/vault/set-passphrase", json={"passphrase": OTHER_PASSPHRASE})
                r = client.post("/api/import-export/restore/credentials", json={"data": payload})
            self.assertEqual(r.status_code, 400, r.text)
            options = r.json()["detail"]["unlock_options"]
            self.assertTrue(options["passphrase"])
            self.assertTrue(options["recovery_code"]["issued_at"])
            self.assertEqual([p["credential_id"] for p in options["passkeys"]],
                             ["cred-1"] if expect_passkey else [], site)

    def test_a_foreign_install_restores_with_the_recovery_code_alone(self):
        with api_client(base_url=self.SITE) as (client, _):
            code = self._seed_with_every_method(client)
            payload = self._export(client)

        with api_client() as (client, _):
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": OTHER_PASSPHRASE})
            local_user = self._user_id(client)
            # Typed back as it was printed, dashes and case and all.
            r = client.post("/api/import-export/restore/credentials",
                            json={"data": payload, "recovery_code": code.lower()})
            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual(self._stored_secrets(client, local_user), (TOKEN, APP_SECRET))

    def test_a_foreign_install_restores_with_the_passkey_alone(self):
        with api_client(base_url=self.SITE) as (client, _):
            self._seed_with_every_method(client)
            payload = self._export(client)

        with api_client(base_url=self.SITE) as (client, _):
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": OTHER_PASSPHRASE})
            local_user = self._user_id(client)
            r = client.post("/api/import-export/restore/credentials", json={
                "data": payload, "passkey_credential_id": "cred-1", "passkey_prf_output": self.PRF,
            })
            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual(self._stored_secrets(client, local_user), (TOKEN, APP_SECRET))

    def test_a_wrong_recovery_code_is_a_clean_refusal(self):
        with api_client(base_url=self.SITE) as (client, _):
            self._seed_with_every_method(client)
            payload = self._export(client)

        with api_client() as (client, _):
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": OTHER_PASSPHRASE})
            r = client.post("/api/import-export/restore/credentials",
                            json={"data": payload, "recovery_code": cs.generate_recovery_code()})
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()["detail"]["code"], "incorrect_backup_secret")

    # ---- after the workspace key is replaced -----------------------------

    def test_a_backup_from_before_a_rotation_is_reopened_not_copied(self):
        # Rotation replaces the key and leaves every slot's wrapping alone, so a file from before it still
        # looks like this install's own by its wrapping — and copied verbatim, its credentials would sit
        # under a key nothing here can open any more. It has to be reopened with a secret and re-keyed.
        with api_client() as (client, _):
            user_id = self._seed(client)
            payload = self._export(client)
            self.assertEqual(client.post("/api/auth/vault/rotate").status_code, 200)
            client.post("/api/auth/vault/lock")

            r = client.post("/api/import-export/restore/credentials", json={"data": payload})
            self.assertEqual(r.status_code, 400, r.text)
            self.assertEqual(r.json()["detail"]["code"], "backup_secret_required")

            client.post("/api/auth/vault/unlock", json={"passphrase": PASSPHRASE})
            r = client.post("/api/import-export/restore/credentials",
                            json={"data": payload, "passphrase": PASSPHRASE})
            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual(self._stored_secrets(client, user_id), (TOKEN, APP_SECRET))

    def test_a_backup_from_before_a_vault_reset_restores_into_the_new_vault(self):
        # The recovery ladder's backup rung: the passphrase is lost, the vault is reset (a new key, every
        # credential cleared), a new passphrase is set — and a backup taken under the old vault puts every
        # credential back, opened with what was in force when it was taken.
        for secret_field in ("passphrase", "recovery_code"):
            with self.subTest(secret_field), api_client() as (client, _):
                user_id = self._seed(client)
                code = client.post("/api/auth/vault/recovery-code").json()["recovery_code"]
                payload = self._export(client)
                reset = client.post("/api/auth/vault/reset", json={"reason": "lost", "confirm": "RESET VAULT"})
                self.assertEqual(reset.status_code, 200, reset.text)
                client.post("/api/auth/vault/set-passphrase", json={"passphrase": OTHER_PASSPHRASE})

                secret = PASSPHRASE if secret_field == "passphrase" else code
                r = client.post("/api/import-export/restore/credentials",
                                json={"data": payload, secret_field: secret})
                self.assertEqual(r.status_code, 200, r.text)
                self.assertEqual(self._stored_secrets(client, user_id), (TOKEN, APP_SECRET))

    # ---- the passphrase a file carries -----------------------------------

    def _left_out(self, client):
        return client.get("/api/import-export/backup/status").json()["credentials_left_out"]

    def test_no_backup_carries_a_passphrase_that_fails_the_current_rule(self):
        # The file carries the passphrase slot to wherever it is kept, open to offline guessing, so it is
        # held to the rule in force — judged at the last unlock, the only moment it can be. The backup is
        # still written, without the credentials.
        from unittest import mock

        with api_client() as (client, _):
            with mock.patch.object(cs, "passphrase_shortfall", return_value=None):
                client.post("/api/auth/vault/set-passphrase", json={"passphrase": "passwordpassword1234"})
            client.post("/api/auth/vault/lock")
            client.post("/api/auth/vault/unlock", json={"passphrase": "passwordpassword1234"})

            self.assertEqual(self._left_out(client)["code"], "weak_passphrase")
            r = client.get("/api/import-export/backup")
            self.assertEqual(r.status_code, 200, r.text)
            with zipfile.ZipFile(io.BytesIO(r.content)) as zf:
                self.assertNotIn(ACCOUNTS_CREDENTIALS_MEMBER, zf.namelist())
            tasks = client.get("/api/tasks").json()
            self.assertIn("vault_passphrase_change", [t["id"] for t in tasks["tasks"]])

    def test_a_passphrase_not_yet_checked_under_the_current_rule_is_asked_for_by_a_dismissable_task(self):
        # Nothing is known to be wrong, so the reminder can be put away; a backup still leaves the
        # credentials out until the passphrase is typed, whether or not it is.
        from backend.db import control_database as cdb

        with api_client() as (client, _):
            self._seed(client)
            with cdb.get_control_db() as conn:
                conn.execute("UPDATE vault_slot SET strength_basis = 'rule-1'")
            self.assertTrue(client.get("/api/auth/status").json()["user"]["vault_passphrase_needs_check"])
            task = next(t for t in client.get("/api/tasks").json()["tasks"] if t["id"] == "vault_passphrase_check")
            self.assertEqual(client.post(f"/api/tasks/dismiss/{task['dismiss_key']}").status_code, 200)
            self.assertNotIn("vault_passphrase_check", [t["id"] for t in client.get("/api/tasks").json()["tasks"]])
            self.assertEqual(self._left_out(client)["code"], "passphrase_unchecked")

            client.post("/api/auth/vault/lock")
            client.post("/api/auth/vault/unlock", json={"passphrase": PASSPHRASE})
            self.assertFalse(client.get("/api/auth/status").json()["user"]["vault_passphrase_needs_check"])
            self.assertIsNone(self._left_out(client))

    def test_the_developer_tool_puts_a_passphrase_in_the_state_a_rule_change_leaves_it_in(self):
        # Its only use is exercising the check, so it is tested by the check working against it: if what it
        # writes stopped reading as unchecked, the tool would succeed and change nothing. Absent unless
        # developer options are on, since it touches every member's slot.
        from unittest import mock
        from backend import app_config

        with api_client() as (client, _):
            self._seed(client)
            path = "/api/auth/vault/developer/mark-passphrases-unchecked"
            with mock.patch.object(app_config, "developer_options_enabled", return_value=False):
                self.assertEqual(client.post(path).status_code, 404)
            self.assertIsNone(self._left_out(client))

            with mock.patch.object(app_config, "developer_options_enabled", return_value=True):
                r = client.post(path)
            self.assertEqual(r.status_code, 200, r.text)
            self.assertTrue(r.json()["user"]["vault_passphrase_needs_check"])
            # As the restart that brings a rule change does.
            self.assertFalse(r.json()["user"]["vault_unlocked"])
            self.assertEqual(self._left_out(client)["code"], "passphrase_unchecked")

            client.post("/api/auth/vault/unlock", json={"passphrase": PASSPHRASE})
            self.assertIsNone(self._left_out(client))

    # ---- refusals -------------------------------------------------------

    def test_a_foreign_backup_without_a_passphrase_asks_for_one(self):
        with api_client() as (client, _):
            self._seed(client)
            payload = self._export(client)

        with api_client() as (client, _):
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": OTHER_PASSPHRASE})
            r = client.post("/api/import-export/restore/credentials", json={"data": payload})
            self.assertEqual(r.status_code, 400)
            self.assertEqual(r.json()["detail"]["code"], "backup_secret_required")

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
            self.assertEqual(r.json()["detail"]["code"], "incorrect_backup_secret")

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
            self.assertEqual(self._stored_secrets(client, user_id), (TOKEN, APP_SECRET))

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
            with in_browser_session(client):
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
