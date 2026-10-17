"""
The accounts part of a backup: identities, the perimeter, backup keys, and the data-source credentials with
the vault that opens them (`services/accounts_backup.py`).

What these defend:

  * **Restore replaces.** Onto an empty install or the one the file came from, the people, their ways in,
    the sign-in setting, the vault and the credentials end up exactly as exported, and everyone is signed
    out. A credential linked since is cleared rather than left under a key nothing here opens.
  * **No lockout.** A file that turns sign-in on is restored only with an administrator's password from it,
    checked before anything is touched.
  * **The export gate holds without holding the backup.** A file carries the vault only when the
    exporter's passphrase clears the current rule and the exporter can open the vault; otherwise it is
    written without the credentials, and restoring it leaves the vault and credentials on the target alone
    unless nobody who could open them is left.
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
        self.assertEqual(status["credentials_left_out"]["code"], "weak_passphrase")
        self.assertFalse(json.loads(members["meta.json"])["credentials_included"])
        self.assertNotIn("accounts/credentials.json", members)
        self.assertNotIn(b"passwordpassword1234", b"".join(members.values()))
        self.assertIn("sections/transactions.ndjson", members)

    def test_someone_who_cannot_open_the_vault_backs_up_everything_but_the_credentials(self):
        with api_client(base_url=SITE) as (client, _):
            self._seed_vault(client)
            sam = client.post("/api/auth/identities", json={"name": "Sam"}).json()["identity"]
            client.post("/api/auth/select-identity", json={"user_id": sam["id"]})
            status = client.get("/api/import-export/backup/status").json()
            members = _members(self._export(client))
        self.assertEqual(status["credentials_left_out"]["code"], "vault_access_required")
        self.assertNotIn("accounts/credentials.json", members)

    # ---- a backup without the credentials -------------------------------

    def test_without_credentials_a_restore_keeps_the_vault_here(self):
        # Sam's backup carries everyone, and the owner of the vault among them, so the vault and the
        # credential stay as they are.
        with api_client(base_url=SITE) as (client, _):
            owner = self._seed_vault(client)
            sam = client.post("/api/auth/identities", json={"name": "Sam"}).json()["identity"]
            client.post("/api/auth/select-identity", json={"user_id": sam["id"]})
            content = self._export(client)
            slots = cs.export_vault_slots(owner)

            r = self._restore_accounts(client, content)
            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual(self._without_site(cs.export_vault_slots(owner)), self._without_site(slots))
            client.post("/api/auth/select-identity", json={"user_id": owner})
            client.post("/api/auth/vault/unlock", json={"passphrase": PASSPHRASE})
            self.assertEqual(self._stored_token(client, owner), TOKEN)

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
            r = self._restore_accounts(client, content)
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
            with get_db() as conn:
                later = conn.execute("SELECT * FROM connection WHERE id = 'conn-2'").fetchone()
            # The row stays, since a data restore never removes a connection, but its credential was sealed
            # under nothing the restored vault holds.
            self.assertIsNone(later["credential_enc"])
            self.assertEqual(later["reauth_required"], 1)

            client.post("/api/auth/select-identity", json={"user_id": user_id})
            client.post("/api/auth/vault/unlock", json={"passphrase": PASSPHRASE})
            self.assertEqual(self._stored_token(client, user_id), TOKEN)

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
