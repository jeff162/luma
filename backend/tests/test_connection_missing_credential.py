"""
Connections with no stored credential — the state a vault reset deliberately leaves behind.

A reset clears `credential`/`credential_enc` and **keeps** the connection rows, so the accounts,
mappings and coverage hanging off them survive for a re-link to land back on. That makes "this connection
has no credential" a normal state rather than a corruption — and the decrypt used to answer it with `""`,
which every caller then handed to a provider as if it were a token. Plaid replies *"access_token must be
a non-empty string"*, and because `disconnect` turns a failed revocation into a 502 that keeps the row,
the one connection that could not be revoked was also the one that could not be deleted: the reset left
husks the user had no way to clear.

These pin the seam (`MissingCredential` rather than an empty string) and the behaviour each caller owes
the user, of which the disconnect is the one that must not fail.
"""

from __future__ import annotations

import unittest
from unittest import mock

from backend.db.database import get_db
from backend.services import crypto_service as cs
from backend.services import plaid_service
from backend.services.providers import config as provider_config
from backend.tests._api_client import STRONG_PASSPHRASE, api_client

ACCOUNTS = [{
    "plaid_account_id": "acct-1", "name": "Everyday Checking", "official_name": None,
    "type": "depository", "subtype": "checking", "mask": "0000",
}]


class SeamTests(unittest.TestCase):
    def test_no_credential_raises_rather_than_returning_an_empty_string(self):
        # The whole defect in one assertion: `""` is indistinguishable from a credential, so it travelled
        # all the way to the provider before anything noticed.
        with self.assertRaises(cs.MissingCredential):
            cs.decrypt_connection_credential({"id": "u1"}, "plaid", "item-1", "", None)

    def test_a_legacy_plaintext_credential_still_reads_through(self):
        # The passthrough this shares a branch with is real and must survive: a pre-vault row holds its
        # credential in the clear and needs no DEK.
        self.assertEqual(
            cs.decrypt_connection_credential({"id": "u1"}, "plaid", "item-1", "plain-token", None),
            "plain-token",
        )

    def test_has_credential_answers_without_a_decrypt(self):
        self.assertFalse(cs.connection_has_credential("", None))
        self.assertTrue(cs.connection_has_credential("", "ciphertext"))
        self.assertTrue(cs.connection_has_credential("plain", None))


class CredentiallessConnectionTests(unittest.TestCase):
    def setUp(self):
        cs.lock_all()

    def tearDown(self):
        cs.lock_all()

    def _reset_leftover(self, client):
        """A Plaid connection put through exactly what a vault reset does to one."""
        client.post("/api/auth/vault/set-passphrase", json={"passphrase": STRONG_PASSPHRASE})
        client.post("/api/providers/plaid/config",
                    json={"client_id": "cid", "secret": "sek", "env": "sandbox"})
        with mock.patch.object(plaid_service, "exchange_public_token",
                               return_value={"access_token": "access-1", "item_id": "item-1"}), \
             mock.patch.object(plaid_service, "fetch_accounts", return_value=ACCOUNTS):
            r = client.post("/api/plaid/exchange",
                            json={"public_token": "public-1", "institution_name": "Harborline Bank"})
        self.assertEqual(r.status_code, 200, r.text)
        phrase = client.get("/api/auth/vault/reset-preview").json()["confirm_phrase"]
        reset = client.post("/api/auth/vault/reset", json={"reason": "lost", "confirm": phrase})
        self.assertEqual(reset.status_code, 200, reset.text)
        return r.json()["connection_id"]

    def test_the_listing_reports_that_nothing_is_stored(self):
        with api_client() as (client, _):
            self._reset_leftover(client)
            connections = provider_config.list_connections("plaid")
            self.assertEqual(len(connections), 1)
            self.assertFalse(connections[0]["has_credential"])
            self.assertTrue(connections[0]["reauth_required"])
            # …and never the credential itself, whatever its state.
            self.assertNotIn("credential", connections[0])
            self.assertNotIn("credential_enc", connections[0])

    def test_disconnect_removes_it_without_calling_the_provider(self):
        # The bug that started this: the row could not be revoked, so it could not be deleted either, and
        # the reset's own leftovers were unclearable. `item_remove` must not be reached at all — an empty
        # token is not a call worth making.
        with api_client() as (client, _):
            self._reset_leftover(client)
            with mock.patch.object(plaid_service, "remove_item") as remove:
                r = client.post("/api/providers/plaid/disconnect", json={"external_id": "item-1"})

            self.assertEqual(r.status_code, 200, r.text)
            remove.assert_not_called()
            # Reported honestly: nothing was revoked, which for Plaid is a real caveat rather than a detail.
            self.assertFalse(r.json()["revoked"])
            with get_db() as conn:
                self.assertEqual(conn.execute("SELECT COUNT(*) FROM connection").fetchone()[0], 0)

    def test_a_normal_disconnect_still_revokes_and_says_so(self):
        # The guard above must not have turned every disconnect into a local delete.
        with api_client() as (client, _):
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": STRONG_PASSPHRASE})
            client.post("/api/providers/plaid/config",
                        json={"client_id": "cid", "secret": "sek", "env": "sandbox"})
            with mock.patch.object(plaid_service, "exchange_public_token",
                                   return_value={"access_token": "access-1", "item_id": "item-1"}), \
                 mock.patch.object(plaid_service, "fetch_accounts", return_value=ACCOUNTS):
                client.post("/api/plaid/exchange", json={"public_token": "public-1"})
            with mock.patch.object(plaid_service, "remove_item") as remove:
                r = client.post("/api/providers/plaid/disconnect", json={"external_id": "item-1"})
            remove.assert_called_once()
            self.assertTrue(r.json()["revoked"])

    def test_reconnecting_in_place_is_refused_with_somewhere_to_go(self):
        # There is no Item to re-authorize, so update mode cannot help — and saying so beats letting Link
        # open against an empty token and fail as though the bank had refused.
        with api_client() as (client, _):
            connection_id = self._reset_leftover(client)
            r = client.get(f"/api/plaid/link-token?connection_id={connection_id}")
            self.assertEqual(r.status_code, 409)
            self.assertEqual(r.json()["detail"]["code"], "credential_unreadable")

    def test_refreshing_accounts_is_refused_rather_than_attempted(self):
        with api_client() as (client, _):
            self._reset_leftover(client)
            r = client.post("/api/providers/plaid/refresh-accounts", json={"external_id": "item-1"})
            self.assertEqual(r.status_code, 409)
            self.assertEqual(r.json()["detail"]["code"], "no_credential")


if __name__ == "__main__":
    unittest.main()
