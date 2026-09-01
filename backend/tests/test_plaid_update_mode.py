"""
Plaid Link update mode — re-authorizing an Item instead of replacing it.

Without it, "reconnect this bank" opened a plain Link session, which mints a **new** Item with a new
`item_id` and new per-account ids. The refreshed credential therefore landed on a second connection row,
the original was stranded with its coverage and cursor, and its `reauth_required` badge could never clear
because nothing would ever sync it again. That is also what made `stable_external_id = True` false for
Plaid as this app used it: the flag is a claim about the *app's* re-authorization path, not only about
what the provider is capable of.

Two properties are pinned here, and both are invisible in a green suite that only checks the happy path:
the token request must differ in exactly the two ways Plaid requires (an `access_token`, and **no**
`products`), and the repair must clear `reauth_required` only on *proof* the Item answers — never on the
client having reported success.
"""

from __future__ import annotations

import unittest
from unittest import mock

from backend.db.database import get_db
from backend.services import crypto_service as cs
from backend.services import plaid_service
from backend.services.providers import get_adapter
from backend.tests._api_client import STRONG_PASSPHRASE, api_client

APP_CONFIG = {"client_id": "cid", "secret": "sek", "env": "sandbox"}
ACCOUNTS = [{
    "plaid_account_id": "acct-1", "name": "Everyday Checking", "official_name": None,
    "type": "depository", "subtype": "checking", "mask": "0000",
}]


class LinkTokenModeTests(unittest.TestCase):
    """What actually goes on the wire, since the two modes differ only in the request body."""

    def _request_for(self, **kwargs):
        client = mock.MagicMock()
        client.link_token_create.return_value.to_dict.return_value = {"link_token": "link-1"}
        with mock.patch.object(plaid_service, "_get_client", return_value=client):
            plaid_service.create_link_token(APP_CONFIG, "u1", **kwargs)
        return client.link_token_create.call_args[0][0]

    def test_a_first_connect_asks_for_the_transactions_product(self):
        request = self._request_for()
        self.assertEqual([str(p) for p in request.products], ["transactions"])
        self.assertFalse(hasattr(request, "access_token"))

    def test_update_mode_sends_the_access_token_and_no_products(self):
        # Both halves matter: the access_token is what makes this a repair rather than a new Item, and
        # Plaid rejects the request outright if `products` rides along — the Item's products were fixed
        # when it was created, and this call is not creating one.
        request = self._request_for(access_token="access-1")
        self.assertEqual(request.access_token, "access-1")
        self.assertFalse(hasattr(request, "products"))

    def test_the_adapter_passes_the_token_through(self):
        with mock.patch.object(plaid_service, "create_link_token", return_value="link-1") as create:
            get_adapter("plaid").create_link_token(APP_CONFIG, "u1", access_token="access-1")
        self.assertEqual(create.call_args[0][2], "access-1")


class RepairEndpointTests(unittest.TestCase):
    def setUp(self):
        cs.lock_all()

    def tearDown(self):
        cs.lock_all()

    def _connected(self, client):
        """One Plaid connection that has since started refusing, which is the state a repair acts on."""
        client.post("/api/auth/vault/set-passphrase", json={"passphrase": STRONG_PASSPHRASE})
        client.post("/api/providers/plaid/config",
                    json={"client_id": "cid", "secret": "sek", "env": "sandbox"})
        with mock.patch.object(plaid_service, "exchange_public_token",
                               return_value={"access_token": "access-1", "item_id": "item-1"}), \
             mock.patch.object(plaid_service, "fetch_accounts", return_value=ACCOUNTS):
            r = client.post("/api/plaid/exchange",
                            json={"public_token": "public-1", "institution_name": "Harborline Bank"})
        self.assertEqual(r.status_code, 200, r.text)
        connection_id = r.json()["connection_id"]
        with get_db() as conn:
            conn.execute("UPDATE connection SET reauth_required = 1, consecutive_sync_failures = 3, "
                         "last_sync_error = 'ITEM_LOGIN_REQUIRED' WHERE id = ?", (connection_id,))
        return connection_id

    def _row(self, connection_id):
        with get_db() as conn:
            return dict(conn.execute(
                "SELECT external_id, reauth_required, consecutive_sync_failures, last_sync_error "
                "FROM connection WHERE id = ?", (connection_id,)).fetchone())

    def test_the_link_token_for_a_connection_is_an_update_token(self):
        with api_client() as (client, _):
            connection_id = self._connected(client)
            with mock.patch.object(plaid_service, "create_link_token", return_value="link-1") as create:
                r = client.get(f"/api/plaid/link-token?connection_id={connection_id}")
            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual(r.json()["mode"], "update")
            # The stored credential is what Link is handed, decrypted from the vault on the way past.
            self.assertEqual(create.call_args[0][2], "access-1")

    def test_a_plain_link_token_stays_a_create_token(self):
        with api_client() as (client, _):
            self._connected(client)
            with mock.patch.object(plaid_service, "create_link_token", return_value="link-1") as create:
                r = client.get("/api/plaid/link-token")
            self.assertEqual(r.json()["mode"], "create")
            self.assertIsNone(create.call_args[0][2])

    def test_a_repair_keeps_the_same_connection_and_clears_the_badge(self):
        # The whole point: the handle does not move, so nothing keyed to this connection is stranded and
        # the flag retires on the row that carried it.
        with api_client() as (client, _):
            connection_id = self._connected(client)
            with mock.patch.object(plaid_service, "fetch_accounts", return_value=ACCOUNTS):
                r = client.post("/api/plaid/repair", json={"connection_id": connection_id})

            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual(r.json()["connection_id"], connection_id)
            row = self._row(connection_id)
            self.assertEqual(row["external_id"], "item-1", "update mode must not change the handle")
            self.assertEqual(row["reauth_required"], 0)
            self.assertEqual(row["consecutive_sync_failures"], 0)
            self.assertIsNone(row["last_sync_error"])
            with get_db() as conn:
                self.assertEqual(
                    conn.execute("SELECT COUNT(*) FROM connection").fetchone()[0], 1,
                    "a repair must not leave a second connection behind",
                )

    def test_a_repair_that_cannot_reach_the_item_leaves_the_badge_alone(self):
        # `reauth_required` is retired by proof everywhere else in the app, so a repair must not clear it
        # on the client having said Link succeeded. Cleared optimistically, the badge would reappear at
        # the next sync and the user would have been told the problem was fixed.
        with api_client() as (client, _):
            connection_id = self._connected(client)
            with mock.patch.object(plaid_service, "fetch_accounts",
                                   side_effect=RuntimeError("ITEM_LOGIN_REQUIRED")):
                r = client.post("/api/plaid/repair", json={"connection_id": connection_id})

            self.assertEqual(r.status_code, 502)
            self.assertEqual(self._row(connection_id)["reauth_required"], 1)

    def test_a_repair_refuses_while_the_vault_is_locked(self):
        # There is no Item to re-authorize without the credential, and the credential needs the DEK.
        with api_client() as (client, _):
            connection_id = self._connected(client)
            client.post("/api/auth/vault/lock")
            r = client.post("/api/plaid/repair", json={"connection_id": connection_id})
            self.assertEqual(r.status_code, 423)
            self.assertEqual(r.json()["detail"]["code"], "vault_locked")


if __name__ == "__main__":
    unittest.main()
