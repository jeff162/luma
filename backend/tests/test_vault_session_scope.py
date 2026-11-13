"""
An unlock belongs to the browser session that presented the secret, not to the identity.

The case this exists for: with sign-in protection off, picking an identity takes no credential, and the unlock
cache used to be keyed on the user alone. Anyone who picked a name on another browser while its owner was
unlocked got the owner's key — and inside the proof window, the authority to add a passkey of their own to the
owner's slot, which outlives any lock. Now each browser unlocks for itself, and only a change to someone's
access reaches every session they have.

Two `TestClient`s are two browsers: separate cookie jars against one app and one pair of databases. The
service-level cases name their sessions directly, since what they pin is which sessions an operation reaches.
"""

from __future__ import annotations

import unittest
from contextlib import contextmanager

from fastapi.testclient import TestClient

from backend.db import control_database as cdb
from backend.services import crypto_service as cs
from backend.tests import test_vault
from backend.tests._api_client import STRONG_PASSPHRASE, api_client


class TwoBrowserTests(unittest.TestCase):
    def setUp(self):
        cs.lock_all()

    def tearDown(self):
        cs.lock_all()

    def _second_browser(self, user_id: str) -> TestClient:
        from backend.main import app

        # Over HTTPS, since a bare test client reads as another device, which the vault refuses over
        # plain HTTP before the session is ever consulted.
        browser = TestClient(app, base_url="https://testserver")
        selected = browser.post("/api/auth/select-identity", json={"user_id": user_id})
        self.assertEqual(selected.status_code, 200, selected.text)
        return browser

    @staticmethod
    def _me(browser) -> dict:
        return browser.get("/api/auth/status").json()["user"]

    def test_picking_an_unlocked_identity_elsewhere_inherits_nothing(self):
        with api_client() as (laptop, _):
            owner = self._me(laptop)["id"]
            laptop.post("/api/auth/vault/set-passphrase", json={"passphrase": STRONG_PASSPHRASE})
            self.assertTrue(self._me(laptop)["vault_unlocked"])

            other = self._second_browser(owner)
            try:
                borrowed = self._me(other)
                self.assertFalse(borrowed["vault_unlocked"])
                self.assertEqual(borrowed["vault_proof_seconds_remaining"], 0)
                # The durable half of the exploit: no new way into the owner's slot can be minted from here.
                self.assertNotEqual(other.post("/api/auth/vault/recovery-code").status_code, 200)
                self.assertIsNone(cdb.get_vault_slot(owner, "recovery"))
            finally:
                other.close()
            self.assertTrue(self._me(laptop)["vault_unlocked"], "the owner's own browser stays open")

    def test_each_browser_unlocks_for_itself_and_signing_out_closes_only_that_one(self):
        with api_client() as (laptop, _):
            owner = self._me(laptop)["id"]
            laptop.post("/api/auth/vault/set-passphrase", json={"passphrase": STRONG_PASSPHRASE})

            phone = self._second_browser(owner)
            try:
                opened = phone.post("/api/auth/vault/unlock", json={"passphrase": STRONG_PASSPHRASE})
                self.assertEqual(opened.status_code, 200, opened.text)
                self.assertTrue(self._me(phone)["vault_unlocked"])

                laptop.post("/api/auth/logout")
                self.assertTrue(self._me(phone)["vault_unlocked"])
            finally:
                phone.close()

    def test_picking_the_same_identity_again_starts_a_new_session(self):
        with api_client() as (browser, _):
            owner = self._me(browser)["id"]
            browser.post("/api/auth/vault/set-passphrase", json={"passphrase": STRONG_PASSPHRASE})
            browser.post("/api/auth/select-identity", json={"user_id": owner})
            self.assertFalse(self._me(browser)["vault_unlocked"])


class SessionReachTests(unittest.TestCase):
    ALICE = "alice's long vault passphrase"
    BOB = "bob's long vault passphrase, too"

    def setUp(self):
        self._stack = test_vault._isolated_stack()
        self._stack.__enter__()
        cs.lock_all()
        self.alice = cdb.create_local_identity("alice")["id"]
        self.bob = cdb.create_local_identity("bob")["id"]
        with self._session("alice-laptop"):
            cs.set_passphrase(self.alice, self.ALICE)
        with self._session("bob-phone"):
            cs.set_passphrase(self.bob, self.BOB)
        with self._session("alice-laptop"):
            cs.grant_access(self.alice, cs.pending_access_requests()[0]["slot_id"])

    def tearDown(self):
        cs.lock_all()
        self._stack.__exit__(None, None, None)

    @contextmanager
    def _session(self, name: str):
        token = cs.set_vault_scope(name)
        try:
            yield
        finally:
            cs.reset_vault_scope(token)

    def _unlocked_in(self, name: str, user_id: str) -> bool:
        with self._session(name):
            return cs.is_unlocked(user_id)

    def test_proof_earned_in_one_session_authorizes_nothing_in_another(self):
        with self._session("alice-laptop"):
            self.assertGreater(cs.proof_seconds_remaining(self.alice), 0)
        with self._session("alice-phone"):
            self.assertEqual(cs.proof_seconds_remaining(self.alice), 0)
            with self.assertRaises(cs.ProofRequired):
                cs.require_recent_proof(self.alice)

    def test_locking_reaches_only_the_session_that_locked(self):
        with self._session("alice-phone"):
            cs.unlock(self.alice, self.ALICE)
            cs.lock(self.alice)
        self.assertFalse(self._unlocked_in("alice-phone", self.alice))
        self.assertTrue(self._unlocked_in("alice-laptop", self.alice))

    def test_revoking_someone_locks_them_in_every_session(self):
        for name in ("bob-phone", "bob-laptop"):
            with self._session(name):
                cs.unlock(self.bob, self.BOB)
        cs.revoke_access(self.bob)
        self.assertFalse(self._unlocked_in("bob-phone", self.bob))
        self.assertFalse(self._unlocked_in("bob-laptop", self.bob))
        self.assertTrue(self._unlocked_in("alice-laptop", self.alice))

    def test_a_rotation_locks_every_session_but_the_one_that_ran_it(self):
        # The others hold a key that opens nothing afterwards; locked is the honest state, and their next
        # unlock picks up the new key.
        with self._session("bob-phone"):
            cs.unlock(self.bob, self.BOB)
        with self._session("alice-phone"):
            cs.unlock(self.alice, self.ALICE)
        with self._session("alice-laptop"):
            cs.rotate_dek(self.alice)
        self.assertTrue(self._unlocked_in("alice-laptop", self.alice))
        self.assertFalse(self._unlocked_in("alice-phone", self.alice))
        self.assertFalse(self._unlocked_in("bob-phone", self.bob))
        with self._session("bob-phone"):
            self.assertEqual(len(cs.unlock(self.bob, self.BOB)), cs.DEK_BYTES)


if __name__ == "__main__":
    unittest.main()
