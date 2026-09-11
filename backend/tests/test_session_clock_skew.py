# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
A session must survive the wall clock stepping backwards.

This covers a bug that was live for months and cost eleven full gate runs to identify: a clock
correction backwards invalidated every session signed in the window it skipped, and `SessionMiddleware`
reported that as `session = {}` — indistinguishable, downstream, from no cookie at all. The tests are
written against the *clock* rather than against the signer's internals, because the mistake worth
guarding is a future fix that "adjusts the timestamp" and moves both sides of the subtraction
(see `session_signing.py`).
"""

import time
import unittest
from unittest import mock

import itsdangerous
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route
from starlette.testclient import TestClient

from backend.session_signing import (
    CLOCK_SKEW_TOLERANCE_SECONDS, ClockSkewTolerantSessionMiddleware, ClockSkewTolerantSigner)

SECRET = "clock-skew-test-secret"
MAX_AGE = 14 * 24 * 60 * 60


class ClockSkewSignerTests(unittest.TestCase):
    """The signer alone. `time.time` is moved rather than the signer patched, because that is what
    actually happens: one clock, read twice, giving two answers."""

    def setUp(self):
        self.signer = ClockSkewTolerantSigner(SECRET)
        self.now = int(time.time())

    def _signed_at(self, when: int) -> bytes:
        with mock.patch("time.time", return_value=when):
            return self.signer.sign(b"payload")

    def _unsign_at(self, value: bytes, when: int, **kwargs):
        with mock.patch("time.time", return_value=when):
            return self.signer.unsign(value, max_age=MAX_AGE, **kwargs)

    def test_a_cookie_signed_seconds_ahead_still_verifies(self):
        """The bug itself: a stamp three seconds in the future is a clock correction, not a stale
        client, and the stock signer rejected it."""
        cookie = self._signed_at(self.now + 3)
        self.assertEqual(self._unsign_at(cookie, self.now), b"payload")

    def test_the_whole_tolerated_window_verifies(self):
        cookie = self._signed_at(self.now + CLOCK_SKEW_TOLERANCE_SECONDS)
        self.assertEqual(self._unsign_at(cookie, self.now), b"payload")

    def test_beyond_the_tolerance_it_is_still_expired(self):
        """The tolerance is finite on purpose: `max_age` is measured from the stamp, so an unbounded one
        would let a wildly future-stamped cookie outlive the session lifetime by that same margin."""
        cookie = self._signed_at(self.now + CLOCK_SKEW_TOLERANCE_SECONDS + 60)
        with self.assertRaises(itsdangerous.SignatureExpired):
            self._unsign_at(cookie, self.now)

    def test_a_genuinely_stale_cookie_still_expires(self):
        """Nothing about the forward direction changes — this is the check the tolerance must not
        weaken."""
        cookie = self._signed_at(self.now - MAX_AGE - 60)
        with self.assertRaises(itsdangerous.SignatureExpired):
            self._unsign_at(cookie, self.now)

    def test_tampering_still_fails(self):
        """The parent's signature validation runs in full; only the two age comparisons are taken over."""
        # The payload is what gets edited, not the signature's last character. A 20-byte HMAC is 27
        # base64url characters and only 4 bits of the last one are significant, so 4 of the 64 possible
        # characters decode to the same digest: a tail edit left the cookie valid on 5.8% of signing
        # timestamps (measured), and since `self.now` moves every run, the test failed that often.
        cookie = self._signed_at(self.now)
        with self.assertRaises(itsdangerous.BadSignature):
            self._unsign_at(b"Payload" + cookie[len(b"payload"):], self.now)

    def test_a_different_secret_still_fails(self):
        cookie = ClockSkewTolerantSigner("another-secret").sign(b"payload")
        with self.assertRaises(itsdangerous.BadSignature):
            self._unsign_at(cookie, self.now)

    def test_no_max_age_asks_no_question_about_time(self):
        """`max_age=None` is Starlette's own way of disabling the check; the override must honour it
        rather than applying the tolerance as a floor of its own."""
        cookie = self._signed_at(self.now + 10 * CLOCK_SKEW_TOLERANCE_SECONDS)
        with mock.patch("time.time", return_value=self.now):
            self.assertEqual(self.signer.unsign(cookie), b"payload")

    def test_the_signing_time_is_still_reported(self):
        cookie = self._signed_at(self.now)
        value, signed_at = self._unsign_at(cookie, self.now, return_timestamp=True)
        self.assertEqual(value, b"payload")
        self.assertEqual(int(signed_at.timestamp()), self.now)


def _session_app(middleware_cls):
    async def write(request):
        request.session["user_id"] = "u1"
        return JSONResponse({"ok": True})

    async def read(request):
        return JSONResponse({"user_id": request.session.get("user_id")})

    app = Starlette(routes=[Route("/write", write), Route("/read", read)])
    app.add_middleware(middleware_cls, secret_key=SECRET, max_age=MAX_AGE)
    return app


class ClockSkewMiddlewareTests(unittest.TestCase):
    """End to end through Starlette, which is where the failure was actually met: an empty session, not
    an exception."""

    def _read_after_step_back(self, middleware_cls, seconds):
        client = TestClient(_session_app(middleware_cls))
        client.get("/write")
        with mock.patch("time.time", return_value=int(time.time()) - seconds):
            return client.get("/read").json()["user_id"]

    def test_the_session_survives_the_clock_stepping_back(self):
        self.assertEqual(
            self._read_after_step_back(ClockSkewTolerantSessionMiddleware, 3), "u1")

    def test_the_stock_middleware_is_what_loses_it(self):
        """The teeth. Without this, the test above would pass against a signer that changed nothing —
        the stock middleware hands the app an empty session for the very same cookie."""
        from starlette.middleware.sessions import SessionMiddleware
        self.assertIsNone(self._read_after_step_back(SessionMiddleware, 3))

    def test_a_step_past_the_tolerance_still_signs_out(self):
        self.assertIsNone(self._read_after_step_back(
            ClockSkewTolerantSessionMiddleware, CLOCK_SKEW_TOLERANCE_SECONDS + 60))


if __name__ == "__main__":
    unittest.main()
