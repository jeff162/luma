"""
Vault + gating through the full HTTP stack (phase 3): the /auth/vault/* lifecycle, the vault status
fields and transport block on /auth/status, and the connect/Production gates that key off vault state.

Runs perimeter-off (the shared harness identity), which is the case that must still require a vault to
store live tokens — app-login and the vault are orthogonal.
"""

from __future__ import annotations

import unittest

from backend.services import attempt_limiter
from backend.services import crypto_service as cs
from backend.tests._api_client import STRONG_PASSPHRASE, api_client, limiter_clock


class VaultEndpointTests(unittest.TestCase):
    def setUp(self):
        cs.lock_all()

    def tearDown(self):
        cs.lock_all()

    def test_status_exposes_vault_and_transport(self):
        with api_client() as (client, _):
            status = client.get("/api/auth/status").json()
            self.assertFalse(status["user"]["vault_configured"])
            self.assertFalse(status["user"]["vault_unlocked"])
            self.assertIn("transport", status)
            for key in ("is_loopback", "scheme", "is_https", "https_expected", "https_warning_suppressed"):
                self.assertIn(key, status["transport"])

    def test_set_lock_unlock_lifecycle(self):
        with api_client() as (client, _):
            r = client.post("/api/auth/vault/set-passphrase", json={"passphrase": STRONG_PASSPHRASE})
            self.assertEqual(r.status_code, 200)
            user = r.json()["user"]
            self.assertTrue(user["vault_configured"])
            self.assertTrue(user["vault_has_passphrase"])
            self.assertTrue(user["vault_unlocked"])

            locked = client.post("/api/auth/vault/lock").json()["user"]
            self.assertFalse(locked["vault_unlocked"])

            with limiter_clock() as clock:
                bad = client.post("/api/auth/vault/unlock", json={"passphrase": "wrong"})
                self.assertEqual(bad.status_code, 400)

                clock.advance(attempt_limiter.MIN_SPACING_SECONDS)
                good = client.post("/api/auth/vault/unlock", json={"passphrase": STRONG_PASSPHRASE})
            self.assertEqual(good.status_code, 200)
            self.assertTrue(good.json()["user"]["vault_unlocked"])

    def test_connect_requires_a_configured_vault(self):
        with api_client() as (client, _):
            r = client.post("/api/plaid/exchange", json={"public_token": "public-sandbox-x"})
            self.assertEqual(r.status_code, 409)
            self.assertEqual(r.json()["detail"]["code"], "vault_not_configured")

    def test_connect_requires_an_unlocked_vault(self):
        with api_client() as (client, _):
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": STRONG_PASSPHRASE})
            client.post("/api/auth/vault/lock")
            r = client.post("/api/plaid/exchange", json={"public_token": "public-sandbox-x"})
            self.assertEqual(r.status_code, 423)
            self.assertEqual(r.json()["detail"]["code"], "vault_locked")

    def test_a_weak_passphrase_is_refused_with_the_numbers_the_dialog_needs(self):
        # The floor is data, not just prose: the dialog gates its own submit button on these two numbers,
        # so a client that had to parse them out of a sentence would drift from the server and either
        # block what the server accepts or offer what it refuses.
        with api_client() as (client, _):
            r = client.post("/api/auth/vault/set-passphrase", json={"passphrase": "shortpass"})
        self.assertEqual(r.status_code, 400, r.text)
        detail = r.json()["detail"]
        self.assertEqual(detail["code"], "weak_passphrase")
        self.assertEqual(detail["min_length"], cs.VAULT_PRODUCTION_MIN_LEN)
        self.assertEqual(detail["min_distinct"], cs.VAULT_PRODUCTION_MIN_DISTINCT)

    def test_changing_to_a_weak_passphrase_is_refused_the_same_way(self):
        with api_client() as (client, _):
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": STRONG_PASSPHRASE})
            r = client.post("/api/auth/vault/change-passphrase",
                            json={"old_passphrase": STRONG_PASSPHRASE, "new_passphrase": "shortpass"})
        self.assertEqual(r.status_code, 400, r.text)
        self.assertEqual(r.json()["detail"]["code"], "weak_passphrase")

    def test_switching_a_provider_to_production_needs_no_second_passphrase_test(self):
        # The environment gate is gone with the weak tier that motivated it. Storing a secret still needs
        # an unlocked vault, and that vault is strong by construction — so Production is reachable without
        # a separate strength challenge that could only ever pass.
        with api_client() as (client, _):
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": STRONG_PASSPHRASE})
            r = client.post("/api/providers/plaid/config",
                            json={"client_id": "cid", "secret": "sek", "env": "production"})
        self.assertEqual(r.status_code, 200, r.text)


class VaultAccessEndpointTests(unittest.TestCase):
    """Enrollment and grant over HTTP: the states a second household member actually moves through.

    Perimeter-off, so identities are switched with `select-identity` — which is also the real shape of
    the case this exists for, since a passwordless install still needs vault access to be shareable.
    """

    OTHER_PASSPHRASE = "another-strong-vault-passphrase"

    def setUp(self):
        cs.lock_all()

    def tearDown(self):
        cs.lock_all()

    def _add_identity(self, client, name: str) -> str:
        return client.post("/api/auth/identities", json={"name": name}).json()["identity"]["id"]

    def _become(self, client, user_id: str, *, unlock_with: str | None = None):
        client.post("/api/auth/select-identity", json={"user_id": user_id})
        # Picking an identity starts a new browser session, and an unlock belongs to the session that made
        # it (`test_vault_session_scope.py`), so switching back to someone does not find them unlocked.
        if unlock_with:
            opened = client.post("/api/auth/vault/unlock", json={"passphrase": unlock_with})
            assert opened.status_code == 200, opened.text

    def test_a_second_user_enrolls_and_is_approved(self):
        with api_client() as (client, _):
            owner = client.get("/api/auth/status").json()["user"]["id"]
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": STRONG_PASSPHRASE})

            joiner = self._add_identity(client, "Joiner")
            self._become(client, joiner)
            enrolled = client.post("/api/auth/vault/set-passphrase", json={"passphrase": self.OTHER_PASSPHRASE})
            self.assertEqual(enrolled.status_code, 200, enrolled.text)
            user = enrolled.json()["user"]
            self.assertTrue(user["vault_access_pending"])
            self.assertFalse(user["vault_has_passphrase"])

            # Unlocking now must say *pending*, not "wrong passphrase" — the passphrase is correct and
            # retyping it can never help.
            blocked = client.post("/api/auth/vault/unlock", json={"passphrase": self.OTHER_PASSPHRASE})
            self.assertEqual(blocked.status_code, 409)
            self.assertEqual(blocked.json()["detail"]["code"], "vault_access_pending")

            self._become(client, owner, unlock_with=STRONG_PASSPHRASE)
            requests = client.get("/api/auth/vault/access-requests").json()["requests"]
            self.assertEqual(len(requests), 1)
            self.assertEqual(requests[0]["user_id"], joiner)
            approved = client.post(f"/api/auth/vault/access-requests/{requests[0]['slot_id']}/approve")
            self.assertEqual(approved.status_code, 200, approved.text)
            self.assertEqual(approved.json()["requests"], [])

            self._become(client, joiner)
            opened = client.post("/api/auth/vault/unlock", json={"passphrase": self.OTHER_PASSPHRASE})
            self.assertEqual(opened.status_code, 200, opened.text)
            self.assertTrue(opened.json()["user"]["vault_unlocked"])

    def test_approving_with_a_locked_vault_is_a_423(self):
        with api_client() as (client, _):
            owner = client.get("/api/auth/status").json()["user"]["id"]
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": STRONG_PASSPHRASE})
            joiner = self._add_identity(client, "Joiner")
            self._become(client, joiner)
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": self.OTHER_PASSPHRASE})

            self._become(client, owner)
            client.post("/api/auth/vault/lock")
            slot_id = client.get("/api/auth/vault/access-requests").json()["requests"][0]["slot_id"]
            r = client.post(f"/api/auth/vault/access-requests/{slot_id}/approve")
            self.assertEqual(r.status_code, 423)
            self.assertEqual(r.json()["detail"]["code"], "vault_locked")

    def test_rotation_keeps_every_granted_member_working(self):
        with api_client() as (client, _):
            owner = client.get("/api/auth/status").json()["user"]["id"]
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": STRONG_PASSPHRASE})
            client.post("/api/providers/plaid/config", json={"client_id": "cid", "secret": "app-secret"})

            joiner = self._add_identity(client, "Joiner")
            self._become(client, joiner)
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": self.OTHER_PASSPHRASE})
            self._become(client, owner, unlock_with=STRONG_PASSPHRASE)
            slot_id = client.get("/api/auth/vault/access-requests").json()["requests"][0]["slot_id"]
            client.post(f"/api/auth/vault/access-requests/{slot_id}/approve")

            rotated = client.post("/api/auth/vault/rotate")
            self.assertEqual(rotated.status_code, 200, rotated.text)
            self.assertEqual(rotated.json()["result"]["secrets_reencrypted"], 1)

            # Both members still open the vault, and the stored app secret still reads back.
            self._become(client, joiner)
            self.assertEqual(
                client.post("/api/auth/vault/unlock", json={"passphrase": self.OTHER_PASSPHRASE}).status_code, 200,
            )
            secret = client.get("/api/providers/plaid/secret")
            self.assertEqual(secret.status_code, 200, secret.text)
            self.assertEqual(secret.json()["secret"], "app-secret")

    def test_rotating_with_a_locked_vault_is_a_423(self):
        with api_client() as (client, _):
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": STRONG_PASSPHRASE})
            client.post("/api/auth/vault/lock")
            r = client.post("/api/auth/vault/rotate")
            self.assertEqual(r.status_code, 423)

    def test_the_pending_queue_surfaces_as_a_task_to_anyone_who_could_act(self):
        # A computed task, like the HTTPS one: no stored dismissal, and it disappears by the condition
        # ceasing to hold. Scoped to a **member**, which is not the same as a member whose vault happens
        # to be open.
        #
        # **Deliberately the reverse of what this pinned until 2026-09-01**, when the task was hidden
        # from a member with a locked vault on the reasoning that they had "no action available". They
        # do — they unlock, then approve — and hiding it removed the only signal that would tell them to.
        # Someone who does not routinely unlock the vault never learns there is anything to unlock for,
        # so the person waiting waits indefinitely on a notification nobody sends.
        with api_client() as (client, _):
            owner = client.get("/api/auth/status").json()["user"]["id"]
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": STRONG_PASSPHRASE})
            joiner = self._add_identity(client, "Joiner")
            self._become(client, joiner)
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": self.OTHER_PASSPHRASE})

            # The person waiting is not told to approve themselves. They hold a slot, but a pending one,
            # so `user_has_slot` is false for them and the scoping still excludes them.
            self.assertNotIn("vault_access_requests", self._task_ids(client))

            self._become(client, owner)
            self.assertIn("vault_access_requests", self._task_ids(client))

            client.post("/api/auth/vault/lock")
            self.assertIn("vault_access_requests", self._task_ids(client),
                          "a locked member can still approve — after unlocking, which is the point")
            locked_task = next(t for t in client.get("/api/tasks").json()["tasks"]
                               if t["id"] == "vault_access_requests")
            self.assertIn("Unlock the vault first", locked_task["description"],
                          "and the task has to name the step between them and approving")

            client.post("/api/auth/vault/unlock", json={"passphrase": STRONG_PASSPHRASE})
            open_task = next(t for t in client.get("/api/tasks").json()["tasks"]
                             if t["id"] == "vault_access_requests")
            self.assertNotIn("Unlock the vault first", open_task["description"],
                             "and stops naming it once it no longer applies")

            slot_id = client.get("/api/auth/vault/access-requests").json()["requests"][0]["slot_id"]
            client.post(f"/api/auth/vault/access-requests/{slot_id}/approve")
            self.assertNotIn("vault_access_requests", self._task_ids(client),
                             "the task must self-clear once the queue empties")

    def test_a_non_member_is_never_nagged_about_the_queue(self):
        # The scoping that survives the change above: someone with no way into the vault cannot approve
        # at any point, so the task would be a nag with nothing behind it.
        with api_client() as (client, _):
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": STRONG_PASSPHRASE})
            joiner = self._add_identity(client, "Joiner")
            self._become(client, joiner)
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": self.OTHER_PASSPHRASE})

            outsider = self._add_identity(client, "Outsider")
            self._become(client, outsider)
            self.assertNotIn("vault_access_requests", self._task_ids(client))

    def _task_ids(self, client) -> list[str]:
        return [t["id"] for t in client.get("/api/tasks").json()["tasks"]]

    def test_revoking_access_needs_admin_and_ends_the_users_reach(self):
        with api_client() as (client, _):
            owner = client.get("/api/auth/status").json()["user"]["id"]
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": STRONG_PASSPHRASE})
            joiner = self._add_identity(client, "Joiner")
            self._become(client, joiner)
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": self.OTHER_PASSPHRASE})
            self._become(client, owner)
            slot_id = client.get("/api/auth/vault/access-requests").json()["requests"][0]["slot_id"]
            client.post(f"/api/auth/vault/access-requests/{slot_id}/approve")

            revoked = client.post(f"/api/auth/vault/access/{joiner}/revoke")
            self.assertEqual(revoked.status_code, 200, revoked.text)

            self._become(client, joiner)
            r = client.post("/api/auth/vault/unlock", json={"passphrase": self.OTHER_PASSPHRASE})
            self.assertEqual(r.status_code, 409)

    def test_members_lists_who_can_open_the_vault_and_drops_a_revoked_one(self):
        # The half that was missing: the UI could show who was *asking* for the credentials but not who
        # already held them, which left "remove someone's access before replacing the key" as advice
        # with nothing to act on.
        with api_client() as (client, _):
            owner = client.get("/api/auth/status").json()["user"]["id"]
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": STRONG_PASSPHRASE})

            members = client.get("/api/auth/vault/members").json()["members"]
            self.assertEqual([m["user_id"] for m in members], [owner])
            self.assertEqual(members[0]["method_count"], 1)

            joiner = self._add_identity(client, "Joiner")
            self._become(client, joiner)
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": self.OTHER_PASSPHRASE})
            # Still pending, so not a member yet — the two lists must not blur together.
            self.assertEqual(
                [m["user_id"] for m in client.get("/api/auth/vault/members").json()["members"]], [owner],
            )

            self._become(client, owner, unlock_with=STRONG_PASSPHRASE)
            slot_id = client.get("/api/auth/vault/access-requests").json()["requests"][0]["slot_id"]
            client.post(f"/api/auth/vault/access-requests/{slot_id}/approve")
            self.assertEqual(
                sorted(m["user_id"] for m in client.get("/api/auth/vault/members").json()["members"]),
                sorted([owner, joiner]),
            )

            client.post(f"/api/auth/vault/access/{joiner}/revoke")
            self.assertEqual(
                [m["user_id"] for m in client.get("/api/auth/vault/members").json()["members"]], [owner],
            )

    def test_members_counts_unlock_methods_per_person_not_per_slot(self):
        # One person with a passphrase and two passkeys is one member with three ways in, not three
        # people — the list answers a question about who holds the credentials.
        prf = cs._b64e(b"\x05" * 32)
        with api_client() as (client, _):
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": STRONG_PASSPHRASE})
            for cred in ("c1", "c2"):
                client.post("/api/auth/vault/passkey/register", headers={"host": "localhost:8000"},
                            json={"credential_id": cred, "prf_output": prf, "prf_salt": "s"})
            members = client.get("/api/auth/vault/members").json()["members"]
        self.assertEqual(len(members), 1)
        self.assertEqual(members[0]["method_count"], 3)

    def test_revoking_your_own_access_is_refused(self):
        # It is "remove my only unlock method" wearing a different label, and nothing recovers from it.
        with api_client() as (client, _):
            owner = client.get("/api/auth/status").json()["user"]["id"]
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": STRONG_PASSPHRASE})
            r = client.post(f"/api/auth/vault/access/{owner}/revoke")
            self.assertEqual(r.status_code, 400)


class VaultPasskeyEndpointTests(unittest.TestCase):
    """The two preconditions the backend owns, and the identity boundary on unlock.

    The ceremony itself is the browser's; what is testable here is that a connection which cannot host
    passkeys says so plainly rather than letting the browser fail opaquely.
    """

    def setUp(self):
        cs.lock_all()

    def tearDown(self):
        cs.lock_all()

    def test_loopback_can_host_passkeys(self):
        # Loopback is a secure context by definition, so the desktop case needs no TLS to use passkeys.
        with api_client() as (client, _):
            params = client.get("/api/auth/vault/passkey/params",
                                headers={"host": "localhost:8000"}).json()
        self.assertTrue(params["available"])
        self.assertEqual(params["rp_id"], "localhost")
        self.assertTrue(params["register_salt"])
        self.assertEqual(params["credentials"], [])

    def test_an_ip_address_host_cannot_and_says_why(self):
        # WebAuthn's Relying Party id must be a domain, so a LAN server reached as 192.168.x.x can never
        # host passkeys however it is served. Reported as a stated reason because the answer the user
        # needs — "use a passphrase here" — is not one a browser exception would ever give them.
        with api_client() as (client, _):
            params = client.get("/api/auth/vault/passkey/params",
                                headers={"host": "192.168.1.50:8000"}).json()
        self.assertFalse(params["available"])
        self.assertEqual(params["reason"], "ip_address_host")
        self.assertIsNone(params["rp_id"])

    def test_a_cleartext_network_bind_cannot_either(self):
        with api_client() as (client, _):
            params = client.get("/api/auth/vault/passkey/params",
                                headers={"host": "luma.example.org"}).json()
        self.assertFalse(params["available"])
        self.assertEqual(params["reason"], "insecure_context")

    def test_registering_where_no_ceremony_can_run_is_refused(self):
        with api_client() as (client, _):
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": STRONG_PASSPHRASE})
            r = client.post("/api/auth/vault/passkey/register",
                            headers={"host": "192.168.1.50:8000"},
                            json={"credential_id": "c1", "prf_output": cs._b64e(b"\x01" * 32),
                                  "prf_salt": "salt"})
        self.assertEqual(r.status_code, 400)

    def test_a_passkey_belonging_to_another_user_is_refused_on_unlock(self):
        # The credential opens its owner's slot, never the caller's session. Honouring it would leave a
        # signed-in user operating the vault as somebody else.
        prf = cs._b64e(b"\x07" * 32)
        with api_client() as (client, _):
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": STRONG_PASSPHRASE})
            registered = client.post("/api/auth/vault/passkey/register",
                                     headers={"host": "localhost:8000"},
                                     json={"credential_id": "c1", "prf_output": prf,
                                           "prf_salt": "salt", "label": "Laptop"})
            self.assertEqual(registered.status_code, 200, registered.text)
            self.assertEqual(len(registered.json()["user"]["vault_passkeys"]), 1)

            other = client.post("/api/auth/identities", json={"name": "Other"}).json()["identity"]["id"]
            client.post("/api/auth/select-identity", json={"user_id": other})
            r = client.post("/api/auth/vault/passkey/unlock",
                            headers={"host": "localhost:8000"},
                            json={"credential_id": "c1", "prf_output": prf})
            self.assertEqual(r.status_code, 403)
            self.assertFalse(client.get("/api/auth/status").json()["user"]["vault_unlocked"])


class VaultRecoveryEndpointTests(unittest.TestCase):
    """The recovery code and the destructive reset over HTTP — the wiring the service tests cannot see:
    which status codes the dialogs key on, and that the code is returned exactly once."""

    def setUp(self):
        cs.lock_all()

    def tearDown(self):
        cs.lock_all()

    def test_recovery_code_is_returned_once_and_then_only_described(self):
        with api_client() as (client, _):
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": STRONG_PASSPHRASE})
            r = client.post("/api/auth/vault/recovery-code")
            self.assertEqual(r.status_code, 200, r.text)
            code = r.json()["recovery_code"]
            self.assertTrue(code)

            # Every later description of the vault says a code exists and when it was issued, and never
            # the code itself — it is stretched into a KEK, so the server genuinely cannot read it back.
            user = client.get("/api/auth/status").json()["user"]
            self.assertTrue(user["vault_has_recovery_code"])
            self.assertIsNotNone(user["vault_recovery_code_issued_at"])
            self.assertNotIn(code, client.get("/api/auth/status").text)

    def test_issuing_a_code_requires_an_unlocked_vault(self):
        with api_client() as (client, _):
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": STRONG_PASSPHRASE})
            client.post("/api/auth/vault/lock")
            r = client.post("/api/auth/vault/recovery-code")
            self.assertEqual(r.status_code, 423)
            self.assertEqual(r.json()["detail"]["code"], "vault_locked")

    def test_recovery_sets_a_new_passphrase_and_reissues(self):
        with api_client() as (client, _):
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": STRONG_PASSPHRASE})
            code = client.post("/api/auth/vault/recovery-code").json()["recovery_code"]
            client.post("/api/auth/vault/lock")

            r = client.post("/api/auth/vault/recover",
                            json={"code": code, "new_passphrase": "a brand new vault passphrase"})
            self.assertEqual(r.status_code, 200, r.text)
            self.assertNotEqual(r.json()["recovery_code"], code)
            self.assertTrue(r.json()["user"]["vault_unlocked"])

            client.post("/api/auth/vault/lock")
            self.assertEqual(
                client.post("/api/auth/vault/unlock",
                            json={"passphrase": "a brand new vault passphrase"}).status_code, 200,
            )

    def test_a_wrong_code_is_reported_as_a_code_problem(self):
        # Not as "incorrect passphrase", which is `_open_slot`'s internal wording and would send the user
        # to the wrong field of the dialog.
        with api_client() as (client, _):
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": STRONG_PASSPHRASE})
            client.post("/api/auth/vault/recovery-code")
            r = client.post("/api/auth/vault/recover",
                            json={"code": cs.generate_recovery_code(), "new_passphrase": "another long passphrase here"})
            self.assertEqual(r.status_code, 400)
            self.assertEqual(r.json()["detail"]["code"], "bad_recovery_code")

    def test_a_weak_replacement_passphrase_reports_the_floor(self):
        with api_client() as (client, _):
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": STRONG_PASSPHRASE})
            code = client.post("/api/auth/vault/recovery-code").json()["recovery_code"]
            r = client.post("/api/auth/vault/recover", json={"code": code, "new_passphrase": "short"})
            self.assertEqual(r.status_code, 400)
            self.assertEqual(r.json()["detail"]["code"], "weak_passphrase")
            self.assertEqual(r.json()["detail"]["min_length"], cs.VAULT_PRODUCTION_MIN_LEN)
            # The code survives a rejected attempt, which is what makes one code enough.
            self.assertTrue(client.get("/api/auth/status").json()["user"]["vault_has_recovery_code"])

    # --- reset ------------------------------------------------------------------------------------

    def test_reset_preview_leads_with_the_free_alternatives(self):
        with api_client() as (client, _):
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": STRONG_PASSPHRASE})
            client.post("/api/auth/vault/recovery-code")
            preview = client.get("/api/auth/vault/reset-preview").json()
            self.assertTrue(preview["has_recovery_code"])
            self.assertEqual(preview["other_members_can_unlock"], [])
            self.assertEqual(preview["own_passkeys"], [])
            self.assertEqual(preview["connections"], 0)
            self.assertIn("confirm_phrase", preview)

    def test_reset_preview_names_the_member_to_go_and_ask(self):
        # A count cannot be acted on; a name can, and that is the entire content of this rung. It also
        # never names the caller, who is the one person asking precisely because they cannot get in.
        with api_client() as (client, _):
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": STRONG_PASSPHRASE})
            other = client.post("/api/auth/identities", json={"name": "Robin"}).json()["identity"]["id"]
            client.post("/api/auth/select-identity", json={"user_id": other})
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": "robin's own long passphrase"})

            preview = client.get("/api/auth/vault/reset-preview").json()
            self.assertEqual([m["display_name"] for m in preview["other_members_can_unlock"]], ["Tester"])

    def test_another_member_does_not_block_the_reset_but_is_named_in_the_result(self):
        # Revised 2026-08-31: this used to be a 409. A slot row cannot prove the other person is
        # reachable, the admin gate already settles who may do this, and the compromise path allowed the
        # same destruction anyway — so the block only stopped users who reported their situation
        # honestly. What replaces it is telling the caller whose access they are also ending.
        with api_client() as (client, _):
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": STRONG_PASSPHRASE})
            other = client.post("/api/auth/identities", json={"name": "Robin"}).json()["identity"]["id"]
            client.post("/api/auth/select-identity", json={"user_id": other})
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": "robin's own long passphrase"})

            # Back to the first identity, which holds the key, to approve Robin's enrollment.
            first = [m for m in client.get("/api/auth/vault/members").json()["members"]][0]["user_id"]
            client.post("/api/auth/select-identity", json={"user_id": first})
            client.post("/api/auth/vault/unlock", json={"passphrase": STRONG_PASSPHRASE})
            slot = client.get("/api/auth/vault/access-requests").json()["requests"][0]["slot_id"]
            self.assertEqual(client.post(f"/api/auth/vault/access-requests/{slot}/approve").status_code, 200)

            phrase = client.get("/api/auth/vault/reset-preview").json()["confirm_phrase"]
            r = client.post("/api/auth/vault/reset", json={"reason": "lost", "confirm": phrase})
            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual(r.json()["also_locked_out"], ["Robin"])
            self.assertFalse(r.json()["user"]["vault_configured"])

    def test_reset_requires_the_typed_confirmation(self):
        with api_client() as (client, _):
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": STRONG_PASSPHRASE})
            r = client.post("/api/auth/vault/reset", json={"reason": "lost", "confirm": "yes"})
            self.assertEqual(r.status_code, 400)
            self.assertEqual(r.json()["detail"]["code"], "confirmation_required")
            self.assertTrue(client.get("/api/auth/status").json()["user"]["vault_configured"])

    def test_reset_clears_the_vault(self):
        with api_client() as (client, _):
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": STRONG_PASSPHRASE})
            phrase = client.get("/api/auth/vault/reset-preview").json()["confirm_phrase"]
            r = client.post("/api/auth/vault/reset", json={"reason": "lost", "confirm": phrase})
            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual(r.json()["revocations"], [])
            self.assertFalse(r.json()["user"]["vault_configured"])

    def test_a_compromise_reset_refuses_while_locked(self):
        # This path exists so the revocations can run, and they need the DEK. Degrading to the lost path
        # would retire every credential while reporting success at the one thing it never attempted.
        with api_client() as (client, _):
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": STRONG_PASSPHRASE})
            phrase = client.get("/api/auth/vault/reset-preview").json()["confirm_phrase"]
            client.post("/api/auth/vault/lock")
            r = client.post("/api/auth/vault/reset", json={"reason": "compromised", "confirm": phrase})
            self.assertEqual(r.status_code, 423)
            self.assertEqual(r.json()["detail"]["code"], "vault_locked")
            self.assertTrue(client.get("/api/auth/status").json()["user"]["vault_configured"])

    def test_a_compromise_reset_lists_the_app_secret_to_rotate(self):
        # Revoking connections never retires the app secret they were authorized under, so after an
        # exposure it is always left for the user — and a forgotten passphrase exposed nothing.
        for reason, expected in (("compromised", [{"provider": "plaid"}]), ("lost", [])):
            with self.subTest(reason=reason), api_client() as (client, _):
                client.post("/api/auth/vault/set-passphrase", json={"passphrase": STRONG_PASSPHRASE})
                client.post("/api/providers/plaid/config", json={"client_id": "cid", "secret": "app-secret"})
                phrase = client.get("/api/auth/vault/reset-preview").json()["confirm_phrase"]
                r = client.post("/api/auth/vault/reset", json={"reason": reason, "confirm": phrase})
                self.assertEqual(r.status_code, 200, r.text)
                self.assertEqual(r.json()["app_secrets_to_rotate"], expected)


class VaultProofEndpointTests(unittest.TestCase):
    """The wiring the service tests cannot see: the status code the client keys on, and the countdown
    it uses to ask for proof *before* an action rather than after a refusal."""

    def setUp(self):
        cs.lock_all()

    def tearDown(self):
        cs.lock_all()

    @staticmethod
    def _lapse_proof():
        with cs._unlock_lock:
            for user_id in list(cs._proved_at):
                cs._proved_at[user_id] -= cs.PROOF_TTL_SECONDS + 1

    def test_the_session_reports_the_remaining_proof_window(self):
        with api_client() as (client, _):
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": STRONG_PASSPHRASE})
            user = client.get("/api/auth/status").json()["user"]
            self.assertGreater(user["vault_proof_seconds_remaining"], 0)
            self.assertLessEqual(user["vault_proof_seconds_remaining"], cs.PROOF_TTL_SECONDS)

            self._lapse_proof()
            user = client.get("/api/auth/status").json()["user"]
            self.assertEqual(user["vault_proof_seconds_remaining"], 0)
            self.assertTrue(user["vault_unlocked"], "only the proof lapsed — the vault stays open")

    def test_a_lapsed_proof_is_its_own_code_not_vault_locked(self):
        # The distinction the client acts on: `vault_locked` sends it to an unlock dialog, which would
        # have nothing to do here — the vault is open and what is missing is recency.
        with api_client() as (client, _):
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": STRONG_PASSPHRASE})
            self._lapse_proof()
            r = client.post("/api/auth/vault/recovery-code")
            self.assertEqual(r.status_code, 403, r.text)
            self.assertEqual(r.json()["detail"]["code"], "proof_required")

    def test_proving_again_reopens_the_door(self):
        with api_client() as (client, _):
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": STRONG_PASSPHRASE})
            self._lapse_proof()
            self.assertEqual(client.post("/api/auth/vault/recovery-code").status_code, 403)

            r = client.post("/api/auth/vault/unlock", json={"passphrase": STRONG_PASSPHRASE})
            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual(client.post("/api/auth/vault/recovery-code").status_code, 200)

    def test_setting_a_passphrase_over_existing_access_is_refused(self):
        # The API-level door the old `set-passphrase` left open: an unlocked session replacing the
        # passphrase with no proof of the old one. Not reachable from the app's own UI, which is exactly
        # why it needed closing at the endpoint rather than in the dialog.
        with api_client() as (client, _):
            client.post("/api/auth/vault/set-passphrase", json={"passphrase": STRONG_PASSPHRASE})
            r = client.post("/api/auth/vault/set-passphrase",
                            json={"passphrase": "a-different-strong-passphrase"})
            self.assertEqual(r.status_code, 400, r.text)
            # The original still opens it.
            client.post("/api/auth/vault/lock")
            self.assertEqual(
                client.post("/api/auth/vault/unlock", json={"passphrase": STRONG_PASSPHRASE}).status_code,
                200,
            )


if __name__ == "__main__":
    unittest.main()
