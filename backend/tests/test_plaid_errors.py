"""
Plaid's failures reach the user as what went wrong, not as the client library's HTTP dump.

The library's exception renders as a status line, every response header and then the body, and that text
was what the +Connect error box, the connection card and the sync log all showed. `plaid_service` now reads
Plaid's own error body, and the adapter turns the one failure the app has a repair for — the bank asking
for its login again — into the seam's reconnect signal.
"""

from __future__ import annotations

import json
import unittest
from unittest import mock

import plaid
import urllib3

from backend.services import plaid_service
from backend.services.providers.base import ProviderCredentialRejected
from backend.services.providers.plaid import PlaidAdapter

APP_CONFIG = {"client_id": "cid", "secret": "sek", "env": "sandbox"}


def _refusal(body) -> plaid.ApiException:
    exc = plaid.ApiException(status=400, reason="Bad Request")
    exc.body = json.dumps(body) if isinstance(body, dict) else body
    return exc


def _client_raising(exc):
    client = mock.Mock()
    client.transactions_sync.side_effect = exc
    client.accounts_get.side_effect = exc
    return client


class PlaidErrorTranslationTests(unittest.TestCase):
    def _fetch_accounts_error(self, exc):
        with mock.patch.object(plaid_service, "_get_client", return_value=_client_raising(exc)):
            with self.assertRaises(plaid_service.PlaidError) as caught:
                plaid_service.fetch_accounts(APP_CONFIG, "access-1")
        return caught.exception

    def test_a_rejected_app_secret_points_at_configure(self):
        err = self._fetch_accounts_error(_refusal({
            "error_type": "INVALID_INPUT", "error_code": "INVALID_API_KEYS",
            "error_message": "invalid client_id or secret provided",
        }))
        self.assertEqual(err.code, "INVALID_API_KEYS")
        self.assertIn("Configure", str(err))
        self.assertNotIn("HTTP response headers", str(err))

    def test_plaids_own_body_is_kept_for_the_log_without_the_headers(self):
        exc = _refusal({
            "error_type": "INVALID_INPUT", "error_code": "INVALID_API_KEYS",
            "error_message": "invalid client_id or secret provided", "display_message": None,
            "request_id": "req-1", "documentation_url": "https://plaid.com/docs/errors/invalid-input/",
        })
        exc.headers = {"Server": "nginx"}
        err = self._fetch_accounts_error(exc)
        self.assertEqual(err.provider_detail["request_id"], "req-1")
        self.assertEqual(err.provider_detail["error_message"], "invalid client_id or secret provided")
        # Empty fields are dropped, and nothing about the response itself is kept.
        self.assertNotIn("display_message", err.provider_detail)
        self.assertNotIn("Server", json.dumps(err.provider_detail))

    def test_any_other_failure_carries_plaids_own_text_and_code(self):
        err = self._fetch_accounts_error(_refusal({
            "error_type": "RATE_LIMIT_EXCEEDED", "error_code": "RATE_LIMIT",
            "error_message": "rate limit exceeded for this endpoint", "display_message": None,
        }))
        self.assertIn("rate limit exceeded for this endpoint", str(err))
        self.assertIn("RATE_LIMIT", str(err))

    def test_a_body_that_is_not_plaids_json_still_reads_as_a_sentence(self):
        err = self._fetch_accounts_error(_refusal("<html>bad gateway</html>"))
        self.assertIsNone(err.code)
        self.assertNotIn("<html>", str(err))

    def test_no_response_at_all_says_plaid_could_not_be_reached(self):
        err = self._fetch_accounts_error(urllib3.exceptions.MaxRetryError(None, "/accounts/get"))
        self.assertIsNone(err.code)
        self.assertNotIn("/accounts/get", str(err))


class ReconnectSignalTests(unittest.TestCase):
    def _sync_error(self, code):
        exc = _refusal({"error_type": "ITEM_ERROR", "error_code": code, "error_message": "whatever"})
        with mock.patch.object(plaid_service, "_get_client", return_value=_client_raising(exc)):
            PlaidAdapter().fetch_transactions_sync(APP_CONFIG, "access-1")

    def test_a_bank_asking_for_its_login_again_is_the_reconnect_signal(self):
        # What makes the card say "reconnect needed" and offer update mode, instead of counting one more
        # sync failure.
        with self.assertRaises(ProviderCredentialRejected):
            self._sync_error("ITEM_LOGIN_REQUIRED")

    def test_a_dead_token_is_not_offered_the_reconnect_it_cannot_use(self):
        # Update mode starts from a working token, so an invalid one stays an ordinary failure.
        with self.assertRaises(plaid_service.PlaidError) as caught:
            self._sync_error("INVALID_ACCESS_TOKEN")
        self.assertNotIsInstance(caught.exception, ProviderCredentialRejected)


if __name__ == "__main__":
    unittest.main()
