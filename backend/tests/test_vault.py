"""
Multi-wrap vault core (phase 3): the workspace-DEK envelope model that replaced the retired
per-user `server_managed` scheme.

These pin the security-relevant invariants: a passphrase slot wraps one workspace DEK; the AEAD tag
is the passphrase verifier (a wrong passphrase never unwraps); the DEK lives only in the process
unlock cache, never at rest; a leaked/copied ciphertext under the wrong DEK fails closed (the
clean-break re-link path); Plaid token encrypt/decrypt require an unlocked vault; and Production
readiness is an all-slots property so the DEK is never reachable through a weak wrap.
"""

from __future__ import annotations

import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path

from backend.db import control_database as cdb
from backend.db import database
from backend.services import crypto_service as cs


@contextmanager
def _isolated_stack():
    tmp = tempfile.TemporaryDirectory()
    data_path = str(Path(tmp.name) / "data.db")
    control_path = str(Path(tmp.name) / "control.db")
    tenant_root = Path(tmp.name) / "tenants"
    originals = (database.DB_PATH, cdb.DB_PATH, cdb.CONTROL_DB_PATH, cdb.TENANT_DATA_ROOT)
    database.DB_PATH = data_path
    cdb.DB_PATH = data_path
    cdb.CONTROL_DB_PATH = control_path
    cdb.TENANT_DATA_ROOT = tenant_root
    database.init_db(data_path)
    cdb.init_control_db()
    try:
        yield data_path
    finally:
        database.DB_PATH, cdb.DB_PATH, cdb.CONTROL_DB_PATH, cdb.TENANT_DATA_ROOT = originals
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

    def test_second_user_cannot_set_without_the_dek(self):
        # Alice mints the DEK; Bob (a different, not-unlocked user) cannot create a slot because he
        # cannot obtain the existing DEK yet (co-present/invite enrollment is a later phase).
        cs.set_passphrase(self.alice, "correct horse battery")
        with self.assertRaises(cs.VaultLocked):
            cs.set_passphrase(self.bob, "bob's passphrase here")

    def test_resetting_own_passphrase_preserves_the_dek(self):
        cs.set_passphrase(self.alice, "correct horse battery")
        dek_before = cs.require_dek(self.alice)
        cs.set_passphrase(self.alice, "a different passphrase")  # unlocked, so this re-wraps
        self.assertEqual(cs.require_dek(self.alice), dek_before)
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

    def test_production_requires_a_strong_passphrase(self):
        self.assertFalse(cs.ready_for_production())  # no vault yet
        cs.set_passphrase(self.alice, "short")  # under the 12-char minimum
        self.assertFalse(cs.ready_for_production())
        cs.change_passphrase(self.alice, "short", "a-sufficiently-long-passphrase")
        self.assertTrue(cs.ready_for_production())

    def test_production_is_blocked_by_any_weak_slot(self):
        # Two slots, one weak: the DEK is only as strong as its weakest wrap, so Production stays off.
        cs.set_passphrase(self.alice, "a-sufficiently-long-passphrase")
        cdb.upsert_vault_slot(
            self.bob,
            method="passphrase",
            wrapped_dek="{}",
            kdf_algo="scrypt",
            kdf_salt="AA==",
            kdf_n=cs.SCRYPT_N,
            kdf_r=cs.SCRYPT_R,
            kdf_p=cs.SCRYPT_P,
            meets_production_min=False,
        )
        self.assertFalse(cs.ready_for_production())


if __name__ == "__main__":
    unittest.main()
