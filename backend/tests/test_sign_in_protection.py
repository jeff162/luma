# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Guessing limits on every typed secret, and sessions the server can end.

The limiter tests move the limiter's clock rather than sleeping (`limiter_clock`). The endpoint tests
are each a miniature of what an attacker would try: a stream of password or code guesses, the right secret
offered during a pause, a code replayed, a copied cookie used after its owner signed out.
"""

import base64
import json
import time
import unittest

import itsdangerous

from backend.db.control_database import TOTP_PERIOD, _totp_code
from backend.services import attempt_limiter
from backend.tests._api_client import STRONG_PASSPHRASE, api_client, limiter_clock

ADMIN_PASSWORD = "admin-password-123"
MEMBER_PASSWORD = "member-password-123"
SPACING = attempt_limiter.MIN_SPACING_SECONDS


def _wrong_code(secret: str) -> str:
    """A six-digit code no current step accepts."""
    now = int(time.time())
    valid = {_totp_code(secret, now + offset * TOTP_PERIOD) for offset in (-1, 0, 1)}
    return next(code for code in (f"{n:06d}" for n in range(1_000_000)) if code not in valid)


class LimiterTests(unittest.TestCase):
    def test_a_second_attempt_inside_the_spacing_is_refused(self):
        with limiter_clock() as clock:
            attempt_limiter.begin("sign_in", "sam")
            attempt_limiter.failed("sign_in", "sam")
            with self.assertRaises(attempt_limiter.TooManyAttempts) as refused:
                attempt_limiter.begin("sign_in", "sam")
            self.assertFalse(refused.exception.locked)
            clock.advance(SPACING)
            attempt_limiter.begin("sign_in", "sam")

    def test_simultaneous_attempts_are_refused_before_any_is_checked(self):
        """The spacing is claimed at the start of an attempt, so a burst cannot all be tried at once."""
        with limiter_clock():
            attempt_limiter.begin("sign_in", "sam")
            with self.assertRaises(attempt_limiter.TooManyAttempts):
                attempt_limiter.begin("sign_in", "sam")

    def test_consecutive_failures_pause_the_account(self):
        with limiter_clock() as clock:
            for attempt in range(attempt_limiter.MAX_CONSECUTIVE_FAILURES):
                attempt_limiter.begin("sign_in", "sam")
                locked = attempt_limiter.failed("sign_in", "sam")
                self.assertEqual(locked, attempt == attempt_limiter.MAX_CONSECUTIVE_FAILURES - 1)
                clock.advance(SPACING)
            with self.assertRaises(attempt_limiter.TooManyAttempts) as refused:
                attempt_limiter.begin("sign_in", "sam")
            self.assertTrue(refused.exception.locked)
            clock.advance(attempt_limiter.LOCKOUT_SECONDS)
            attempt_limiter.begin("sign_in", "sam")

    def test_a_success_clears_the_count(self):
        with limiter_clock() as clock:
            for _ in range(attempt_limiter.MAX_CONSECUTIVE_FAILURES - 1):
                attempt_limiter.begin("sign_in", "sam")
                attempt_limiter.failed("sign_in", "sam")
                clock.advance(SPACING)
            attempt_limiter.begin("sign_in", "sam")
            attempt_limiter.succeeded("sign_in", "sam")
            attempt_limiter.begin("sign_in", "sam")
            self.assertFalse(attempt_limiter.failed("sign_in", "sam"))

    def test_failures_spread_out_are_forgotten(self):
        with limiter_clock() as clock:
            for _ in range(attempt_limiter.MAX_CONSECUTIVE_FAILURES - 1):
                attempt_limiter.begin("sign_in", "sam")
                attempt_limiter.failed("sign_in", "sam")
                clock.advance(SPACING)
            clock.advance(attempt_limiter.FAILURE_MEMORY_SECONDS + 1)
            attempt_limiter.begin("sign_in", "sam")
            self.assertFalse(attempt_limiter.failed("sign_in", "sam"))

    def test_kinds_of_secret_are_counted_apart(self):
        with limiter_clock():
            attempt_limiter.begin("vault", "u1")
            attempt_limiter.begin("two_factor", "u1")
            attempt_limiter.begin("sign_in", "u1")


class _SignInOn(unittest.TestCase):
    """The harness identity ("Tester") becomes the admin; "Sam" becomes a member with a password."""

    def _turn_sign_in_on(self, client) -> None:
        admin_id = client.get("/api/auth/me").json()["user"]["id"]
        client.post("/api/auth/identities", json={"name": "Sam"})
        enabled = client.post("/api/auth/enable", json={
            "enabled": True, "claim_user_id": admin_id, "admin_password": ADMIN_PASSWORD, "initial_passwords": {},
        })
        self.assertEqual(enabled.status_code, 200, enabled.text)
        client.post("/api/auth/logout")
        self.assertEqual(client.post("/api/auth/login", json={"username": "Sam", "password": ""}).status_code, 200)
        changed = client.post("/api/auth/change-password", json={"new_password": MEMBER_PASSWORD})
        self.assertEqual(changed.status_code, 200, changed.text)
        client.post("/api/auth/logout")

    def _login(self, client, username: str, password: str):
        return client.post("/api/auth/login", json={"username": username, "password": password})

    def _sign_in(self, client, username: str, password: str) -> None:
        signed_in = self._login(client, username, password)
        self.assertEqual(signed_in.status_code, 200, signed_in.text)

    def _assert_too_many(self, response, retry_after: int | None = None) -> dict:
        self.assertEqual(response.status_code, 429, response.text)
        detail = response.json()["detail"]
        self.assertEqual(detail["code"], "too_many_attempts")
        self.assertEqual(response.headers["Retry-After"], str(detail["retry_after"]))
        if retry_after is not None:
            self.assertEqual(detail["retry_after"], retry_after)
        return detail


class PasswordGuessingTests(_SignInOn):
    def test_wrong_passwords_pause_the_account_and_the_right_one_waits_too(self):
        with api_client() as (client, _), limiter_clock() as clock:
            self._turn_sign_in_on(client)
            for _ in range(attempt_limiter.MAX_CONSECUTIVE_FAILURES - 1):
                self.assertEqual(self._login(client, "Sam", "guess").status_code, 401)
                clock.advance(SPACING)
            # The failure that starts the pause says so at once.
            self._assert_too_many(self._login(client, "Sam", "guess"), attempt_limiter.LOCKOUT_SECONDS)

            clock.advance(SPACING)
            self._assert_too_many(self._login(client, "Sam", MEMBER_PASSWORD))

            clock.advance(attempt_limiter.LOCKOUT_SECONDS)
            self._sign_in(client, "Sam", MEMBER_PASSWORD)

    def test_a_guess_straight_after_another_is_refused_unchecked(self):
        with api_client() as (client, _), limiter_clock():
            self._turn_sign_in_on(client)
            self.assertEqual(self._login(client, "Sam", "guess").status_code, 401)
            self._assert_too_many(self._login(client, "Sam", MEMBER_PASSWORD), SPACING)

    def test_a_name_with_no_account_is_limited_the_same_way(self):
        """Otherwise the difference between a 401 and a 429 would say which names are real."""
        with api_client() as (client, _), limiter_clock() as clock:
            self._turn_sign_in_on(client)
            for _ in range(attempt_limiter.MAX_CONSECUTIVE_FAILURES - 1):
                self.assertEqual(self._login(client, "nobody", "guess").status_code, 401)
                clock.advance(SPACING)
            self._assert_too_many(self._login(client, "nobody", "guess"), attempt_limiter.LOCKOUT_SECONDS)

    def test_one_account_paused_leaves_the_others_alone(self):
        with api_client() as (client, _), limiter_clock() as clock:
            self._turn_sign_in_on(client)
            for _ in range(attempt_limiter.MAX_CONSECUTIVE_FAILURES):
                self._login(client, "Sam", "guess")
                clock.advance(SPACING)
            self._sign_in(client, "Tester", ADMIN_PASSWORD)


class TwoFactorGuessingTests(_SignInOn):
    def _enable_two_factor(self, client) -> str:
        self._sign_in(client, "Sam", MEMBER_PASSWORD)
        secret = client.post("/api/auth/2fa/setup").json()["secret"]
        confirmed = client.post("/api/auth/2fa/confirm", json={"secret": secret, "code": _totp_code(secret)})
        self.assertEqual(confirmed.status_code, 200, confirmed.text)
        client.post("/api/auth/logout")
        return secret

    def _to_second_factor(self, client) -> None:
        pending = self._login(client, "Sam", MEMBER_PASSWORD)
        self.assertEqual(pending.status_code, 200, pending.text)
        self.assertTrue(pending.json().get("requires_2fa"))

    def test_wrong_codes_drop_the_challenge_so_the_password_is_needed_again(self):
        with api_client() as (client, _), limiter_clock() as clock:
            self._turn_sign_in_on(client)
            secret = self._enable_two_factor(client)
            self._to_second_factor(client)
            wrong = _wrong_code(secret)
            for _ in range(attempt_limiter.MAX_CONSECUTIVE_FAILURES - 1):
                self.assertEqual(client.post("/api/auth/2fa/verify", json={"code": wrong}).status_code, 401)
                clock.advance(SPACING)
            detail = self._assert_too_many(client.post("/api/auth/2fa/verify", json={"code": wrong}))
            self.assertTrue(detail.get("restart_sign_in"))

            # The challenge is gone: even the right code has nothing to answer.
            clock.advance(SPACING)
            gone = client.post("/api/auth/2fa/verify", json={"code": _totp_code(secret)})
            self.assertEqual(gone.status_code, 400, gone.text)

            # Proving the password again does not reopen the guessing: the pause is the account's.
            self._to_second_factor(client)
            self._assert_too_many(client.post("/api/auth/2fa/verify", json={"code": _totp_code(secret)}))

            clock.advance(attempt_limiter.LOCKOUT_SECONDS)
            self._to_second_factor(client)
            done = client.post("/api/auth/2fa/verify", json={"code": _totp_code(secret)})
            self.assertEqual(done.status_code, 200, done.text)

    def test_a_code_is_accepted_once(self):
        with api_client() as (client, _), limiter_clock():
            self._turn_sign_in_on(client)
            secret = self._enable_two_factor(client)
            code = _totp_code(secret)
            self._to_second_factor(client)
            self.assertEqual(client.post("/api/auth/2fa/verify", json={"code": code}).status_code, 200)
            client.post("/api/auth/logout")

            self._to_second_factor(client)
            replayed = client.post("/api/auth/2fa/verify", json={"code": code})
            self.assertEqual(replayed.status_code, 401, replayed.text)

    def test_turning_two_factor_off_is_limited_like_signing_in(self):
        """A stolen session must not be able to guess its way to switching the second factor off."""
        with api_client() as (client, _), limiter_clock() as clock:
            self._turn_sign_in_on(client)
            secret = self._enable_two_factor(client)
            self._to_second_factor(client)
            client.post("/api/auth/2fa/verify", json={"code": _totp_code(secret)})
            wrong = _wrong_code(secret)
            for _ in range(attempt_limiter.MAX_CONSECUTIVE_FAILURES - 1):
                clock.advance(SPACING)
                self.assertEqual(client.post("/api/auth/2fa/disable", json={"code": wrong}).status_code, 401)
            clock.advance(SPACING)
            self._assert_too_many(client.post("/api/auth/2fa/disable", json={"code": wrong}))
            self.assertTrue(client.get("/api/auth/me").json()["user"]["two_factor_enabled"])


class VaultGuessingTests(unittest.TestCase):
    def test_wrong_passphrases_pause_unlocking_and_the_right_one_waits_too(self):
        with api_client() as (client, _), limiter_clock() as clock:
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": STRONG_PASSPHRASE})
            client.post("/api/auth/vault/lock")
            for _ in range(attempt_limiter.MAX_CONSECUTIVE_FAILURES - 1):
                self.assertEqual(
                    client.post("/api/auth/vault/unlock", json={"passphrase": "guess"}).status_code, 400,
                )
                clock.advance(SPACING)
            last = client.post("/api/auth/vault/unlock", json={"passphrase": "guess"})
            self.assertEqual(last.status_code, 429, last.text)

            clock.advance(SPACING)
            waiting = client.post("/api/auth/vault/unlock", json={"passphrase": STRONG_PASSPHRASE})
            self.assertEqual(waiting.status_code, 429, waiting.text)

            clock.advance(attempt_limiter.LOCKOUT_SECONDS)
            opened = client.post("/api/auth/vault/unlock", json={"passphrase": STRONG_PASSPHRASE})
            self.assertEqual(opened.status_code, 200, opened.text)
            self.assertTrue(opened.json()["user"]["vault_unlocked"])

    def test_a_wrong_old_passphrase_counts_against_the_same_limit(self):
        with api_client() as (client, _), limiter_clock() as clock:
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": STRONG_PASSPHRASE})
            for _ in range(attempt_limiter.MAX_CONSECUTIVE_FAILURES):
                client.post("/api/auth/vault/change-passphrase", json={
                    "old_passphrase": "guess", "new_passphrase": STRONG_PASSPHRASE + "-2",
                })
                clock.advance(SPACING)
            client.post("/api/auth/vault/lock")
            refused = client.post("/api/auth/vault/unlock", json={"passphrase": STRONG_PASSPHRASE})
            self.assertEqual(refused.status_code, 429, refused.text)


class SessionEndingTests(_SignInOn):
    def _cookies(self, client) -> dict:
        return dict(client.cookies)

    def _use(self, client, cookies: dict) -> None:
        client.cookies.clear()
        for name, value in cookies.items():
            client.cookies.set(name, value)

    def test_signing_out_ends_a_copy_of_the_cookie_too(self):
        with api_client() as (client, _):
            self._turn_sign_in_on(client)
            self._sign_in(client, "Sam", MEMBER_PASSWORD)
            copied = self._cookies(client)
            client.post("/api/auth/logout")

            self._use(client, copied)
            self.assertEqual(client.get("/api/auth/me").status_code, 401)
            self.assertNotIn("user", client.get("/api/auth/status").json())

    def test_setting_a_password_signs_the_account_out_elsewhere(self):
        with api_client() as (client, _):
            self._turn_sign_in_on(client)
            self._sign_in(client, "Sam", MEMBER_PASSWORD)
            sams_browser = self._cookies(client)

            client.cookies.clear()
            self._sign_in(client, "Tester", ADMIN_PASSWORD)
            sam = next(u for u in client.get("/api/auth/users").json()["users"] if u["username"] == "Sam")
            reset = client.patch(f"/api/auth/users/{sam['id']}", json={"password": "a-new-member-password"})
            self.assertEqual(reset.status_code, 200, reset.text)

            self._use(client, sams_browser)
            self.assertEqual(client.get("/api/auth/me").status_code, 401)

    def test_changing_your_own_password_keeps_this_browser_signed_in(self):
        with api_client() as (client, _):
            self._turn_sign_in_on(client)
            self._sign_in(client, "Tester", ADMIN_PASSWORD)
            other_browser = self._cookies(client)
            client.cookies.clear()
            self._sign_in(client, "Tester", ADMIN_PASSWORD)
            me = client.get("/api/auth/me").json()["user"]["id"]

            changed = client.patch(f"/api/auth/users/{me}", json={"password": "a-new-admin-password"})
            self.assertEqual(changed.status_code, 200, changed.text)
            self.assertEqual(client.get("/api/auth/me").status_code, 200)

            self._use(client, other_browser)
            self.assertEqual(client.get("/api/auth/me").status_code, 401)

    def test_disabling_an_account_signs_it_out(self):
        with api_client() as (client, _):
            self._turn_sign_in_on(client)
            self._sign_in(client, "Sam", MEMBER_PASSWORD)
            sams_browser = self._cookies(client)

            client.cookies.clear()
            self._sign_in(client, "Tester", ADMIN_PASSWORD)
            sam = next(u for u in client.get("/api/auth/users").json()["users"] if u["username"] == "Sam")
            disabled = client.patch(f"/api/auth/users/{sam['id']}", json={"status": "disabled"})
            self.assertEqual(disabled.status_code, 200, disabled.text)

            self._use(client, sams_browser)
            self.assertEqual(client.get("/api/auth/me").status_code, 401)

    def test_choosing_another_identity_ends_the_session_it_replaces(self):
        with api_client() as (client, _):
            before = self._cookies(client)
            other = client.post("/api/auth/identities", json={"name": "Sam"}).json()["identity"]
            self.assertEqual(client.post("/api/auth/select-identity", json={"user_id": other["id"]}).status_code, 200)

            self._use(client, before)
            self.assertEqual(client.get("/api/auth/me").status_code, 401)

    def test_a_signed_cookie_naming_no_session_is_refused(self):
        """What a cookie from before sessions were recorded looks like, and what one signed with a leaked
        secret looks like: a valid signature and a user, but no session the server started."""
        from backend.main import config

        with api_client() as (client, _):
            me = client.get("/api/auth/me").json()["user"]["id"]
            payload = base64.b64encode(json.dumps({"user_id": me}).encode("utf-8"))
            forged = itsdangerous.TimestampSigner(str(config.session_secret)).sign(payload).decode("utf-8")
            self._use(client, {config.session_cookie_name: forged})
            self.assertEqual(client.get("/api/auth/me").status_code, 401)


if __name__ == "__main__":
    unittest.main()
