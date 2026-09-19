"""
The data-connection log records every operation on a connection, not only syncs.

A Plaid secret rotated and deleted on the dashboard failed both +Connect and sync with the client library's
HTTP dump, and only the sync left any record: the connect's failure went to an error box and nowhere else.
These pin the log's widened contract end to end, through the real endpoints:

* a connect that fails before any connection exists is recorded, under the provider's connect attempts;
* a successful connect is recorded under the connection it created;
* a disconnect keeps its own row and removes the rest, so the log still says when a connection went and
  whether access ended at the provider;
* retention is by age, pruned on write and on changing the setting.

Plaid is driven at its client, below `plaid_service`, so each failure passes through the same error
translation a real one does.
"""

from __future__ import annotations

import json
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

import plaid

from backend.db.database import get_db
from backend.services import connection_log
from backend.services import crypto_service as cs
from backend.services import plaid_service
from backend.tests._api_client import STRONG_PASSPHRASE, api_client

ACCOUNTS = [{
    "plaid_account_id": "acct-1", "name": "Everyday Checking", "official_name": None,
    "type": "depository", "subtype": "checking", "mask": "0000",
}]


def _plaid_refusal(code: str, message: str) -> plaid.ApiException:
    exc = plaid.ApiException(status=400, reason="Bad Request")
    exc.body = json.dumps({"error_type": "INVALID_INPUT", "error_code": code, "error_message": message,
                           "display_message": None, "request_id": "req-1"})
    return exc


class _RefusingClient:
    """A Plaid client every call of which is refused with the given error."""

    def __init__(self, exc):
        self._exc = exc

    def __getattr__(self, name):
        def call(*_args, **_kwargs):
            raise self._exc
        return call


class ConnectionLogTests(unittest.TestCase):
    def setUp(self):
        cs.lock_all()

    def tearDown(self):
        cs.lock_all()

    def _configure(self, client):
        client.post("/api/auth/vault/set-passphrase", json={"passphrase": STRONG_PASSPHRASE})
        client.post("/api/providers/plaid/config", json={"client_id": "cid", "secret": "sek", "env": "sandbox"})

    def _connect(self, client, item_id="item-1", institution="Harborline Bank"):
        with mock.patch.object(plaid_service, "exchange_public_token",
                               return_value={"access_token": f"access-{item_id}", "item_id": item_id}), \
             mock.patch.object(plaid_service, "fetch_accounts", return_value=ACCOUNTS):
            r = client.post("/api/plaid/exchange", json={"public_token": "public-1", "institution_name": institution})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["connection_id"]

    def _log(self, client, **params):
        r = client.get("/api/sync/diagnostics", params=params)
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def test_a_refused_connect_says_why_and_is_logged_without_a_connection(self):
        with api_client() as (client, _):
            self._configure(client)
            refusal = _plaid_refusal("INVALID_API_KEYS", "invalid client_id or secret provided")
            with mock.patch.object(plaid_service, "_get_client", return_value=_RefusingClient(refusal)):
                r = client.post("/api/plaid/exchange", json={"public_token": "public-1"})

            self.assertEqual(r.status_code, 502)
            message = r.json()["detail"]["message"]
            # Readable, and naming the one place to fix it — never the library's header dump.
            self.assertIn("Configure", message)
            self.assertNotIn("HTTP response headers", message)

            log = self._log(client)
            [entry] = log["entries"]
            self.assertEqual((entry["event"], entry["connection_id"]), ("connect", None))
            self.assertEqual(entry["error"], message)
            # Plaid's own account of it rides beside the readable message, request id and all.
            self.assertEqual(entry["detail"]["provider_error"]["request_id"], "req-1")
            self.assertEqual([(c["subject"], c["connection_id"]) for c in log["counts"]], [("connect:plaid", None)])

    def test_a_link_session_that_could_not_start_is_logged_as_the_connect_it_began(self):
        with api_client() as (client, _):
            self._configure(client)
            refusal = _plaid_refusal("INVALID_API_KEYS", "invalid client_id or secret provided")
            with mock.patch.object(plaid_service, "_get_client", return_value=_RefusingClient(refusal)):
                r = client.get("/api/plaid/link-token")

            self.assertEqual(r.status_code, 502)
            [entry] = self._log(client)["entries"]
            self.assertEqual((entry["event"], entry["connection_id"]), ("connect", None))
            self.assertIn("INVALID_API_KEYS", entry["error"])

    def test_an_error_inside_link_is_logged_from_the_browsers_report(self):
        with api_client() as (client, _):
            r = client.post("/api/plaid/link-error", json={
                "institution_name": "Harborline Bank", "error_code": "INSTITUTION_DOWN",
                "display_message": "This bank is not responding right now.",
            })
            self.assertEqual(r.status_code, 200, r.text)
            [entry] = self._log(client)["entries"]
            self.assertEqual((entry["event"], entry["institution"]), ("connect", "Harborline Bank"))
            self.assertIn("INSTITUTION_DOWN", entry["error"])

    def test_a_connect_is_logged_under_the_connection_it_made(self):
        with api_client() as (client, _):
            self._configure(client)
            connection_id = self._connect(client)
            [entry] = self._log(client)["entries"]
            self.assertEqual((entry["event"], entry["connection_id"], entry["error"]), ("connect", connection_id, None))
            self.assertEqual(entry["detail"]["accounts"], 1)

    def test_a_disconnect_keeps_only_its_own_row(self):
        with api_client() as (client, _):
            self._configure(client)
            gone = self._connect(client, "item-1", "Harborline Bank")
            kept = self._connect(client, "item-2", "Riverstone Credit Union")
            with mock.patch.object(plaid_service, "remove_item"):
                r = client.post("/api/providers/plaid/disconnect", json={"external_id": "item-1"})
            self.assertEqual(r.status_code, 200, r.text)

            log = self._log(client)
            gone_rows = [e for e in log["entries"] if e["connection_id"] == gone]
            self.assertEqual([(e["event"], e["detail"]["revoked"]) for e in gone_rows], [("disconnect", True)])
            # The other connection's history is untouched.
            self.assertEqual([e["event"] for e in log["entries"] if e["connection_id"] == kept], ["connect"])
            pills = {c["subject"]: c["disconnected"] for c in log["counts"]}
            self.assertEqual(pills, {gone: True, kept: False})

    def test_a_provider_scope_takes_in_what_it_has_no_ids_for(self):
        # What a provider's card opens with: its failed connects and its disconnected connections, neither
        # of which that card could name by a live connection id.
        with api_client() as (client, _):
            self._configure(client)
            gone = self._connect(client, "item-1")
            with mock.patch.object(plaid_service, "remove_item"):
                client.post("/api/providers/plaid/disconnect", json={"external_id": "item-1"})
            connection_log.record_event(event=connection_log.CONNECT, provider="plaid", error="refused")
            connection_log.record_event(event=connection_log.CONNECT, provider="simplefin", error="refused")

            scoped = self._log(client, provider="plaid")
            self.assertEqual(
                sorted((e["connection_id"] or "-", e["event"]) for e in scoped["entries"]),
                sorted([(gone, "disconnect"), ("-", "connect")]),
            )
            self.assertEqual(scoped["total"], 2)
            # A subject selects exactly its pill, the connect attempts included.
            self.assertEqual(
                [e["provider"] for e in self._log(client, subject="connect:simplefin")["entries"]], ["simplefin"],
            )

    def test_entries_older_than_the_retention_window_are_pruned(self):
        with api_client() as (client, _):
            old = (datetime.now(timezone.utc) - timedelta(days=45)).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
            recent = (datetime.now(timezone.utc) - timedelta(days=10)).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
            with get_db() as conn:
                for row_id, started in (("old", old), ("recent", recent)):
                    conn.execute(
                        "INSERT INTO connection_sync_log (id, provider, event, started_at) VALUES (?, 'plaid', 'connect', ?)",
                        (row_id, started),
                    )
            # Pruned on the next write, at the default thirty days.
            connection_log.record_event(event=connection_log.CONNECT, provider="plaid", error="refused")
            ids = {e["id"] for e in self._log(client)["entries"]}
            self.assertNotIn("old", ids)
            self.assertIn("recent", ids)

            # Shortening the window applies at once rather than at the next write.
            r = client.put("/api/sync/diagnostics/retention", json={"days": 7})
            self.assertEqual(r.json(), {"retention_days": 7})
            log = self._log(client)
            self.assertNotIn("recent", {e["id"] for e in log["entries"]})
            self.assertEqual(log["retention_days"], 7)

    def test_a_retention_outside_its_bounds_is_refused(self):
        with api_client() as (client, _):
            for days in (0, 366):
                r = client.put("/api/sync/diagnostics/retention", json={"days": days})
                self.assertEqual(r.status_code, 400, days)
            self.assertEqual(self._log(client)["retention_days"], connection_log.DEFAULT_RETENTION_DAYS)


if __name__ == "__main__":
    unittest.main()
