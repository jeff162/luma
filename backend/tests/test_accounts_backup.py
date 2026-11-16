"""
The accounts part of a backup: identities, the perimeter, backup keys, and the data-source credentials with
the vault that opens them (`services/accounts_backup.py`).

What these defend:

  * **Restore replaces.** Onto an empty install or the one the file came from, the people, their ways in,
    the sign-in setting, the vault and the credentials end up exactly as exported, and everyone is signed
    out. A credential linked since is cleared rather than left under a key nothing here opens.
  * **No lockout.** A file that turns sign-in on is restored only with an administrator's password from it,
    checked before anything is touched.
  * **Every way in that holds up goes in.** A file carries every member's recovery code and passkeys, and
    each passphrase that passes the current rule, or every passphrase when the file is encrypted. With no
    way in left the file is written without the credentials, and restoring it leaves the vault and
    credentials on the target alone unless nobody who could open them is left.
  * **Coverage.** Every table of the control database is either carried or left out for a stated reason.
"""

from __future__ import annotations

import base64
import io
import json
import unittest
import zipfile

from backend.db import control_database as cdb
from backend.db.database import get_db
from backend.routers.import_export.backup import BACKUP_SECTION_NAMES
from backend.services import accounts_backup
from backend.services import crypto_service as cs
from backend.tests._api_client import STRONG_PASSPHRASE, api_client, in_browser_session

PASSPHRASE = STRONG_PASSPHRASE
OTHER_PASSPHRASE = "robin keeps a different long vault passphrase"
ADMIN_PASSWORD = "admin-password-123"
TOKEN = "access-sandbox-TEST-TOKEN"
APP_SECRET = "app-secret-value"
SITE = "https://luma.local"
PRF = base64.b64encode(b"\x5a" * 32).decode()

# Control-database tables a backup does not carry, each with its reason. Every other table must be carried
# by the accounts part, and the coverage test below fails on one that is neither, which is the point: a new
# table cannot be left out of the backup without someone deciding it should be.
CONTROL_TABLES_LEFT_OUT = {
    # The workspace record names this machine's financial database by path. Restored identities are
    # attached to whichever record the target has.
    "tenant",
    # Signed-in browsers. A restore replaces the identities they were authenticated against, so it ends
    # them all rather than carrying any.
    "sign_in_session",
    # This install's own record of the backups it wrote, kept so a passphrase change can name the files it
    # strands. It describes files, not people, and must survive a restore — the moment it is most wanted.
    "credentials_export",
    # The workspace keys this install retired. Like the export record it describes this install's history,
    # and a restore must not erase the record that refuses an old file's credentials.
    "retired_vault_key",
    # Carried in part: the perimeter's two keys (`cdb.PERIMETER_SETTING_KEYS`). The rest describe the
    # machine — the session signing secret and cookie name, the proxy certificate accepted here, error
    # counters, update checks.
    "app_setting",
}
# Carried by the accounts part's credentials, which hold the exporter's slots.
CONTROL_TABLES_CARRIED = {table for _part, table in cdb.IDENTITY_TABLES} | {"vault_slot"}


def _members(content: bytes) -> dict[str, bytes]:
    with zipfile.ZipFile(io.BytesIO(content)) as zf:
        return {name: zf.read(name) for name in zf.namelist()}


class AccountsBackupTests(unittest.TestCase):
    def setUp(self):
        cs.lock_all()

    def tearDown(self):
        cs.lock_all()

    # ---- fixtures -------------------------------------------------------

    def _me(self, client) -> dict:
        return client.get("/api/auth/me").json()["user"]

    def _seed_vault(self, client) -> str:
        """A vault with a passphrase, a recovery code and a passkey, one connection credential and one
        provider secret. Returns the user id."""
        client.post("/api/auth/vault/set-passphrase", json={"passphrase": PASSPHRASE})
        user_id = self._me(client)["id"]
        client.post("/api/auth/vault/recovery-code")
        registered = client.post("/api/auth/vault/passkey/register", json={
            "credential_id": "cred-1", "prf_output": PRF, "prf_salt": "c2FsdA==", "label": "Laptop",
        })
        self.assertEqual(registered.status_code, 200, registered.text)
        with in_browser_session(client):
            credential, credential_enc = cs.encrypt_connection_credential({"id": user_id}, "plaid", "ext-1", TOKEN)
        with get_db() as conn:
            conn.execute(
                "INSERT INTO connection (id, provider, external_id, credential, credential_enc, institution)"
                " VALUES ('conn-1', 'plaid', 'ext-1', ?, ?, 'Northgate Bank')",
                (credential, credential_enc),
            )
        client.post("/api/providers/plaid/config", json={"client_id": "cid", "secret": APP_SECRET})
        return user_id

    def _seed_source(self, client) -> dict:
        """An install with every kind of thing the accounts part carries: two identities, a preference,
        a backup key, the vault and credentials, then sign-in on with the first identity as an administrator
        using an authenticator, recovery codes and a sign-in passkey."""
        admin_id = self._seed_vault(client)
        sam = client.post("/api/auth/identities", json={"name": "Sam"}).json()["identity"]
        client.post("/api/auth/preferences", json={"key": "ui.example", "value": {"columns": 3}})
        keypair = client.post("/api/import-export/backup/keypair", json={"key_size": 2048}).json()
        created = client.post("/api/import-export/backup/recipients", json={
            "label": "Offsite", "public_key": keypair["public_key"],
        })
        self.assertEqual(created.status_code, 200, created.text)
        enabled = client.post("/api/auth/enable", json={
            "enabled": True, "claim_user_id": admin_id, "admin_password": ADMIN_PASSWORD, "initial_passwords": {},
        })
        self.assertEqual(enabled.status_code, 200, enabled.text)
        totp = cdb.begin_totp_setup(admin_id)["secret"]
        cdb.enable_totp(admin_id, totp)
        cdb.replace_recovery_codes(admin_id)
        cdb.add_app_passkey(admin_id, credential_id="login-cred", public_key="cHVibGlj", label="Phone")
        return {
            "admin_id": admin_id, "sam_id": sam["id"], "totp": totp,
            "identities": cdb.export_identities(),
            "slots": cs.export_vault_slots(admin_id),
            "recipients": client.get("/api/import-export/backup/recipients").json(),
        }

    def _export(self, client) -> bytes:
        r = client.get("/api/import-export/backup")
        self.assertEqual(r.status_code, 200, r.text)
        return r.content

    def _restore_accounts(self, client, content: bytes, **form):
        """Restore only the accounts part of a backup."""
        return self._restore(client, content, include_data=False, include_accounts=True, **form)

    def _restore(self, client, content: bytes, **form):
        return client.post(
            "/api/import-export/restore-file",
            files={"file": ("backup.zip", content, "application/zip")},
            data={key: str(value) if not isinstance(value, bool) else ("true" if value else "false")
                  for key, value in form.items()},
        )

    def _sign_in_as_admin(self, client, totp: str) -> None:
        r = client.post("/api/auth/login", json={"username": "Tester", "password": ADMIN_PASSWORD})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.json().get("requires_2fa"))
        r = client.post("/api/auth/2fa/verify", json={"code": cdb._totp_code(totp)})
        self.assertEqual(r.status_code, 200, r.text)

    def _stored_token(self, client, user_id) -> str:
        with get_db() as conn:
            row = conn.execute("SELECT * FROM connection WHERE id = 'conn-1'").fetchone()
        with in_browser_session(client):
            return cs.decrypt_connection_credential(
                {"id": user_id}, "plaid", "ext-1", row["credential"], row["credential_enc"],
            )

    @staticmethod
    def _without_site(slots):
        # The passkey's host is carried as a digest under a fresh salt, so it differs on every export.
        return [{k: v for k, v in s.items() if k != "site"} for s in slots]

    # ---- coverage -------------------------------------------------------

    def test_every_control_table_is_carried_or_left_out_for_a_reason(self):
        with api_client():
            with cdb.get_control_db() as conn:
                tables = {r["name"] for r in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
                )}
        self.assertEqual(tables - CONTROL_TABLES_LEFT_OUT, CONTROL_TABLES_CARRIED)

    # ---- what each file holds -------------------------------------------

    def test_a_backup_holds_both_parts(self):
        with api_client(base_url=SITE) as (client, _):
            self._seed_vault(client)
            members = _members(self._export(client))
        meta = json.loads(members["meta.json"])
        self.assertEqual(meta["kind"], "full")
        self.assertTrue(meta["credentials_included"])
        self.assertEqual(
            {n for n in members if n.startswith("sections/")},
            {f"sections/{s}.ndjson" for s in BACKUP_SECTION_NAMES},
        )
        self.assertEqual(
            {n for n in members if n.startswith("accounts/")},
            {f"accounts/{rows}.ndjson" for rows in accounts_backup.ROW_LISTS} | {"accounts/credentials.json"},
        )

    def test_no_usable_credential_appears_anywhere_in_the_file(self):
        # Asserted over every member's bytes, so a secret added to a new field still trips it.
        with api_client(base_url=SITE) as (client, _):
            self._seed_vault(client)
            members = _members(self._export(client))
        everything = b"".join(members.values())
        self.assertNotIn(TOKEN.encode(), everything)
        self.assertNotIn(APP_SECRET.encode(), everything)
        self.assertNotIn(PASSPHRASE.encode(), everything)

    def test_the_identities_carry_no_machine_detail(self):
        with api_client(base_url=SITE) as (client, _):
            self._seed_vault(client)
            members = _members(self._export(client))
        users = [json.loads(line) for line in members["accounts/users.ndjson"].splitlines()]
        self.assertTrue(users)
        self.assertTrue(all("tenant_id" not in u for u in users))

    # ---- the export gate ------------------------------------------------

    def test_a_passphrase_failing_the_rule_leaves_the_credentials_out_and_the_backup_in(self):
        from unittest import mock

        with api_client() as (client, _):
            with mock.patch.object(cs, "passphrase_shortfall", return_value=None):
                client.post("/api/auth/vault/set-passphrase", json={"passphrase": "passwordpassword1234"})
            client.post("/api/auth/vault/lock")
            client.post("/api/auth/vault/unlock", json={"passphrase": "passwordpassword1234"})
            status = client.get("/api/import-export/backup/status").json()
            members = _members(self._export(client))
        self.assertEqual([p["code"] for p in status["passphrases_left_out"]], ["weak_passphrase"])
        self.assertFalse(json.loads(members["meta.json"])["credentials_included"])
        self.assertNotIn("accounts/credentials.json", members)
        self.assertNotIn(b"passwordpassword1234", b"".join(members.values()))
        self.assertIn("sections/transactions.ndjson", members)

    def test_credentials_left_out_are_recorded_in_the_history(self):
        from unittest import mock

        with api_client() as (client, _):
            with mock.patch.object(cs, "passphrase_shortfall", return_value=None):
                client.post("/api/auth/vault/set-passphrase", json={"passphrase": "passwordpassword1234"})
            client.post("/api/auth/vault/lock")
            client.post("/api/auth/vault/unlock", json={"passphrase": "passwordpassword1234"})
            with in_browser_session(client):
                credential, credential_enc = cs.encrypt_connection_credential(self._me(client), "plaid", "ext-1", TOKEN)
            with get_db() as conn:
                conn.execute(
                    "INSERT INTO connection (id, provider, external_id, credential, credential_enc)"
                    " VALUES ('conn-1', 'plaid', 'ext-1', ?, ?)",
                    (credential, credential_enc),
                )
            self._export(client)
            history = client.get("/api/import-export/backup/history").json()["backups"]
        self.assertEqual(history[0]["credentials_left_out"], "no_strong_unlock")

    def test_someone_who_cannot_open_the_vault_still_backs_up_the_credentials(self):
        # The file carries the slots of those who can, so Sam's backup restores the vault for them.
        with api_client(base_url=SITE) as (client, _):
            owner = self._seed_vault(client)
            sam = client.post("/api/auth/identities", json={"name": "Sam"}).json()["identity"]
            client.post("/api/auth/select-identity", json={"user_id": sam["id"]})
            status = client.get("/api/import-export/backup/status").json()
            members = _members(self._export(client))
        self.assertIsNone(status["credentials_left_out"])
        slots = json.loads(members["accounts/credentials.json"])["vault_slots"]
        self.assertEqual({s["user_id"] for s in slots}, {owner})

    # ---- which ways into the vault a backup carries ---------------------

    def _add_member(self, client, name: str, passphrase: str) -> str:
        """A second member with vault access, granted by the first, who must be unlocked."""
        member = client.post("/api/auth/identities", json={"name": name}).json()["identity"]
        cs.set_passphrase(member["id"], passphrase)
        with in_browser_session(client):
            cs.grant_access(self._me(client)["id"], cs.pending_access_requests()[0]["slot_id"])
        return member["id"]

    def test_every_members_validated_passphrase_goes_in_and_opens_the_vault_after_a_restore(self):
        with api_client(base_url=SITE) as (client, _):
            owner = self._seed_vault(client)
            robin = self._add_member(client, "Robin", OTHER_PASSPHRASE)
            content = self._export(client)
            slots = json.loads(_members(content)["accounts/credentials.json"])["vault_slots"]
            self.assertIn((robin, "passphrase"), {(s["user_id"], s["method"]) for s in slots})

            r = self._restore_accounts(client, content)
            self.assertEqual(r.status_code, 200, r.text)
            client.post("/api/auth/select-identity", json={"user_id": robin})
            r = client.post("/api/auth/vault/unlock", json={"passphrase": OTHER_PASSPHRASE})
            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual(self._stored_token(client, robin), TOKEN)
        self.assertIn(owner, {s["user_id"] for s in slots})

    def test_an_unencrypted_backup_leaves_out_an_unvalidated_passphrase_and_an_encrypted_one_keeps_it(self):
        with api_client(base_url=SITE) as (client, _):
            owner = self._seed_vault(client)
            with cdb.get_control_db() as conn:
                conn.execute("UPDATE vault_slot SET strength_basis = 'rule-1' WHERE method = 'passphrase'")
            status = client.get("/api/import-export/backup/status").json()
            plain = json.loads(_members(self._export(client))["accounts/credentials.json"])["vault_slots"]
            keypair = client.post("/api/import-export/backup/keypair", json={"key_size": 2048}).json()
            client.post("/api/import-export/backup/recipients", json={
                "label": "Offsite", "public_key": keypair["public_key"],
            })
            encrypted = client.get("/api/import-export/backup", params={"encrypted": "true"})
            self.assertEqual(encrypted.status_code, 200, encrypted.text)
            exports = cdb.credentials_exports_detail()
        # The recovery code and passkey still carry the credentials.
        self.assertIsNone(status["credentials_left_out"])
        self.assertEqual(status["passphrases_left_out"], [
            {"user_id": owner, "name": "Tester", "code": "passphrase_unchecked", "own": True},
        ])
        self.assertEqual(sorted(s["method"] for s in plain), ["passkey", "recovery"])
        # Only the encrypted file carries the passphrase, so only it is recorded against it.
        self.assertEqual(len(exports), 1)

    # ---- a backup without the credentials -------------------------------

    def test_without_credentials_a_restore_that_removes_every_vault_member_clears_them(self):
        # Onto another install whose vault belongs to someone the file does not name: nothing could open
        # that install's credentials afterwards, so they go, as a vault reset leaves them.
        with api_client(base_url=SITE) as (client, _):
            self._seed_vault(client)
            sam = client.post("/api/auth/identities", json={"name": "Sam"}).json()["identity"]
            client.post("/api/auth/select-identity", json={"user_id": sam["id"]})
            content = self._export(client)

        with api_client(base_url=SITE) as (client, _):
            self._seed_vault(client)
            r = self._restore_accounts(client, content, include_credentials=False)
            self.assertEqual(r.status_code, 200, r.text)
            self.assertFalse(cs.vault_configured())
            with get_db() as conn:
                row = conn.execute("SELECT * FROM connection WHERE id = 'conn-1'").fetchone()
                secret = conn.execute("SELECT secret_enc FROM provider_config").fetchone()
        self.assertIsNone(row["credential_enc"])
        self.assertEqual(row["reauth_required"], 1)
        self.assertIsNone(secret["secret_enc"])

    # ---- restoring onto an empty install --------------------------------

    def test_a_full_restore_onto_a_fresh_install_brings_back_the_whole_system(self):
        with api_client(base_url=SITE) as (client, _):
            source = self._seed_source(client)
            content = self._export(client)

        with api_client(base_url=SITE) as (client, _):
            local_identity = self._me(client)["id"]

            r = self._restore(client, content, include_accounts=True)
            self.assertEqual(r.status_code, 400, r.text)
            self.assertEqual(r.json()["detail"]["code"], "admin_password_required")
            self.assertEqual(r.json()["detail"]["admins"], ["Tester"])
            r = self._restore(client, content, include_accounts=True,
                              admin_username="Tester", admin_password="not-it")
            self.assertEqual(r.json()["detail"]["code"], "incorrect_admin_password")
            # Refused before anything was touched.
            self.assertEqual(self._me(client)["id"], local_identity)
            self.assertFalse(cdb.auth_required())

            # The file was made with sign-in on and this install has it off; the perimeter comes with the
            # file, so that is no reason to stop.
            r = self._restore(client, content, include_accounts=True,
                              admin_username="tester", admin_password=ADMIN_PASSWORD)
            self.assertEqual(r.status_code, 200, r.text)
            self.assertTrue(r.json()["signed_out"])

            self.assertEqual(cdb.export_identities(), source["identities"])
            self.assertIsNone(cdb.get_user_by_id(local_identity))
            self.assertEqual(self._without_site(cs.export_vault_slots(source["admin_id"])),
                             self._without_site(source["slots"]))
            self.assertEqual(cs.export_vault_slots(source["sam_id"]), [])
            self.assertEqual(client.get("/api/auth/me").status_code, 401)

            self._sign_in_as_admin(client, source["totp"])
            self.assertEqual(client.get("/api/import-export/backup/recipients").json(), source["recipients"])
            self.assertEqual(client.get("/api/auth/preferences").json()["preferences"]["ui.example"], {"columns": 3})
            # The vault opens with the passphrase it had, with nothing asked at restore, and the credential
            # was copied as it was sealed.
            self.assertEqual(client.post("/api/auth/vault/unlock", json={"passphrase": PASSPHRASE}).status_code, 200)
            self.assertEqual(self._stored_token(client, source["admin_id"]), TOKEN)

    def test_the_accounts_alone_restore_without_touching_the_financial_data(self):
        with api_client(base_url=SITE) as (client, _):
            source = self._seed_source(client)
            content = self._export(client)

        with api_client(base_url=SITE) as (client, _):
            # Another install's file over a ledger with data in it: the guard that asks before erasing a
            # different system's ledger has nothing to ask about, since the ledger stays.
            with get_db() as conn:
                conn.execute("INSERT INTO account (id, name, display_name) VALUES ('acct-here', 'Here', 'Here')")
            r = self._restore_accounts(client, content, admin_username="Tester", admin_password=ADMIN_PASSWORD)
            self.assertEqual(r.status_code, 200, r.text)
            self.assertNotIn("restored_counts", r.json())
            self.assertEqual(cdb.export_identities(), source["identities"])
            with get_db() as conn:
                self.assertTrue(conn.execute("SELECT 1 FROM account WHERE id = 'acct-here'").fetchone())
                # The connection the file holds credentials for is created, so they have a row to sit on.
                self.assertTrue(conn.execute("SELECT credential_enc FROM connection WHERE id = 'conn-1'").fetchone()[0])

    # ---- restoring over the install it came from ------------------------

    def test_restoring_over_the_same_install_puts_it_back_as_it_was(self):
        with api_client(base_url=SITE) as (client, _):
            user_id = self._seed_vault(client)
            identities = cdb.export_identities()
            content = self._export(client)

            # Since the backup: a member joins, and a data source is linked.
            newcomer = client.post("/api/auth/identities", json={"name": "Newcomer"}).json()["identity"]
            client.post("/api/auth/vault/unlock", json={"passphrase": PASSPHRASE})
            with in_browser_session(client):
                credential, credential_enc = cs.encrypt_connection_credential({"id": user_id}, "plaid", "ext-2", "later")
            with get_db() as conn:
                conn.execute(
                    "INSERT INTO connection (id, provider, external_id, credential, credential_enc)"
                    " VALUES ('conn-2', 'plaid', 'ext-2', ?, ?)",
                    (credential, credential_enc),
                )

            r = self._restore(client, content, include_accounts=True)
            self.assertEqual(r.status_code, 200, r.text)

            self.assertEqual(cdb.export_identities(), identities)
            self.assertIsNone(cdb.get_user_by_id(newcomer["id"]))
            self.assertEqual(client.get("/api/auth/me").status_code, 401, "everyone is signed out")
            # Data and credentials both came back, so the connections are the backup's and no others. The one
            # linked since is gone and named, since access granted to it may still be live at the provider.
            self.assertEqual(r.json()["removed_connections"], ["plaid"])
            with get_db() as conn:
                self.assertIsNone(conn.execute("SELECT 1 FROM connection WHERE id = 'conn-2'").fetchone())
                self.assertEqual(
                    [json.loads(row["detail"]) for row in conn.execute(
                        "SELECT detail FROM connection_sync_log WHERE connection_id = 'conn-2'")],
                    [{"revoked": False, "reason": "restored"}],
                )
                self.assertEqual(conn.execute("SELECT institution FROM connection WHERE id = 'conn-1'").fetchone()[0],
                                 "Northgate Bank")

            client.post("/api/auth/select-identity", json={"user_id": user_id})
            client.post("/api/auth/vault/unlock", json={"passphrase": PASSPHRASE})
            self.assertEqual(self._stored_token(client, user_id), TOKEN)

    def test_without_the_credentials_a_restore_keeps_the_connections_it_does_not_name(self):
        # The credentials left here are the half of each row this restore does not replace, so the rows
        # they sit on stay.
        with api_client(base_url=SITE) as (client, _):
            self._seed_vault(client)
            content = self._export(client)
            with get_db() as conn:
                conn.execute("INSERT INTO connection (id, provider, external_id, credential_enc)"
                             " VALUES ('conn-2', 'plaid', 'ext-2', 'kept-token')")

            r = self._restore(client, content, include_accounts=True, include_credentials=False)
            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual(r.json()["removed_connections"], [])
            with get_db() as conn:
                self.assertEqual(conn.execute("SELECT credential_enc FROM connection WHERE id = 'conn-2'")
                                 .fetchone()[0], "kept-token")

    def test_a_credential_linked_after_the_backup_is_cleared_for_reconnection(self):
        with api_client(base_url=SITE) as (client, _):
            user_id = self._seed_vault(client)
            content = self._export(client)
            client.post("/api/auth/vault/unlock", json={"passphrase": PASSPHRASE})
            with in_browser_session(client):
                credential, credential_enc = cs.encrypt_connection_credential({"id": user_id}, "plaid", "ext-2", "later")
            with get_db() as conn:
                conn.execute(
                    "INSERT INTO connection (id, provider, external_id, credential, credential_enc)"
                    " VALUES ('conn-2', 'plaid', 'ext-2', ?, ?)",
                    (credential, credential_enc),
                )

            r = self._restore_accounts(client, content)
            self.assertEqual(r.status_code, 200, r.text)
            with get_db() as conn:
                later = conn.execute("SELECT * FROM connection WHERE id = 'conn-2'").fetchone()
        self.assertIsNone(later["credential_enc"])
        self.assertEqual(later["reauth_required"], 1)

    def test_declining_the_credentials_keeps_the_vault_and_credentials_here(self):
        # The file carries credentials; asked not to restore them, it restores as a file without them.
        with api_client(base_url=SITE) as (client, _):
            user_id = self._seed_vault(client)
            content = self._export(client)
            self.assertIn("accounts/credentials.json", _members(content))
            client.post("/api/auth/vault/unlock", json={"passphrase": PASSPHRASE})
            with in_browser_session(client):
                credential, credential_enc = cs.encrypt_connection_credential({"id": user_id}, "plaid", "ext-1", "later")
            with get_db() as conn:
                conn.execute("UPDATE connection SET credential = ?, credential_enc = ? WHERE id = 'conn-1'",
                             (credential, credential_enc))

            r = self._restore_accounts(client, content, include_credentials=False)
            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual(r.json()["accounts"]["credentials"], 0)
            client.post("/api/auth/select-identity", json={"user_id": user_id})
            client.post("/api/auth/vault/unlock", json={"passphrase": PASSPHRASE})
            self.assertEqual(self._stored_token(client, user_id), "later")

    def test_a_backup_can_restore_only_its_financial_data(self):
        with api_client(base_url=SITE) as (client, _):
            self._seed_vault(client)
            content = self._export(client)
            newcomer = client.post("/api/auth/identities", json={"name": "Newcomer"}).json()["identity"]
            identities = cdb.export_identities()

            r = self._restore(client, content)
            self.assertEqual(r.status_code, 200, r.text)
            self.assertNotIn("signed_out", r.json())
            self.assertEqual(cdb.export_identities(), identities)
            self.assertIsNotNone(cdb.get_user_by_id(newcomer["id"]))
            self.assertEqual(client.get("/api/auth/me").status_code, 200)

    def test_restoring_names_users_whose_usernames_traded_places(self):
        # The unique username column would collide midway through a row-by-row update.
        with api_client(base_url=SITE) as (client, _):
            first = self._me(client)
            second = client.post("/api/auth/identities", json={"name": "Second"}).json()["identity"]
            self._seed_vault(client)
            identities = cdb.export_identities()
            content = self._export(client)
            with cdb.get_control_db() as conn:
                conn.execute("UPDATE user_account SET username = 'swap' WHERE id = ?", (first["id"],))
                conn.execute("UPDATE user_account SET username = ? WHERE id = ?", (first["username"], second["id"]))
                conn.execute("UPDATE user_account SET username = ? WHERE id = ?", (second["username"], first["id"]))

            r = self._restore_accounts(client, content)
            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual(cdb.export_identities(), identities)


    # ---- a retired key, and what a backup needs -----------------------

    def _restore_after_retirement(self, retire, **form) -> tuple[dict, str, int]:
        """Restore a backup's accounts part after `retire` retired its key; the response, the stored
        credential, and how many retirements are still recorded."""
        with api_client(base_url=SITE) as (client, _):
            user_id = self._seed_vault(client)
            content = self._export(client)
            client.post("/api/auth/vault/unlock", json={"passphrase": PASSPHRASE})
            with in_browser_session(client):
                retire(user_id)
            r = self._restore_accounts(client, content, **form)
            with get_db() as conn:
                credential_enc = conn.execute("SELECT credential_enc FROM connection WHERE id = 'conn-1'").fetchone()[0]
            with cdb.get_control_db() as conn:
                retired = conn.execute("SELECT COUNT(*) FROM retired_vault_key").fetchone()[0]
        return r, credential_enc, retired

    UNTRUSTED = ((lambda uid: cs.reset_vault(uid, reason="compromised"), "compromised"),
                 (lambda uid: cs.rotate_dek(uid, reason="replaced"), "replaced"))

    def test_credentials_under_a_key_retired_as_untrusted_are_asked_about_before_anything_changes(self):
        for retire, reason in self.UNTRUSTED:
            with self.subTest(reason=reason):
                r, _credential, retired = self._restore_after_retirement(retire)
                self.assertEqual(r.status_code, 409, r.text)
                detail = r.json()["detail"]
                self.assertEqual((detail["code"], detail["reason"]), ("credentials_retired", reason))
                self.assertTrue(detail["retired_at"])
                self.assertEqual(detail["confirm_phrase"], "RESTORE ANYWAY")
                self.assertGreater(retired, 0)

    def test_declining_withholds_them(self):
        for retire, reason in self.UNTRUSTED:
            with self.subTest(reason=reason):
                r, credential_enc, _retired = self._restore_after_retirement(
                    retire, restore_retired_credentials=False)
                self.assertEqual(r.status_code, 200, r.text)
                self.assertEqual(r.json().get("credentials_withheld"), reason)
                if reason == "compromised":
                    self.assertIsNone(credential_enc, "the reset's clearing stands")

    def test_choosing_to_restore_them_puts_them_back_and_forgets_the_retirement(self):
        # Forgotten, because the key is this vault's again: a backup taken under it from now on must restore.
        for retire, reason in self.UNTRUSTED:
            with self.subTest(reason=reason):
                r, credential_enc, retired = self._restore_after_retirement(
                    retire, restore_retired_credentials=True, retired_credentials_confirm="restore anyway")
                self.assertEqual(r.status_code, 200, r.text)
                self.assertNotIn("credentials_withheld", r.json())
                self.assertIsNotNone(credential_enc)
                self.assertEqual(retired, 0)

    def test_restoring_them_needs_the_typed_phrase(self):
        r, _credential, retired = self._restore_after_retirement(
            lambda uid: cs.rotate_dek(uid, reason="replaced"), restore_retired_credentials=True)
        self.assertEqual(r.status_code, 400, r.text)
        self.assertEqual(r.json()["detail"]["code"], "confirmation_required")
        self.assertGreater(retired, 0)

    def test_credentials_under_a_key_lost_or_routinely_replaced_are_restored_without_asking(self):
        for retire in (lambda uid: cs.reset_vault(uid, reason="lost"),
                       lambda uid: cs.rotate_dek(uid, reason="routine")):
            with self.subTest():
                r, credential_enc, _retired = self._restore_after_retirement(retire)
                self.assertEqual(r.status_code, 200, r.text)
                self.assertNotIn("credentials_withheld", r.json())
                self.assertIsNotNone(credential_enc)

    def test_the_reset_dialog_lists_one_backup_per_passphrase_with_what_opens_it(self):
        with api_client(base_url=SITE) as (client, _):
            self._seed_vault(client)
            self._export(client)
            self._export(client)
            changed = client.post("/api/auth/vault/change-passphrase", json={
                "old_passphrase": PASSPHRASE, "new_passphrase": PASSPHRASE + "-renewed",
            })
            self.assertEqual(changed.status_code, 200, changed.text)
            self._export(client)
            backups = cs.credentials_backups_by_passphrase()
        self.assertEqual([(b["passphrase_current"], b["recovery"], b["passkeys"]) for b in backups],
                         [(True, "current", ["Laptop"]), (False, "current", ["Laptop"])])

    def test_a_passphrase_change_after_a_backup_asks_for_a_new_one_until_it_is_taken(self):
        with api_client(base_url=SITE) as (client, _):
            self._seed_vault(client)
            tasks = lambda: {t["id"] for t in client.get("/api/tasks").json()["tasks"]}  # noqa: E731
            self.assertNotIn("backup_due", tasks(), "no backup was ever taken")
            self._export(client)
            client.post("/api/auth/vault/change-passphrase", json={
                "old_passphrase": PASSPHRASE, "new_passphrase": PASSPHRASE + "-renewed",
            })
            self.assertIn("backup_due", tasks())
            self._export(client)
            self.assertNotIn("backup_due", tasks())


    def test_credentials_replaced_after_a_backup_ask_for_a_new_one(self):
        with api_client(base_url=SITE) as (client, _):
            self._seed_vault(client)
            tasks = lambda: {t["id"] for t in client.get("/api/tasks").json()["tasks"]}  # noqa: E731
            self._export(client)
            # Both stamps have one-second resolution; the export is moved back so the order is the test's.
            with cdb.get_control_db() as conn:
                conn.execute("UPDATE credentials_export SET exported_at = datetime('now', '-1 minute')")
            cdb.record_credentials_reissued()
            self.assertIn("backup_due", tasks())
            self._export(client)
            with cdb.get_control_db() as conn:
                conn.execute("UPDATE credentials_export SET exported_at = datetime('now', '+1 minute') "
                             "WHERE exported_at = (SELECT MAX(exported_at) FROM credentials_export)")
            self.assertNotIn("backup_due", tasks())

    def test_several_vault_changes_after_a_backup_raise_one_task(self):
        with api_client(base_url=SITE) as (client, _):
            self._seed_vault(client)
            self._export(client)
            with cdb.get_control_db() as conn:
                conn.execute("UPDATE credentials_export SET exported_at = datetime('now', '-1 minute')")
            client.post("/api/auth/vault/change-passphrase", json={
                "old_passphrase": PASSPHRASE, "new_passphrase": PASSPHRASE + "-renewed",
            })
            rotated = client.post("/api/auth/vault/rotate", json={"reason": "replaced"})
            self.assertEqual(rotated.status_code, 200, rotated.text)
            # Matched by prefix so the test also fails against a builder raising one task per event.
            due = [t for t in client.get("/api/tasks").json()["tasks"] if t["id"].startswith("backup_due")]
            self.assertEqual(len(due), 1)


class RestoringAdminCheckTests(unittest.TestCase):
    """`check_restoring_admin` on its own, for the shapes a file can take."""

    def _part(self, *, auth: str | None, users: list[dict]) -> dict:
        settings = [{"key": "auth_enabled", "value": auth}] if auth is not None else []
        return {"settings": settings, "users": users}

    def _admin(self, **overrides) -> dict:
        return {"username": "Admin", "role": "admin", "status": "active",
                "password_hash": cdb._hash_password(ADMIN_PASSWORD), **overrides}

    def test_a_file_with_sign_in_off_asks_for_nothing(self):
        accounts_backup.check_restoring_admin(self._part(auth="0", users=[self._admin()]), None, None)
        accounts_backup.check_restoring_admin(self._part(auth=None, users=[]), None, None)

    def test_only_an_active_administrator_with_a_password_counts(self):
        for user in (self._admin(role="member"), self._admin(status="disabled"),
                     self._admin(password_hash=cdb.UNSET_PASSWORD_SENTINEL)):
            with self.subTest(user=user), self.assertRaises(accounts_backup.AdminPasswordRequired):
                accounts_backup.check_restoring_admin(self._part(auth="1", users=[user]), "Admin", ADMIN_PASSWORD)
        accounts_backup.check_restoring_admin(self._part(auth="1", users=[self._admin()]), "admin", ADMIN_PASSWORD)


if __name__ == "__main__":
    unittest.main()
