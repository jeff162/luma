"""The 401 log line, which is a diagnostic tool rather than behaviour — and which nothing else covers.

It exists to identify an intermittent that reproduces roughly once in eleven full runs, so the moment it
is wrong is the moment nobody can afford it: a typo here sits undetected until the next occurrence, and
then costs another eleven runs. These assert the three states the line has to tell apart, because a
single "not authenticated" reason spans all three and they want different fixes.

What is deliberately *not* asserted is the response body. It stays one opaque message for every case on
purpose — which check fired is not a caller's business — so a test that pinned the body to the reason
would be locking in the leak the design avoids.
"""

from __future__ import annotations

import logging
import unittest

from backend.tests._api_client import api_client


class AuthRejectionDiagnosticsTests(unittest.TestCase):
    def _reject(self, prepare):
        """Make one request that the tenant middleware will refuse, and return its log line."""
        with api_client() as (client, _data_path):
            prepare(client)
            with self.assertLogs(level=logging.WARNING) as captured:
                response = client.get("/api/accounts")
            self.assertEqual(response.status_code, 401)
            lines = [line for line in captured.output if "[auth] rejected" in line]
            self.assertEqual(len(lines), 1, f"expected one rejection line, got {captured.output}")
            return lines[0]

    def _cookie_name(self):
        from backend.main import config
        return config.session_cookie_name

    def test_a_request_carrying_nothing_is_named_as_carrying_nothing(self):
        line = self._reject(lambda client: client.cookies.clear())
        self.assertIn("no cookie", line)
        # No session at all, so no field names either — the placeholder, not an empty gap in the line.
        self.assertIn("session keys: -", line)

    def test_a_cleared_cookie_is_told_apart_from_a_signature_that_failed(self):
        # Starlette empties the cookie rather than only expiring it, so a client that has not dropped it
        # yet keeps sending this. It used to be indistinguishable from a cookie signed under another
        # secret, which is the confusion that made the intermittent unreadable.
        line = self._reject(lambda client: client.cookies.set(self._cookie_name(), "null"))
        self.assertIn("cleared cookie", line)

    def test_a_cookie_that_does_not_verify_reads_as_a_signed_cookie_with_no_session(self):
        # The signature fails, so `SessionMiddleware` hands the app an empty session. Present-and-signed
        # with no keys is the signature of a secret mismatch; present-and-signed *with* keys but no
        # user_id would mean something wrote a session without one.
        line = self._reject(lambda client: client.cookies.set(self._cookie_name(), "not-a-valid-signature"))
        self.assertIn("signed cookie", line)
        self.assertIn("session keys: -", line)

    def test_the_session_value_never_reaches_the_log(self):
        # The line is meant to be pasted into a bug report, and the cookie's value *is* the session.
        secret_looking = "eyJ1c2VyX2lkIjogInNvbWVvbmUifQ.signature-part"
        line = self._reject(lambda client: client.cookies.set(self._cookie_name(), secret_looking))
        self.assertNotIn(secret_looking, line)
        self.assertNotIn("signature-part", line)


if __name__ == "__main__":
    unittest.main()
