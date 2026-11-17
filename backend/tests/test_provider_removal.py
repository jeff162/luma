"""
Removing a provider (`DELETE /api/providers/{provider}/config`) and removing a connection from this install
only.

A restored install holds the same provider tokens as the one it came from, so revoking a connection here
also ends the access there. Both removals therefore offer to leave the access live, and these pin that
leaving it live never reaches the provider, that revoking does, and that a refused revoke part way through a
provider's connections keeps the app credential the remaining connections still need.
"""

from __future__ import annotations

import unittest
from unittest import mock

from backend.db.database import get_db
from backend.services import crypto_service as cs
from backend.services import plaid_service
from backend.tests._api_client import STRONG_PASSPHRASE, api_client


def _accounts(n: int) -> list[dict]:
    return [{
        "plaid_account_id": f"acct-{n}", "name": f"Everyday Checking {n}", "official_name": None,
        "type": "depository", "subtype": "checking", "mask": f"000{n}",
    }]


class ProviderRemovalTests(unittest.TestCase):
    def setUp(self):
        cs.lock_all()

    def tearDown(self):
        cs.lock_all()

    def _configure_with_connections(self, client, count: int = 2):
        client.post("/api/auth/vault/set-passphrase", json={"passphrase": STRONG_PASSPHRASE})
        client.post("/api/providers/plaid/config", json={"client_id": "cid", "secret": "sek", "env": "sandbox"})
        for n in range(1, count + 1):
            with mock.patch.object(plaid_service, "exchange_public_token",
                                   return_value={"access_token": f"access-{n}", "item_id": f"item-{n}"}), \
                 mock.patch.object(plaid_service, "fetch_accounts", return_value=_accounts(n)):
                r = client.post("/api/plaid/exchange", json={"public_token": f"public-{n}"})
            self.assertEqual(r.status_code, 200, r.text)
            mapped = client.post(f"/api/connections/{r.json()['connection_id']}/account-map",
                                 json={"mappings": {f"acct-{n}": {"mode": "new", "name": f"Checking {n}"}}})
            self.assertEqual(mapped.status_code, 200, mapped.text)

    def _counts(self):
        with get_db() as conn:
            return (
                conn.execute("SELECT COUNT(*) FROM connection WHERE provider = 'plaid'").fetchone()[0],
                conn.execute("SELECT COUNT(*) FROM provider_config WHERE provider = 'plaid'").fetchone()[0],
                conn.execute("SELECT COUNT(*) FROM account").fetchone()[0],
            )

    def _disconnect_reasons(self, client):
        return sorted(e["detail"]["reason"] for e in client.get("/api/sync/diagnostics").json()["entries"]
                      if e["event"] == "disconnect" and not e.get("error"))

    def test_removing_from_this_install_only_never_calls_the_provider(self):
        with api_client() as (client, _):
            self._configure_with_connections(client)
            accounts_before = self._counts()[2]
            with mock.patch.object(plaid_service, "remove_item") as remove:
                r = client.delete("/api/providers/plaid/config?revoke=false")
            self.assertEqual(r.status_code, 200, r.text)
            remove.assert_not_called()
            self.assertEqual(self._counts(), (0, 0, accounts_before))
            self.assertEqual(self._disconnect_reasons(client), ["kept_at_provider", "kept_at_provider"])
            status = client.get("/api/providers/plaid/config").json()
            self.assertFalse(status["configured"])

    def test_revoking_revokes_every_connection_before_the_credential_goes(self):
        with api_client() as (client, _):
            self._configure_with_connections(client)
            with mock.patch.object(plaid_service, "remove_item") as remove:
                r = client.delete("/api/providers/plaid/config?revoke=true")
            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual(sorted(c.args[1] for c in remove.call_args_list), ["access-1", "access-2"])
            self.assertEqual(self._counts()[:2], (0, 0))

    def test_a_refused_revoke_keeps_the_credential_and_the_rest_of_the_connections(self):
        with api_client() as (client, _):
            self._configure_with_connections(client)
            with mock.patch.object(plaid_service, "remove_item",
                                   side_effect=[None, RuntimeError("wrong environment")]):
                refused = client.delete("/api/providers/plaid/config?revoke=true")
            self.assertEqual(refused.status_code, 502, refused.text)
            self.assertEqual(refused.json()["detail"]["code"], "revoke_failed")
            self.assertEqual(self._counts()[:2], (1, 1))

            with mock.patch.object(plaid_service, "remove_item") as remove:
                finished = client.delete("/api/providers/plaid/config?revoke=false")
            self.assertEqual(finished.status_code, 200, finished.text)
            remove.assert_not_called()
            self.assertEqual(self._counts()[:2], (0, 0))

    def test_a_locked_vault_removes_nothing(self):
        with api_client() as (client, _):
            self._configure_with_connections(client)
            cs.lock_all()
            r = client.delete("/api/providers/plaid/config?revoke=false")
            self.assertEqual(r.status_code, 423, r.text)
            self.assertEqual(self._counts()[:2], (2, 1))

    def test_a_running_sync_removes_nothing(self):
        with api_client() as (client, _):
            self._configure_with_connections(client)
            with get_db() as conn:
                conn.execute("UPDATE connection SET sync_started_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')")
            r = client.delete("/api/providers/plaid/config?revoke=false")
            self.assertEqual(r.status_code, 409, r.text)
            self.assertEqual(r.json()["detail"]["code"], "sync_running")
            self.assertEqual(self._counts()[:2], (2, 1))

    def test_one_connection_can_be_removed_here_only_with_the_vault_locked(self):
        # Leaving the access live decrypts nothing, so it needs neither the vault nor the app credential.
        with api_client() as (client, _):
            self._configure_with_connections(client, count=1)
            cs.lock_all()
            with mock.patch.object(plaid_service, "remove_item") as remove:
                r = client.post("/api/providers/plaid/disconnect",
                                json={"external_id": "item-1", "remove_without_revoking": True})
            self.assertEqual(r.status_code, 200, r.text)
            remove.assert_not_called()
            self.assertFalse(r.json()["revoked"])
            self.assertEqual(self._counts()[0], 0)
            self.assertEqual(self._disconnect_reasons(client), ["kept_at_provider"])


if __name__ == "__main__":
    unittest.main()
