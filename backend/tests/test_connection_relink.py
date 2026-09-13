"""
Re-linking a data source whose handle is derived from its credential.

`connect` upserts on `(provider, external_id)`, which is a clean credential refresh where the *provider*
issues the handle (Plaid's `item_id`). Where the handle is derived from the credential instead — SimpleFIN
hashes the access URL, because the URL is the credential and so cannot also be the public handle — a new
credential is a new handle, so the upsert inserts a **second** connection row and strands the first.

What is actually stranded is narrower than it looks, and that distinction is what these tests pin. The
account *mappings* survive on their own: `record_provider_accounts` and sync both key on
`account.external_account_id`, which is unique and durable. What is lost is everything keyed to
`connection_id` — per-account coverage, the cursor, sync history — which for a metered provider means a
full history re-walk. So the fix is to re-point the surviving row rather than to migrate state onto a new
one, and the property worth pinning is that **nothing keyed to `connection_id` moves at all**.

The decision has to be taken *before* the provider is called, because a claim or exchange is single-use:
there is no authorizing again to act on a different answer. Hence a request that carries the answer, and a
staleness policy that absorbs a wrong one rather than refusing and burning the authorization.
"""

from __future__ import annotations

import unittest
from unittest import mock

from backend.db.database import get_db
from backend.routers.accounts import resolve_default_owner_id
from backend.services.connection_mapping import apply_account_mapping
from backend.services import crypto_service as cs
from backend.services.providers import get_adapter
from backend.services.providers.base import ProviderAdapter
from backend.services.source_capabilities import REJECT_ZERO_AMOUNT
from backend.tests._api_client import STRONG_PASSPHRASE, api_client, in_browser_session

PROVIDER = "simplefin"


class _StubAdapter(ProviderAdapter):
    """A credential-derived handle, like SimpleFIN's, with the claim replaced by a dict lookup.

    Stubbed rather than driven through the real adapter because the real one's claim is single-use against
    a live Bridge — which is the very constraint under test, and not something to exercise for real.
    """

    provider = PROVIDER
    requires_app_config = False
    stable_external_id = False
    zero_amount_rows = REJECT_ZERO_AMOUNT

    def __init__(self):
        self.credential = "https://user:pass@bridge.example/first"

    def connect(self, app_config, payload):
        return {
            "external_id": "sfin_" + self.credential[-8:],
            "credential": self.credential,
            "institution": "Harborline Bridge",
        }

    def fetch_accounts(self, app_config, credential):
        return [{"external_account_id": "acct-1", "name": "Everyday Checking", "official_name": None,
                 "type": "depository", "subtype": "checking", "mask": "0000", "currency": "USD"}]

    def fetch_transactions(self, app_config, credential, **kwargs):
        return []

    def remove(self, app_config, credential):
        pass


class RelinkAdoptionTests(unittest.TestCase):
    def setUp(self):
        cs.lock_all()
        self.adapter = _StubAdapter()

    def tearDown(self):
        cs.lock_all()

    def _connect(self, client, *, adopt=None):
        with mock.patch("backend.routers.providers.get_adapter", return_value=self.adapter):
            body = {"payload": {"setup_token": "tok"}}
            if adopt:
                body["adopt_connection_id"] = adopt
            return client.post(f"/api/providers/{PROVIDER}/connect", json=body)

    def _connections(self):
        with get_db() as conn:
            return [dict(r) for r in conn.execute(
                "SELECT id, external_id, institution FROM connection ORDER BY rowid")]

    def _coverage(self):
        with get_db() as conn:
            return [dict(r) for r in conn.execute(
                "SELECT connection_id, external_account_id, coverage_start_date, account_id, mapping_mode "
                "FROM connection_account ORDER BY rowid")]

    def _seed_history(self, connection_id):
        """The state a re-link is at risk of stranding: a mapped local account, how far back this
        connection has actually walked, and where its cursor sits. All of it hangs off `connection_id`,
        which is the reason re-pointing that row preserves it and inserting a new one does not.

        The mapping is applied through the real call rather than by inserting an `account` row, because
        `connect` deliberately creates no local accounts — the mapping step does — so a fixture that
        skipped it would be testing a connection no user has finished setting up.
        """
        with get_db() as conn:
            apply_account_mapping(
                conn, connection_id=connection_id, provider=PROVIDER, institution="Harborline Bridge",
                mappings={"acct-1": {"mode": "new", "name": "Everyday Checking"}},
                default_owner_id=resolve_default_owner_id(conn, None),
            )
            conn.execute(
                "UPDATE connection_account SET coverage_start_date = '2024-01-01', history_complete = 1 "
                "WHERE connection_id = ?", (connection_id,))
            conn.execute(
                "UPDATE connection SET transactions_cursor = 'walked-to-here', initial_sync_complete = 1 "
                "WHERE id = ?", (connection_id,))

    def _establish(self, client):
        """One workspace with a vault, one connection, and a history worth not losing."""
        client.post("/api/auth/vault/set-passphrase", json={"passphrase": STRONG_PASSPHRASE})
        first = self._connect(client)
        self.assertEqual(first.status_code, 200, first.text)
        connection_id = first.json()["connection_id"]
        self._seed_history(connection_id)
        return connection_id

    # --- the capability itself --------------------------------------------------------------------

    def test_the_two_real_providers_declare_opposite_answers(self):
        # The whole feature keys off this, and a new adapter inheriting the default silently would land in
        # the Plaid case — which is the safe direction (no question asked) but the wrong one for any
        # provider whose handle rides its credential.
        self.assertTrue(get_adapter("plaid").stable_external_id)
        self.assertFalse(get_adapter("simplefin").stable_external_id)

    # --- the defect, and the fix ------------------------------------------------------------------

    def test_without_adoption_a_new_credential_lands_as_a_second_connection(self):
        # Pinned deliberately: this is the behaviour the feature exists to offer an alternative to, and it
        # stays correct for a user who really is adding a second bridge.
        with api_client() as (client, _):
            first_id = self._establish(client)
            self.adapter.credential = "https://user:pass@bridge.example/second"
            second = self._connect(client)

            self.assertEqual(second.status_code, 200, second.text)
            self.assertFalse(second.json()["adopted"])
            self.assertEqual(len(self._connections()), 2)
            # And the cost is the coverage, not the mapping: the new row starts with nothing walked.
            fresh = [c for c in self._coverage() if c["connection_id"] != first_id]
            self.assertEqual(len(fresh), 1)
            self.assertIsNone(fresh[0]["coverage_start_date"])

    def test_adoption_re_points_the_surviving_row_and_keeps_everything_hanging_off_it(self):
        with api_client() as (client, _):
            first_id = self._establish(client)
            self.adapter.credential = "https://user:pass@bridge.example/second"

            r = self._connect(client, adopt=first_id)
            self.assertEqual(r.status_code, 200, r.text)
            self.assertTrue(r.json()["adopted"])
            self.assertEqual(r.json()["connection_id"], first_id)

            rows = self._connections()
            self.assertEqual(len(rows), 1, "a re-link must not leave a second connection behind")
            self.assertEqual(rows[0]["id"], first_id)
            self.assertEqual(rows[0]["external_id"], "sfin_e/second")

            # The point of re-pointing rather than migrating: none of this was touched, so none of it
            # could be lost.
            coverage = self._coverage()
            self.assertEqual(len(coverage), 1)
            self.assertEqual(coverage[0]["connection_id"], first_id)
            self.assertEqual(coverage[0]["coverage_start_date"], '2024-01-01')
            self.assertEqual(coverage[0]["mapping_mode"], "new")
            self.assertIsNotNone(coverage[0]["account_id"])
            with get_db() as conn:
                cursor = conn.execute("SELECT transactions_cursor FROM connection WHERE id = ?", (first_id,)).fetchone()[0]
                account = conn.execute("SELECT connection_id FROM account").fetchone()
            self.assertEqual(cursor, 'walked-to-here')
            self.assertEqual(account["connection_id"], first_id)

    def test_the_adopted_row_carries_the_new_credential(self):
        # The half that would make a silent no-op look like success: the row survives either way, so the
        # thing to check is that it now opens with the credential just authorized.
        with api_client() as (client, _):
            first_id = self._establish(client)
            self.adapter.credential = "https://user:pass@bridge.example/second"
            self._connect(client, adopt=first_id)

            with get_db() as conn:
                row = dict(conn.execute(
                    "SELECT external_id, credential, credential_enc FROM connection WHERE id = ?",
                    (first_id,)).fetchone())
            user = {"id": cs.cdb.list_vault_slots()[0]["user_id"]}
            with in_browser_session(client):
                self.assertEqual(
                    cs.decrypt_connection_credential(user, PROVIDER, row["external_id"],
                                                     row["credential"], row["credential_enc"]),
                    "https://user:pass@bridge.example/second",
                )

    # --- staleness: absorbed, never refused, because the authorization is already spent ------------

    def test_naming_a_connection_that_is_gone_falls_through_to_an_ordinary_connect(self):
        # Refusing would be the tidy answer and the wrong one: the claim has already been spent by the time
        # this is known, so a refusal costs the user their setup token over a stale dialog.
        with api_client() as (client, _):
            self._establish(client)
            self.adapter.credential = "https://user:pass@bridge.example/second"
            r = self._connect(client, adopt="no-such-connection")

            self.assertEqual(r.status_code, 200, r.text)
            self.assertFalse(r.json()["adopted"])
            self.assertEqual(len(self._connections()), 2)

    def test_a_handle_already_held_by_another_row_refreshes_that_row_instead(self):
        # The user answered "this replaces A", but the provider handed back B's handle — so this is really
        # a credential refresh of B. Re-pointing A would trip the UNIQUE index; the upsert lands it on B,
        # which is where it belongs.
        with api_client() as (client, _):
            first_id = self._establish(client)
            self.adapter.credential = "https://user:pass@bridge.example/second"
            second_id = self._connect(client).json()["connection_id"]

            # Re-authorize the *second* bridge while claiming it replaces the first.
            r = self._connect(client, adopt=first_id)
            self.assertEqual(r.status_code, 200, r.text)
            self.assertFalse(r.json()["adopted"])
            self.assertEqual(r.json()["connection_id"], second_id)
            self.assertEqual(len(self._connections()), 2)


if __name__ == "__main__":
    unittest.main()
