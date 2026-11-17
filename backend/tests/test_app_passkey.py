# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Passkey sign-in, end to end through the real endpoints.

The ceremonies run against a software authenticator (`_software_authenticator.py`) that produces the
same bytes a browser does, so every assertion here is verified by the same code a real sign-in runs.

Two things this file is careful about. The **negative** cases are the point: an authentication check is
only worth having if it refuses, so each one is driven by making exactly the mistake it exists to catch —
a replayed challenge, a foreign origin, a signature from the wrong key. And the **two-factor** case is a
test of a design decision rather than of a line of code: a passkey sign-in is meant to complete without
the TOTP prompt, and if that ever silently reverts, the feature has lost its reason to exist.
"""

import os
import unittest
from unittest import mock

from webauthn import base64url_to_bytes

from backend.tests._api_client import api_client
from backend.tests._software_authenticator import SoftwareAuthenticator, b64url

# Loopback, because a passkey ceremony refuses to run on a cleartext non-loopback host — which is the
# real rule, not a harness quirk (`security-model.md` → *Transport security*).
BASE_URL = "http://localhost"
ORIGIN = "http://localhost"
RP_ID = "localhost"
ADMIN_PASSWORD = "an-admin-password"


class PasskeySignInTests(unittest.TestCase):
    def _turn_sign_in_on(self, client) -> str:
        """The harness identity becomes an admin with a password, and signs in. Returns the user id."""
        admin_id = client.get("/api/auth/me").json()["user"]["id"]
        enabled = client.post("/api/auth/enable", json={
            "enabled": True, "claim_user_id": admin_id,
            "admin_password": ADMIN_PASSWORD, "initial_passwords": {},
        })
        self.assertEqual(enabled.status_code, 200, enabled.text)
        return admin_id

    def _sign_in_with_password(self, client, username: str = "Tester"):
        signed_in = client.post("/api/auth/login", json={
            "username": username, "password": ADMIN_PASSWORD,
        })
        self.assertEqual(signed_in.status_code, 200, signed_in.text)
        return signed_in

    def _register(self, client, authenticator: SoftwareAuthenticator, *, label="Laptop"):
        begun = client.post("/api/auth/passkey/register/begin")
        self.assertEqual(begun.status_code, 200, begun.text)
        options = begun.json()["options"]
        # A real authenticator stores whatever handle the options name and returns it on every sign-in,
        # so the test takes it from there too rather than assuming how the server derives it.
        authenticator.user_handle = base64url_to_bytes(options["user"]["id"])
        credential = authenticator.create(rp_id=RP_ID, challenge=options["challenge"], origin=ORIGIN)
        return client.post(
            "/api/auth/passkey/register/complete",
            json={"credential": credential, "label": label},
            headers={"Origin": ORIGIN},
        )

    def _begin_login(self, client) -> str:
        begun = client.post("/api/auth/passkey/login/begin")
        self.assertEqual(begun.status_code, 200, begun.text)
        return begun.json()["options"]["challenge"]

    def _complete_login(self, client, credential):
        return client.post(
            "/api/auth/passkey/login/complete",
            json={"credential": credential},
            headers={"Origin": ORIGIN},
        )

    # --- the path a user actually takes ---------------------------------------------------------

    def test_a_registered_passkey_signs_in(self):
        with api_client(base_url=BASE_URL) as (client, _):
            admin_id = self._turn_sign_in_on(client)
            self._sign_in_with_password(client)
            authenticator = SoftwareAuthenticator()
            registered = self._register(client, authenticator)
            self.assertEqual(registered.status_code, 200, registered.text)
            self.assertEqual(len(registered.json()["user"]["app_passkeys"]), 1)
            self.assertEqual(registered.json()["user"]["app_passkeys"][0]["label"], "Laptop")

            client.post("/api/auth/logout")
            self.assertEqual(client.get("/api/auth/me").status_code, 401)

            challenge = self._begin_login(client)
            assertion = authenticator.get(rp_id=RP_ID, challenge=challenge, origin=ORIGIN)
            completed = self._complete_login(client, assertion)
            self.assertEqual(completed.status_code, 200, completed.text)
            self.assertEqual(completed.json()["user"]["id"], admin_id)
            # The session is real, not just a response body: the next request is authenticated.
            self.assertEqual(client.get("/api/auth/me").json()["user"]["id"], admin_id)

    def test_a_passkey_sign_in_completes_without_the_two_factor_prompt(self):
        """The design decision, asserted. A passkey is run with user verification required, so it
        establishes possession *and* a biometric or PIN — the TOTP step would charge twice for the same
        guarantee, and the friction it adds is what this feature exists to remove."""
        with api_client(base_url=BASE_URL) as (client, _):
            admin_id = self._turn_sign_in_on(client)
            self._sign_in_with_password(client)
            authenticator = SoftwareAuthenticator()
            self.assertEqual(self._register(client, authenticator).status_code, 200)

            setup = client.post("/api/auth/2fa/setup")
            self.assertEqual(setup.status_code, 200, setup.text)
            secret = setup.json()["secret"]
            from backend.db.control_database import _totp_code

            confirmed = client.post("/api/auth/2fa/confirm", json={
                "secret": secret, "code": _totp_code(secret),
            })
            self.assertEqual(confirmed.status_code, 200, confirmed.text)
            self.assertTrue(confirmed.json()["user"]["two_factor_enabled"])

            # A password sign-in now stops at the second factor...
            client.post("/api/auth/logout")
            with_password = self._sign_in_with_password(client)
            self.assertTrue(with_password.json().get("requires_2fa"))

            # ...while the passkey completes the sign-in outright.
            client.post("/api/auth/logout")
            challenge = self._begin_login(client)
            assertion = authenticator.get(rp_id=RP_ID, challenge=challenge, origin=ORIGIN)
            completed = self._complete_login(client, assertion)
            self.assertEqual(completed.status_code, 200, completed.text)
            self.assertNotIn("requires_2fa", completed.json())
            self.assertEqual(completed.json()["user"]["id"], admin_id)

    def test_a_removed_passkey_no_longer_signs_in(self):
        """A second device stays registered so the sign-in ceremony still starts — with none left it is
        refused before any passkey is asked for, which would never reach the check this is about."""
        with api_client(base_url=BASE_URL) as (client, _):
            self._turn_sign_in_on(client)
            self._sign_in_with_password(client)
            laptop, phone = SoftwareAuthenticator(), SoftwareAuthenticator()
            passkey_id = self._register(client, laptop).json()["user"]["app_passkeys"][0]["id"]
            self._register(client, phone, label="Phone")

            removed = client.delete(f"/api/auth/passkey/{passkey_id}")
            self.assertEqual(removed.status_code, 200, removed.text)
            self.assertEqual([p["label"] for p in removed.json()["user"]["app_passkeys"]], ["Phone"])

            client.post("/api/auth/logout")
            challenge = self._begin_login(client)
            assertion = laptop.get(rp_id=RP_ID, challenge=challenge, origin=ORIGIN)
            self.assertEqual(self._complete_login(client, assertion).status_code, 401)

            challenge = self._begin_login(client)
            assertion = phone.get(rp_id=RP_ID, challenge=challenge, origin=ORIGIN)
            self.assertEqual(self._complete_login(client, assertion).status_code, 200)

    # --- the refusals ---------------------------------------------------------------------------

    def test_an_assertion_cannot_be_replayed(self):
        """The same signed assertion, sent twice. The challenge is popped from the session on use, so
        the second attempt has nothing to verify against — which is the property that makes a captured
        assertion worthless."""
        with api_client(base_url=BASE_URL) as (client, _):
            self._turn_sign_in_on(client)
            self._sign_in_with_password(client)
            authenticator = SoftwareAuthenticator()
            self._register(client, authenticator)
            client.post("/api/auth/logout")

            challenge = self._begin_login(client)
            assertion = authenticator.get(rp_id=RP_ID, challenge=challenge, origin=ORIGIN)
            self.assertEqual(self._complete_login(client, assertion).status_code, 200)

            client.post("/api/auth/logout")
            replayed = self._complete_login(client, assertion)
            self.assertEqual(replayed.status_code, 400, replayed.text)
            self.assertEqual(client.get("/api/auth/me").status_code, 401)

    def test_an_assertion_signed_by_a_different_key_is_refused(self):
        """Proves the signature is actually checked, rather than the credential merely being looked up.
        Everything is right except the key that signed it."""
        with api_client(base_url=BASE_URL) as (client, _):
            self._turn_sign_in_on(client)
            self._sign_in_with_password(client)
            authenticator = SoftwareAuthenticator()
            self._register(client, authenticator)
            client.post("/api/auth/logout")

            impostor = SoftwareAuthenticator()
            challenge = self._begin_login(client)
            forged = authenticator.get(
                rp_id=RP_ID, challenge=challenge, origin=ORIGIN, signing_key=impostor.key,
            )
            self.assertEqual(self._complete_login(client, forged).status_code, 401)
            self.assertEqual(client.get("/api/auth/me").status_code, 401)

    def test_an_assertion_from_another_origin_is_refused(self):
        with api_client(base_url=BASE_URL) as (client, _):
            self._turn_sign_in_on(client)
            self._sign_in_with_password(client)
            authenticator = SoftwareAuthenticator()
            self._register(client, authenticator)
            client.post("/api/auth/logout")

            challenge = self._begin_login(client)
            elsewhere = authenticator.get(
                rp_id=RP_ID, challenge=challenge, origin="http://not-this-app.test",
            )
            self.assertEqual(self._complete_login(client, elsewhere).status_code, 401)

    def test_an_unverified_user_is_refused(self):
        """User verification is what makes a passkey stand in for two factors, so an assertion that
        merely proves someone touched the device must not sign anyone in."""
        with api_client(base_url=BASE_URL) as (client, _):
            self._turn_sign_in_on(client)
            self._sign_in_with_password(client)
            authenticator = SoftwareAuthenticator()
            self._register(client, authenticator)
            client.post("/api/auth/logout")

            challenge = self._begin_login(client)
            unverified = authenticator.get(
                rp_id=RP_ID, challenge=challenge, origin=ORIGIN, user_verified=False,
            )
            self.assertEqual(self._complete_login(client, unverified).status_code, 401)

    def test_a_sign_counter_that_goes_backwards_is_refused(self):
        """A counter running backwards is the documented signal of a cloned credential. Driven from an
        authenticator that keeps a real counter, since the check is skipped entirely for one that does
        not — see the sibling test below, which is the case that would break if this one were tightened."""
        with api_client(base_url=BASE_URL) as (client, _):
            self._turn_sign_in_on(client)
            self._sign_in_with_password(client)
            authenticator = SoftwareAuthenticator(sign_count=5)
            self._register(client, authenticator)
            client.post("/api/auth/logout")

            challenge = self._begin_login(client)
            assertion = authenticator.get(rp_id=RP_ID, challenge=challenge, origin=ORIGIN)
            self.assertEqual(self._complete_login(client, assertion).status_code, 200)

            client.post("/api/auth/logout")
            challenge = self._begin_login(client)
            stale = authenticator.get(rp_id=RP_ID, challenge=challenge, origin=ORIGIN, sign_count=3)
            self.assertEqual(self._complete_login(client, stale).status_code, 401)

    def test_an_authenticator_that_keeps_no_counter_still_signs_in(self):
        """Platform authenticators backed by a synced keychain report a permanent 0. Treating that as a
        regression would lock out the very devices this feature is for, so a 0 against a stored 0 is an
        ordinary sign-in — twice over, since the second is where a naive `<=` check would fire."""
        with api_client(base_url=BASE_URL) as (client, _):
            self._turn_sign_in_on(client)
            self._sign_in_with_password(client)
            authenticator = SoftwareAuthenticator()
            self._register(client, authenticator)
            client.post("/api/auth/logout")

            for _attempt in range(2):
                challenge = self._begin_login(client)
                assertion = authenticator.get(
                    rp_id=RP_ID, challenge=challenge, origin=ORIGIN, sign_count=0,
                )
                self.assertEqual(self._complete_login(client, assertion).status_code, 200)
                client.post("/api/auth/logout")

    def test_an_unknown_credential_is_refused(self):
        with api_client(base_url=BASE_URL) as (client, _):
            self._turn_sign_in_on(client)
            self._sign_in_with_password(client)
            self._register(client, SoftwareAuthenticator())
            client.post("/api/auth/logout")

            stranger = SoftwareAuthenticator()
            challenge = self._begin_login(client)
            assertion = stranger.get(rp_id=RP_ID, challenge=challenge, origin=ORIGIN)
            self.assertEqual(self._complete_login(client, assertion).status_code, 401)

    def test_registering_a_passkey_needs_a_signed_in_session(self):
        with api_client(base_url=BASE_URL) as (client, _):
            self._turn_sign_in_on(client)
            client.post("/api/auth/logout")
            self.assertEqual(client.post("/api/auth/passkey/register/begin").status_code, 401)
            stranger = SoftwareAuthenticator()
            credential = stranger.create(rp_id=RP_ID, challenge=b64url(b"x" * 32), origin=ORIGIN)
            refused = client.post(
                "/api/auth/passkey/register/complete",
                json={"credential": credential},
                headers={"Origin": ORIGIN},
            )
            self.assertEqual(refused.status_code, 401)

    def test_the_same_passkey_cannot_be_registered_twice(self):
        with api_client(base_url=BASE_URL) as (client, _):
            self._turn_sign_in_on(client)
            self._sign_in_with_password(client)
            authenticator = SoftwareAuthenticator()
            self.assertEqual(self._register(client, authenticator).status_code, 200)
            again = self._register(client, authenticator, label="Same device")
            self.assertEqual(again.status_code, 400, again.text)
            me = client.get("/api/auth/me").json()["user"]
            self.assertEqual(len(me["app_passkeys"]), 1)

    # --- what the sign-in screen is told ---------------------------------------------------------

    def test_params_reports_availability_without_a_session(self):
        with api_client(base_url=BASE_URL) as (client, _):
            self._turn_sign_in_on(client)
            self._sign_in_with_password(client)
            authenticator = SoftwareAuthenticator()
            self._register(client, authenticator)
            client.post("/api/auth/logout")

            params = client.get("/api/auth/passkey/params")
            self.assertEqual(params.status_code, 200, params.text)
            self.assertTrue(params.json()["available"])
            self.assertEqual(params.json()["rp_id"], RP_ID)
            self.assertTrue(params.json()["any_registered"])

    def test_a_cleartext_networked_host_cannot_run_a_ceremony(self):
        """`testserver` is a name rather than an address, so what disqualifies it is the cleartext
        connection — and the reason is stated rather than left to surface as a browser exception."""
        with api_client() as (client, _):
            params = client.get("/api/auth/passkey/params")
            self.assertEqual(params.status_code, 200, params.text)
            self.assertFalse(params.json()["available"])
            self.assertEqual(params.json()["reason"], "insecure_context")
            self.assertIsNone(params.json()["rp_id"])


    # --- what a device's passkey chooser is given ------------------------------------------------
    #
    # A device keeps one passkey list per host — not per install, port or feature — so the vault's
    # passkeys and every other Luma database served on the same host land in the same list. These pin the
    # three things that keep sign-in usable in that list and keep it from damaging the vault's entries.

    def test_sign_in_names_exactly_the_workspaces_sign_in_passkeys(self):
        """The list is what stops the browser offering every passkey it holds for the host."""
        with api_client(base_url=BASE_URL) as (client, _):
            self._turn_sign_in_on(client)
            self._sign_in_with_password(client)
            laptop, phone = SoftwareAuthenticator(), SoftwareAuthenticator()
            self._register(client, laptop)
            self._register(client, phone, label="Phone")
            client.post("/api/auth/logout")

            begun = client.post("/api/auth/passkey/login/begin")
            self.assertEqual(begun.status_code, 200, begun.text)
            listed = {entry["id"] for entry in begun.json()["options"]["allowCredentials"]}
            self.assertEqual(listed, {b64url(laptop.credential_id), b64url(phone.credential_id)})

    def test_nothing_to_sign_in_with_is_refused_before_a_device_is_asked(self):
        """An empty list means "any passkey" to a browser, so it must never be sent."""
        with api_client(base_url=BASE_URL) as (client, _):
            self._turn_sign_in_on(client)
            client.post("/api/auth/logout")
            self.assertFalse(client.get("/api/auth/passkey/params").json()["any_registered"])
            self.assertEqual(client.post("/api/auth/passkey/login/begin").status_code, 400)

    def test_a_sign_in_passkey_is_registered_under_its_own_account_handle(self):
        """The handle is how an authenticator decides two passkeys are the same account, and it may replace
        one with the other. Sharing the vault's would let adding one delete the other from the device."""
        with api_client(base_url=BASE_URL) as (client, _):
            self._turn_sign_in_on(client)
            self._sign_in_with_password(client)
            sign_in = client.post("/api/auth/passkey/register/begin").json()["options"]["user"]
            vault = client.get("/api/auth/vault/passkey/params").json()
            self.assertNotEqual(base64url_to_bytes(sign_in["id"]), vault["user_handle"].encode())

    def test_the_two_kinds_are_labelled_apart(self):
        """Both kinds sit in one list on the device; a bare username twice gives no way to pick."""
        with api_client(base_url=BASE_URL) as (client, _):
            self._turn_sign_in_on(client)
            self._sign_in_with_password(client)
            sign_in = client.post("/api/auth/passkey/register/begin").json()["options"]["user"]
            vault = client.get("/api/auth/vault/passkey/params").json()
            self.assertNotEqual(sign_in["name"], vault["user_name"])
            self.assertNotEqual(sign_in["displayName"], vault["display_name"])
            self.assertNotIn("Tester", {sign_in["name"], vault["user_name"]})

    def test_both_kinds_name_the_server_as_it_was_renamed(self):
        """The interface's own name is fixed at build time, so on an installation renamed by `APP_NAME`
        the vault's ceremony has to take the name from the server, as sign-in does — colour left off."""
        with mock.patch.dict(os.environ, {"APP_NAME": "<red>Ledger Demo"}), api_client(base_url=BASE_URL) as (client, _):
            self._turn_sign_in_on(client)
            self._sign_in_with_password(client)
            sign_in = client.post("/api/auth/passkey/register/begin").json()["options"]["rp"]
            vault = client.get("/api/auth/vault/passkey/params").json()
            self.assertEqual(sign_in["name"], "Ledger Demo")
            self.assertEqual(vault["rp_name"], sign_in["name"])

    def test_an_assertion_carrying_the_vaults_handle_is_refused(self):
        """A passkey that claims the account id as its handle — the vault's, and what sign-in passkeys
        used to be registered under — does not sign in, whatever else about it checks out."""
        with api_client(base_url=BASE_URL) as (client, _):
            admin_id = self._turn_sign_in_on(client)
            self._sign_in_with_password(client)
            laptop = SoftwareAuthenticator()
            self._register(client, laptop)
            client.post("/api/auth/logout")

            laptop.user_handle = admin_id.encode()
            challenge = self._begin_login(client)
            assertion = laptop.get(rp_id=RP_ID, challenge=challenge, origin=ORIGIN)
            self.assertEqual(self._complete_login(client, assertion).status_code, 401)
            self.assertEqual(client.get("/api/auth/me").status_code, 401)


if __name__ == "__main__":
    unittest.main()
