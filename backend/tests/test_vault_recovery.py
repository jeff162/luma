"""
Vault recovery: the rungs between a forgotten passphrase and rebuilding every connection.

Two features share this file because they are two rungs of one ladder. A **recovery code** is a third
slot method that opens the vault and re-keys the passphrase without touching the DEK, so nothing is
re-encrypted and no connection is re-linked. The **destructive reset** is the bottom rung, and what it
must *not* destroy is as load-bearing as what it does: only two columns are encrypted, and the accounts,
transactions, connection rows and per-account mappings that make a connection expensive to rebuild are
plaintext beside them.

The properties pinned here are the ones whose violation would be silent — a code that stays live after
being spent, a reset that leaves unopenable ciphertext behind or takes the ledger with it, a refusal
rule that fires on the wrong slots, and the sequencing that makes a single recovery code safe.
"""

from __future__ import annotations

import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path

from backend.db import control_database as cdb
from backend.db import database
from backend.services import crypto_service as cs

ALICE_PASSPHRASE = "alice's long vault passphrase"
NEW_PASSPHRASE = "a replacement passphrase for the vault"


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


class _VaultCase(unittest.TestCase):
    """One workspace, one member, one connection and one app secret — the shape both features act on."""

    def setUp(self):
        self._stack = _isolated_stack()
        self._stack.__enter__()
        cs.lock_all()
        self.alice = cdb.create_local_identity("alice")["id"]
        self.bob = cdb.create_local_identity("bob")["id"]
        cs.set_passphrase(self.alice, ALICE_PASSPHRASE)
        self.dek = cs.require_dek(self.alice)
        with database.get_db() as conn:
            conn.execute(
                "INSERT INTO connection (id, provider, external_id, credential, credential_enc, institution)"
                " VALUES ('c1','plaid','item-1',?,?,'Harborline Bank')",
                cs.encrypt_connection_credential({"id": self.alice}, "plaid", "item-1", "access-token-abc"),
            )
            conn.execute(
                "INSERT INTO provider_config (provider, client_id, secret, secret_enc, env)"
                " VALUES ('plaid','client-1',?,?,'sandbox')",
                cs.encrypt_app_credential({"id": self.alice}, "plaid", "app-secret-xyz"),
            )
            conn.execute(
                "INSERT INTO account (id, name, display_name, external_account_id, connection_id, provider)"
                " VALUES ('a1','Everyday Checking','Everyday Checking','ext-1','c1','plaid')"
            )
            conn.execute(
                "INSERT INTO txn (id, account_id, date, amount) VALUES ('t1','a1','2026-01-05',-42.5)"
            )

    def tearDown(self):
        cs.lock_all()
        self._stack.__exit__(None, None, None)

    def _ledger_counts(self) -> tuple[int, int, int]:
        with database.get_db() as conn:
            return (
                conn.execute("SELECT COUNT(*) FROM account").fetchone()[0],
                conn.execute("SELECT COUNT(*) FROM txn").fetchone()[0],
                conn.execute("SELECT COUNT(*) FROM connection").fetchone()[0],
            )


class RecoveryCodeTests(_VaultCase):
    # --- the code itself -------------------------------------------------------------------------

    def test_code_carries_far_more_entropy_than_the_sign_in_generator(self):
        # The property, not the formatting: a vault slot's wrap is offline-attackable, so the 40-bit
        # sign-in code would be a real weakness here. Asserted as a floor on the decoded material rather
        # than on the string, so re-grouping the display form cannot silently weaken it.
        self.assertGreaterEqual(cs.RECOVERY_CODE_BYTES * 8, 128)
        codes = {cs.generate_recovery_code() for _ in range(50)}
        self.assertEqual(len(codes), 50, "codes must not repeat")

    def test_formatting_and_case_are_presentation_only(self):
        cs.issue_recovery_code(self.alice)
        slot = cdb.get_vault_slot(self.alice, "recovery")
        code = cs.generate_recovery_code()
        self.assertEqual(cs.normalize_recovery_code(code), cs.normalize_recovery_code(code.lower()))
        self.assertEqual(cs.normalize_recovery_code(code), cs.normalize_recovery_code(code.replace("-", " ")))
        self.assertIsNotNone(slot)

    def test_issuing_requires_an_unlocked_vault(self):
        cs.lock(self.alice)
        with self.assertRaises(cs.VaultLocked):
            cs.issue_recovery_code(self.alice)

    def test_regenerating_retires_the_previous_code(self):
        first = cs.issue_recovery_code(self.alice)
        second = cs.issue_recovery_code(self.alice)
        self.assertNotEqual(first, second)
        self.assertEqual(len(cdb.list_vault_slots(self.alice, method="recovery")), 1)
        cs.lock(self.alice)
        with self.assertRaises(ValueError):
            cs.recover_with_code(self.alice, first, NEW_PASSPHRASE)

    # --- recovery --------------------------------------------------------------------------------

    def test_recovery_restores_access_without_touching_the_dek(self):
        code = cs.issue_recovery_code(self.alice)
        cs.lock(self.alice)

        cs.recover_with_code(self.alice, code, NEW_PASSPHRASE)

        # The whole point of this rung: the DEK is unchanged, so every stored secret still reads and no
        # connection needs re-linking.
        self.assertEqual(cs.require_dek(self.alice), self.dek)
        cs.lock(self.alice)
        self.assertEqual(cs.unlock(self.alice, NEW_PASSPHRASE), self.dek)
        with database.get_db() as conn:
            credential = conn.execute("SELECT credential_enc FROM connection WHERE id='c1'").fetchone()[0]
        self.assertEqual(
            cs.decrypt_connection_credential({"id": self.alice}, "plaid", "item-1", "", credential),
            "access-token-abc",
        )

    def test_the_old_passphrase_stops_working(self):
        code = cs.issue_recovery_code(self.alice)
        cs.lock(self.alice)
        cs.recover_with_code(self.alice, code, NEW_PASSPHRASE)
        cs.lock(self.alice)
        with self.assertRaises(ValueError):
            cs.unlock(self.alice, ALICE_PASSPHRASE)

    def test_a_used_code_is_replaced_by_a_fresh_one(self):
        code = cs.issue_recovery_code(self.alice)
        cs.lock(self.alice)
        reissued = cs.recover_with_code(self.alice, code, NEW_PASSPHRASE)

        self.assertNotEqual(reissued, code)
        self.assertTrue(cs.has_recovery_code(self.alice))
        # Consumed means the slot is gone, so the spent code must not open the replacement slot.
        cs.lock(self.alice)
        with self.assertRaises(ValueError):
            cs.recover_with_code(self.alice, code, "yet another vault passphrase here")
        # …and the reissued one must, which is what makes forgetting the replacement survivable too.
        cs.lock(self.alice)
        cs.recover_with_code(self.alice, reissued, "yet another vault passphrase here")
        self.assertEqual(cs.require_dek(self.alice), self.dek)

    def test_a_wrong_code_changes_nothing(self):
        code = cs.issue_recovery_code(self.alice)
        cs.lock(self.alice)
        with self.assertRaises(ValueError):
            cs.recover_with_code(self.alice, cs.generate_recovery_code(), NEW_PASSPHRASE)
        # The real code still works and the old passphrase still does: a failed attempt is inert.
        cs.lock(self.alice)
        self.assertEqual(cs.unlock(self.alice, ALICE_PASSPHRASE), self.dek)
        cs.lock(self.alice)
        cs.recover_with_code(self.alice, code, NEW_PASSPHRASE)

    def test_a_weak_new_passphrase_leaves_the_code_live(self):
        # The ordering property that makes a *single* recovery code safe: a failure anywhere before the
        # slot is deleted must leave the whole operation repeatable, rather than spending the one code
        # the user has on an attempt that achieved nothing.
        code = cs.issue_recovery_code(self.alice)
        cs.lock(self.alice)
        with self.assertRaises(cs.WeakPassphrase):
            cs.recover_with_code(self.alice, code, "short")

        self.assertTrue(cs.has_recovery_code(self.alice))
        cs.lock(self.alice)
        cs.recover_with_code(self.alice, code, NEW_PASSPHRASE)
        self.assertEqual(cs.require_dek(self.alice), self.dek)

    def test_recovery_needs_a_code_to_have_been_issued(self):
        cs.lock(self.alice)
        with self.assertRaises(cs.VaultLocked):
            cs.recover_with_code(self.alice, cs.generate_recovery_code(), NEW_PASSPHRASE)


class VaultResetTests(_VaultCase):
    def test_reset_clears_the_secrets_and_flags_relink_but_keeps_the_ledger(self):
        before = self._ledger_counts()
        result = cs.reset_vault(self.alice, reason="lost")

        self.assertEqual(result["connections_needing_relink"], 1)
        self.assertFalse(cs.vault_configured())
        self.assertEqual(cdb.list_vault_slots(), [])
        self.assertEqual(self._ledger_counts(), before, "accounts, transactions and connections must survive")
        with database.get_db() as conn:
            row = conn.execute(
                "SELECT credential, credential_enc, reauth_required FROM connection WHERE id='c1'"
            ).fetchone()
            secret = conn.execute("SELECT secret, secret_enc FROM provider_config WHERE provider='plaid'").fetchone()
        self.assertIsNone(row["credential_enc"])
        self.assertEqual(row["credential"], "")
        self.assertEqual(row["reauth_required"], 1)
        self.assertIsNone(secret["secret_enc"])
        self.assertEqual(secret["secret"], "")

    def test_every_encrypted_column_is_reached(self):
        # Derived from the registry rather than listed, so a secret added to the vault later fails this
        # test instead of being quietly left behind as permanently unopenable litter.
        cs.reset_vault(self.alice, reason="lost")
        with database.get_db() as conn:
            for spec in cs.ENCRYPTED_COLUMNS:
                remaining = conn.execute(
                    f"SELECT COUNT(*) FROM {spec.table} WHERE {spec.column} IS NOT NULL"
                ).fetchone()[0]
                self.assertEqual(remaining, 0, f"{spec.table}.{spec.column} was not cleared")

    def test_a_new_passphrase_after_a_reset_mints_a_different_dek(self):
        cs.reset_vault(self.alice, reason="lost")
        cs.set_passphrase(self.alice, NEW_PASSPHRASE)
        self.assertNotEqual(cs.require_dek(self.alice), self.dek)

    def test_ciphertext_written_before_a_reset_never_opens_again(self):
        _, enc = cs.encrypt_connection_credential({"id": self.alice}, "plaid", "item-9", "token-9")
        cs.reset_vault(self.alice, reason="lost")
        cs.set_passphrase(self.alice, NEW_PASSPHRASE)
        with self.assertRaises(cs.VaultDecryptError):
            cs.decrypt_connection_credential({"id": self.alice}, "plaid", "item-9", "", enc)

    # --- the refusal, and what it is actually about ----------------------------------------------

    def _enrol_bob(self):
        cs.set_passphrase(self.bob, "bob's own long vault passphrase")
        cs.grant_access(self.alice, cdb.get_vault_slot(self.bob, "passphrase")["id"])

    def test_another_member_holding_a_slot_does_not_block_a_reset(self):
        # Revised 2026-08-31: this used to refuse. A slot row cannot prove the other person is reachable,
        # still holds their secret, or is willing — the same argument the module already makes about the
        # caller's own leftover slots — and the compromise path permitted the identical destruction
        # anyway, so the block only ever stopped a user who described their situation accurately. It is a
        # redirect the dialog leads with, by name, not a bar.
        with database.get_db() as conn:
            self._enrol_bob()
            cs.reset_vault(self.alice, reason="lost")
            self.assertFalse(cs.vault_configured())
            self.assertIsNone(
                conn.execute("SELECT credential_enc FROM connection WHERE id='c1'").fetchone()[0]
            )

    def test_a_reset_ends_every_member_access_not_just_the_callers(self):
        # The consequence that replaces the refusal, and the reason it has to be stated up front: there is
        # one DEK per workspace, so Bob's perfectly good slot dies with it.
        self._enrol_bob()
        self.assertEqual(len(cdb.list_vault_slots(self.bob)), 1)
        cs.reset_vault(self.alice, reason="lost")
        self.assertEqual(cdb.list_vault_slots(self.bob), [])

    def test_a_compromise_reset_proceeds_too(self):
        # Unchanged, and the case that always argued for allowing it: a leaked key is no less leaked for
        # someone else holding a slot.
        self._enrol_bob()
        cs.reset_vault(self.alice, reason="compromised")
        self.assertFalse(cs.vault_configured())

    def test_the_users_own_other_slots_are_no_obstacle_either(self):
        cs.issue_recovery_code(self.alice)
        cs.reset_vault(self.alice, reason="lost")
        self.assertFalse(cs.vault_configured())

    def test_a_reset_must_state_why(self):
        with self.assertRaises(ValueError):
            cs.reset_vault(self.alice, reason="")


class ProofWindowTests(_VaultCase):
    """The three doors that mint a durable unlock method, and the five-minute life of a proof.

    Holding the DEK is not authority to hand out new ways of reaching it: each of these operations turns
    transient access to an unlocked session into permanent, independent access. The properties pinned
    here are the ones whose violation would be **silent** — a door that quietly stops checking, and a
    proof stamp that ordinary use keeps alive forever.
    """

    PRF = cs._b64e(b"\x22" * 32)

    def _lapse_proof(self):
        """Age the proof past its window without waiting five minutes of wall clock.

        The stamp is monotonic, so it is moved rather than the clock — which also means this test does
        not care what `PROOF_TTL_SECONDS` is set to.
        """
        with cs._unlock_lock:
            for user_id in list(cs._proved_at):
                cs._proved_at[user_id] -= cs.PROOF_TTL_SECONDS + 1

    # --- door 1: the passphrase slot ---------------------------------------------------------------

    def test_an_unlocked_session_cannot_mint_a_passphrase(self):
        self._lapse_proof()
        with self.assertRaises(ValueError):
            cs.set_passphrase(self.alice, "a passphrase of the caller's choosing")
        # And the refusal wrote nothing: the original still opens the same DEK.
        cs.lock(self.alice)
        self.assertEqual(cs.unlock(self.alice, ALICE_PASSPHRASE), self.dek)

    # --- door 2: passkey registration --------------------------------------------------------------

    def test_registering_a_passkey_needs_recent_proof(self):
        self._lapse_proof()
        with self.assertRaises(cs.ProofRequired):
            cs.register_passkey_slot(self.alice, credential_id="cred-x", prf_output=self.PRF,
                                     prf_salt="salt-x")
        self.assertIsNone(cdb.get_vault_slot_by_credential("cred-x"))

    def test_registering_a_passkey_succeeds_with_proof(self):
        self._lapse_proof()
        cs.unlock(self.alice, ALICE_PASSPHRASE)  # the proof
        cs.register_passkey_slot(self.alice, credential_id="cred-x", prf_output=self.PRF,
                                 prf_salt="salt-x")
        self.assertIsNotNone(cdb.get_vault_slot_by_credential("cred-x"))

    # --- door 3: recovery codes --------------------------------------------------------------------

    def test_issuing_a_recovery_code_needs_recent_proof(self):
        self._lapse_proof()
        with self.assertRaises(cs.ProofRequired):
            cs.issue_recovery_code(self.alice)
        self.assertFalse(cs.has_recovery_code(self.alice))

    def test_issuing_a_recovery_code_succeeds_with_proof(self):
        self._lapse_proof()
        cs.unlock(self.alice, ALICE_PASSPHRASE)
        cs.issue_recovery_code(self.alice)
        self.assertTrue(cs.has_recovery_code(self.alice))

    # --- the stamp itself --------------------------------------------------------------------------

    def test_ordinary_use_does_not_renew_the_proof(self):
        """The regression that would disable the whole control without failing anything else.

        `_cache_get_all` pushes the *unlock's* deadline out on every read — that is what makes it an
        idle timeout. A proof stamp riding on that same entry would be renewed by ordinary decryption
        and would never expire. So: lapse the proof, then do exactly the kind of work that slides the
        unlock, and the door must still be shut.
        """
        self._lapse_proof()
        for _ in range(3):
            cs.require_dek(self.alice)                      # slides the unlock cache
            cs.decrypt_app_credential({"id": self.alice}, "plaid", "", self._app_secret_enc())
        self.assertTrue(cs.is_unlocked(self.alice), "the vault must still be open — only proof lapsed")
        with self.assertRaises(cs.ProofRequired):
            cs.issue_recovery_code(self.alice)

    def test_unlocking_stamps_proof_so_the_common_path_prompts_once(self):
        # Unlock, then add a passkey: the ordinary sitting, and it must not ask for the passphrase that
        # was typed seconds earlier.
        self._lapse_proof()
        cs.lock(self.alice)
        cs.unlock(self.alice, ALICE_PASSPHRASE)
        cs.register_passkey_slot(self.alice, credential_id="cred-y", prf_output=self.PRF,
                                 prf_salt="salt-y")
        self.assertGreater(cs.proof_seconds_remaining(self.alice), 0)

    def test_locking_drops_the_proof(self):
        cs.lock(self.alice)
        self.assertEqual(cs.proof_seconds_remaining(self.alice), 0)

    def _app_secret_enc(self):
        with database.get_db() as conn:
            return conn.execute("SELECT secret_enc FROM provider_config WHERE provider='plaid'").fetchone()[0]


class RemovalProofTests(_VaultCase):
    """Removing an unlock method joins the same window as adding one.

    Taking a method away grants nothing, which is why the original rule covered only the three doors that
    *mint* one. But someone at an unlocked machine could strip every passkey and the recovery code,
    leaving the owner one forgotten passphrase from rebuilding every connection — and "any change to how
    the vault is opened needs recent proof" is a simpler rule to hold than one with a carve-out.
    """

    PRF = cs._b64e(b"\x66" * 32)

    def setUp(self):
        super().setUp()
        cs.register_passkey_slot(self.alice, credential_id="cred-r", prf_output=self.PRF,
                                 prf_salt="salt-r", label="Laptop")

    def _lapse_proof(self):
        with cs._unlock_lock:
            for user_id in list(cs._proved_at):
                cs._proved_at[user_id] -= cs.PROOF_TTL_SECONDS + 1

    def test_removing_a_passkey_needs_recent_proof(self):
        slot_id = cdb.get_vault_slot_by_credential("cred-r")["id"]
        self._lapse_proof()
        with self.assertRaises(cs.ProofRequired):
            cs.remove_slot(self.alice, slot_id)
        self.assertIsNotNone(cdb.get_vault_slot_by_credential("cred-r"), "nothing may be deleted")

    def test_removing_succeeds_with_proof(self):
        slot_id = cdb.get_vault_slot_by_credential("cred-r")["id"]
        self._lapse_proof()
        cs.unlock(self.alice, ALICE_PASSPHRASE)
        cs.remove_slot(self.alice, slot_id)
        self.assertIsNone(cdb.get_vault_slot_by_credential("cred-r"))

    def test_the_last_way_in_is_refused_before_proof_is_asked_for(self):
        # A removal that could never be allowed should say so, rather than collecting a secret and then
        # refusing what it was given for.
        cs.remove_slot(self.alice, cdb.get_vault_slot_by_credential("cred-r")["id"])
        self._lapse_proof()
        with self.assertRaises(ValueError) as caught:
            cs.remove_slot(self.alice, cdb.get_vault_slot(self.alice, "passphrase")["id"])
        self.assertNotIsInstance(caught.exception, cs.ProofRequired)


class GrantAccessProofTests(_VaultCase):
    """Approving somebody else is the fourth door, and the one with the shortest path to abuse.

    It mints a durable unlock method for another account. With sign-in protection off anyone can create
    an identity, set a passphrase on it — which lands pending — and then approve it from a session left
    unlocked, walking away with a permanent slot of their own. Holding the DEK is not enough.
    """

    def _pending_bob(self):
        cs.set_passphrase(self.bob, "bob's own long vault passphrase")
        return cdb.get_vault_slot(self.bob, "passphrase")["id"]

    def _lapse_proof(self):
        with cs._unlock_lock:
            for user_id in list(cs._proved_at):
                cs._proved_at[user_id] -= cs.PROOF_TTL_SECONDS + 1

    def test_approving_needs_recent_proof(self):
        slot_id = self._pending_bob()
        self._lapse_proof()
        with self.assertRaises(cs.ProofRequired):
            cs.grant_access(self.alice, slot_id)
        self.assertFalse(cs.user_has_slot(self.bob), "no access may be granted")

    def test_approving_succeeds_with_proof(self):
        slot_id = self._pending_bob()
        self._lapse_proof()
        cs.unlock(self.alice, ALICE_PASSPHRASE)
        cs.grant_access(self.alice, slot_id)
        self.assertEqual(cs.unlock(self.bob, "bob's own long vault passphrase"), self.dek)

    def test_a_locked_granter_is_told_the_vault_is_locked(self):
        # The DEK check comes first, so the answer names the step the user can act on rather than asking
        # for a secret that would not be enough on its own.
        slot_id = self._pending_bob()
        cs.lock(self.alice)
        with self.assertRaises(cs.VaultLocked) as caught:
            cs.grant_access(self.alice, slot_id)
        self.assertNotIsInstance(caught.exception, cs.ProofRequired)


class DiscardRecoveryCodeTests(_VaultCase):
    """Deleting a recovery code outright, rather than replacing one and not writing the new one down."""

    def test_discarding_clears_the_rung_the_ladder_offers(self):
        # The reason this exists: `has_recovery_code` drives rung 2 of the recovery dialog, so
        # replace-and-forget left the app offering a code the user deliberately does not hold.
        cs.issue_recovery_code(self.alice)
        self.assertTrue(cs.has_recovery_code(self.alice))
        cs.discard_recovery_code(self.alice)
        self.assertFalse(cs.has_recovery_code(self.alice))

    def test_the_discarded_code_stops_working(self):
        code = cs.issue_recovery_code(self.alice)
        cs.discard_recovery_code(self.alice)
        with self.assertRaises(cs.VaultLocked):
            cs.recover_with_code(self.alice, code, NEW_PASSPHRASE)

    def test_the_vault_is_otherwise_untouched(self):
        cs.issue_recovery_code(self.alice)
        cs.discard_recovery_code(self.alice)
        cs.lock_all()
        self.assertEqual(cs.unlock(self.alice, ALICE_PASSPHRASE), self.dek)

    def test_discarding_the_only_way_in_is_refused(self):
        # Reachable: issue a code, then remove the passphrase slot (allowed — the code remains). The code
        # is now the only path to the DEK, and deleting it would brick the workspace.
        cs.issue_recovery_code(self.alice)
        cs.remove_slot(self.alice, cdb.get_vault_slot(self.alice, "passphrase")["id"])
        with self.assertRaises(ValueError):
            cs.discard_recovery_code(self.alice)
        self.assertTrue(cs.has_recovery_code(self.alice))

    def test_discarding_when_there_is_none_says_so(self):
        with self.assertRaises(ValueError):
            cs.discard_recovery_code(self.alice)


class PasskeyPassphraseTests(_VaultCase):
    """Setting a passphrase by proving with a passkey — the rung a passkey holder had no route to."""

    PRF = cs._b64e(b"\x33" * 32)

    def setUp(self):
        super().setUp()
        cs.register_passkey_slot(self.alice, credential_id="cred-pk", prf_output=self.PRF,
                                 prf_salt="salt-pk", label="Laptop")

    def test_a_passkey_sets_a_new_passphrase_and_keeps_the_dek(self):
        cs.set_passphrase_with_passkey("cred-pk", self.PRF, NEW_PASSPHRASE)
        cs.lock_all()
        self.assertEqual(cs.unlock(self.alice, NEW_PASSPHRASE), self.dek,
                         "the DEK is unchanged, so no credential is re-encrypted and nothing re-links")

    def test_the_old_passphrase_stops_working(self):
        cs.set_passphrase_with_passkey("cred-pk", self.PRF, NEW_PASSPHRASE)
        cs.lock_all()
        with self.assertRaises(ValueError):
            cs.unlock(self.alice, ALICE_PASSPHRASE)

    def test_the_stored_credentials_still_open_afterwards(self):
        cs.set_passphrase_with_passkey("cred-pk", self.PRF, NEW_PASSPHRASE)
        cs.lock_all()
        cs.unlock(self.alice, NEW_PASSPHRASE)
        with database.get_db() as conn:
            row = conn.execute("SELECT credential_enc FROM connection WHERE id='c1'").fetchone()
        self.assertEqual(
            cs.decrypt_connection_credential({"id": self.alice}, "plaid", "item-1", "", row[0]),
            "access-token-abc",
        )

    def test_a_wrong_prf_output_changes_nothing(self):
        with self.assertRaises(ValueError):
            cs.set_passphrase_with_passkey("cred-pk", cs._b64e(b"\x44" * 32), NEW_PASSPHRASE)
        cs.lock_all()
        self.assertEqual(cs.unlock(self.alice, ALICE_PASSPHRASE), self.dek)

    def test_a_weak_replacement_leaves_the_old_passphrase_working(self):
        # The same ordering property that makes a single recovery code safe: a refusal on the way in
        # must leave the attempt repeatable rather than the user with neither secret.
        with self.assertRaises(cs.WeakPassphrase):
            cs.set_passphrase_with_passkey("cred-pk", self.PRF, "short")
        cs.lock_all()
        self.assertEqual(cs.unlock(self.alice, ALICE_PASSPHRASE), self.dek)

    def test_a_passkey_only_member_can_set_a_first_passphrase(self):
        # The flow removing `set_passphrase`'s third branch must not break: bob holds a granted passkey
        # and no passphrase at all, and this is his only route to one.
        bob_prf = cs._b64e(b"\x55" * 32)
        cs.register_passkey_slot(self.bob, credential_id="cred-bob", prf_output=bob_prf,
                                 prf_salt="salt-bob")
        cs.grant_access(self.alice, cdb.get_vault_slot_by_credential("cred-bob")["id"])
        self.assertIsNone(cdb.get_vault_slot(self.bob, "passphrase"))

        cs.set_passphrase_with_passkey("cred-bob", bob_prf, "bob's brand new long passphrase")
        cs.lock_all()
        self.assertEqual(cs.unlock(self.bob, "bob's brand new long passphrase"), self.dek)


class ReenrolmentTests(_VaultCase):
    """Rung 1: a member whose access is intact but whose secret is gone asks to be let back in."""

    def _enrol_bob(self):
        cs.set_passphrase(self.bob, "bob's own long vault passphrase")
        cs.grant_access(self.alice, cdb.get_vault_slot(self.bob, "passphrase")["id"])

    def test_a_locked_out_member_lands_in_the_approval_queue(self):
        self._enrol_bob()
        cs.lock(self.alice)
        cs.request_reenrolment(self.alice, NEW_PASSPHRASE)

        pending = [r for r in cs.pending_access_requests() if r["user_id"] == self.alice]
        self.assertEqual(len(pending), 1)
        self.assertTrue(pending[0]["replaces_access"],
                        "the approver must be able to tell this from a newcomer enrolling")

    def test_approval_restores_access_without_touching_the_dek(self):
        self._enrol_bob()
        cs.lock(self.alice)
        cs.request_reenrolment(self.alice, NEW_PASSPHRASE)

        cs.unlock(self.bob, "bob's own long vault passphrase")
        slot = cdb.get_vault_slot(self.alice, "passphrase")
        cs.grant_access(self.bob, slot["id"])

        self.assertEqual(cs.unlock(self.alice, NEW_PASSPHRASE), self.dek,
                         "same DEK, so no data source is reconnected")

    def test_it_is_refused_when_nobody_could_grant_it(self):
        # The self-brick: alice is the only member, so overwriting her slot with a pending one would
        # destroy the only path to the DEK with no one able to seal it back.
        cs.lock(self.alice)
        with self.assertRaises(cs.VaultLocked):
            cs.request_reenrolment(self.alice, NEW_PASSPHRASE)
        self.assertEqual(cs.unlock(self.alice, ALICE_PASSPHRASE), self.dek)

    def test_an_open_vault_is_told_to_change_instead(self):
        self._enrol_bob()
        with self.assertRaises(ValueError):
            cs.request_reenrolment(self.alice, NEW_PASSPHRASE)

    def test_a_user_with_no_access_enrols_normally_instead(self):
        self._enrol_bob()
        carol = cdb.create_local_identity("carol")["id"]
        with self.assertRaises(ValueError):
            cs.request_reenrolment(carol, NEW_PASSPHRASE)


if __name__ == "__main__":
    unittest.main()
