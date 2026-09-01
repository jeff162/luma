# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
The vault: multi-wrap envelope encryption for provider (Plaid/aggregator) secrets.

One workspace Data Encryption Key (DEK) protects every per-connection secret. The DEK is never
stored in the clear. Each user holds a "slot" — a way in, guarded by a Key-Encryption-Key (KEK)
derived from that user's unlock secret (a passphrase, or a passkey's WebAuthn PRF output). Unlocking a
slot re-derives the KEK, recovers the DEK, and holds it in a server-side, in-process unlock cache with
an idle timeout — never in the signed session cookie, which is serialized to the browser.

The security property is **leaked DB != leaked tokens**: an attacker with the database files but no
live unlock secret cannot derive any KEK, so no slot opens and every provider secret stays opaque.
This deliberately does *not* protect against a compromised running host (the server is trusted; it
holds the DEK while unlocked), which matches the self-hosted/LAN deployment model.

**A slot does not wrap the DEK directly; it owns a keypair.** `public_key` sits in the clear,
`wrapped_private_key` is AEAD-sealed under the KEK, and `sealed_dek` is the DEK sealed *to that public
key*. The indirection buys the two operations the original design could not perform, both for the same
reason — a wrap made from someone's own secret can only ever be made *by* them:

  * **Enrollment.** A new user creates a slot with no `sealed_dek` (they have no DEK to put in it) and
    any member with the vault unlocked seals the DEK to their public key. Nothing secret travels
    between the two people, so there is no bearer code to intercept, expire, or revoke.
  * **Rotation.** Re-keying can re-seal the new DEK for *every remaining* slot, because sealing needs
    only public keys. Under direct wrapping it could only have destroyed everyone else's access.

Legacy directly-wrapped slots (format 1) still unlock and are converted in place the first time their
passphrase arrives — the one moment both the KEK and the DEK are in hand.

This replaces the retired `server_managed` model, where a per-user DEK was wrapped under an app master
key the server always held — so the server could always decrypt at rest, and a leaked DB *was* a
leaked token set. There is no `off`/plaintext path and no master-key fallback: the vault is the only
custody. Any ciphertext written under the old model is unrecoverable here by design (a clean break —
a live connection simply re-links).
"""

import base64
import hashlib
import json
import os
import threading
import time
import uuid
from dataclasses import dataclass
from typing import Callable

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from backend.db import control_database as cdb
from backend.db.database import get_db

# scrypt work factors for passphrase slots (interactive-login scale, ~32 MiB). Persisted per slot so
# they can be raised later without breaking existing wraps. cryptography 43 has no Argon2id KDF; the
# design permits Argon2 *or* scrypt, and scrypt is memory-hard with no extra dependency.
SCRYPT_N = 2 ** 15
SCRYPT_R = 8
SCRYPT_P = 1

DEK_BYTES = 32  # AES-256

# Idle auto-lock: an unlocked DEK is dropped from the cache after this long without use. Sized to a
# working day so "first sync of the day" costs one unlock and later syncs reuse it; a backend restart
# also drops it (re-unlock required). Sliding — each use pushes the deadline out.
UNLOCK_TTL_SECONDS = 8 * 60 * 60

# How long a freshly presented unlock secret keeps authorizing *changes to the unlock methods
# themselves* — adding a passkey, minting a recovery code, writing a passphrase slot. Deliberately far
# shorter than the unlock above, and deliberately NOT sliding: see `_stamp_proof`.
#
# Five minutes covers a run of related actions in one sitting (unlock, open Vault settings, add a
# passkey) without ever asking twice, while leaving an unattended session closed. The alternative
# considered — proof at every boundary — is the kind of prompt that gets answered by choosing a weaker
# secret, which would cost more than it bought.
PROOF_TTL_SECONDS = 5 * 60

# The vault-passphrase floor. **Every** passphrase meets it — there is no weaker tier and no test-mode
# exemption. This is the *vault* minimum, separate from the app-login password policy.
#
# It used to be conditional, demanded only where a connection was judged "live": Plaid gated on the switch
# to `env == "production"`, SimpleFIN on the claim URL not being its demo one. That was a real weak tier,
# and the argument for keeping it — that a throwaway passphrase makes clicking around a sandbox cheaper —
# does not survive the passphrase living in a password manager, where entering a long one costs the same
# as a short one. A conditional floor also has to be right at every gate that guards it and stays right as
# providers are added; an unconditional one cannot be got wrong. So the tier is gone: a strong passphrase
# is required before any data connection can be configured, whatever the provider or its environment.
#
# Length is the main lever, for the password-manager reason above. The small distinct-character
# requirement rejects degenerate inputs (one character repeated, trivial alternations) that clear a length
# check while carrying almost no entropy.
VAULT_PRODUCTION_MIN_LEN = 20
VAULT_PRODUCTION_MIN_DISTINCT = 6


# A vault recovery code's entropy, in raw bytes before base32 encoding. 20 bytes is 160 bits and encodes
# to exactly 32 unpadded base32 characters.
#
# **Deliberately not `control_database.generate_recovery_codes`**, which is the sign-in generator: that
# produces 40 bits, which is sound for a 2FA code because the server checks it against a hash and can rate
# limit and lock out. A vault slot is the opposite situation — its wrap is offline-attackable by anyone
# holding the control DB, which is the exact threat the vault exists to answer, and no rate limit reaches
# an attacker working on their own machine. Reusing the sign-in generator here would quietly reintroduce
# the weak wrap that the passphrase floor below was raised to eliminate.
RECOVERY_CODE_BYTES = 20

# Base32 (RFC 4648) rather than hex: it carries more bits per character and its alphabet already excludes
# the digits most often misread off a printout (0/1/8 have no letter twin in it).
_RECOVERY_CODE_GROUP = 8


class VaultLocked(Exception):
    """The workspace vault is not unlocked for this user, so the DEK is unavailable."""


class VaultAccessPending(VaultLocked):
    """This user's slot exists and their secret is correct, but no member has granted it the DEK yet.

    Separate from plain `VaultLocked` because the two need opposite advice: a locked vault is opened by
    entering a secret, while a pending one cannot be opened by anything the user does — someone else has
    to approve it. Told the first story, a waiting user retypes a passphrase that was never wrong."""


class ProofRequired(Exception):
    """A change to the unlock methods was attempted without a recently presented secret.

    Deliberately not a `VaultLocked`: the vault *is* open, and telling the caller to unlock would send
    them to a dialog that has nothing to do. What is missing is recency, and the answer is to present a
    passphrase or a passkey again — which is why this carries its own type all the way to its own HTTP
    code rather than reusing the locked one.
    """


class WeakPassphrase(ValueError):
    """A passphrase below the floor in `passphrase_meets_production_min` was offered for a vault slot.

    Typed rather than a bare ValueError because the endpoints turn it into a specific error code the UI
    keys on, and because the two numbers a user needs to hear are the constants above — a caller that has
    to parse a message string to say "20 characters, 6 distinct" will drift from them."""


class MissingCredential(Exception):
    """This connection has no stored credential at all — neither ciphertext nor a legacy plaintext value.

    A real state, not a corruption: a vault reset clears both columns and keeps the connection rows on
    purpose, so the accounts, mappings and coverage hanging off them survive for a re-link to land back
    on. Typed because the alternative was worse than an error — the decrypt used to return `""` here, and
    an empty string is indistinguishable from a credential, so every caller went on to hand it to a
    provider. Plaid answers that with *"access_token must be a non-empty string"*, which surfaced as a
    failed **disconnect**: the one row that could not be revoked was also the one that could not be
    deleted.

    What each caller should do differs, which is why this is raised rather than handled here: a disconnect
    should drop the local row without calling the provider (there is nothing to revoke *with*), a
    re-authorize should refuse and send the user to a fresh connect (there is no credential to repair),
    and a sync should skip.
    """


class VaultDecryptError(Exception):
    """A stored ciphertext could not be decrypted under the current DEK (wrong/rotated key, or a
    clean-break blob from the retired server_managed model). The caller should treat the connection
    as needing a re-link."""


def _b64e(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def _b64d(data: str) -> bytes:
    return base64.b64decode(data.encode("ascii"))


def _aad(*parts) -> bytes:
    # Bind ciphertext to the context it was created for so a copied blob cannot be replayed under a
    # different row/user and still decrypt successfully.
    return "|".join("" if part is None else str(part) for part in parts).encode("utf-8")


def _slot_aad(user_id: str) -> bytes:
    """The legacy (format-1) wrap context. Frozen: existing slots decrypt under exactly this."""
    return _aad("vault-slot", user_id)


def _private_key_aad(user_id: str, slot_id: str) -> bytes:
    # Binds a wrapped private key to its own slot as well as its owner, so a slot row copied over
    # another (a second passkey, a restored control DB) cannot be opened by the wrong secret.
    return _aad("vault-slot-key", user_id, slot_id)


def _sealed_dek_aad(user_id: str, slot_id: str) -> bytes:
    return _aad("vault-slot-dek", user_id, slot_id)


# --- The server-side unlock cache (never the cookie) ---------------------------------------------
#
# Keyed by user_id: unlocking your own slot populates *your* entry, so another user's unlock does not
# grant you the DEK — the per-user boundary is "who unlocked their slot," exactly as designed. Process
# memory only: lost on restart (re-unlock) and shared across a user's own sessions/devices (fine for a
# household). A raw DEK must never enter the signed session cookie.
#
# An entry holds a *list* of DEKs, newest first. It has more than one only mid-rotation, where the
# outgoing key must stay readable until the last ciphertext has been rewritten — see `rotate_dek`.
# Encryption always uses the first; decryption tries them in order.

_unlock_lock = threading.Lock()
_unlocked: dict[str, dict] = {}


def _cache_put(user_id: str, deks: bytes | list[bytes]) -> None:
    keys = [deks] if isinstance(deks, bytes) else [d for d in deks if d]
    with _unlock_lock:
        _unlocked[user_id] = {"deks": keys, "expires_at": time.monotonic() + UNLOCK_TTL_SECONDS}


def _cache_get_all(user_id: str) -> list[bytes] | None:
    with _unlock_lock:
        entry = _unlocked.get(user_id)
        if not entry:
            return None
        if entry["expires_at"] < time.monotonic():
            _unlocked.pop(user_id, None)
            return None
        entry["expires_at"] = time.monotonic() + UNLOCK_TTL_SECONDS  # sliding idle window
        return list(entry["deks"])


def _cache_get(user_id: str) -> bytes | None:
    keys = _cache_get_all(user_id)
    return keys[0] if keys else None


def lock(user_id: str) -> None:
    """Drop this user's unlocked DEK from the cache (logout, explicit lock)."""
    with _unlock_lock:
        _unlocked.pop(user_id, None)
        _proved_at.pop(user_id, None)


def lock_all() -> None:
    """Drop every unlocked DEK (e.g. when sign-in protection is disabled)."""
    with _unlock_lock:
        _unlocked.clear()
        _proved_at.clear()


# --- Recent proof ---------------------------------------------------------------------------------
#
# Holding the DEK is *not* authority to hand out new ways of reaching it. Three operations mint a
# durable unlock method — writing a passphrase slot, registering a passkey, issuing a recovery code —
# and each one turns transient access to an unlocked session into permanent independent access that
# survives lock, relock, and the owner trying to get back in. So each requires a secret presented
# recently, not merely a DEK found in the cache.
#
# **Kept in its own dict, and absolute rather than sliding.** `_cache_get_all` pushes the unlock's
# deadline out on every read, which is what makes it an *idle* timeout. A proof stamp living on that
# same entry would be renewed by ordinary decryption and would never expire — a control that reads as
# enforced and is not. Storing it separately also means `_cache_put`, which rewrites the whole cache
# entry, cannot silently reset it.
_proved_at: dict[str, float] = {}


def _stamp_proof(user_id: str) -> None:
    """Record that this user has just presented an unlock secret.

    Called only from the four places one is actually verified — `unlock`, `unlock_with_passkey`,
    `change_passphrase`, `recover_with_code`. Never from a cache read, and never from an operation that
    merely *uses* the DEK.
    """
    with _unlock_lock:
        _proved_at[user_id] = time.monotonic()


def proof_seconds_remaining(user_id: str) -> int:
    """How much longer this user's proof authorizes a change to their unlock methods; 0 when none.

    Served to the client so a surface can ask for proof *before* an action rather than only after a
    refusal. Seconds remaining rather than an expiry timestamp on purpose: the browser then needs no
    clock agreement with the server, and can run its own countdown from it.
    """
    with _unlock_lock:
        stamped = _proved_at.get(user_id)
    if stamped is None:
        return 0
    return max(0, int(PROOF_TTL_SECONDS - (time.monotonic() - stamped)))


def has_recent_proof(user_id: str) -> bool:
    return proof_seconds_remaining(user_id) > 0


def require_recent_proof(user_id: str) -> None:
    """Gate for the three doors above. Raises `ProofRequired` when the window has lapsed."""
    if not has_recent_proof(user_id):
        raise ProofRequired(
            "Confirm your passphrase or passkey to change how this vault is opened"
        )


# --- KDF + wrap/unwrap primitives ----------------------------------------------------------------

def _derive_kek(passphrase: str, salt: bytes, n: int = SCRYPT_N, r: int = SCRYPT_R, p: int = SCRYPT_P) -> bytes:
    return Scrypt(salt=salt, length=32, n=n, r=r, p=p).derive(passphrase.encode("utf-8"))


def _wrap(key: bytes, plaintext: bytes, *, aad: bytes) -> str:
    nonce = os.urandom(12)
    ciphertext = AESGCM(key).encrypt(nonce, plaintext, aad)
    return json.dumps({"v": 1, "n": _b64e(nonce), "c": _b64e(ciphertext)})


def _unwrap(key: bytes, payload: str, *, aad: bytes) -> bytes:
    data = json.loads(payload)
    return AESGCM(key).decrypt(_b64d(data["n"]), _b64d(data["c"]), aad)


# --- Sealing to a slot's public key --------------------------------------------------------------
#
# Plain ECIES over X25519: an ephemeral keypair per seal, HKDF over the shared secret, AES-GCM under
# the result. This is what makes the DEK giveable — the holder needs only the recipient's public key,
# never their secret — so both enrollment and rotation reduce to "seal it again for these public keys".
#
# The ephemeral public key is bound into the HKDF salt alongside the recipient's, so a shared secret
# can never be reused to open a seal made for a different pair.

def _seal_key(shared: bytes, ephemeral_public: bytes, recipient_public: bytes) -> bytes:
    return HKDF(
        algorithm=hashes.SHA256(), length=32,
        salt=ephemeral_public + recipient_public, info=b"vault.slot-seal.v1",
    ).derive(shared)


def _seal(recipient_public: bytes, plaintext: bytes, *, aad: bytes) -> str:
    ephemeral = X25519PrivateKey.generate()
    ephemeral_public = ephemeral.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    shared = ephemeral.exchange(X25519PublicKey.from_public_bytes(recipient_public))
    key = _seal_key(shared, ephemeral_public, recipient_public)
    nonce = os.urandom(12)
    return json.dumps({
        "v": 1,
        "epk": _b64e(ephemeral_public),
        "n":   _b64e(nonce),
        "c":   _b64e(AESGCM(key).encrypt(nonce, plaintext, aad)),
    })


def _open_seal(private_key: bytes, payload: str, *, aad: bytes) -> bytes:
    data = json.loads(payload)
    private = X25519PrivateKey.from_private_bytes(private_key)
    recipient_public = private.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    ephemeral_public = _b64d(data["epk"])
    key = _seal_key(private.exchange(X25519PublicKey.from_public_bytes(ephemeral_public)),
                    ephemeral_public, recipient_public)
    return AESGCM(key).decrypt(_b64d(data["n"]), _b64d(data["c"]), aad)


# --- Vault status --------------------------------------------------------------------------------

def vault_configured() -> bool:
    """True once the workspace DEK exists (at least one slot holds it)."""
    return cdb.vault_slot_count() > 0


def slot_holds_dek(slot: dict | None) -> bool:
    """Whether a slot can actually produce the DEK, as opposed to awaiting a grant."""
    if not slot:
        return False
    return bool(slot["wrapped_dek"] if slot["format"] == 1 else slot["sealed_dek"])


def user_has_slot(user_id: str) -> bool:
    """Whether this user has any unlock method that opens the vault — the question the UI asks before
    offering an Unlock prompt. A pending enrollment is deliberately not one: there is no secret they
    could enter that would work yet (see `user_access_pending`)."""
    return any(slot_holds_dek(s) for s in cdb.list_vault_slots(user_id))


def user_access_pending(user_id: str) -> bool:
    slots = cdb.list_vault_slots(user_id)
    return bool(slots) and not any(slot_holds_dek(s) for s in slots)


def user_passkey_slots(user_id: str) -> list[dict]:
    """This user's passkey slots as the UI needs them — never the wrapping material."""
    return [
        {
            "id":         s["id"],
            "label":      s["label"],
            "created_at": s["created_at"],
            "pending":    not slot_holds_dek(s),
        }
        for s in cdb.list_vault_slots(user_id, method="passkey")
    ]


def is_unlocked(user_id: str) -> bool:
    return _cache_get(user_id) is not None


def ready_for_production() -> bool:
    """Every slot in the vault meets the passphrase floor, so the DEK is not recoverable through a weak wrap.

    Trivially true for any slot written by `_write_passphrase_slot`, which now refuses to write a weak one.
    Kept anyway, and still checked at the connect boundary: it is the *invariant*, and what it guards
    against is a future slot **type** rather than a weak passphrase — phase 4's passkey slots wrap the same
    DEK, and a slot method that reintroduced a weak wrap would be invisible to a check that only ran when
    the passphrase was set. The flag it reads is also carried in the credentials backup payload, where the
    slot may have been written by an older, laxer install."""
    return cdb.all_slots_meet_production_min()


def passphrase_meets_production_min(passphrase: str) -> bool:
    p = passphrase or ""
    return len(p) >= VAULT_PRODUCTION_MIN_LEN and len(set(p)) >= VAULT_PRODUCTION_MIN_DISTINCT


def require_dek(user_id: str) -> bytes:
    dek = _cache_get(user_id)
    if dek is None:
        raise VaultLocked()
    return dek


def require_deks(user_id: str) -> list[bytes]:
    """Every DEK this user's unlock currently vouches for, newest first. Only decryption uses the tail,
    and only during a rotation — see the unlock cache."""
    deks = _cache_get_all(user_id)
    if not deks:
        raise VaultLocked()
    return deks


# --- Slot lifecycle (set / unlock / change) ------------------------------------------------------

# The slot methods whose secret is *typed by a person* and therefore stretched, each carrying its own
# scrypt parameters. Named once because two places must agree about it forever: `_write_slot`, which
# decides whether to mint a salt, and `_slot_kek`, which decides how to derive. A passkey is the
# exception either way — its PRF output is already uniform key material.
#
# A recovery code is in the set even though it is generated and carries real entropy. Stretching it is
# belt-and-braces rather than load-bearing, and it costs one scrypt derivation on a path taken once in a
# disaster; the alternative — a second, unstretched derivation rule — would be a second thing to get
# right for no measurable gain.
KDF_METHODS = ("passphrase", "recovery")


def _slot_kek(slot: dict, secret: str) -> bytes:
    """The KEK a slot's own unlock secret derives, per its method.

    A typed secret is stretched (a passphrase is low-entropy and the wrap is offline-attackable); a
    passkey's PRF output is already 32 uniform bytes from the authenticator, so it only needs domain
    separation, not hardening — stretching it would cost seconds of CPU to add nothing."""
    if slot["method"] == "passkey":
        return HKDF(
            algorithm=hashes.SHA256(), length=32,
            salt=slot["id"].encode("utf-8"), info=b"vault.passkey-kek.v1",
        ).derive(_b64d(secret))
    return _derive_kek(secret, _b64d(slot["kdf_salt"]), slot["kdf_n"], slot["kdf_r"], slot["kdf_p"])


def _open_slot(slot: dict, secret: str, *, user_id: str) -> tuple[bytes | None, list[bytes]]:
    """Open a slot with its unlock secret: `(private_key, deks)`.

    `private_key` is None for a legacy format-1 slot (it has none). `deks` is empty when the slot is
    still awaiting a grant — the secret was right, there is simply nothing sealed to it yet. A wrong
    secret raises `ValueError`: the AEAD tag is the verifier, so no separate check is stored.
    """
    kek = _slot_kek(slot, secret)
    if slot["format"] == 1:
        try:
            return None, [_unwrap(kek, slot["wrapped_dek"], aad=_slot_aad(user_id))]
        except Exception as exc:
            raise ValueError("incorrect passphrase") from exc
    try:
        private_key = _unwrap(kek, slot["wrapped_private_key"], aad=_private_key_aad(user_id, slot["id"]))
    except Exception as exc:
        raise ValueError("incorrect passphrase") from exc
    aad = _sealed_dek_aad(user_id, slot["id"])
    deks = [
        _open_seal(private_key, sealed, aad=aad)
        for sealed in (slot["sealed_dek"], slot["sealed_dek_prev"]) if sealed
    ]
    return private_key, deks


def _write_slot(
    user_id: str, *, method: str, secret: str, dek: bytes | None,
    slot_id: str | None = None, label: str | None = None,
    credential_id: str | None = None, prf_salt: str | None = None,
    private_key: bytes | None = None, meets_production_min: bool = True,
    replaces_access: bool = False,
) -> str:
    """Write one format-2 slot. `dek=None` leaves it pending a grant.

    Every slot in the system is written through here, which is why the passphrase floor is enforced
    here too: a check on each caller would have to be remembered on the next one, and the one that got
    missed would be the hole.
    """
    # The floor is a *passphrase* policy, not a KDF one: a recovery code is generated to a fixed entropy
    # by `generate_recovery_code` and has no user-chosen weakness to guard against, so applying a
    # length-and-distinct-character rule to it would only ever reject well-formed key material.
    if method == "passphrase" and not passphrase_meets_production_min(secret):
        raise WeakPassphrase(
            f"the vault passphrase must be at least {VAULT_PRODUCTION_MIN_LEN} characters with at least "
            f"{VAULT_PRODUCTION_MIN_DISTINCT} distinct characters"
        )
    if method in KDF_METHODS:
        salt = os.urandom(16)
        kdf = {"kdf_algo": "scrypt", "kdf_salt": _b64e(salt), "kdf_n": SCRYPT_N, "kdf_r": SCRYPT_R, "kdf_p": SCRYPT_P}
    else:
        kdf = {}

    # The id is resolved here, before any wrapping, rather than by the storage layer: it is bound into
    # the AAD of the material written alongside it, so composing the row against a fresh id and then
    # storing it over an existing one would produce a wrap that nothing can open. A passphrase slot and a
    # recovery slot are each unique per user, so replacing one means adopting its id.
    if not slot_id and method in KDF_METHODS:
        current = cdb.get_vault_slot(user_id, method)
        slot_id = current["id"] if current else None
    slot_id = slot_id or str(uuid.uuid4())
    slot_shape = dict(kdf, id=slot_id, method=method, credential_id=credential_id, prf_salt=prf_salt)
    kek = _slot_kek(slot_shape, secret)

    # An existing keypair is kept when only the KEK is changing (a passphrase change): the DEK stays
    # sealed to the same public key, so nothing has to be re-sealed and no other slot is disturbed.
    private_key = private_key or X25519PrivateKey.generate().private_bytes_raw()
    public_key = X25519PrivateKey.from_private_bytes(private_key).public_key().public_bytes(
        Encoding.Raw, PublicFormat.Raw
    )
    return cdb.upsert_vault_slot(
        user_id,
        method=method,
        slot_id=slot_id,
        label=label,
        credential_id=credential_id,
        prf_salt=prf_salt,
        public_key=_b64e(public_key),
        wrapped_private_key=_wrap(kek, private_key, aad=_private_key_aad(user_id, slot_id)),
        sealed_dek=(
            _seal(public_key, dek, aad=_sealed_dek_aad(user_id, slot_id)) if dek is not None else None
        ),
        meets_production_min=meets_production_min,
        replaces_access=replaces_access,
        **kdf,
    )


def set_passphrase(user_id: str, passphrase: str) -> None:
    """Create this user's passphrase slot, in the two cases where no existing access is at stake.

    The first passphrase in the workspace mints the DEK. Anyone with no working slot is **enrolling**:
    the slot is written with no DEK and waits for a member to grant it, which is a normal outcome here
    rather than a refusal.

    **A third case used to live here and was removed (2026-09-01):** a user who already held the DEK,
    unlocked, could re-seal it under a passphrase of their choosing with no proof of the old one. That
    turned a session someone had merely walked up to into a durable, independent way into the vault —
    the new passphrase kept working after lock and relock, and the owner's stopped. Replacing a working
    slot now goes through a path that carries proof: `change_passphrase`, `set_passphrase_with_passkey`,
    or `recover_with_code`. A locked-out holder who has none of them uses `request_reenrolment`.
    """
    if not passphrase:
        raise ValueError("passphrase is required")

    existing = cdb.get_vault_slot(user_id, "passphrase")
    if not vault_configured():
        dek = os.urandom(DEK_BYTES)
    elif user_has_slot(user_id):
        raise ValueError(
            "this user can already open the vault — changing the passphrase needs the current "
            "passphrase, a passkey, or a recovery code"
        )
    else:
        dek = None

    _write_slot(user_id, method="passphrase", secret=passphrase, dek=dek, slot_id=existing["id"] if existing else None,
                meets_production_min=passphrase_meets_production_min(passphrase))
    # Choosing the secret counts as presenting it — otherwise setting up a vault and immediately adding
    # a passkey would ask for the passphrase that was typed seconds earlier. Safe in both surviving
    # branches: one has no existing access to escalate from, the other writes a slot that opens nothing
    # until it is granted.
    _stamp_proof(user_id)
    if dek is not None:
        _cache_put(user_id, dek)


def change_passphrase(user_id: str, old_passphrase: str, new_passphrase: str) -> None:
    """Re-derive the KEK from a new passphrase, keeping the slot's keypair and therefore its access.

    Deliberately not a re-seal: what a passphrase change protects is the *stored wrapping*, and the DEK
    is unchanged, so nobody else's slot is touched and no credential is re-encrypted. A passphrase
    change is not a response to a compromise — `rotate_dek` is.
    """
    if not new_passphrase:
        raise ValueError("new passphrase is required")
    slot = cdb.get_vault_slot(user_id, "passphrase")
    if not slot:
        raise VaultLocked("no passphrase is set for this user")
    private_key, deks = _open_slot(slot, old_passphrase, user_id=user_id)  # verifies the old passphrase
    _stamp_proof(user_id)
    if slot["format"] == 1:
        # No keypair to rewrap yet — the change is also the conversion.
        _write_slot(
            user_id, method="passphrase", secret=new_passphrase, dek=deks[0] if deks else None,
            slot_id=slot["id"], meets_production_min=passphrase_meets_production_min(new_passphrase),
        )
    else:
        if not passphrase_meets_production_min(new_passphrase):
            raise WeakPassphrase(
                f"the vault passphrase must be at least {VAULT_PRODUCTION_MIN_LEN} characters with at least "
                f"{VAULT_PRODUCTION_MIN_DISTINCT} distinct characters"
            )
        salt = os.urandom(16)
        cdb.rewrap_vault_slot_secret(
            slot["id"],
            wrapped_private_key=_wrap(
                _derive_kek(new_passphrase, salt), private_key,
                aad=_private_key_aad(user_id, slot["id"]),
            ),
            kdf_algo="scrypt", kdf_salt=_b64e(salt), kdf_n=SCRYPT_N, kdf_r=SCRYPT_R, kdf_p=SCRYPT_P,
            meets_production_min=passphrase_meets_production_min(new_passphrase),
        )
    if deks:
        _cache_put(user_id, deks)


def _slot_wrapping(slot: dict | None) -> str | None:
    """The part of a slot that a passphrase change replaces — what the export fingerprint is taken over.

    Under format 2 the DEK's seal survives a passphrase change untouched; the private-key wrap is the
    piece that moves. Fingerprinting the seal instead would report "nothing changed" after exactly the
    event the fingerprint exists to detect.
    """
    if not slot:
        return None
    return slot["wrapped_dek"] if slot["format"] == 1 else slot["wrapped_private_key"]


def wrapped_dek_fingerprint(wrapped_dek: str | None) -> str | None:
    """A stable, non-reversible marker for one *wrapping* of the DEK.

    It answers exactly one question — "was this file written against the wrapping the vault has now?" —
    which is what lets a passphrase change name the credentials backups it is about to strand instead of
    warning about backups in general. Equality is the whole contract; nothing derives key material from
    it, and it must never be treated as one.

    A plain digest suffices and no secret salt is involved: the input already sits in the control DB, so
    hashing it exposes nothing new, and a fingerprint that varied per call could not be compared across
    the export and the change that invalidates it. The domain-separation prefix keeps this digest from
    colliding with any other use of the same bytes."""
    if not wrapped_dek:
        return None
    return hashlib.sha256(b"vault.wrapped-dek.v1|" + wrapped_dek.encode("utf-8")).hexdigest()


def current_wrapped_dek_fingerprint(user_id: str) -> str | None:
    """The fingerprint of the wrapping in force for this user, or None when no slot exists."""
    return wrapped_dek_fingerprint(_slot_wrapping(cdb.get_vault_slot(user_id)))


def exported_slot_fingerprint(exported: dict | None) -> str | None:
    """The same fingerprint, for a slot as carried inside a credentials backup file.

    Exists so the backup path does not have to know which field a given format keeps its wrapping in —
    that rule belongs here, next to the formats themselves."""
    if not exported:
        return None
    return wrapped_dek_fingerprint(_slot_wrapping({"format": 1, **exported}))


def unwrap_dek_from_slot(slot: dict, passphrase: str, *, user_id: str) -> bytes:
    """The DEK a passphrase opens from an **arbitrary** slot — this install's, or one carried in a
    credentials backup taken on another machine.

    `user_id` is the id the slot was written *for*, not necessarily the caller: the AAD binds the
    material to it, so a foreign slot only opens when its own id comes along with it. That is why the
    credentials backup carries the exporting user's id beside the key material.

    Deliberately does **not** populate the unlock cache. The DEK this returns belongs to whatever
    workspace produced the slot; caching it under the local user would quietly install a foreign key as
    this workspace's own.
    """
    # A dict from a backup file, not a DB row: fill in the columns a format-1 file never carried.
    slot = {"format": 1, "sealed_dek_prev": None, **slot}
    _, deks = _open_slot(slot, passphrase, user_id=user_id)
    if not deks:
        raise ValueError("this vault key carries no workspace key")
    return deks[0]


def unlock(user_id: str, passphrase: str) -> bytes:
    slot = cdb.get_vault_slot(user_id, "passphrase")
    if not slot:
        raise VaultLocked("no passphrase is set for this user")
    return _unlock_with_slot(slot, passphrase, user_id=user_id)


def _unlock_with_slot(slot: dict, secret: str, *, user_id: str) -> bytes:
    private_key, deks = _open_slot(slot, secret, user_id=user_id)
    if not deks:
        raise VaultAccessPending("vault access has not been granted for this user yet")
    if slot["format"] == 1:
        _upgrade_slot_to_keypair(slot, secret, deks[0], user_id=user_id)
    _cache_put(user_id, deks)
    # The choke point both unlock paths pass through, so a passphrase and a passkey ceremony stamp
    # proof identically and neither can be forgotten separately.
    _stamp_proof(user_id)
    return deks[0]


def _upgrade_slot_to_keypair(slot: dict, secret: str, dek: bytes, *, user_id: str) -> None:
    """Convert a legacy directly-wrapped slot in place, now that both the KEK and the DEK are in hand.

    Unlock is the only moment that is ever true, which is why this rides here rather than running as a
    migration at startup: a slot cannot be converted without the secret that opens it, and the secret
    only exists in the process while someone is signing in to the vault. An install whose owner never
    unlocks simply keeps working on format 1.
    """
    kek = _slot_kek(slot, secret)
    private_key = X25519PrivateKey.generate().private_bytes_raw()
    public_key = X25519PrivateKey.from_private_bytes(private_key).public_key().public_bytes(
        Encoding.Raw, PublicFormat.Raw
    )
    wrapped_private_key = _wrap(kek, private_key, aad=_private_key_aad(user_id, slot["id"]))
    cdb.upgrade_vault_slot_to_format_2(
        slot["id"],
        public_key=_b64e(public_key),
        wrapped_private_key=wrapped_private_key,
        sealed_dek=_seal(public_key, dek, aad=_sealed_dek_aad(user_id, slot["id"])),
        old_fingerprint=wrapped_dek_fingerprint(slot["wrapped_dek"]),
        new_fingerprint=wrapped_dek_fingerprint(wrapped_private_key),
    )


def export_vault_slot(user_id: str) -> dict | None:
    """The user's passphrase slot as portable material: exactly enough to re-derive the KEK and unwrap
    the DEK **given the passphrase**, and nothing else. `None` when no slot exists.

    This is what makes a ciphertext credentials backup restorable on another machine — without it the
    exported ciphertext is undecryptable anywhere but the install that produced it (the key lives in the
    control DB, the ciphertext in the data DB). It is safe to hand out only because `wrapped_dek` is
    passphrase-wrapped: the file's security is exactly the vault passphrase's strength, which is why
    `meets_production_min` rides along for the UI to warn on.
    """
    slot = cdb.get_vault_slot(user_id)
    if not slot or not slot_holds_dek(slot):
        return None
    return {
        "user_id":              user_id,   # the slot's AAD — see `unwrap_dek_from_slot`
        "method":               slot["method"],
        "format":               slot["format"],
        # Format 1 carries the DEK wrapped straight under the KEK; format 2 carries the keypair that
        # holds it. A reader picks by `format`, and a pre-format-2 file simply has none of the latter.
        "wrapped_dek":          slot["wrapped_dek"],
        "id":                   slot["id"],   # part of the format-2 AAD, so it must travel with them
        "public_key":           slot["public_key"],
        "wrapped_private_key":  slot["wrapped_private_key"],
        "sealed_dek":           slot["sealed_dek"],
        "kdf_algo":             slot["kdf_algo"],
        "kdf_salt":             slot["kdf_salt"],
        "kdf_n":                slot["kdf_n"],
        "kdf_r":                slot["kdf_r"],
        "kdf_p":                slot["kdf_p"],
        "meets_production_min": bool(slot["meets_production_min"]),
    }


def vault_slot_is_local(exported: dict | None, user_id: str) -> bool:
    """Whether an exported slot is this workspace's own — same user and the identical wrapping.

    When it is, a backup's ciphertext is already valid against the live DEK and can be restored
    verbatim: no passphrase, no unlock, no re-encryption. That is the ordinary "restore my own backup
    onto the machine that made it" case, and it should not demand a passphrase to do nothing.

    Compared on the wrapping rather than the seal for the same reason the fingerprint is: after a
    passphrase change the seal is still byte-identical, and treating such a file as local would restore
    it verbatim under a key the file no longer documents.
    """
    if not exported:
        return False
    local = cdb.get_vault_slot(user_id)
    if not local or exported.get("user_id") != user_id:
        return False
    return _slot_wrapping({"format": 1, **exported}) == _slot_wrapping(local)


# --- Per-connection secret encrypt/decrypt (under the DEK) ---------------------------------------

def encrypt_secret(dek: bytes, plaintext: str, *, aad: bytes) -> str:
    return _wrap(dek, plaintext.encode("utf-8"), aad=aad)


def decrypt_secret(dek: bytes | list[bytes], payload: str, *, aad: bytes) -> str:
    """Open a secret under the DEK, accepting a list so an interrupted rotation still reads.

    Trying keys in turn is safe rather than sloppy: AES-GCM rejects the wrong key at the tag, so a
    second attempt can only succeed on ciphertext that key genuinely sealed."""
    for key in ([dek] if isinstance(dek, bytes) else dek):
        try:
            return _unwrap(key, payload, aad=aad).decode("utf-8")
        except Exception:
            continue
    raise VaultDecryptError()


# --- Per-connection credential storage (provider-agnostic) ----------------------------------------
#
# A connection holds one opaque provider secret (Plaid: the access_token; SimpleFIN: the access URL; a
# further provider: its own shape). The vault doesn't care which — it wraps a string under the DEK.
# Storage contract for callers is (credential, credential_enc): the credential is *always*
# ciphertext-only, the plaintext column left empty. Both paths require the caller's vault unlocked.

def _connection_aad(provider: str, external_id: str) -> bytes:
    # Plaid continuity: access tokens written before provider-agnostic connections used exactly this AAD
    # (`plaid_item|<item_id>|access_token`), so the Plaid path must keep it or existing ciphertext won't
    # decrypt after the plaid_item → connection cutover. Other providers get their own clean namespace.
    if provider == "plaid":
        return _aad("plaid_item", external_id, "access_token")
    return _aad("connection", provider, external_id, "credential")


def encrypt_connection_credential(user: dict, provider: str, external_id: str, secret: str) -> tuple[str, str | None]:
    dek = require_dek(user["id"])
    payload = encrypt_secret(dek, secret, aad=_connection_aad(provider, external_id))
    return "", payload


def decrypt_connection_credential_with_dek(dek: bytes | list[bytes], provider: str, external_id: str,
                                           credential: str | None, credential_enc: str | None) -> str:
    """Decrypt under an explicitly supplied DEK rather than the caller's unlocked one — the restore path
    for a credentials backup taken elsewhere, where the ciphertext belongs to the *backup's* workspace.
    Keeps the AAD construction in here; a caller reconstructing it would be a second copy of the rule."""
    if credential_enc:
        return decrypt_secret(dek, credential_enc, aad=_connection_aad(provider, external_id))
    # A legacy plaintext row (never encrypted) reads straight through — no DEK needed. New writes never
    # take this path.
    return credential or ""


def connection_has_credential(credential: str | None, credential_enc: str | None) -> bool:
    """Whether there is anything to decrypt. Callers that only need to *offer* an action — a UI deciding
    whether "Reconnect" can work — ask this rather than attempting a decrypt they would discard."""
    return bool(credential_enc) or bool(credential)


def decrypt_connection_credential(user: dict, provider: str, external_id: str, credential: str | None, credential_enc: str | None) -> str:
    if credential_enc:
        return decrypt_connection_credential_with_dek(
            require_deks(user["id"]), provider, external_id, credential, credential_enc,
        )
    if credential:
        return credential
    # Never `""`. See `MissingCredential` — an empty string reads as a credential to every caller and
    # reaches the provider as one.
    raise MissingCredential(f"no credential is stored for this {provider} connection")


# --- App-level provider credential storage (the aggregator's own app secret) ----------------------
#
# Distinct from a per-connection credential: this is the *app*-level secret that identifies the Luma
# app to the provider (Plaid's `secret`), one per provider, not per linked bank. It moves out of `.env`
# into the vaulted DB (phase 6b) so it isn't a plaintext secret on disk. Only the secret is vaulted —
# the paired `client_id`/`env` are semi-public and stored plaintext by the caller.

def _app_credential_aad(provider: str) -> bytes:
    return _aad("app_credential", provider, "secret")


def encrypt_app_credential(user: dict, provider: str, secret: str) -> tuple[str, str | None]:
    dek = require_dek(user["id"])
    payload = encrypt_secret(dek, secret, aad=_app_credential_aad(provider))
    return "", payload


def decrypt_app_credential_with_dek(dek: bytes | list[bytes], provider: str, secret: str | None, secret_enc: str | None) -> str:
    """The app-credential twin of `decrypt_connection_credential_with_dek` — see there."""
    if secret_enc:
        return decrypt_secret(dek, secret_enc, aad=_app_credential_aad(provider))
    return secret or ""


def decrypt_app_credential(user: dict, provider: str, secret: str | None, secret_enc: str | None) -> str:
    if secret_enc:
        return decrypt_app_credential_with_dek(require_deks(user["id"]), provider, secret, secret_enc)
    return secret or ""


# --- Enrollment, revocation and rotation ---------------------------------------------------------
#
# The three operations sealing makes possible. All of them move the DEK between *public* keys, so none
# needs any other user's secret — that asymmetry is the whole reason a slot owns a keypair rather than
# wrapping the DEK directly (see the module docstring).

def pending_access_requests() -> list[dict]:
    """Everyone waiting on a grant, as the approving member needs to see them."""
    return [
        {
            "slot_id":      s["id"],
            "user_id":      s["user_id"],
            "username":     s["username"],
            "display_name": s["display_name"] or s["username"],
            "method":       s["method"],
            "label":        s["label"],
            "requested_at": s["created_at"],
            # A newcomer enrolling and a locked-out member coming back read identically in this queue,
            # and they ask different things of the approver — the second hands back access that already
            # existed, to whoever wrote the request. Surfaced so the approval can say so.
            "replaces_access": bool(s["replaces_access"]),
        }
        for s in cdb.list_pending_vault_slots()
    ]


def vault_members() -> list[dict]:
    """Everyone who can currently open the vault.

    The counterpart to `pending_access_requests`, and the half that was missing: without it the UI can
    show who is *asking* for the credentials but not who already holds them, which leaves "remove
    someone's access before rotating" as advice with nothing to act on."""
    return [
        {
            "user_id":      m["user_id"],
            "display_name": m["display_name"] or m["username"],
            "role":         m["role"],
            "method_count": m["method_count"],
            "since":        m["since"],
        }
        for m in cdb.list_vault_members()
    ]


def grant_access(granter_id: str, slot_id: str) -> dict:
    """Seal the workspace DEK to one pending slot's public key.

    Nothing about the grantee is needed beyond the public key already in their row, so this works
    whether or not they are signed in — which is what removes the invite ceremony's requirement that
    the two people coincide, and what lets a passkey slot be granted even though its PRF output exists
    only during a live browser ceremony.

    Requires the granter to have presented a secret recently — see `require_recent_proof` below.
    """
    slot = cdb.get_vault_slot_by_id(slot_id)
    if not slot:
        raise ValueError("no such vault access request")
    if slot_holds_dek(slot):
        raise ValueError("this user already has vault access")
    dek = require_dek(granter_id)
    # The fourth door, and the only one that mints a durable unlock method for *somebody else*. Gated for
    # the same reason as the other three, with a shorter path to abuse than any of them: with sign-in
    # protection off, anyone can create an identity, set a passphrase on it (which lands pending), and
    # then approve it from a session left unlocked — walking away from a machine would hand over a
    # permanent slot of their own. Checked after the DEK so a locked vault reports itself as locked.
    require_recent_proof(granter_id)
    cdb.set_vault_slot_sealed_dek(
        slot_id,
        _seal(_b64d(slot["public_key"]), dek, aad=_sealed_dek_aad(slot["user_id"], slot_id)),
    )
    return {"user_id": slot["user_id"], "slot_id": slot_id}


def revoke_access(user_id: str) -> None:
    """Drop every slot a user holds, ending their ability to open the vault.

    Enough on its own for an amicable departure. It cannot un-see a DEK the person already held while
    unlocked, so a hostile one is this *followed by* `rotate_dek` — which is exactly the order the two
    functions have to be called in, since rotation deliberately re-seals for whatever slots remain.
    """
    cdb.delete_vault_slots(user_id)
    lock(user_id)


@dataclass(frozen=True)
class _EncryptedColumn:
    """One place a secret sits sealed under the workspace DEK.

    A registry rather than inline SQL because two things must agree about this list forever — rotation,
    which has to reach every one of them, and the test that fails when a new one is added without being
    reached. The AAD builder rides along because re-encrypting means reproducing the exact context the
    value was sealed in, and that rule already lives in this module."""
    table: str
    column: str
    key: str
    context_columns: tuple[str, ...]
    aad: Callable[[dict], bytes]


ENCRYPTED_COLUMNS = (
    _EncryptedColumn(
        table="connection", column="credential_enc", key="id",
        context_columns=("provider", "external_id"),
        aad=lambda row: _connection_aad(row["provider"], row["external_id"]),
    ),
    _EncryptedColumn(
        table="provider_config", column="secret_enc", key="provider",
        context_columns=("provider",),
        aad=lambda row: _app_credential_aad(row["provider"]),
    ),
)


def rotate_dek(user_id: str) -> dict:
    """Replace the workspace DEK and re-encrypt everything sealed under the old one.

    The point of rotation is that a DEK someone saw while unlocked stops opening anything new. Slots
    that remain keep working; slots deleted first (see `revoke_access`) are simply not re-sealed, which
    is what ends their access.

    **Three phases, because no transaction spans both databases.** Slots live in the control DB and the
    ciphertext in the data DB, so a single failure between the two writes could otherwise leave rows
    sealed under a key no slot can produce — every credential lost, which for a data source is a
    re-link and for some providers a re-mapping too. Instead the outgoing key is kept reachable in
    `sealed_dek_prev` until the new ciphertext is committed, so an interruption at any point leaves
    every row readable under one of the two keys and the whole operation safe to run again.

    Keeping the old key briefly does not weaken the rotation: it is sealed only to the slots that
    survive, and a revoked slot was deleted before any of this ran.

    An interruption is **resumed, not restarted.** Starting a fresh rotation over an unfinished one
    would push the key the ciphertext is actually under off the end of the two the slots can hold —
    turning a recoverable state into the exact loss the phases exist to prevent. So a vault that still
    carries a previous seal finishes the rotation already in flight, and only a settled one mints a new
    key.
    """
    deks = require_deks(user_id)
    granted = [s for s in cdb.list_vault_slots() if slot_holds_dek(s)]
    resuming = any(s["sealed_dek_prev"] for s in granted)

    if resuming:
        new_dek = deks[0]
    else:
        new_dek = os.urandom(DEK_BYTES)
        # Phase 1 — every remaining slot can reach both keys.
        for slot in granted:
            cdb.set_vault_slot_sealed_dek(
                slot["id"],
                _seal(_b64d(slot["public_key"]), new_dek, aad=_sealed_dek_aad(slot["user_id"], slot["id"])),
                keep_previous=True,
            )
        deks = [new_dek] + deks
        _cache_put(user_id, deks)

    # Phase 2 — re-seal the ciphertext itself, one transaction over the data DB. Every key the caller
    # holds is offered to the decrypt, because a resumed rotation meets rows under either of them.
    rewritten = 0
    with get_db() as conn:
        for spec in ENCRYPTED_COLUMNS:
            columns = ", ".join(dict.fromkeys((spec.key, spec.column) + spec.context_columns))
            rows = conn.execute(
                f"SELECT {columns} FROM {spec.table} WHERE {spec.column} IS NOT NULL AND {spec.column} != ''"
            ).fetchall()
            for row in rows:
                row = dict(row)
                aad = spec.aad(row)
                plaintext = decrypt_secret(deks, row[spec.column], aad=aad)
                conn.execute(
                    f"UPDATE {spec.table} SET {spec.column} = ? WHERE {spec.key} = ?",
                    (encrypt_secret(new_dek, plaintext, aad=aad), row[spec.key]),
                )
                rewritten += 1

    # Phase 3 — the old key has no ciphertext left to open.
    cdb.clear_vault_slot_previous_deks()
    _cache_put(user_id, new_dek)
    return {"slots_resealed": len(granted), "secrets_reencrypted": rewritten, "resumed": resuming}


# --- Passkey slots (WebAuthn PRF) ----------------------------------------------------------------
#
# A passkey slot's KEK is the authenticator's PRF output for a per-slot salt — a stable, secret, 32-byte
# value that a plain passkey does not provide (authentication alone yields no key material; the `prf`
# extension is what does, and it must be asked for at registration).
#
# **The WebAuthn assertion is deliberately not verified here, and that is not an omission.** The vault
# is not an authentication decision — signing in to the app is a separate perimeter. A PRF output that
# is wrong fails to open `wrapped_private_key` at the AEAD tag, exactly as a wrong passphrase does, so
# the slot is self-verifying. Checking a signature on top would mean storing credential public keys and
# running challenge state to prove something already proven, and would pull in a WebAuthn library to do
# it. What the browser must genuinely provide is a secure context, which is a transport question and is
# enforced where transport is known (see `routers/auth.py`).

def new_passkey_salt() -> str:
    """A fresh PRF input for a registration about to happen.

    Per slot rather than fixed, so two authenticators registered by the same person derive unrelated
    KEKs — and so a salt captured from one ceremony says nothing about any other."""
    return _b64e(os.urandom(32))


def passkey_credentials(user_id: str) -> list[dict]:
    """What the browser needs to run a `get()` against this user's registered passkeys. The salt is
    public input to the authenticator, not a secret — the PRF output it produces is the secret, and it
    never leaves the browser except as the unlock attempt itself."""
    return [
        {"credential_id": s["credential_id"], "prf_salt": s["prf_salt"], "slot_id": s["id"],
         "label": s["label"], "pending": not slot_holds_dek(s)}
        for s in cdb.list_vault_slots(user_id, method="passkey")
    ]


def register_passkey_slot(user_id: str, *, credential_id: str, prf_output: str,
                          prf_salt: str, label: str | None = None) -> dict:
    """Add a passkey as an unlock method, or record it as pending when this user has no access yet.

    Enrolling by passkey is allowed for exactly the reason a keypair slot makes possible: the grant
    later needs only the public key this writes now, not a live ceremony with the authenticator.
    """
    if cdb.get_vault_slot_by_credential(credential_id):
        raise ValueError("that passkey is already registered")
    if user_has_slot(user_id):
        # Adding a method to a vault this user can already open must seal the real DEK into it. Writing
        # it pending instead would put someone who already has access into the approval queue, and
        # minting a key would strand every credential — so the caller has to be holding the genuine one.
        dek = require_dek(user_id)
        # And holding it is not enough on its own: this is one of the three doors that mint a durable
        # credential. Checked after the DEK so a locked vault reports itself as locked, which is the
        # more useful answer and the one the caller can act on.
        require_recent_proof(user_id)
    else:
        dek = None
    slot_id = _write_slot(
        user_id, method="passkey", secret=prf_output, dek=dek,
        label=(label or "").strip() or "Passkey", credential_id=credential_id, prf_salt=prf_salt,
        # The KEK is 32 bytes straight from the authenticator — there is no weak-passphrase analog for
        # it to fall short of, and `ready_for_production` is asking about the strength of the wrap.
        meets_production_min=True,
    )
    return {"slot_id": slot_id, "pending": dek is None}


def unlock_with_passkey(credential_id: str, prf_output: str) -> tuple[str, bytes]:
    """Open the vault from a passkey ceremony. Returns `(user_id, dek)` — the credential identifies the
    slot, so the caller does not have to be told which user it belongs to."""
    slot = cdb.get_vault_slot_by_credential(credential_id)
    if not slot:
        raise VaultLocked("that passkey is not registered with this vault")
    return slot["user_id"], _unlock_with_slot(slot, prf_output, user_id=slot["user_id"])


def set_passphrase_with_passkey(credential_id: str, prf_output: str, new_passphrase: str) -> str:
    """Prove with a passkey and write the passphrase slot in the same request. Returns the user id.

    The passkey counterpart of `recover_with_code`, and one request for the same reason: the proof and
    the replacement travel together, so there is no window in which a ceremony has been spent and no
    passphrase exists yet.

    It serves three situations that are one operation underneath — a passkey holder who has forgotten
    the passphrase, one who simply wants to change it, and a passkey-only member setting a *first*
    passphrase. All three write the same slot sealed to the same DEK, so none of them re-encrypts a
    credential or costs a re-link.

    The proof is fresher than the one it replaces: a ceremony happens at this moment, where a typed old
    passphrase may have been read off a note beside the keyboard.
    """
    if not new_passphrase:
        raise ValueError("a new passphrase is required")
    slot = cdb.get_vault_slot_by_credential(credential_id)
    if not slot:
        raise VaultLocked("that passkey is not registered with this vault")
    user_id = slot["user_id"]

    _, deks = _open_slot(slot, prf_output, user_id=user_id)  # ValueError when the PRF output is wrong
    if not deks:
        raise VaultAccessPending("vault access has not been granted for this passkey yet")
    _stamp_proof(user_id)

    # Before any write, so a passphrase below the floor is refused with the old slot untouched and the
    # attempt simply repeatable — the same ordering property that makes a single recovery code safe.
    existing = cdb.get_vault_slot(user_id, "passphrase")
    _write_slot(
        user_id, method="passphrase", secret=new_passphrase, dek=deks[0],
        slot_id=existing["id"] if existing else None,
        meets_production_min=passphrase_meets_production_min(new_passphrase),
    )
    _cache_put(user_id, deks)
    return user_id


def request_reenrolment(user_id: str, new_passphrase: str) -> dict:
    """Replace an unopenable passphrase slot with a **pending** one, for a member to grant.

    The rung for a user whose access is intact but whose secret is gone: the slot still holds the DEK,
    which is exactly why `set_passphrase` refuses them — `user_has_slot` is true. Nothing here can seal
    the DEK, because nothing here can reach it; the new slot opens nothing until an unlocked member
    approves it, at which point the DEK is unchanged and no data source is reconnected.

    **Refused when nobody else could grant it.** Otherwise this is a self-brick: the only slot that
    holds the DEK is overwritten with one that does not, and there is no one to seal it back. That check
    belongs here rather than only in the dialog offering the rung — a UI-side gate is a suggestion.
    """
    if not new_passphrase:
        raise ValueError("a new passphrase is required")
    if not user_has_slot(user_id):
        raise ValueError("this user has no vault access to replace — set a passphrase to enrol instead")
    if is_unlocked(user_id):
        # Being able to open the vault means a proof-carrying path is available, and those keep the
        # user's access instead of parking it behind someone else's approval.
        raise ValueError("this vault is already open — change the passphrase instead of re-enrolling")
    if not [m for m in vault_members() if m["user_id"] != user_id]:
        raise VaultLocked(
            "nobody else can open this vault, so a new passphrase could never be approved — "
            "use a recovery code, or rebuild the vault"
        )

    existing = cdb.get_vault_slot(user_id, "passphrase")
    _write_slot(
        user_id, method="passphrase", secret=new_passphrase, dek=None,
        slot_id=existing["id"] if existing else None,
        meets_production_min=passphrase_meets_production_min(new_passphrase),
        replaces_access=True,
    )
    # The old wrapping is gone either way; dropping any cached DEK keeps the session honest about it.
    lock(user_id)
    return {"pending": True}


def remove_slot(user_id: str, slot_id: str) -> None:
    """Remove one unlock method, refusing to remove the last one that works.

    The refusal is the point: the vault has no recovery path by design, so deleting a final slot would
    silently destroy this user's access to every stored credential — and where they are the only member,
    the workspace's. Losing access should take a deliberate reset, never a tidy-up.

    **Removal joins the proof window (2026-09-01)**, which the original mint-only rule left out. Taking a
    method away grants nothing, so it is vandalism rather than escalation — but someone at an unlocked
    machine could strip every passkey and the recovery code, leaving the owner one forgotten passphrase
    away from rebuilding every connection. "Any change to how the vault is opened needs recent proof" is
    also a simpler rule to hold than "any addition does", and a rule with a carve-out is the one that gets
    forgotten at the next call site.
    """
    slot = cdb.get_vault_slot_by_id(slot_id)
    if not slot or slot["user_id"] != user_id:
        raise ValueError("no such unlock method")
    remaining = [s for s in cdb.list_vault_slots(user_id) if s["id"] != slot_id and slot_holds_dek(s)]
    if slot_holds_dek(slot) and not remaining:
        raise ValueError("this is the only way you can open the vault — add another before removing it")
    # After the refusal above, so a removal that could never be allowed says so instead of asking for a
    # secret and then refusing what it was given for.
    require_recent_proof(user_id)
    cdb.delete_vault_slot(slot_id)


def discard_recovery_code(user_id: str) -> None:
    """Delete this user's recovery code without minting a replacement.

    `issue_recovery_code` always replaces, so "invalidate the one I wrote down" was only expressible as
    *replace and then do not record the new one* — which leaves `has_recovery_code` true. That flag drives
    rung 2 of the recovery ladder, so the app would go on offering "use your recovery code" as the free
    rung above rebuilding, to somebody who deliberately has none. The ladder is ordered by what the user
    can actually do, and a phantom rung corrupts exactly that.

    Replace-and-discard also *renders* a fresh code on screen before abandoning it — clipboard, a
    screenshot, a synced notes app. Deleting shows nothing.

    Routed through `remove_slot`, so the last-way-in guard covers it: a user who removed their passphrase
    slot while holding a code has the code as their only access, and that case must refuse.
    """
    slot = cdb.get_vault_slot(user_id, "recovery")
    if not slot:
        raise ValueError("no recovery code has been issued for this user")
    remove_slot(user_id, slot["id"])


# --- Recovery-code slots -------------------------------------------------------------------------
#
# The rung between "another member re-enrols you" and the destructive reset — and on a single-user
# install, the *only* rung, which is why the vault having none left that install a forgotten passphrase
# away from rebuilding every connection.
#
# A recovery code is a third slot method and needs no schema of its own: `vault_slot.method` is a column
# rather than an enum, and `_derive_kek` does not care whether the secret it is fed was typed by a person
# or generated. What differs from the sign-in recovery codes in `control_database` is *verification*. A
# 2FA code is checked against a stored hash, so it can be marked used with a flag. A vault code has no
# hash to check — it must actually derive a KEK that unwraps a slot's private key — so "used" can only
# mean the slot is deleted, which is a real destructive step and has to be sequenced accordingly.
#
# **One code, and recovery is one request.** Each code is an independent path to the same DEK, so a set
# of N multiplies the exposure to buy redundancy that keeping two copies of one code already provides
# (they are written down together and lost together). The hazard that argues for a set — the code spent,
# then something failing before the replacement passphrase is set, leaving the user with neither — is
# real but belongs to a *two-step* flow, so `recover_with_code` is a single operation ordered such that
# every failure is safe: the replacement slot is written before the recovery slot is deleted. A failure
# before that point leaves the code untouched and the whole thing retryable; a failure at the deletion
# leaves the user holding both a working passphrase and a live code, which costs nothing. Reissuing on
# the way out closes the other version of the worry — forgetting the *replacement* passphrase is not a
# return to the dead end.

def generate_recovery_code() -> str:
    """A fresh vault recovery code, grouped for transcription. See `RECOVERY_CODE_BYTES` for why this
    does not reuse the sign-in generator."""
    raw = base64.b32encode(os.urandom(RECOVERY_CODE_BYTES)).decode("ascii").rstrip("=")
    return "-".join(raw[i:i + _RECOVERY_CODE_GROUP] for i in range(0, len(raw), _RECOVERY_CODE_GROUP))


def normalize_recovery_code(code: str) -> str:
    """The canonical form a code is hashed into a KEK from.

    Grouping and case are presentation, so they are stripped rather than demanded back: a code read off a
    printout arrives with the dashes the user saw, pasted from a manager without them, and typed by hand
    in either case. Only base32's own alphabet survives, so a stray space cannot change the KEK.
    """
    return "".join(c for c in (code or "").upper() if c.isalnum())


def has_recovery_code(user_id: str) -> bool:
    return cdb.get_vault_slot(user_id, "recovery") is not None


def recovery_code_issued_at(user_id: str) -> str | None:
    """When the current code was issued — the only thing the UI can honestly say about a secret it is
    never shown again. A date lets someone recognize a code they still hold."""
    slot = cdb.get_vault_slot(user_id, "recovery")
    return slot["updated_at"] if slot else None


def issue_recovery_code(user_id: str) -> str:
    """Mint a recovery code for this user, replacing any current one, and return it to be shown once.

    Requires the vault open, for the same reason enrollment does: the code has to carry the DEK, and only
    an unlocked member holds it. Replacing rather than accumulating is the `vault_slot_one_recovery`
    invariant — issuing a new code retires the old one, so a code written down and then regenerated stops
    working, which is the property the user is relying on when they regenerate after a scare.
    """
    dek = require_dek(user_id)
    require_recent_proof(user_id)  # after the DEK, so a locked vault reports itself as locked
    code = generate_recovery_code()
    _write_slot(user_id, method="recovery", secret=normalize_recovery_code(code), dek=dek)
    return code


def recover_with_code(user_id: str, code: str, new_passphrase: str) -> str:
    """Open the vault with a recovery code and set a new passphrase in its place. Returns a fresh code.

    One operation rather than unlock-then-change, and the ordering is the safety property — see the
    section comment above. The steps are: open the recovery slot, write the passphrase slot sealed to the
    same DEK, delete the recovery slot, issue a replacement.

    The DEK is unchanged throughout, so **nothing is re-encrypted and no connection needs re-linking**.
    That is the whole point of this rung: the passphrase was the only thing lost, and a passphrase only
    ever guarded the wrapping.
    """
    if not new_passphrase:
        raise ValueError("a new passphrase is required")
    slot = cdb.get_vault_slot(user_id, "recovery")
    if not slot:
        raise VaultLocked("no recovery code has been issued for this user")

    _, deks = _open_slot(slot, normalize_recovery_code(code), user_id=user_id)  # ValueError on a wrong code
    _stamp_proof(user_id)
    if not deks:
        # A recovery slot is only ever written with the DEK in hand, so this is a corrupted row rather
        # than the pending-enrollment state the same shape means on a passphrase slot.
        raise VaultLocked("this recovery code no longer carries the workspace key")

    # Before the deletion below, and the reason a failed step here is harmless: a weak passphrase raises
    # out of `_write_slot` having written nothing, leaving the code live and the attempt repeatable.
    existing = cdb.get_vault_slot(user_id, "passphrase")
    _write_slot(
        user_id, method="passphrase", secret=new_passphrase, dek=deks[0],
        slot_id=existing["id"] if existing else None,
        meets_production_min=passphrase_meets_production_min(new_passphrase),
    )
    cdb.delete_vault_slot(slot["id"])
    _cache_put(user_id, deks)
    return issue_recovery_code(user_id)


# --- The destructive reset -----------------------------------------------------------------------
#
# The bottom of the recovery ladder, and the only rung that costs something. Everything above it — a
# credentials backup opened with the passphrase it was made under, another member re-enrolling the stuck
# user, a recovery code — leaves the DEK intact and re-links nothing. This one replaces the DEK, which
# permanently strands every secret sealed under the old one.
#
# **What it must not do is as load-bearing as what it does.** Connections, accounts and transactions
# survive untouched: only two columns are ever encrypted, and the account mappings, per-account coverage,
# cursors and sync history that make a connection expensive to rebuild are all plaintext beside them.
# Deleting connection rows to "clean up" would discard exactly the part that is not lost with the
# credential, and would turn a re-link into a re-mapping.
#
# **Two reasons lead here and they are not the same operation.** A *lost* passphrase is a dead end, and
# the vault cannot be opened, so no credential can be decrypted and nothing can be revoked at the
# provider. A *compromised* one is still known, so the vault can be unlocked first and every revocable
# credential retired properly on the way out. The caller asks the user which it is; this function only
# needs to know because the refusal below applies to one of them.

# **A member who can unlock is a redirect, not a refusal (revised 2026-08-31).**
#
# This used to refuse the lost-passphrase reset outright while anyone else held a slot, on the reasoning
# that destroying reachable credentials is the worse outcome. The reasoning is right about which path is
# *better*; it was wrong that the system can insist on it, for three reasons:
#
#   * It asserts something it cannot know. A `vault_slot` row does not prove the other person is
#     reachable, still holds their secret, or is willing — which is the *same* argument this module
#     already makes for the stuck user's own leftover slots.
#   * The authority question is settled elsewhere: reset is admin-gated precisely because it destroys
#     shared workspace state.
#   * It was not a safety property. The compromise path permits the identical destruction with other
#     members present (deliberately — a leaked key is no less leaked for someone else holding a slot), so
#     the block only ever stopped a user who described their situation accurately.
#
# So the caller leads with the free alternative, names the person, and — if the user says none of them
# apply — carries out the reset and tells them what it also costs the other members.


def reset_vault(user_id: str, *, reason: str) -> dict:
    """Destroy the workspace vault: every slot, every stored secret, and the DEK behind them.

    Afterwards `vault_configured()` is false, so the next passphrase mints a fresh DEK — which is what
    makes the reset → set → restore-a-credentials-backup sequence work, and equally what makes the old
    ciphertext permanently unopenable if there is no backup.

    Clearing the ciphertext is not tidiness. Once no slot can produce the old DEK the stored values are
    unopenable forever, so leaving them behind only yields `VaultDecryptError` at every future sync — the
    clean-break behaviour the model has always described as meaning *re-link*.

    It destroys **every** member's access, not just the caller's — there is one DEK per workspace. That is
    a consequence to state before the fact, not a reason to refuse; the note above this section records why
    the other-member check is a redirect rather than a block.

    The columns come from `ENCRYPTED_COLUMNS` rather than being named here, so a secret added to the
    vault later is cleared by this without anyone remembering to come back — the same registry rotation
    reads, with the same test standing behind it.
    """
    if reason not in ("lost", "compromised"):
        raise ValueError("a vault reset must state whether the passphrase was lost or compromised")

    with get_db() as conn:
        # Counted and flagged *before* anything is cleared, because the flag's meaning depends on what was
        # there: `reauth_required` says "this connection's credential is gone", and after the UPDATE below
        # there is no longer any way to tell which ones that was true of.
        connections = conn.execute("SELECT COUNT(*) FROM connection").fetchone()[0]
        conn.execute("UPDATE connection SET reauth_required = 1")
        for spec in ENCRYPTED_COLUMNS:
            conn.execute(f"UPDATE {spec.table} SET {spec.column} = NULL WHERE {spec.column} IS NOT NULL")
        # The pre-vault plaintext columns go too. New writes never populate them (`encrypt_*` returns an
        # empty plaintext beside the ciphertext), so on any current install this clears nothing — but a
        # legacy row that survived would otherwise keep syncing after a reset that told the user every
        # connection needs re-linking, and for the compromise path it would leave the single most exposed
        # copy of a credential sitting in the database the reset was run *because of*.
        conn.execute("UPDATE connection SET credential = '' WHERE credential != ''")
        conn.execute("UPDATE provider_config SET secret = '' WHERE secret != ''")

    # Last, and only once the ciphertext is gone. Reversed, an interruption between the two would leave
    # unopenable rows behind a vault that still looked configured — a state with no way out but a second
    # reset, and no screen that would say so.
    cdb.delete_all_vault_slots()
    lock_all()
    return {"connections_needing_relink": connections, "reason": reason}
