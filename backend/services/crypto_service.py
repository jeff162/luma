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


class VaultLocked(Exception):
    """The workspace vault is not unlocked for this user, so the DEK is unavailable."""


class VaultAccessPending(VaultLocked):
    """This user's slot exists and their secret is correct, but no member has granted it the DEK yet.

    Separate from plain `VaultLocked` because the two need opposite advice: a locked vault is opened by
    entering a secret, while a pending one cannot be opened by anything the user does — someone else has
    to approve it. Told the first story, a waiting user retypes a passphrase that was never wrong."""


class WeakPassphrase(ValueError):
    """A passphrase below the floor in `passphrase_meets_production_min` was offered for a vault slot.

    Typed rather than a bare ValueError because the endpoints turn it into a specific error code the UI
    keys on, and because the two numbers a user needs to hear are the constants above — a caller that has
    to parse a message string to say "20 characters, 6 distinct" will drift from them."""


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


def lock_all() -> None:
    """Drop every unlocked DEK (e.g. when sign-in protection is disabled)."""
    with _unlock_lock:
        _unlocked.clear()


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

def _slot_kek(slot: dict, secret: str) -> bytes:
    """The KEK a slot's own unlock secret derives, per its method.

    A passphrase is stretched (it is low-entropy and the wrap is offline-attackable); a passkey's PRF
    output is already 32 uniform bytes from the authenticator, so it only needs domain separation, not
    hardening — stretching it would cost seconds of CPU to add nothing."""
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
) -> str:
    """Write one format-2 slot. `dek=None` leaves it pending a grant.

    Every slot in the system is written through here, which is why the passphrase floor is enforced
    here too: a check on each caller would have to be remembered on the next one, and the one that got
    missed would be the hole.
    """
    if method == "passphrase":
        if not passphrase_meets_production_min(secret):
            raise WeakPassphrase(
                f"the vault passphrase must be at least {VAULT_PRODUCTION_MIN_LEN} characters with at least "
                f"{VAULT_PRODUCTION_MIN_DISTINCT} distinct characters"
            )
        salt = os.urandom(16)
        kdf = {"kdf_algo": "scrypt", "kdf_salt": _b64e(salt), "kdf_n": SCRYPT_N, "kdf_r": SCRYPT_R, "kdf_p": SCRYPT_P}
    else:
        kdf = {}

    # The id is resolved here, before any wrapping, rather than by the storage layer: it is bound into
    # the AAD of the material written alongside it, so composing the row against a fresh id and then
    # storing it over an existing one would produce a wrap that nothing can open. A passphrase slot is
    # unique per user, so replacing one means adopting its id.
    if not slot_id and method == "passphrase":
        current = cdb.get_vault_slot(user_id, "passphrase")
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
        **kdf,
    )


def set_passphrase(user_id: str, passphrase: str) -> None:
    """Create or replace this user's passphrase slot.

    Three cases, distinguished by what the caller can already reach. The first passphrase in the
    workspace mints the DEK. A user who already holds it (their own slot, unlocked) re-seals the same
    DEK. Anyone else is **enrolling**: the slot is written with no DEK and waits for a member to grant
    it, which is a normal outcome here rather than a refusal.
    """
    if not passphrase:
        raise ValueError("passphrase is required")

    existing = cdb.get_vault_slot(user_id, "passphrase")
    if not vault_configured():
        dek = os.urandom(DEK_BYTES)
    elif user_has_slot(user_id):
        # Replacing a working slot must not mint a second DEK over the top of the real one, so the
        # caller has to be holding the genuine one.
        dek = require_dek(user_id)
    else:
        dek = None

    _write_slot(user_id, method="passphrase", secret=passphrase, dek=dek, slot_id=existing["id"] if existing else None,
                meets_production_min=passphrase_meets_production_min(passphrase))
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
# A connection holds one opaque provider secret (Plaid: the access_token; Teller/SimpleFIN: their own
# shapes). The vault doesn't care which — it wraps a string under the DEK. Storage contract for callers
# is (credential, credential_enc): the credential is *always* ciphertext-only, the plaintext column left
# empty. Both paths require the caller's vault unlocked.

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


def decrypt_connection_credential(user: dict, provider: str, external_id: str, credential: str | None, credential_enc: str | None) -> str:
    if credential_enc:
        return decrypt_connection_credential_with_dek(
            require_deks(user["id"]), provider, external_id, credential, credential_enc,
        )
    return credential or ""


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
    """
    slot = cdb.get_vault_slot_by_id(slot_id)
    if not slot:
        raise ValueError("no such vault access request")
    if slot_holds_dek(slot):
        raise ValueError("this user already has vault access")
    dek = require_dek(granter_id)
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


def remove_slot(user_id: str, slot_id: str) -> None:
    """Remove one unlock method, refusing to remove the last one that works.

    The refusal is the point: the vault has no recovery path by design, so deleting a final slot would
    silently destroy this user's access to every stored credential — and where they are the only member,
    the workspace's. Losing access should take a deliberate reset, never a tidy-up.
    """
    slot = cdb.get_vault_slot_by_id(slot_id)
    if not slot or slot["user_id"] != user_id:
        raise ValueError("no such unlock method")
    remaining = [s for s in cdb.list_vault_slots(user_id) if s["id"] != slot_id and slot_holds_dek(s)]
    if slot_holds_dek(slot) and not remaining:
        raise ValueError("this is the only way you can open the vault — add another before removing it")
    cdb.delete_vault_slot(slot_id)
