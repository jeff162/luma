"""
Unified single-table identity model: the one-time local-profile -> user_account
unification, enable/disable-as-a-flag-flip, the dropped auth latch, the unset-password (claim)
primitive, the forced password-change login branch, and the pwless-session invalidation.

These pin the invariants that make the perimeter toggle safe: legacy local profiles fold into real
accounts (preferences preserved) and the table is retired; turning sign-in protection on claims an
admin and forces the rest to set a password; turning it off is a lossless flag flip; multiple
passwordless users never force auth on; and a perimeter-off (pwless) session stops working the moment
the perimeter comes up.
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


class IdentityModelTests(unittest.TestCase):
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

    def _seed_legacy_profile(self, name: str) -> str:
        """Recreate a physical local_preference_profile row as an older version would have left it,
        so _unify_local_profiles_into_users has something to migrate."""
        import uuid
        pid = str(uuid.uuid4())
        with cdb.get_control_db() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS local_preference_profile (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
                    created_at TEXT NOT NULL DEFAULT (datetime('now'))
                )
                """
            )
            conn.execute("INSERT INTO local_preference_profile (id, name) VALUES (?, ?)", (pid, name))
        return pid

    def _table_exists(self, name: str) -> bool:
        with cdb.get_control_db() as conn:
            return conn.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
            ).fetchone() is not None

    # --- one-time unification ------------------------------------------------

    def test_unify_creates_users_rekeys_prefs_and_drops_table(self):
        mark = self._seed_legacy_profile("Mark")
        sam = self._seed_legacy_profile("Sam")
        self._set_pref(mark, "ui.theme", '"dark"')
        self._set_pref(sam, "ui.theme", '"light"')

        cdb._unify_local_profiles_into_users()

        users = {u["username"]: u for u in cdb.list_users()}
        self.assertEqual(set(users), {"Mark", "Sam"})
        # Passwordless and not forced-to-change: an ordinary perimeter-off identity.
        self.assertFalse(cdb.get_login_account("Mark")["password_set"])
        self.assertFalse(cdb.get_login_account("Mark")["must_change_password"])
        # Preferences followed the identity from profile id to user id.
        self.assertEqual(self._pref(users["Mark"]["id"], "ui.theme"), '"dark"')
        self.assertEqual(self._pref(users["Sam"]["id"], "ui.theme"), '"light"')
        self.assertIsNone(self._pref(mark, "ui.theme"))
        # The legacy table is retired, and auth stays off (no latch).
        self.assertFalse(self._table_exists("local_preference_profile"))
        self.assertFalse(cdb.auth_required())

    def test_unify_is_idempotent_and_shares_one_tenant(self):
        self._seed_legacy_profile("Mark")
        self._seed_legacy_profile("Sam")
        cdb._unify_local_profiles_into_users()
        cdb._unify_local_profiles_into_users()  # no table now: a no-op, not a crash

        tenants = {u["tenant_id"] for u in (cdb.get_user_by_id(u["id"]) for u in cdb.list_users())}
        self.assertEqual(len(tenants), 1)  # one shared workspace, multiple identities

    def test_unify_folds_profile_into_same_named_existing_account(self):
        existing = cdb.create_local_identity("Mark")
        self._set_pref("legacy-scope", "ui.theme", '"dark"')
        # Point the seeded profile's preferences at it, then migrate.
        pid = self._seed_legacy_profile("Mark")
        self._set_pref(pid, "ui.density", '"compact"')

        cdb._unify_local_profiles_into_users()

        # No duplicate account; the profile's preferences fold into the existing user.
        self.assertEqual([u["username"] for u in cdb.list_users()], ["Mark"])
        self.assertEqual(self._pref(existing["id"], "ui.density"), '"compact"')

    # --- enable / disable as flag flips -------------------------------------

    def test_enable_with_admin_claims_and_forces_others(self):
        mark = cdb.create_local_identity("Mark")
        sam = cdb.create_local_identity("Sam")
        _guest = cdb.create_local_identity("Guest")

        admin = cdb.enable_auth_with_admin(
            mark["id"], "password123", initial_passwords={sam["id"]: "sam-password"}
        )

        self.assertEqual(admin["role"], "admin")
        self.assertTrue(cdb.auth_required())
        # Claimed identity: real password, admin, not forced to change.
        self.assertTrue(cdb.get_login_account("Mark")["password_set"])
        self.assertFalse(cdb.get_login_account("Mark")["must_change_password"])
        # Seeded member: usable password but still must change it.
        self.assertTrue(cdb.get_login_account("Sam")["password_set"])
        self.assertTrue(cdb.get_login_account("Sam")["must_change_password"])
        self.assertIsNotNone(cdb.authenticate_user("Sam", "sam-password"))
        # Unseeded member: left claimable and forced to change; nothing authenticates.
        self.assertFalse(cdb.get_login_account("Guest")["password_set"])
        self.assertTrue(cdb.get_login_account("Guest")["must_change_password"])
        self.assertIsNone(cdb.authenticate_user("Guest", "anything"))

    def test_enable_rejects_weak_admin_password_before_any_write(self):
        mark = cdb.create_local_identity("Mark")
        cdb.create_local_identity("Sam")
        with self.assertRaises(ValueError):
            cdb.enable_auth_with_admin(mark["id"], "short")  # < min_8
        self.assertFalse(cdb.auth_required())
        self.assertFalse(cdb.get_login_account("Mark")["password_set"])

    def test_disable_is_lossless_flag_flip(self):
        mark = cdb.create_local_identity("Mark")
        cdb.enable_auth_with_admin(mark["id"], "password123")
        self.assertTrue(cdb.auth_required())

        cdb.disable_auth_mode()
        self.assertFalse(cdb.auth_required())
        # The account and its password hash survive, so re-enabling is seamless.
        self.assertIn("Mark", [u["username"] for u in cdb.list_users()])
        self.assertTrue(cdb.get_login_account("Mark")["password_set"])
        self.assertIsNotNone(cdb.authenticate_user("Mark", "password123"))

    def test_delete_last_identity_allowed_when_perimeter_off(self):
        # Local mode auto-promotes the earliest identity to admin, but with sign-in off the
        # "keep one admin" guard must not apply — clearing local identities down to none has to work
        # (it lands back on the first-run chooser). See the delete_user guard.
        mark = cdb.create_local_identity("Mark")
        cdb.get_user_by_id(mark["id"])  # exists
        cdb.delete_user(mark["id"])
        self.assertEqual(cdb.list_users(), [])

    def test_delete_last_admin_blocked_when_perimeter_on(self):
        mark = cdb.create_local_identity("Mark")
        cdb.enable_auth_with_admin(mark["id"], "password123")
        with self.assertRaises(ValueError):
            cdb.delete_user(mark["id"])  # would strand the workspace with no admin

    def test_latch_dropped_multiple_passwordless_users_stay_local(self):
        cdb.create_local_identity("Mark")
        cdb.create_local_identity("Sam")
        cdb.create_local_identity("Guest")
        # Three accounts, flag off => still perimeter-off (the old user_count()>1 latch is gone).
        self.assertFalse(cdb.auth_required())

    # --- primitives carried over --------------------------------------------

    def test_create_identity_after_deleting_all_reuses_orphan_tenant(self):
        # delete_user leaves the tenant row behind, so creating a new identity into an empty
        # user_account table must adopt that surviving tenant, not mint a second one on the same
        # db_path (which would violate the unique tenant.db_path). Regression for the welcome-screen
        # 500 after a "reset to first-run".
        first = cdb.create_local_identity("Mark")
        original_tenant = cdb.get_user_by_id(first["id"])["tenant_id"]
        cdb.delete_user(first["id"])
        self.assertEqual(cdb.list_users(), [])

        second = cdb.create_local_identity("Sam")  # must not raise
        self.assertEqual(cdb.get_user_by_id(second["id"])["tenant_id"], original_tenant)

    def test_create_local_identity_is_passwordless(self):
        user = cdb.create_local_identity("Mark")
        self.assertEqual(user["role"], "member")
        acct = cdb.get_login_account("Mark")
        self.assertFalse(acct["password_set"])
        self.assertFalse(acct["must_change_password"])

    def test_unset_sentinel_never_verifies(self):
        cdb.enable_auth_mode()
        admin = cdb._create_user_with_tenant("Admin", "password123", role="admin")
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
        admin = cdb._create_user_with_tenant("Admin", "password123", role="admin")
        user = cdb._create_user_with_tenant("Member", "password123", role="member", tenant_id=admin["tenant_id"])

        cdb.update_user(user["id"], password="")
        acct = cdb.get_login_account("Member")
        self.assertFalse(acct["password_set"])
        self.assertTrue(acct["must_change_password"])

        cdb.update_user(user["id"], password="newpassword1")
        acct = cdb.get_login_account("Member")
        self.assertTrue(acct["password_set"])
        self.assertFalse(acct["must_change_password"])

        cdb.update_user(user["id"], must_change_password=True)
        acct = cdb.get_login_account("Member")
        self.assertTrue(acct["password_set"])
        self.assertTrue(acct["must_change_password"])

    def test_totp_setup_includes_qr_svg(self):
        cdb.enable_auth_mode()
        admin = cdb._create_user_with_tenant("Admin", "password123", role="admin")
        setup = cdb.begin_totp_setup(admin["id"])
        self.assertTrue(setup["otpauth_uri"].startswith("otpauth://totp/"))
        self.assertTrue(setup["qr_svg"].startswith("data:image/svg+xml"))



@contextmanager
def _client_stack():
    """Full-stack TestClient with both DBs isolated and tenant paths consistent. The session secret is
    pinned rather than left to the resolver so the signing key does not depend on which temp control DB
    happened to exist when `backend.main` was first imported."""
    from fastapi.testclient import TestClient

    tmp = tempfile.TemporaryDirectory()
    data_path = str(Path(tmp.name) / "data.db")
    control_path = str(Path(tmp.name) / "control.db")
    originals = (database.DB_PATH, cdb.DB_PATH, cdb.CONTROL_DB_PATH)
    prior_secret = os.environ.get("SESSION_SECRET")
    database.DB_PATH = data_path
    cdb.DB_PATH = data_path
    cdb.CONTROL_DB_PATH = control_path
    os.environ["SESSION_SECRET"] = "test-session-secret-that-is-long-enough-xyz"
    database.init_db(data_path)
    cdb.init_control_db()
    from backend.main import app
    try:
        with TestClient(app) as client:
            yield client
    finally:
        database.DB_PATH, cdb.DB_PATH, cdb.CONTROL_DB_PATH = originals
        if prior_secret is None:
            os.environ.pop("SESSION_SECRET", None)
        else:
            os.environ["SESSION_SECRET"] = prior_secret
        tmp.cleanup()


class PerimeterOffSessionTests(unittest.TestCase):
    def test_select_identity_establishes_session_and_scopes_prefs(self):
        with _client_stack() as client:
            mark = client.post("/api/auth/identities", json={"name": "Mark"}).json()["identity"]

            # No session yet: a protected route is unauthenticated.
            self.assertEqual(client.get("/api/auth/me").status_code, 401)

            selected = client.post("/api/auth/select-identity", json={"user_id": mark["id"]})
            self.assertEqual(selected.status_code, 200, selected.text)
            self.assertEqual(selected.json()["user"]["username"], "Mark")

            # The session now carries the identity; preferences scope to it.
            me = client.get("/api/auth/me")
            self.assertEqual(me.status_code, 200, me.text)
            self.assertEqual(me.json()["user"]["id"], mark["id"])
            client.post("/api/auth/preferences", json={"key": "ui.theme", "value": "dark"})
            self.assertEqual(client.get("/api/auth/preferences").json()["preferences"]["ui.theme"], "dark")

    def test_pwless_session_rejected_once_perimeter_comes_up(self):
        with _client_stack() as client:
            mark = client.post("/api/auth/identities", json={"name": "Mark"}).json()["identity"]
            client.post("/api/auth/select-identity", json={"user_id": mark["id"]})
            self.assertEqual(client.get("/api/auth/me").status_code, 200)

            # Another admin turns the perimeter on out of band; the existing pwless session is now stale.
            cdb.enable_auth_mode()
            self.assertEqual(client.get("/api/auth/me").status_code, 401)
            self.assertNotIn("user", client.get("/api/auth/status").json())


class EnableDisableFlowTests(unittest.TestCase):
    def test_enable_claims_admin_and_member_claims_at_login(self):
        with _client_stack() as client:
            mark = client.post("/api/auth/identities", json={"name": "Mark"}).json()["identity"]
            client.post("/api/auth/identities", json={"name": "Sam"})

            enable = client.post("/api/auth/enable", json={
                "enabled": True,
                "claim_user_id": mark["id"],
                "admin_password": "password123",
                "initial_passwords": {},
            })
            self.assertEqual(enable.status_code, 200, enable.text)
            self.assertEqual(enable.json()["user"]["username"], "Mark")

            client.post("/api/auth/logout")

            # Sam is claimable: login with no password, then forced to set one.
            login = client.post("/api/auth/login", json={"username": "Sam", "password": ""})
            self.assertEqual(login.status_code, 200, login.text)
            self.assertTrue(login.json().get("requires_password_change"))
            changed = client.post("/api/auth/change-password", json={"new_password": "sam-new-password"})
            self.assertEqual(changed.status_code, 200, changed.text)
            self.assertFalse(changed.json()["user"]["must_change_password"])

            client.post("/api/auth/logout")
            relogin = client.post("/api/auth/login", json={"username": "Sam", "password": "sam-new-password"})
            self.assertEqual(relogin.status_code, 200, relogin.text)

    def test_enable_applies_chosen_password_policy(self):
        with _client_stack() as client:
            mark = client.post("/api/auth/identities", json={"name": "Mark"}).json()["identity"]
            resp = client.post("/api/auth/enable", json={
                "enabled": True,
                "claim_user_id": mark["id"],
                "admin_password": "x",  # allowed only because the policy is 'none'
                "password_policy": "none",
            })
            self.assertEqual(resp.status_code, 200, resp.text)
            self.assertEqual(client.get("/api/auth/status").json()["password_policy"], "none")

    def test_enable_rejects_password_below_chosen_policy(self):
        with _client_stack() as client:
            mark = client.post("/api/auth/identities", json={"name": "Mark"}).json()["identity"]
            resp = client.post("/api/auth/enable", json={
                "enabled": True,
                "claim_user_id": mark["id"],
                "admin_password": "short",
                "password_policy": "strong",
            })
            self.assertEqual(resp.status_code, 400, resp.text)
            self.assertFalse(client.get("/api/auth/status").json()["auth_enabled"])

    def test_disable_returns_to_perimeter_off_and_keeps_accounts(self):
        with _client_stack() as client:
            mark = client.post("/api/auth/identities", json={"name": "Mark"}).json()["identity"]
            client.post("/api/auth/enable", json={
                "enabled": True, "claim_user_id": mark["id"], "admin_password": "password123",
            })
            self.assertTrue(client.get("/api/auth/status").json()["auth_enabled"])

            disabled = client.post("/api/auth/disable")
            self.assertEqual(disabled.status_code, 200, disabled.text)
            status = client.get("/api/auth/status").json()
            self.assertFalse(status["auth_enabled"])
            # The identity survives and can be re-selected in perimeter-off mode.
            names = [i["display_name"] for i in client.get("/api/auth/identities").json()["identities"]]
            self.assertIn("Mark", names)

    def test_reset_after_enable_disables_then_deletes_every_user(self):
        # The developer "reset to first-run" chain in auth mode: disable (admin), which drops to local
        # mode, then delete every identity including the former admin — leaving an empty workspace.
        with _client_stack() as client:
            mark = client.post("/api/auth/identities", json={"name": "Mark"}).json()["identity"]
            client.post("/api/auth/identities", json={"name": "Sam"})
            client.post("/api/auth/enable", json={
                "enabled": True, "claim_user_id": mark["id"], "admin_password": "password123",
            })
            self.assertTrue(client.get("/api/auth/status").json()["auth_enabled"])

            self.assertEqual(client.post("/api/auth/disable").status_code, 200)
            # Now perimeter-off: the identity endpoints are reachable and no admin guard blocks deletion.
            # Delete the session's own identity (Mark) LAST, as the reset flow does — deleting it first
            # would invalidate the session and 401 the rest.
            ids = [i["id"] for i in client.get("/api/auth/identities").json()["identities"]]
            ordered = [i for i in ids if i != mark["id"]] + [mark["id"]]
            for ident_id in ordered:
                self.assertEqual(client.delete(f"/api/auth/identities/{ident_id}").status_code, 200)
            self.assertEqual(client.get("/api/auth/identities").json()["identities"], [])

    def test_disable_requires_admin(self):
        with _client_stack() as client:
            mark = client.post("/api/auth/identities", json={"name": "Mark"}).json()["identity"]
            client.post("/api/auth/identities", json={"name": "Sam"})
            client.post("/api/auth/enable", json={
                "enabled": True,
                "claim_user_id": mark["id"],
                "admin_password": "password123",
                "initial_passwords": {},
            })
            # Sign in as the non-admin member and confirm disable is refused.
            client.post("/api/auth/login", json={"username": "Sam", "password": ""})
            client.post("/api/auth/change-password", json={"new_password": "sam-password-1"})
            resp = client.post("/api/auth/disable")
            self.assertEqual(resp.status_code, 403, resp.text)
            self.assertTrue(client.get("/api/auth/status").json()["auth_enabled"])



if __name__ == "__main__":
    unittest.main()
