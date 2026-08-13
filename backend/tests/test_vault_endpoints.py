"""
Vault + gating through the full HTTP stack (phase 3): the /auth/vault/* lifecycle, the vault status
fields and transport block on /auth/status, and the connect/Production gates that key off vault state.

Runs perimeter-off (the shared harness identity), which is the case that must still require a vault to
store live tokens — app-login and the vault are orthogonal.
"""

from __future__ import annotations

import unittest

from backend.services import crypto_service as cs
from backend.tests._api_client import STRONG_PASSPHRASE, api_client


class VaultEndpointTests(unittest.TestCase):
    def setUp(self):
        cs.lock_all()

    def tearDown(self):
        cs.lock_all()

    def test_status_exposes_vault_and_transport(self):
        with api_client() as (client, _):
            status = client.get("/api/auth/status").json()
            self.assertFalse(status["user"]["vault_configured"])
            self.assertFalse(status["user"]["vault_unlocked"])
            self.assertIn("transport", status)
            for key in ("is_loopback", "scheme", "is_https", "https_expected", "https_warning_suppressed"):
                self.assertIn(key, status["transport"])

    def test_set_lock_unlock_lifecycle(self):
        with api_client() as (client, _):
            r = client.post("/api/auth/vault/set-passphrase", json={"passphrase": STRONG_PASSPHRASE})
            self.assertEqual(r.status_code, 200)
            user = r.json()["user"]
            self.assertTrue(user["vault_configured"])
            self.assertTrue(user["vault_has_passphrase"])
            self.assertTrue(user["vault_unlocked"])

            locked = client.post("/api/auth/vault/lock").json()["user"]
            self.assertFalse(locked["vault_unlocked"])

            bad = client.post("/api/auth/vault/unlock", json={"passphrase": "wrong"})
            self.assertEqual(bad.status_code, 400)

            good = client.post("/api/auth/vault/unlock", json={"passphrase": STRONG_PASSPHRASE})
            self.assertEqual(good.status_code, 200)
            self.assertTrue(good.json()["user"]["vault_unlocked"])

    def test_connect_requires_a_configured_vault(self):
        with api_client() as (client, _):
            r = client.post("/api/plaid/exchange", json={"public_token": "public-sandbox-x"})
            self.assertEqual(r.status_code, 409)
            self.assertEqual(r.json()["detail"]["code"], "vault_not_configured")

    def test_connect_requires_an_unlocked_vault(self):
        with api_client() as (client, _):
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": STRONG_PASSPHRASE})
            client.post("/api/auth/vault/lock")
            r = client.post("/api/plaid/exchange", json={"public_token": "public-sandbox-x"})
            self.assertEqual(r.status_code, 423)
            self.assertEqual(r.json()["detail"]["code"], "vault_locked")

    def test_a_weak_passphrase_is_refused_with_the_numbers_the_dialog_needs(self):
        # The floor is data, not just prose: the dialog gates its own submit button on these two numbers,
        # so a client that had to parse them out of a sentence would drift from the server and either
        # block what the server accepts or offer what it refuses.
        with api_client() as (client, _):
            r = client.post("/api/auth/vault/set-passphrase", json={"passphrase": "shortpass"})
        self.assertEqual(r.status_code, 400, r.text)
        detail = r.json()["detail"]
        self.assertEqual(detail["code"], "weak_passphrase")
        self.assertEqual(detail["min_length"], cs.VAULT_PRODUCTION_MIN_LEN)
        self.assertEqual(detail["min_distinct"], cs.VAULT_PRODUCTION_MIN_DISTINCT)

    def test_changing_to_a_weak_passphrase_is_refused_the_same_way(self):
        with api_client() as (client, _):
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": STRONG_PASSPHRASE})
            r = client.post("/api/auth/vault/change-passphrase",
                            json={"old_passphrase": STRONG_PASSPHRASE, "new_passphrase": "shortpass"})
        self.assertEqual(r.status_code, 400, r.text)
        self.assertEqual(r.json()["detail"]["code"], "weak_passphrase")

    def test_switching_a_provider_to_production_needs_no_second_passphrase_test(self):
        # The environment gate is gone with the weak tier that motivated it. Storing a secret still needs
        # an unlocked vault, and that vault is strong by construction — so Production is reachable without
        # a separate strength challenge that could only ever pass.
        with api_client() as (client, _):
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": STRONG_PASSPHRASE})
            r = client.post("/api/providers/plaid/config",
                            json={"client_id": "cid", "secret": "sek", "env": "production"})
        self.assertEqual(r.status_code, 200, r.text)


if __name__ == "__main__":
    unittest.main()
