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

import base64
import json
import logging
import unittest

import itsdangerous

from backend.tests._api_client import api_client


class AuthRejectionDiagnosticsTests(unittest.TestCase):
    def _reject(self, prepare):
        """Make one request that the sign-in session middleware will refuse, and return its log line."""
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

    def _signed_session(self, payload):
        """A cookie signed exactly as `SessionMiddleware` signs one, so the re-verify diagnostic is
        exercised against a genuine article rather than against a string it happens to reject."""
        from backend.main import config
        signer = itsdangerous.TimestampSigner(str(config.session_secret))
        body = base64.b64encode(json.dumps(payload).encode())
        return signer.sign(body).decode()

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

    def test_a_cookie_that_does_not_verify_says_so_when_re_verified(self):
        # The verdict has to disagree with the offline check when the secret genuinely differs — this is
        # the branch that would send the investigation back to how the secret is resolved.
        line = self._reject(lambda client: client.cookies.set(self._cookie_name(), "not-a-valid-signature"))
        self.assertIn("re-verified here: BadSignature", line)

    def test_a_verifiable_cookie_with_no_user_id_is_named_as_such(self):
        # Present, correctly signed, and simply written without an identity — which the older line could
        # not tell apart from a signature failure, since both arrive as an empty-looking rejection.
        cookie = self._signed_session({"pwless": True})
        line = self._reject(lambda client: client.cookies.set(self._cookie_name(), cookie))
        self.assertIn("re-verified here: verifies, no user_id", line)
        # It decoded, so the session is not empty — the keys prove the two facts are independent.
        self.assertIn("session keys: pwless", line)

    def test_a_verifiable_cookie_carrying_a_user_id_is_named_as_such(self):
        """The verdict this instrument exists for. A preserved trace of the intermittent showed exactly
        this — a cookie that verifies, carrying a user_id — behind a rejection reading `session keys: -`.
        Reproduced here with an identity the control database does not have, which takes a different
        branch of the middleware but exercises the same reading of the same cookie."""
        cookie = self._signed_session({"user_id": "nobody-by-that-id", "pwless": True})
        line = self._reject(lambda client: client.cookies.set(self._cookie_name(), cookie))
        self.assertIn("re-verified here: verifies, user_id present", line)

    def test_an_out_of_date_cookie_reports_how_far_out(self):
        """`SignatureExpired` covers both a stale cookie and one signed *ahead* of the verifying clock,
        and those mean opposite things — a client that kept an old session, against a clock that stepped
        backwards and invalidated every session signed in the window it skipped. The age is a duration,
        never anything about the session, and its sign is what separates them."""
        from backend.main import _signed_age, config
        signer = itsdangerous.TimestampSigner(str(config.session_secret))
        body = base64.b64encode(json.dumps({"user_id": "someone"}).encode())
        # Signed as of a minute from now — what a backwards clock step leaves behind.
        future = signer.sign(body).decode().split(".")
        future[1] = base64.urlsafe_b64encode(
            (signer.get_timestamp() + 60).to_bytes(5, "big").lstrip(b"\x00")).rstrip(b"=").decode()
        self.assertTrue(_signed_age(".".join(future)).endswith("s"))
        self.assertTrue(_signed_age(".".join(future)).startswith("-"))
        self.assertEqual(_signed_age("nonsense"), "unreadable")

    def test_no_cookie_has_nothing_to_re_verify(self):
        line = self._reject(lambda client: client.cookies.clear())
        self.assertIn("re-verified here: -", line)

    def test_the_session_value_never_reaches_the_log(self):
        # The line is meant to be pasted into a bug report, and the cookie's value *is* the session.
        secret_looking = "eyJ1c2VyX2lkIjogInNvbWVvbmUifQ.signature-part"
        line = self._reject(lambda client: client.cookies.set(self._cookie_name(), secret_looking))
        self.assertNotIn(secret_looking, line)
        self.assertNotIn("signature-part", line)


if __name__ == "__main__":
    unittest.main()
