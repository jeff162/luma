"""
Multi-wrap vault core: the workspace-DEK envelope model that replaced the retired per-user
`server_managed` scheme (phase 3), and the keypair slots that made enrollment and rotation
possible (phases 4–5).

These pin the security-relevant invariants: one workspace DEK behind every slot; the AEAD tag as the
secret's only verifier (a wrong secret never opens anything); the DEK living only in the process
unlock cache, never at rest; a ciphertext under the wrong DEK failing closed (the clean-break re-link
path); token encrypt/decrypt requiring an unlocked vault; Production readiness being an all-slots
property so the DEK is never reachable through a weak wrap; enrollment never minting a second DEK;
and rotation surviving an interruption between the two databases it has to write.
"""

from __future__ import annotations

import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path

from backend.db import control_database as cdb
from backend.db import database
from backend.services import crypto_service as cs

# The scrypt parameters every passphrase slot was written with before Argon2id. Fixed here rather than
# read from the service, because what these tests build is a slot as an older install actually wrote it.
LEGACY_SCRYPT = {"kdf_algo": "scrypt", "kdf_n": 2 ** 15, "kdf_r": 8, "kdf_p": 1}


@contextmanager
def _isolated_stack():
    tmp = tempfile.TemporaryDirectory()
    data_path = str(Path(tmp.name) / "data.db")
    control_path = str(Path(tmp.name) / "control.db")
    originals = (database.DB_PATH, cdb.DB_PATH, cdb.CONTROL_DB_PATH)
    database.DB_PATH = data_path
    cdb.DB_PATH = data_path
    cdb.CONTROL_DB_PATH = control_path
    database.init_db(data_path)
    cdb.init_control_db()
    try:
        yield data_path
    finally:
        database.DB_PATH, cdb.DB_PATH, cdb.CONTROL_DB_PATH = originals
        tmp.cleanup()


class VaultTests(unittest.TestCase):
    def setUp(self):
        self._stack = _isolated_stack()
        self._stack.__enter__()
        cs.lock_all()  # the unlock cache is process-global; start every test locked
        self.alice = cdb.create_local_identity("alice")["id"]
        self.bob = cdb.create_local_identity("bob")["id"]

    def tearDown(self):
        cs.lock_all()
        self._stack.__exit__(None, None, None)

    # --- set / unlock / lock ---------------------------------------------------------------------

    def test_set_passphrase_configures_and_unlocks(self):
        self.assertFalse(cs.vault_configured())
        cs.set_passphrase(self.alice, "correct horse battery")
        self.assertTrue(cs.vault_configured())
        self.assertTrue(cs.user_has_slot(self.alice))
        self.assertTrue(cs.is_unlocked(self.alice))

    def test_lock_then_unlock_roundtrip(self):
        cs.set_passphrase(self.alice, "correct horse battery")
        cs.lock(self.alice)
        self.assertFalse(cs.is_unlocked(self.alice))
        dek = cs.unlock(self.alice, "correct horse battery")
        self.assertEqual(len(dek), cs.DEK_BYTES)
        self.assertTrue(cs.is_unlocked(self.alice))

    def test_unlock_yields_the_same_dek(self):
        cs.set_passphrase(self.alice, "correct horse battery")
        first = cs.require_dek(self.alice)
        cs.lock(self.alice)
        second = cs.unlock(self.alice, "correct horse battery")
        self.assertEqual(first, second)

    def test_wrong_passphrase_rejected_and_stays_locked(self):
        cs.set_passphrase(self.alice, "correct horse battery")
        cs.lock(self.alice)
        with self.assertRaises(ValueError):
            cs.unlock(self.alice, "wrong passphrase")
        self.assertFalse(cs.is_unlocked(self.alice))

    def test_require_dek_raises_when_locked(self):
        cs.set_passphrase(self.alice, "correct horse battery")
        cs.lock(self.alice)
        with self.assertRaises(cs.VaultLocked):
            cs.require_dek(self.alice)

    def test_empty_passphrase_rejected(self):
        with self.assertRaises(ValueError):
            cs.set_passphrase(self.alice, "")

    # --- enrollment boundary ---------------------------------------------------------------------

    def test_second_user_setting_a_passphrase_enrolls_rather_than_minting(self):
        # Alice mints the DEK. Bob setting a passphrase is an *enrollment*: it must never mint a second
        # DEK (that would silently strand every credential Alice's key sealed), and it must not fail
        # either — his slot is real, holds his keypair, and waits for a grant.
        cs.set_passphrase(self.alice, "correct horse battery")
        alice_dek = cs.require_dek(self.alice)
        cs.set_passphrase(self.bob, "bob's passphrase here")
        self.assertTrue(cs.user_access_pending(self.bob))
        self.assertFalse(cs.user_has_slot(self.bob))
        self.assertFalse(cs.is_unlocked(self.bob))
        self.assertEqual(cs.require_dek(self.alice), alice_dek, "enrollment must not disturb the DEK")

    def test_a_pending_slot_reports_itself_as_pending_not_as_a_wrong_secret(self):
        # The distinction the UI depends on: Bob's passphrase is correct, so telling him it is wrong
        # would send him retyping something that was never the problem.
        cs.set_passphrase(self.alice, "correct horse battery")
        cs.set_passphrase(self.bob, "bob's passphrase here")
        with self.assertRaises(cs.VaultAccessPending):
            cs.unlock(self.bob, "bob's passphrase here")
        # A genuinely wrong secret still fails as a wrong secret, not as pending.
        with self.assertRaises(ValueError) as caught:
            cs.unlock(self.bob, "not bob's passphrase")
        self.assertNotIsInstance(caught.exception, cs.VaultAccessPending)

    def test_an_unlocked_session_cannot_replace_the_passphrase(self):
        # **Deliberately the reverse of what this pinned until 2026-09-01**, when re-setting an own
        # passphrase while unlocked was allowed and documented as "unlocked, so this re-wraps". That
        # turned a session someone had merely walked up to into a durable, independent way in: the new
        # passphrase kept working after lock and relock, and the owner's stopped. Replacing a working
        # slot now needs a secret, not a DEK found in the cache.
        cs.set_passphrase(self.alice, "correct horse battery")
        dek_before = cs.require_dek(self.alice)
        with self.assertRaises(ValueError):
            cs.set_passphrase(self.alice, "a different passphrase")
        # Nothing was written on the way to the refusal: the original still opens the same DEK.
        self.assertEqual(cs.require_dek(self.alice), dek_before)
        cs.lock(self.alice)
        self.assertEqual(cs.unlock(self.alice, "correct horse battery"), dek_before)

    def test_a_proof_carrying_path_still_replaces_it(self):
        # The other half: the refusal above must not be a dead end. `change_passphrase` carries the old
        # passphrase as its proof and keeps the same DEK, so no credential is re-encrypted.
        cs.set_passphrase(self.alice, "correct horse battery")
        dek_before = cs.require_dek(self.alice)
        cs.change_passphrase(self.alice, "correct horse battery", "a different passphrase")
        cs.lock(self.alice)
        self.assertEqual(cs.unlock(self.alice, "a different passphrase"), dek_before)

    def test_change_passphrase_requires_correct_old(self):
        cs.set_passphrase(self.alice, "correct horse battery")
        with self.assertRaises(ValueError):
            cs.change_passphrase(self.alice, "wrong old", "new passphrase here")
        cs.change_passphrase(self.alice, "correct horse battery", "brand new passphrase")
        cs.lock(self.alice)
        cs.unlock(self.alice, "brand new passphrase")  # new works
        cs.lock(self.alice)
        with self.assertRaises(ValueError):
            cs.unlock(self.alice, "correct horse battery")  # old no longer works

    # --- per-connection credential paths ---------------------------------------------------------

    def test_connection_credential_roundtrip_when_unlocked(self):
        cs.set_passphrase(self.alice, "correct horse battery")
        user = {"id": self.alice}
        stored, enc = cs.encrypt_connection_credential(user, "plaid", "item-1", "access-sandbox-abc")
        self.assertEqual(stored, "")  # ciphertext-only; no plaintext path
        self.assertTrue(enc)
        self.assertEqual(
            cs.decrypt_connection_credential(user, "plaid", "item-1", stored, enc), "access-sandbox-abc"
        )

    def test_connection_encrypt_requires_unlock(self):
        cs.set_passphrase(self.alice, "correct horse battery")
        cs.lock(self.alice)
        with self.assertRaises(cs.VaultLocked):
            cs.encrypt_connection_credential({"id": self.alice}, "plaid", "item-1", "tok")

    def test_decrypt_wrong_context_fails_closed(self):
        # A ciphertext bound to (item-1) must not decrypt under a different external id — the AAD binding.
        cs.set_passphrase(self.alice, "correct horse battery")
        user = {"id": self.alice}
        _, enc = cs.encrypt_connection_credential(user, "plaid", "item-1", "tok")
        with self.assertRaises(cs.VaultDecryptError):
            cs.decrypt_connection_credential(user, "plaid", "item-2", "", enc)

    def test_plaid_aad_continuity_across_the_plaid_item_cutover(self):
        # A Plaid access token encrypted under the *pre-6a* AAD (`plaid_item|<item>|access_token`) must
        # still decrypt through the generalized connection API — that continuity is what makes the
        # plaid_item -> connection migration a no-rekey cutover, not a forced re-link.
        cs.set_passphrase(self.alice, "correct horse battery")
        user = {"id": self.alice}
        dek = cs.require_dek(self.alice)
        legacy_enc = cs.encrypt_secret(dek, "access-sandbox-abc", aad=cs._aad("plaid_item", "item-1", "access_token"))
        self.assertEqual(
            cs.decrypt_connection_credential(user, "plaid", "item-1", "", legacy_enc), "access-sandbox-abc"
        )

    def test_decrypt_under_a_different_dek_is_the_clean_break(self):
        # Simulate a blob written under an old/rotated DEK (the retired server_managed ciphertext): a
        # fresh vault cannot read it, and the failure surfaces as VaultDecryptError -> re-link.
        cs.set_passphrase(self.alice, "correct horse battery")
        user = {"id": self.alice}
        _, enc = cs.encrypt_connection_credential(user, "plaid", "item-1", "tok")
        cdb.delete_vault_slots(self.alice)
        cs.lock_all()
        cs.set_passphrase(self.alice, "correct horse battery")  # a brand-new DEK
        with self.assertRaises(cs.VaultDecryptError):
            cs.decrypt_connection_credential({"id": self.alice}, "plaid", "item-1", "", enc)

    def test_legacy_plaintext_passthrough_needs_no_dek(self):
        # A row that was never encrypted (enc is None) reads straight through, even locked.
        self.assertEqual(
            cs.decrypt_connection_credential({"id": self.alice}, "plaid", "item-1", "plain-token", None),
            "plain-token",
        )

    # --- Production readiness (all-slots property) -----------------------------------------------

    def test_a_passphrase_under_the_floor_cannot_be_set_at_all(self):
        # There is no weak tier to land in any more: the floor is refused at the point of writing a slot,
        # rather than accepted and then held back from "production". A weak passphrase that can be stored
        # is a weak wrap on the DEK, whatever the install is subsequently allowed to do with it.
        with self.assertRaises(cs.WeakPassphrase):
            cs.set_passphrase(self.alice, "short")
        self.assertFalse(cs.vault_configured(), "a refused passphrase must not leave a half-made vault")

    def test_a_long_but_degenerate_passphrase_is_refused_too(self):
        # Length alone isn't enough: one character repeated clears the length floor while carrying almost
        # no entropy, so the distinct-character guard rejects it.
        with self.assertRaises(cs.WeakPassphrase):
            cs.set_passphrase(self.alice, "a" * 30)

    def test_a_change_cannot_weaken_an_existing_slot(self):
        # The other half of the same rule, and the one a check placed only on `set_passphrase` would miss.
        cs.set_passphrase(self.alice, "a-sufficiently-long-passphrase")
        with self.assertRaises(cs.WeakPassphrase):
            cs.change_passphrase(self.alice, "a-sufficiently-long-passphrase", "short")
        self.assertTrue(cs.ready_for_production(), "the refused change must leave the strong slot intact")
        # And the old passphrase still unlocks: nothing was rewrapped on the way to the refusal.
        cs.lock(self.alice)
        cs.unlock(self.alice, "a-sufficiently-long-passphrase")

    def test_readiness_is_still_blocked_by_a_weak_slot_written_another_way(self):
        # Why `ready_for_production` survives the floor being unconditional. It is not asking about the
        # passphrase just set — nothing weak can be set — it is asserting a property of *every* slot,
        # including one this service did not write: a slot carried in from an older, laxer install, or a
        # future slot method (phase 4's passkeys) that wraps the same DEK. The DEK is only ever as strong
        # as its weakest wrap, and a check that ran only when a passphrase was chosen would never see one.
        cs.set_passphrase(self.alice, "a-sufficiently-long-passphrase")
        cdb.upsert_vault_slot(
            self.bob,
            method="passphrase",
            public_key="AA==",
            wrapped_private_key="{}",
            sealed_dek="{}",
            kdf=dict(LEGACY_SCRYPT, kdf_salt="AA=="),
            meets_production_min=False,
        )
        self.assertFalse(cs.ready_for_production())

    def test_a_slot_still_awaiting_a_grant_does_not_block_readiness(self):
        # The other side of the same rule. A pending slot wraps nothing, so it cannot be the weak link
        # in a chain it is not yet part of — and if it did block, one person asking for access would
        # silently take every provider out of Production until someone approved them.
        cs.set_passphrase(self.alice, "a-sufficiently-long-passphrase")
        cdb.upsert_vault_slot(
            self.bob,
            method="passphrase",
            public_key="AA==",
            wrapped_private_key="{}",
            sealed_dek=None,
            kdf=dict(LEGACY_SCRYPT, kdf_salt="AA=="),
            meets_production_min=False,
        )
        self.assertTrue(cs.ready_for_production())


class EnrollmentTests(unittest.TestCase):
    """Phase 5: a second person getting into the same vault, and being put back out of it.

    The property under test throughout is that granting moves the DEK between *public* keys — the
    granter never learns the grantee's secret and the grantee never needs the granter present.
    """

    def setUp(self):
        self._stack = _isolated_stack()
        self._stack.__enter__()
        cs.lock_all()
        self.alice = cdb.create_local_identity("alice")["id"]
        self.bob = cdb.create_local_identity("bob")["id"]
        cs.set_passphrase(self.alice, "alice's long vault passphrase")
        self.dek = cs.require_dek(self.alice)

    def tearDown(self):
        cs.lock_all()
        self._stack.__exit__(None, None, None)

    def _bob_requests(self) -> str:
        cs.set_passphrase(self.bob, "bob's long vault passphrase")
        return cs.pending_access_requests()[0]["slot_id"]

    def test_granted_access_opens_the_same_dek_and_reads_existing_ciphertext(self):
        # The whole point: not "Bob has a vault" but "Bob has *this* vault" — a credential sealed
        # before he existed must open for him afterwards, or the grant achieved nothing.
        _, enc = cs.encrypt_connection_credential({"id": self.alice}, "plaid", "item-1", "access-token-abc")
        slot_id = self._bob_requests()
        cs.grant_access(self.alice, slot_id)
        self.assertEqual(cs.unlock(self.bob, "bob's long vault passphrase"), self.dek)
        self.assertEqual(
            cs.decrypt_connection_credential({"id": self.bob}, "plaid", "item-1", "", enc),
            "access-token-abc",
        )

    def test_granting_never_needs_the_grantees_secret(self):
        # Bob's passphrase is not in the process at grant time, and the grant still works — which is
        # what removes the invite ceremony's bearer code and its co-presence requirement.
        slot_id = self._bob_requests()
        cs.lock(self.bob)
        cs.lock_all()
        cs.unlock(self.alice, "alice's long vault passphrase")
        cs.grant_access(self.alice, slot_id)
        self.assertEqual(cs.unlock(self.bob, "bob's long vault passphrase"), self.dek)

    def test_a_locked_granter_cannot_grant(self):
        slot_id = self._bob_requests()
        cs.lock(self.alice)
        with self.assertRaises(cs.VaultLocked):
            cs.grant_access(self.alice, slot_id)
        self.assertTrue(cs.user_access_pending(self.bob), "a refused grant must leave the request standing")

    def test_granting_twice_is_refused_rather_than_resealing(self):
        slot_id = self._bob_requests()
        cs.grant_access(self.alice, slot_id)
        with self.assertRaises(ValueError):
            cs.grant_access(self.alice, slot_id)

    def test_revoked_access_stops_opening_the_vault(self):
        slot_id = self._bob_requests()
        cs.grant_access(self.alice, slot_id)
        cs.unlock(self.bob, "bob's long vault passphrase")
        cs.revoke_access(self.bob)
        self.assertFalse(cs.is_unlocked(self.bob), "revocation must drop a live unlock, not only the row")
        with self.assertRaises(cs.VaultLocked):
            cs.unlock(self.bob, "bob's long vault passphrase")

    def test_a_pending_request_can_change_its_own_passphrase_before_approval(self):
        # Someone who mistypes while enrolling is otherwise stuck: they cannot unlock (nothing is
        # sealed yet) and re-setting must not be mistaken for minting a second vault.
        self._bob_requests()
        cs.set_passphrase(self.bob, "bob's second long passphrase")
        slot_id = cs.pending_access_requests()[0]["slot_id"]
        cs.grant_access(self.alice, slot_id)
        self.assertEqual(cs.unlock(self.bob, "bob's second long passphrase"), self.dek)
        cs.lock(self.bob)
        with self.assertRaises(ValueError):
            cs.unlock(self.bob, "bob's long vault passphrase")


class LastMemberRemovalTests(unittest.TestCase):
    """Removing the last person who can open the vault resets it: nothing could read the credentials any
    more, and a passphrase set afterwards would wait forever for an approval nobody can give."""

    def setUp(self):
        self._stack = _isolated_stack()
        self._stack.__enter__()
        cs.lock_all()
        self.alice = cdb.create_local_identity("alice")["id"]
        self.bob = cdb.create_local_identity("bob")["id"]
        cs.set_passphrase(self.alice, "alice's long vault passphrase")
        self.seals = cs._slot_seal_digests(cdb.list_vault_slots())
        with database.get_db() as conn:
            conn.execute(
                "INSERT INTO connection (id, provider, external_id, credential, credential_enc)"
                " VALUES ('c1','plaid','item-1',?,?)",
                cs.encrypt_connection_credential({"id": self.alice}, "plaid", "item-1", "access-token-abc"),
            )
        cs.set_passphrase(self.bob, "bob's long vault passphrase")  # pending, with nobody but Alice to approve

    def tearDown(self):
        cs.lock_all()
        self._stack.__exit__(None, None, None)

    def _connection(self):
        with database.get_db() as conn:
            return dict(conn.execute("SELECT credential_enc, reauth_required FROM connection").fetchone())

    def test_deleting_the_only_member_resets_the_vault(self):
        self.assertEqual(cs.sole_vault_member_id(), self.alice)
        relink = cs.remove_vault_member(self.alice, lambda: cdb.delete_user(self.alice))
        self.assertEqual(relink, 1)
        self.assertEqual(self._connection(), {"credential_enc": None, "reauth_required": 1})
        self.assertFalse(cs.vault_configured(), "the stranded request goes too, so the next passphrase starts a vault")
        self.assertEqual(cdb.retired_vault_seal_reasons(self.seals), {"lost"})

    def test_revoking_the_only_member_resets_the_vault(self):
        cs.revoke_access(self.alice)
        self.assertFalse(cs.vault_configured())
        self.assertIsNone(self._connection()["credential_enc"])

    def test_removing_someone_while_a_member_remains_changes_nothing(self):
        cs.grant_access(self.alice, cs.pending_access_requests()[0]["slot_id"])
        self.assertIsNone(cs.sole_vault_member_id())
        self.assertIsNone(cs.remove_vault_member(self.alice, lambda: cdb.delete_user(self.alice)))
        self.assertIsNotNone(self._connection()["credential_enc"])
        self.assertEqual(cs.unlock(self.bob, "bob's long vault passphrase"), cs.require_dek(self.bob))

    def test_a_refused_removal_leaves_the_vault_alone(self):
        def refuse():
            raise ValueError("at least one active admin is required")
        with self.assertRaises(ValueError):
            cs.remove_vault_member(self.alice, refuse)
        self.assertIsNotNone(self._connection()["credential_enc"])
        self.assertEqual(cs.sole_vault_member_id(), self.alice)


class RotationTests(unittest.TestCase):
    """Phase 5: re-keying, and specifically that it cannot brick credentials halfway through."""

    def setUp(self):
        self._stack = _isolated_stack()
        self._stack.__enter__()
        cs.lock_all()
        self.alice = cdb.create_local_identity("alice")["id"]
        self.bob = cdb.create_local_identity("bob")["id"]
        cs.set_passphrase(self.alice, "alice's long vault passphrase")
        self.old_dek = cs.require_dek(self.alice)
        with database.get_db() as conn:
            conn.execute(
                "INSERT INTO connection (id, provider, external_id, credential, credential_enc, institution)"
                " VALUES ('c1','plaid','item-1',?,?,'Test Bank')",
                cs.encrypt_connection_credential({"id": self.alice}, "plaid", "item-1", "access-token-abc"),
            )
            conn.execute(
                "INSERT INTO provider_config (provider, client_id, secret, secret_enc, env)"
                " VALUES ('plaid','client-1',?,?,'sandbox')",
                cs.encrypt_app_credential({"id": self.alice}, "plaid", "app-secret-xyz"),
            )

    def tearDown(self):
        cs.lock_all()
        self._stack.__exit__(None, None, None)

    def _stored(self) -> tuple[str, str]:
        with database.get_db() as conn:
            return (
                conn.execute("SELECT credential_enc FROM connection WHERE id = 'c1'").fetchone()[0],
                conn.execute("SELECT secret_enc FROM provider_config WHERE provider = 'plaid'").fetchone()[0],
            )

    def _assert_everything_reads(self, user_id: str):
        credential, secret = self._stored()
        self.assertEqual(
            cs.decrypt_connection_credential({"id": user_id}, "plaid", "item-1", "", credential),
            "access-token-abc",
        )
        self.assertEqual(cs.decrypt_app_credential({"id": user_id}, "plaid", "", secret), "app-secret-xyz")

    def test_rotation_replaces_the_key_and_rewrites_every_secret(self):
        before = self._stored()
        result = cs.rotate_dek(self.alice)
        self.assertEqual(result["secrets_reencrypted"], 2)
        self.assertNotEqual(self._stored(), before, "ciphertext must actually be rewritten")
        cs.lock(self.alice)
        self.assertNotEqual(cs.unlock(self.alice, "alice's long vault passphrase"), self.old_dek)
        self._assert_everything_reads(self.alice)

    def test_the_old_key_no_longer_opens_the_rewritten_secrets(self):
        # What rotation is *for*: a DEK someone saw while unlocked stops being useful.
        cs.rotate_dek(self.alice)
        credential, _ = self._stored()
        with self.assertRaises(cs.VaultDecryptError):
            cs.decrypt_secret(self.old_dek, credential, aad=cs._connection_aad("plaid", "item-1"))

    def test_every_remaining_slot_survives_a_rotation(self):
        # The capability the old direct-wrapping design could not offer at all: Bob keeps his own
        # passphrase and still lands on the new key, without Alice ever holding his secret.
        cs.set_passphrase(self.bob, "bob's long vault passphrase")
        cs.grant_access(self.alice, cs.pending_access_requests()[0]["slot_id"])
        cs.rotate_dek(self.alice)
        cs.lock_all()
        self.assertEqual(
            cs.unlock(self.bob, "bob's long vault passphrase"),
            cs.unlock(self.alice, "alice's long vault passphrase"),
        )
        self._assert_everything_reads(self.bob)

    def test_a_revoked_slot_is_not_resealed(self):
        cs.set_passphrase(self.bob, "bob's long vault passphrase")
        cs.grant_access(self.alice, cs.pending_access_requests()[0]["slot_id"])
        cs.revoke_access(self.bob)
        cs.rotate_dek(self.alice)
        with self.assertRaises(cs.VaultLocked):
            cs.unlock(self.bob, "bob's long vault passphrase")

    def test_an_interruption_between_the_two_databases_leaves_everything_readable(self):
        # The failure the three-phase order exists to prevent. Slots live in the control DB and the
        # ciphertext in the data DB, so a crash between those writes would otherwise strand every
        # credential under a key no slot can produce. Simulated by failing inside the data-DB pass,
        # after the new seals are already committed.
        original = cs.encrypt_secret

        def explode(dek, plaintext, *, aad):
            raise RuntimeError("interrupted mid-rotation")

        cs.encrypt_secret = explode
        try:
            with self.assertRaises(RuntimeError):
                cs.rotate_dek(self.alice)
        finally:
            cs.encrypt_secret = original

        cs.lock_all()
        cs.unlock(self.alice, "alice's long vault passphrase")
        self._assert_everything_reads(self.alice)

        # Running it again *resumes* rather than starting over. Minting a third key here would push the
        # one the ciphertext is actually under off the end of the two a slot can hold — turning the
        # recoverable state above into exactly the loss the phases exist to prevent.
        result = cs.rotate_dek(self.alice)
        self.assertTrue(result["resumed"])
        self._assert_everything_reads(self.alice)
        cs.lock_all()
        cs.unlock(self.alice, "alice's long vault passphrase")
        self._assert_everything_reads(self.alice)

    def test_every_encrypted_column_in_the_schema_is_registered_for_rotation(self):
        # Fail-on-omission guard. Rotation reaching only the columns someone remembered is the exact
        # shape of a silent data-loss bug: a new vaulted column would keep its old-DEK ciphertext,
        # decrypt nowhere afterwards, and nothing would say so until the credential was next used.
        # Derived from the live schema rather than a hand-written list so adding a column trips it.
        with database.get_db() as conn:
            tables = [r["name"] for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            ).fetchall()]
            found = {
                (table, column["name"])
                for table in tables
                for column in conn.execute(f"PRAGMA table_info({table})").fetchall()
                if column["name"].endswith("_enc")
            }
        registered = {(spec.table, spec.column) for spec in cs.ENCRYPTED_COLUMNS}
        self.assertEqual(
            found, registered,
            "every `*_enc` column must be listed in crypto_service.ENCRYPTED_COLUMNS so rotation rewrites it",
        )


class LegacySlotUpgradeTests(unittest.TestCase):
    """Format 1 (the DEK wrapped straight under the KEK) converting to the keypair format.

    Conversion can only happen while someone is unlocking, because that is the only moment both the
    KEK and the DEK exist in the process — so these check it happens there, and that nothing about the
    install's history is lost on the way through.
    """

    def setUp(self):
        self._stack = _isolated_stack()
        self._stack.__enter__()
        cs.lock_all()
        self.alice = cdb.create_local_identity("alice")["id"]
        self.passphrase = "a legacy install's passphrase"
        self.dek = self._write_legacy_slot()

    def tearDown(self):
        cs.lock_all()
        self._stack.__exit__(None, None, None)

    def _write_legacy_slot(self) -> bytes:
        """A slot exactly as the pre-phase-4 code wrote one: no keypair, DEK wrapped under the KEK."""
        import os
        import uuid

        dek = os.urandom(cs.DEK_BYTES)
        salt = os.urandom(16)
        kek = cs._derive_kek(self.passphrase, dict(LEGACY_SCRYPT, kdf_salt=cs._b64e(salt)))
        with cdb.get_control_db() as conn:
            conn.execute(
                """
                INSERT INTO vault_slot
                    (id, user_id, method, format, wrapped_dek, kdf_algo, kdf_salt, kdf_n, kdf_r, kdf_p,
                     meets_production_min)
                VALUES (?,?,'passphrase',1,?, 'scrypt',?,?,?,?,1)
                """,
                (
                    str(uuid.uuid4()), self.alice,
                    cs._wrap(kek, dek, aad=cs._slot_aad(self.alice)),
                    cs._b64e(salt), LEGACY_SCRYPT["kdf_n"], LEGACY_SCRYPT["kdf_r"], LEGACY_SCRYPT["kdf_p"],
                ),
            )
        return dek

    def test_the_pre_phase_4_table_is_rebuilt_with_its_rows_intact(self):
        # The rebuild only ever runs against a control DB that predates this change, so a suite whose
        # databases are all created fresh would never execute it — the branch every existing install
        # depends on would be the one nothing covers. This drops the old table shape in and runs startup
        # over it, which is exactly what an upgrade does.
        wrapped = cdb.get_vault_slot(self.alice)["wrapped_dek"]
        with cdb.get_control_db() as conn:
            conn.execute("DROP TABLE vault_slot")
            conn.executescript(
                """
                CREATE TABLE vault_slot (
                    id                   TEXT PRIMARY KEY,
                    user_id              TEXT NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
                    method               TEXT NOT NULL DEFAULT 'passphrase',
                    wrapped_dek          TEXT NOT NULL,
                    kdf_algo             TEXT NOT NULL DEFAULT 'scrypt',
                    kdf_salt             TEXT NOT NULL,
                    kdf_n                INTEGER NOT NULL,
                    kdf_r                INTEGER NOT NULL,
                    kdf_p                INTEGER NOT NULL,
                    meets_production_min INTEGER NOT NULL DEFAULT 0,
                    created_at           TEXT NOT NULL DEFAULT (datetime('now')),
                    updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
                    UNIQUE(user_id, method)
                );
                """
            )
            conn.execute(
                """
                INSERT INTO vault_slot
                    (id, user_id, method, wrapped_dek, kdf_algo, kdf_salt, kdf_n, kdf_r, kdf_p,
                     meets_production_min)
                VALUES ('old-slot', ?, 'passphrase', ?, 'scrypt', 'AA==', 16384, 8, 1, 1)
                """,
                (self.alice, wrapped),
            )

        cdb.init_control_db()

        slot = cdb.get_vault_slot(self.alice)
        self.assertEqual(slot["id"], "old-slot", "the row must survive with its identity")
        self.assertEqual(slot["format"], 1, "it cannot be converted without the passphrase")
        self.assertEqual(slot["wrapped_dek"], wrapped)
        self.assertIsNone(slot["sealed_dek"])
        # And the new shape is genuinely in force: a second passkey is what the old UNIQUE forbade.
        cdb.upsert_vault_slot(self.alice, method="passkey", credential_id="c1", public_key="AA==",
                              wrapped_private_key="{}", sealed_dek="{}", meets_production_min=True)
        cdb.upsert_vault_slot(self.alice, method="passkey", credential_id="c2", public_key="AA==",
                              wrapped_private_key="{}", sealed_dek="{}", meets_production_min=True)
        self.assertEqual(len(cdb.list_vault_slots(self.alice, method="passkey")), 2)

    def test_rebuilding_is_idempotent_across_restarts(self):
        # Startup runs on every boot, so a second pass over an already-rebuilt table must be a no-op
        # rather than a second rebuild — and must not resurrect the scratch table.
        before = cdb.get_vault_slot(self.alice)
        cdb.init_control_db()
        cdb.init_control_db()
        self.assertEqual(cdb.get_vault_slot(self.alice), before)
        with cdb.get_control_db() as conn:
            leftovers = conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='vault_slot_rebuilt'"
            ).fetchone()
        self.assertIsNone(leftovers)

    def test_a_legacy_slot_unlocks_and_converts_in_place(self):
        self.assertEqual(cdb.get_vault_slot(self.alice)["format"], 1)
        self.assertEqual(cs.unlock(self.alice, self.passphrase), self.dek)
        slot = cdb.get_vault_slot(self.alice)
        self.assertEqual(slot["format"], 2)
        self.assertIsNone(slot["wrapped_dek"], "the superseded wrap must not be left behind")
        self.assertTrue(slot["public_key"] and slot["wrapped_private_key"] and slot["sealed_dek"])
        self.assertEqual(slot["kdf_algo"], "argon2id", "and it leaves on the current KDF, not the legacy one")

    def test_the_converted_slot_still_opens_ciphertext_written_before_it(self):
        # Conversion changes how the DEK is *reached*, never which DEK it is.
        cs._cache_put(self.alice, self.dek)
        _, enc = cs.encrypt_connection_credential({"id": self.alice}, "plaid", "item-1", "access-token-abc")
        cs.lock_all()
        cs.unlock(self.alice, self.passphrase)
        self.assertEqual(
            cs.decrypt_connection_credential({"id": self.alice}, "plaid", "item-1", "", enc),
            "access-token-abc",
        )

    def test_conversion_carries_the_credentials_export_history_across(self):
        # Those rows answer "which backups would a passphrase change strand". Conversion changes the
        # value they are keyed by while changing nothing about which passphrase opens those files, so
        # leaving them behind would quietly stop the change dialog naming backups that still restore.
        before = cs.current_wrapped_dek_fingerprint(self.alice)
        cdb.record_credentials_export(self.alice, before)
        cs.unlock(self.alice, self.passphrase)
        after = cs.current_wrapped_dek_fingerprint(self.alice)
        self.assertNotEqual(after, before)
        self.assertEqual(len(cdb.credentials_exports_for_fingerprint(after)), 1)
        self.assertEqual(cdb.credentials_exports_for_fingerprint(before), [])

    def test_a_legacy_slot_can_be_granted_from_once_converted(self):
        # An install that has never enrolled anyone is exactly the one that will want to, so the
        # upgrade has to leave a slot that can seal for others rather than one that merely opens.
        bob = cdb.create_local_identity("bob")["id"]
        cs.unlock(self.alice, self.passphrase)
        cs.set_passphrase(bob, "bob's long vault passphrase")
        cs.grant_access(self.alice, cs.pending_access_requests()[0]["slot_id"])
        self.assertEqual(cs.unlock(bob, "bob's long vault passphrase"), self.dek)


class PassphraseCurrencyTests(unittest.TestCase):
    """A passphrase slot held to today's KDF and strength rule, at the one moment that is possible.

    Neither can be applied to a stored slot — both need the passphrase — so unlock does both, silently
    when nothing has changed. What these defend is that an install's existing slots do not stay on
    whatever was current when they were written.
    """

    PASSPHRASE = "a-strong-vault-passphrase"
    WEAK = "passwordpassword1234"   # clears the length and falls to a dictionary attack

    def setUp(self):
        self._stack = _isolated_stack()
        self._stack.__enter__()
        cs.lock_all()
        self.alice = cdb.create_local_identity("alice")["id"]

    def tearDown(self):
        cs.lock_all()
        self._stack.__exit__(None, None, None)

    def _put_slot_on_scrypt(self, passphrase: str) -> None:
        """Rewrap Alice's passphrase slot exactly as the scrypt-era code would have left it."""
        import os

        slot = cdb.get_vault_slot(self.alice)
        private_key, _ = cs._open_slot(slot, passphrase, user_id=self.alice)
        kdf = dict(LEGACY_SCRYPT, kdf_salt=cs._b64e(os.urandom(16)))
        cdb.rewrap_vault_slot_secret(
            slot["id"],
            wrapped_private_key=cs._wrap(cs._derive_kek(passphrase, kdf), private_key,
                                         aad=cs._private_key_aad(self.alice, slot["id"])),
            kdf=kdf, meets_production_min=True, strength_basis=None,
        )

    def test_a_new_slot_uses_the_current_kdf(self):
        cs.set_passphrase(self.alice, self.PASSPHRASE)
        slot = cdb.get_vault_slot(self.alice)
        self.assertEqual(
            (slot["kdf_algo"], slot["kdf_m"], slot["kdf_t"], slot["kdf_p"]),
            ("argon2id", cs.ARGON2_MEMORY_KIB, cs.ARGON2_TIME_COST, cs.ARGON2_LANES),
        )
        self.assertEqual(slot["strength_basis"], cs.STRENGTH_BASIS)

    def test_unlock_moves_a_scrypt_slot_onto_the_current_kdf_without_disturbing_its_key(self):
        # The keypair and the DEK's seal are what other code relies on — grants, rotation, and whether a
        # backup is still valid here — so the upgrade replaces the KEK's wrap and nothing else.
        cs.set_passphrase(self.alice, self.PASSPHRASE)
        dek = cs.require_dek(self.alice)
        self._put_slot_on_scrypt(self.PASSPHRASE)
        before = cdb.get_vault_slot(self.alice)
        cs.lock_all()

        self.assertEqual(cs.unlock(self.alice, self.PASSPHRASE), dek)

        after = cdb.get_vault_slot(self.alice)
        self.assertEqual(after["kdf_algo"], "argon2id")
        self.assertIsNone(after["kdf_n"], "no scrypt parameter may survive beside the Argon2id ones")
        self.assertEqual((after["public_key"], after["sealed_dek"]), (before["public_key"], before["sealed_dek"]))
        cs.lock_all()
        self.assertEqual(cs.unlock(self.alice, self.PASSPHRASE), dek, "and it opens under the new KDF")

    def test_the_upgrade_carries_the_credentials_export_history_across(self):
        # Same passphrase, so every backup it names still opens with exactly what it did; a change dialog
        # that stopped listing them would be wrong about what the change strands.
        cs.set_passphrase(self.alice, self.PASSPHRASE)
        self._put_slot_on_scrypt(self.PASSPHRASE)
        cdb.record_credentials_export(self.alice, cs.current_wrapped_dek_fingerprint(self.alice))
        cs.lock_all()
        cs.unlock(self.alice, self.PASSPHRASE)
        self.assertEqual(len(cdb.credentials_exports_for_fingerprint(cs.current_wrapped_dek_fingerprint(self.alice))), 1)

    def test_a_passphrase_failing_the_current_rule_still_unlocks_but_is_flagged(self):
        # A passphrase written under an earlier, laxer rule. Refusing the unlock would stop this member's
        # syncing over a passphrase nobody has shown to be exposed; what changes is that they are asked to
        # replace it, no data source can be connected, and an unencrypted backup leaves it out.
        from unittest import mock

        with mock.patch.object(cs, "passphrase_shortfall", return_value=None):
            cs.set_passphrase(self.alice, self.WEAK)
        with cdb.get_control_db() as conn:
            conn.execute("UPDATE vault_slot SET strength_basis = NULL")
        cs.lock_all()
        self.assertTrue(cs.ready_for_production(), "an earlier rule's verdict stands until the passphrase is typed")
        self.assertEqual(cs.passphrase_export_shortfall(self.alice), "passphrase_unchecked")

        cs.unlock(self.alice, self.WEAK)

        self.assertTrue(cs.is_unlocked(self.alice))
        self.assertTrue(cs.passphrase_needs_change(self.alice))
        self.assertFalse(cs.ready_for_production())
        self.assertEqual(cs.passphrase_export_shortfall(self.alice), "weak_passphrase")

        cs.change_passphrase(self.alice, self.WEAK, self.PASSPHRASE)
        self.assertFalse(cs.passphrase_needs_change(self.alice))
        self.assertTrue(cs.ready_for_production())
        self.assertIsNone(cs.passphrase_export_shortfall(self.alice))

    def test_a_passing_passphrase_judged_under_an_earlier_rule_is_cleared_by_one_unlock(self):
        cs.set_passphrase(self.alice, self.PASSPHRASE)
        with cdb.get_control_db() as conn:
            conn.execute("UPDATE vault_slot SET strength_basis = NULL")
        cs.lock_all()
        self.assertEqual(cs.passphrase_export_shortfall(self.alice), "passphrase_unchecked")
        cs.unlock(self.alice, self.PASSPHRASE)
        self.assertIsNone(cs.passphrase_export_shortfall(self.alice))

    def test_a_new_estimator_release_asks_for_the_passphrase_to_be_typed_again(self):
        # A new release can move a score as surely as a new threshold can, so a verdict is current only
        # for the release that took it. Until the passphrase is typed nothing is known to be wrong, so it
        # is a request, not a block, except that an unencrypted backup leaves it out.
        cs.set_passphrase(self.alice, self.PASSPHRASE)
        self.assertFalse(cs.passphrase_needs_check(self.alice))
        cs.lock_all()
        from unittest import mock

        with mock.patch.object(cs, "STRENGTH_BASIS", cs.STRENGTH_BASIS + "-next"):
            self.assertTrue(cs.passphrase_needs_check(self.alice))
            self.assertFalse(cs.passphrase_needs_change(self.alice))
            self.assertTrue(cs.ready_for_production())
            self.assertEqual(cs.passphrase_export_shortfall(self.alice), "passphrase_unchecked")

            cs.unlock(self.alice, self.PASSPHRASE)

            self.assertFalse(cs.passphrase_needs_check(self.alice))
            self.assertIsNone(cs.passphrase_export_shortfall(self.alice))

    def test_the_basis_names_the_installed_estimator_release(self):
        # Read from the distribution, so a dependency refresh changes it without anyone remembering to.
        from importlib.metadata import version

        self.assertIn(f"zxcvbn-{version('zxcvbn')}", cs.STRENGTH_BASIS)

    def test_a_slot_asking_for_unbounded_work_is_refused_before_any_is_done(self):
        # A slot read out of a backup file carries whatever parameters the file names.
        kdf = {"kdf_algo": "argon2id", "kdf_salt": "AA==", "kdf_m": 64 * 1024 * 1024, "kdf_t": 3, "kdf_p": 4}
        with self.assertRaises(ValueError):
            cs._derive_kek(self.PASSPHRASE, kdf)


class PasskeySlotTests(unittest.TestCase):
    """Phase 4: a WebAuthn PRF output standing in for a passphrase.

    The authenticator is not simulated — only its output is, which is the whole interface the vault
    has to it: 32 secret bytes for a given salt. Everything else about WebAuthn is the browser's.
    """

    def setUp(self):
        self._stack = _isolated_stack()
        self._stack.__enter__()
        cs.lock_all()
        self.alice = cdb.create_local_identity("alice")["id"]
        self.bob = cdb.create_local_identity("bob")["id"]
        cs.set_passphrase(self.alice, "alice's long vault passphrase")
        self.dek = cs.require_dek(self.alice)
        self.prf = cs._b64e(b"\x11" * 32)

    def tearDown(self):
        cs.lock_all()
        self._stack.__exit__(None, None, None)

    def test_registering_and_unlocking_with_a_passkey(self):
        cs.register_passkey_slot(self.alice, credential_id="cred-1", prf_output=self.prf,
                                 prf_salt="salt-1", label="Laptop")
        cs.lock_all()
        user_id, dek = cs.unlock_with_passkey("cred-1", self.prf)
        self.assertEqual(user_id, self.alice)
        self.assertEqual(dek, self.dek)

    def test_a_wrong_prf_output_does_not_open_the_slot(self):
        cs.register_passkey_slot(self.alice, credential_id="cred-1", prf_output=self.prf, prf_salt="salt-1")
        cs.lock_all()
        with self.assertRaises(ValueError):
            cs.unlock_with_passkey("cred-1", cs._b64e(b"\x22" * 32))

    def test_several_passkeys_coexist_with_the_passphrase(self):
        # A person with two machines registers two authenticators; all three methods open one vault.
        second = cs._b64e(b"\x33" * 32)
        cs.register_passkey_slot(self.alice, credential_id="cred-1", prf_output=self.prf, prf_salt="s1", label="Laptop")
        cs.register_passkey_slot(self.alice, credential_id="cred-2", prf_output=second, prf_salt="s2", label="Phone")
        self.assertEqual(len(cs.user_passkey_slots(self.alice)), 2)
        cs.lock_all()
        self.assertEqual(cs.unlock_with_passkey("cred-1", self.prf)[1], self.dek)
        cs.lock_all()
        self.assertEqual(cs.unlock_with_passkey("cred-2", second)[1], self.dek)
        cs.lock_all()
        self.assertEqual(cs.unlock(self.alice, "alice's long vault passphrase"), self.dek)

    def test_a_passkey_can_enroll_a_user_who_has_no_access_yet(self):
        # The doc's "passkey twist" — a PRF KEK exists only during a live ceremony — stops mattering
        # once a grant needs nothing but a public key. Bob enrols by passkey with nobody else present.
        result = cs.register_passkey_slot(self.bob, credential_id="cred-b", prf_output=self.prf, prf_salt="s1")
        self.assertTrue(result["pending"])
        cs.grant_access(self.alice, result["slot_id"])
        self.assertEqual(cs.unlock_with_passkey("cred-b", self.prf)[1], self.dek)

    def test_adding_a_passkey_to_a_locked_vault_is_refused(self):
        # The two wrong outcomes this rules out, both silent: writing the slot *pending* would put
        # someone who already has access into the approval queue, and minting a key for it would strand
        # every credential the real one sealed. Neither shows up until much later.
        cs.lock(self.alice)
        with self.assertRaises(cs.VaultLocked):
            cs.register_passkey_slot(self.alice, credential_id="cred-1", prf_output=self.prf, prf_salt="s1")
        self.assertEqual(cs.pending_access_requests(), [])
        self.assertEqual(cs.user_passkey_slots(self.alice), [])

    def test_the_same_credential_cannot_be_registered_twice(self):
        cs.register_passkey_slot(self.alice, credential_id="cred-1", prf_output=self.prf, prf_salt="s1")
        with self.assertRaises(ValueError):
            cs.register_passkey_slot(self.bob, credential_id="cred-1", prf_output=self.prf, prf_salt="s1")

    def test_a_passkey_slot_satisfies_production_readiness(self):
        # Its KEK is 32 bytes from the authenticator, so there is no weak-passphrase analog to fail —
        # but readiness is an all-slots property, so a slot type that answered "no" would silently take
        # every provider out of Production the moment a passkey was added.
        cs.register_passkey_slot(self.alice, credential_id="cred-1", prf_output=self.prf, prf_salt="s1")
        self.assertTrue(cs.ready_for_production())

    def test_the_last_unlock_method_cannot_be_removed(self):
        # There is no recovery by design, so removing a final slot would destroy access to every stored
        # credential. Losing access must take a deliberate reset, never a tidy-up.
        slot = cdb.get_vault_slot(self.alice)
        with self.assertRaises(ValueError):
            cs.remove_slot(self.alice, slot["id"])
        result = cs.register_passkey_slot(self.alice, credential_id="cred-1", prf_output=self.prf, prf_salt="s1")
        cs.remove_slot(self.alice, slot["id"])  # now that the passkey works, the passphrase may go
        cs.lock_all()
        self.assertEqual(cs.unlock_with_passkey("cred-1", self.prf)[1], self.dek)
        with self.assertRaises(ValueError):
            cs.remove_slot(self.alice, result["slot_id"])

    def test_a_passkey_slot_belonging_to_someone_else_cannot_be_removed(self):
        result = cs.register_passkey_slot(self.alice, credential_id="cred-1", prf_output=self.prf, prf_salt="s1")
        with self.assertRaises(ValueError):
            cs.remove_slot(self.bob, result["slot_id"])

    def test_a_passkey_survives_a_rotation(self):
        cs.register_passkey_slot(self.alice, credential_id="cred-1", prf_output=self.prf, prf_salt="s1")
        cs.rotate_dek(self.alice)
        cs.lock_all()
        _, dek = cs.unlock_with_passkey("cred-1", self.prf)
        self.assertNotEqual(dek, self.dek)
        self.assertEqual(dek, cs.unlock(self.alice, "alice's long vault passphrase"))


if __name__ == "__main__":
    unittest.main()
