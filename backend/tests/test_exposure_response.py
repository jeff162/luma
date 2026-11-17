"""
Responding to an exposed database without re-linking: `POST /auth/vault/reissue-credentials`.

The property that matters is that a copied credential stops working while the connection keeps syncing —
so the provider is asked for a replacement, the replacement is what is stored, and a provider that cannot
reissue is left for the user rather than silently counted as done.
"""

from __future__ import annotations

import unittest
from unittest import mock

from backend.db.database import get_db
from backend.services import crypto_service as cs
from backend.services import plaid_service
from backend.services.providers.config import set_sync_running
from backend.tests._api_client import STRONG_PASSPHRASE, api_client, in_browser_session

ACCOUNTS = [{
    "plaid_account_id": "acct-1", "name": "Everyday Checking", "official_name": None,
    "type": "depository", "subtype": "checking", "mask": "0000",
}]


class ReissueCredentialsTests(unittest.TestCase):
    def setUp(self):
        cs.lock_all()

    def tearDown(self):
        cs.lock_all()

    def _plaid_connection(self, client):
        client.post("/api/auth/vault/set-passphrase", json={"passphrase": STRONG_PASSPHRASE})
        client.post("/api/providers/plaid/config", json={"client_id": "cid", "secret": "sek", "env": "sandbox"})
        with mock.patch.object(plaid_service, "exchange_public_token",
                               return_value={"access_token": "access-old", "item_id": "item-1"}), \
             mock.patch.object(plaid_service, "fetch_accounts", return_value=ACCOUNTS):
            r = client.post("/api/plaid/exchange",
                            json={"public_token": "public-1", "institution_name": "Harborline Bank"})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["connection_id"]

    def _stored_credential(self, client, connection_id):
        with get_db() as conn:
            row = conn.execute(
                "SELECT provider, external_id, credential, credential_enc FROM connection WHERE id = ?",
                (connection_id,),
            ).fetchone()
        user = {"id": client.get("/api/auth/status").json()["user"]["id"]}
        with in_browser_session(client):
            return cs.decrypt_connection_credential(
                user, row["provider"], row["external_id"], row["credential"], row["credential_enc"],
            )

    def test_the_replacement_is_stored_and_the_rest_is_left_to_the_user(self):
        with api_client() as (client, _):
            connection_id = self._plaid_connection(client)
            # A provider that cannot reissue: reported for the user to revoke, and never sent anything.
            with get_db() as conn:
                conn.execute(
                    "INSERT INTO connection (id, provider, external_id, credential, credential_enc, institution) "
                    "VALUES ('c-sf', 'simplefin', 'bridge-1', '', 'sealed', 'Riverstone Credit Union')"
                )
            with mock.patch.object(plaid_service, "invalidate_access_token",
                                   return_value="access-new") as invalidate:
                r = client.post("/api/auth/vault/reissue-credentials")

            self.assertEqual(r.status_code, 200, r.text)
            invalidate.assert_called_once()
            self.assertEqual(invalidate.call_args.args[1], "access-old")
            self.assertEqual(self._stored_credential(client, connection_id), "access-new")
            outcomes = {o["connection_id"]: o["outcome"] for o in r.json()["outcomes"]}
            self.assertEqual(outcomes, {connection_id: "reissued", "c-sf": "manual"})
            # Only the credential that needs the app secret is retired by replacing it; the other is the
            # user's to replace at its provider.
            covered = {o["connection_id"]: o["covered_by_app_secret"] for o in r.json()["outcomes"]}
            self.assertEqual(covered, {connection_id: True, "c-sf": False})
            # Reissuing every connection never touches the app secret, so it is always on the list.
            self.assertEqual(r.json()["app_secrets_to_rotate"], [{"provider": "plaid"}])

    def test_a_refusal_keeps_the_stored_credential(self):
        # The old credential is still live when the provider refuses, so it has to stay the stored one —
        # and the user is told this connection is theirs to finish.
        with api_client() as (client, _):
            connection_id = self._plaid_connection(client)
            with mock.patch.object(plaid_service, "invalidate_access_token",
                                   side_effect=RuntimeError("ITEM_LOGIN_REQUIRED")):
                r = client.post("/api/auth/vault/reissue-credentials")

            self.assertEqual(r.status_code, 200, r.text)
            [outcome] = r.json()["outcomes"]
            self.assertEqual(outcome["outcome"], "failed")
            self.assertIn("ITEM_LOGIN_REQUIRED", outcome["detail"])
            self.assertEqual(self._stored_credential(client, connection_id), "access-old")

    def test_refused_while_a_sync_is_running(self):
        # That pull holds the credential being replaced; swapping it underneath would fail the sync.
        with api_client() as (client, _):
            connection_id = self._plaid_connection(client)
            set_sync_running([connection_id], True)
            try:
                with mock.patch.object(plaid_service, "invalidate_access_token") as invalidate:
                    r = client.post("/api/auth/vault/reissue-credentials")
            finally:
                set_sync_running([connection_id], False)
            self.assertEqual(r.status_code, 409, r.text)
            self.assertEqual(r.json()["detail"]["code"], "sync_running")
            invalidate.assert_not_called()

    def test_refused_while_the_vault_is_locked(self):
        with api_client() as (client, _):
            self._plaid_connection(client)
            client.post("/api/auth/vault/lock")
            with mock.patch.object(plaid_service, "invalidate_access_token") as invalidate:
                r = client.post("/api/auth/vault/reissue-credentials")
            self.assertEqual(r.status_code, 423, r.text)
            invalidate.assert_not_called()
