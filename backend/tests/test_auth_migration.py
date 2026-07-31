"""
Profile->account migration, the unset-password (claim) primitive, and the forced password-change
login branch introduced with the security/deployment model.

These pin the invariants that make "turn on sign-in protection" safe: every local profile becomes a
real account (preferences preserved), a claimed profile becomes the admin, non-claimed accounts are
forced to set a password at next login, and an unset (sentinel) password can never be authenticated
against — only claimed through the forced-change flow.
"""

from __future__ import annotations

import os
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path

from backend.db import control_database as cdb
from backend.db import database


@contextmanager
def _isolated_stack():
    """Point both DBs at fresh temp files and make the tenant/legacy paths consistent, so a migration
    adopts the temp data DB (never the developer's real luma-data.db)."""
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


class ProfileMigrationTests(unittest.TestCase):
    def setUp(self):
        self._stack = _isolated_stack()
        self.data_path = self._stack.__enter__()

    def tearDown(self):
        self._stack.__exit__(None, None, None)

    def _set_pref(self, scope_id, key, value):
        with database.get_db(db_path=self.data_path) as conn:
            conn.execute(
                "INSERT INTO ui_preference (scope_id, pref_key, pref_value) VALUES (?, ?, ?)",
                (scope_id, key, value),
            )

    def _pref(self, scope_id, key):
        with database.get_db(db_path=self.data_path) as conn:
            row = conn.execute(
                "SELECT pref_value FROM ui_preference WHERE scope_id = ? AND pref_key = ?",
                (scope_id, key),
            ).fetchone()
        return row["pref_value"] if row else None

    def test_single_profile_migration_makes_admin_and_enables_auth(self):
        profile = cdb.create_local_preference_profile("Jeff")
        admin = cdb.migrate_profiles_to_accounts(profile["id"], "password123")

        self.assertEqual(admin["role"], "admin")
        self.assertFalse(admin["must_change_password"])
        self.assertTrue(cdb.auth_required())  # single account => needs the explicit flag
        self.assertEqual(cdb.list_local_preference_profiles(), [])

    def test_multi_profile_claim_and_forced_change(self):
        jeff = cdb.create_local_preference_profile("Jeff")
        sam = cdb.create_local_preference_profile("Sam")
        guest = cdb.create_local_preference_profile("Guest")

        admin = cdb.migrate_profiles_to_accounts(
            jeff["id"],
            "password123",
            initial_passwords={sam["id"]: "sam-password", guest["id"]: ""},
        )

        sam_acct = cdb.get_login_account("Sam")
        guest_acct = cdb.get_login_account("Guest")
        admin_acct = cdb.get_login_account("Jeff")

        # Claimed profile is the admin with a usable password and no forced change.
        self.assertEqual(admin["role"], "admin")
        self.assertTrue(admin_acct["password_set"])
        self.assertFalse(admin_acct["must_change_password"])

        # An initial password is stored and usable, but the account still must change it.
        self.assertTrue(sam_acct["password_set"])
        self.assertTrue(sam_acct["must_change_password"])
        self.assertIsNotNone(cdb.authenticate_user("Sam", "sam-password"))

        # A blank starting password leaves the account unset (claimable) and forced to change.
        self.assertFalse(guest_acct["password_set"])
        self.assertTrue(guest_acct["must_change_password"])
        self.assertIsNone(cdb.authenticate_user("Guest", ""))
        self.assertIsNone(cdb.authenticate_user("Guest", "anything"))

    def test_migration_rekeys_preferences_to_new_user(self):
        profile = cdb.create_local_preference_profile("Jeff")
        self._set_pref(profile["id"], "ui.theme", '"dark"')

        admin = cdb.migrate_profiles_to_accounts(profile["id"], "password123")

        self.assertEqual(self._pref(admin["id"], "ui.theme"), '"dark"')
        self.assertIsNone(self._pref(profile["id"], "ui.theme"))

    def test_migration_rejects_weak_admin_password_before_creating_anything(self):
        profile = cdb.create_local_preference_profile("Jeff")
        with self.assertRaises(ValueError):
            cdb.migrate_profiles_to_accounts(profile["id"], "short")  # < min_8
        # Nothing was created and the workspace is still in local mode.
        self.assertFalse(cdb.auth_required())
        self.assertEqual(len(cdb.list_local_preference_profiles()), 1)

    def test_unset_sentinel_never_verifies(self):
        # An account created blank stores the sentinel and cannot be authenticated against.
        cdb.enable_auth_mode()
        admin = cdb._create_user_with_tenant("Admin", "password123", role="admin", use_legacy_db_if_present=True)
        member = cdb._create_user_with_tenant(
            "Blank", "", role="member", tenant_id=admin["tenant_id"], must_change_password=True,
        )
        acct = cdb.get_login_account("Blank")
        self.assertFalse(acct["password_set"])
        self.assertTrue(acct["must_change_password"])
        self.assertFalse(cdb.password_is_set(cdb.UNSET_PASSWORD_SENTINEL))
        self.assertIsNone(cdb.authenticate_user("Blank", ""))
        self.assertEqual(member["role"], "member")

    def test_update_user_password_and_flag_semantics(self):
        cdb.enable_auth_mode()
        admin = cdb._create_user_with_tenant("Admin", "password123", role="admin", use_legacy_db_if_present=True)
        user = cdb._create_user_with_tenant("Member", "password123", role="member", tenant_id=admin["tenant_id"])

        # Blank reset makes the account claimable and implicitly forces a change.
        cdb.update_user(user["id"], password="")
        acct = cdb.get_login_account("Member")
        self.assertFalse(acct["password_set"])
        self.assertTrue(acct["must_change_password"])

        # Setting a real password clears the flag again.
        cdb.update_user(user["id"], password="newpassword1")
        acct = cdb.get_login_account("Member")
        self.assertTrue(acct["password_set"])
        self.assertFalse(acct["must_change_password"])

        # The flag can be toggled on its own (require change without changing the password).
        cdb.update_user(user["id"], must_change_password=True)
        acct = cdb.get_login_account("Member")
        self.assertTrue(acct["password_set"])
        self.assertTrue(acct["must_change_password"])

    def test_retired_multi_tenant_profile_falls_back(self):
        cdb.set_app_setting("security_profile", "multi_tenant")
        self.assertEqual(cdb.get_security_profile(), cdb.SECURITY_PROFILE_LOCAL_PRIVATE)

    def test_retired_household_profile_falls_back(self):
        cdb.set_app_setting("security_profile", "household_shared")
        self.assertEqual(cdb.get_security_profile(), cdb.SECURITY_PROFILE_LOCAL_PRIVATE)

    def test_totp_setup_includes_qr_svg(self):
        cdb.enable_auth_mode()
        admin = cdb._create_user_with_tenant("Admin", "password123", role="admin", use_legacy_db_if_present=True)
        setup = cdb.begin_totp_setup(admin["id"])
        self.assertTrue(setup["otpauth_uri"].startswith("otpauth://totp/"))
        self.assertTrue(setup["qr_svg"].startswith("data:image/svg+xml"))

    def test_data_provider_intent_roundtrip(self):
        self.assertFalse(cdb.get_data_provider_intended())  # default off
        cdb.set_data_provider_intended(True)
        self.assertTrue(cdb.get_data_provider_intended())
        cdb.set_data_provider_intended(False)
        self.assertFalse(cdb.get_data_provider_intended())


@contextmanager
def _client_stack():
    """Full-stack TestClient with both DBs isolated, tenant paths consistent, and a valid
    SESSION_SECRET so the runtime-config gate on the auth endpoints passes."""
    from fastapi.testclient import TestClient

    tmp = tempfile.TemporaryDirectory()
    data_path = str(Path(tmp.name) / "data.db")
    control_path = str(Path(tmp.name) / "control.db")
    tenant_root = Path(tmp.name) / "tenants"
    originals = (database.DB_PATH, cdb.DB_PATH, cdb.CONTROL_DB_PATH, cdb.TENANT_DATA_ROOT)
    prior_secret = os.environ.get("SESSION_SECRET")
    database.DB_PATH = data_path
    cdb.DB_PATH = data_path
    cdb.CONTROL_DB_PATH = control_path
    cdb.TENANT_DATA_ROOT = tenant_root
    os.environ["SESSION_SECRET"] = "test-session-secret-that-is-long-enough-xyz"
    database.init_db(data_path)
    cdb.init_control_db()
    from backend.main import app
    try:
        with TestClient(app) as client:
            yield client
    finally:
        database.DB_PATH, cdb.DB_PATH, cdb.CONTROL_DB_PATH, cdb.TENANT_DATA_ROOT = originals
        if prior_secret is None:
            os.environ.pop("SESSION_SECRET", None)
        else:
            os.environ["SESSION_SECRET"] = prior_secret
        tmp.cleanup()


class ForcedChangeLoginFlowTests(unittest.TestCase):
    def test_migrated_member_must_change_password_at_login(self):
        with _client_stack() as client:
            jeff = client.post("/api/auth/local-preference-profiles", json={"name": "Jeff"}).json()["profile"]
            sam = client.post("/api/auth/local-preference-profiles", json={"name": "Sam"}).json()["profile"]

            enable = client.post("/api/auth/enable", json={
                "enabled": True,
                "claim_profile_id": jeff["id"],
                "admin_password": "password123",
                "initial_passwords": {},
            })
            self.assertEqual(enable.status_code, 200, enable.text)
            self.assertEqual(enable.json()["user"]["username"], "Jeff")

            client.post("/api/auth/logout")

            # Sam has an unset (claimable) password: login accepts no password but demands a change.
            login = client.post("/api/auth/login", json={"username": "Sam", "password": ""})
            self.assertEqual(login.status_code, 200, login.text)
            self.assertTrue(login.json().get("requires_password_change"))

            changed = client.post("/api/auth/change-password", json={"new_password": "sam-new-password"})
            self.assertEqual(changed.status_code, 200, changed.text)
            self.assertEqual(changed.json()["user"]["username"], "Sam")
            self.assertFalse(changed.json()["user"]["must_change_password"])

            # The new password now authenticates normally with no forced change.
            client.post("/api/auth/logout")
            relogin = client.post("/api/auth/login", json={"username": "Sam", "password": "sam-new-password"})
            self.assertEqual(relogin.status_code, 200, relogin.text)
            self.assertEqual(relogin.json()["user"]["username"], "Sam")

    def test_enable_applies_chosen_password_policy(self):
        with _client_stack() as client:
            jeff = client.post("/api/auth/local-preference-profiles", json={"name": "Jeff"}).json()["profile"]
            # Picking 'none' lets a short admin password through, instead of the min_8 default.
            resp = client.post("/api/auth/enable", json={
                "enabled": True,
                "claim_profile_id": jeff["id"],
                "admin_password": "x",
                "initial_passwords": {},
                "password_policy": "none",
            })
            self.assertEqual(resp.status_code, 200, resp.text)
            self.assertEqual(resp.json()["user"]["username"], "Jeff")
            self.assertEqual(client.get("/api/auth/status").json()["password_policy"], "none")

    def test_enable_rejects_password_below_chosen_policy(self):
        with _client_stack() as client:
            jeff = client.post("/api/auth/local-preference-profiles", json={"name": "Jeff"}).json()["profile"]
            resp = client.post("/api/auth/enable", json={
                "enabled": True,
                "claim_profile_id": jeff["id"],
                "admin_password": "short",
                "initial_passwords": {},
                "password_policy": "strong",
            })
            self.assertEqual(resp.status_code, 400, resp.text)
            # Migration did not proceed — still local mode.
            self.assertFalse(client.get("/api/auth/status").json()["auth_enabled"])

    def test_data_provider_intent_endpoint_and_status(self):
        with _client_stack() as client:
            self.assertFalse(client.get("/api/auth/status").json()["data_provider_intended"])
            saved = client.post("/api/auth/data-provider-intent", json={"intended": True})
            self.assertEqual(saved.status_code, 200, saved.text)
            self.assertTrue(saved.json()["data_provider_intended"])
            self.assertTrue(client.get("/api/auth/status").json()["data_provider_intended"])


if __name__ == "__main__":
    unittest.main()
