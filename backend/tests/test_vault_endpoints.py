"""
Vault + gating through the full HTTP stack (phase 3): the /auth/vault/* lifecycle, the vault status
fields and transport block on /auth/status, and the connect/Production gates that key off vault state.

Runs perimeter-off (the shared harness identity), which is the case that must still require a vault to
store live tokens — app-login and the vault are orthogonal.
"""

from __future__ import annotations

import unittest

from backend.services import crypto_service as cs
from backend.tests._api_client import api_client


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
            r = client.post("/api/auth/vault/set-passphrase", json={"passphrase": "a-strong-passphrase"})
            self.assertEqual(r.status_code, 200)
            user = r.json()["user"]
            self.assertTrue(user["vault_configured"])
            self.assertTrue(user["vault_has_passphrase"])
            self.assertTrue(user["vault_unlocked"])

            locked = client.post("/api/auth/vault/lock").json()["user"]
            self.assertFalse(locked["vault_unlocked"])

            bad = client.post("/api/auth/vault/unlock", json={"passphrase": "wrong"})
            self.assertEqual(bad.status_code, 400)

            good = client.post("/api/auth/vault/unlock", json={"passphrase": "a-strong-passphrase"})
            self.assertEqual(good.status_code, 200)
            self.assertTrue(good.json()["user"]["vault_unlocked"])

    def test_connect_requires_a_configured_vault(self):
        with api_client() as (client, _):
            r = client.post("/api/plaid/exchange", json={"public_token": "public-sandbox-x"})
            self.assertEqual(r.status_code, 409)
            self.assertEqual(r.json()["detail"]["code"], "vault_not_configured")

    def test_connect_requires_an_unlocked_vault(self):
        with api_client() as (client, _):
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": "a-strong-passphrase"})
            client.post("/api/auth/vault/lock")
            r = client.post("/api/plaid/exchange", json={"public_token": "public-sandbox-x"})
            self.assertEqual(r.status_code, 423)
            self.assertEqual(r.json()["detail"]["code"], "vault_locked")

    def test_production_gate_blocks_without_a_strong_vault(self):
        # The Production gate moved onto the per-provider Configure endpoint (phase 6b); a weak vault must
        # still block switching a provider to Production. The gate runs before any write.
        with api_client() as (client, _):
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": "shortpass"})  # under the Production min
            r = client.post("/api/providers/plaid/config", json={"env": "production"})
            self.assertEqual(r.status_code, 400)
            self.assertIn("vault passphrase", r.json()["detail"])


if __name__ == "__main__":
    unittest.main()
