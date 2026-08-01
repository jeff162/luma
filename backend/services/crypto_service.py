# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
The vault: multi-wrap envelope encryption for provider (Plaid/aggregator) secrets.

One workspace Data Encryption Key (DEK) protects every per-connection secret. The DEK is never
stored in the clear: it is wrapped once per user "slot" under a Key-Encryption-Key (KEK) derived
from that user's unlock secret (a passphrase in this phase; a passkey PRF output later). Unlocking a
slot re-derives the KEK, unwraps the DEK, and holds it in a server-side, in-process unlock cache with
an idle timeout — never in the signed session cookie, which is serialized to the browser.

The security property is **leaked DB != leaked tokens**: an attacker with the database files but no
live unlock secret cannot derive any KEK, so every wrapped DEK — and therefore every provider secret
— stays opaque. This deliberately does *not* protect against a compromised running host (the server
is trusted; it holds the DEK while unlocked), which matches the self-hosted/LAN deployment model.

This replaces the retired `server_managed` model, where a per-user DEK was wrapped under an app master
key the server always held — so the server could always decrypt at rest, and a leaked DB *was* a
leaked token set. There is no `off`/plaintext path and no master-key fallback: the vault is the only
custody. Any ciphertext written under the old model is unrecoverable here by design (a clean break —
a live connection simply re-links).
"""

import base64
import json
import os
import threading
import time

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt

from backend.db import control_database as cdb

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

# Minimum passphrase length for a slot to be usable in Production (real, live bank tokens). Sandbox
# accepts any passphrase. This is the *vault* minimum, separate from the app-login password policy.
VAULT_PRODUCTION_MIN_LEN = 12


class VaultLocked(Exception):
    """The workspace vault is not unlocked for this user, so the DEK is unavailable."""


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
    return _aad("vault-slot", user_id)


# --- The server-side unlock cache (never the cookie) ---------------------------------------------
#
# Keyed by user_id: unlocking your own slot populates *your* entry, so another user's unlock does not
# grant you the DEK — the per-user boundary is "who unlocked their slot," exactly as designed. Process
# memory only: lost on restart (re-unlock) and shared across a user's own sessions/devices (fine for a
# household). A raw DEK must never enter the signed session cookie.

_unlock_lock = threading.Lock()
_unlocked: dict[str, dict] = {}


def _cache_put(user_id: str, dek: bytes) -> None:
    with _unlock_lock:
        _unlocked[user_id] = {"dek": dek, "expires_at": time.monotonic() + UNLOCK_TTL_SECONDS}


def _cache_get(user_id: str) -> bytes | None:
    with _unlock_lock:
        entry = _unlocked.get(user_id)
        if not entry:
            return None
        if entry["expires_at"] < time.monotonic():
            _unlocked.pop(user_id, None)
            return None
        entry["expires_at"] = time.monotonic() + UNLOCK_TTL_SECONDS  # sliding idle window
        return entry["dek"]


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


# --- Vault status --------------------------------------------------------------------------------

def vault_configured() -> bool:
    """True once the workspace DEK exists (at least one slot wraps it)."""
    return cdb.vault_slot_count() > 0


def user_has_slot(user_id: str) -> bool:
    return cdb.get_vault_slot(user_id) is not None


def is_unlocked(user_id: str) -> bool:
    return _cache_get(user_id) is not None


def ready_for_production() -> bool:
    """The vault may hold live (Production) tokens only when every slot meets the Production minimum,
    so the DEK is never recoverable through a weak wrap."""
    return cdb.all_slots_meet_production_min()


def passphrase_meets_production_min(passphrase: str) -> bool:
    return len(passphrase or "") >= VAULT_PRODUCTION_MIN_LEN


def require_dek(user_id: str) -> bytes:
    dek = _cache_get(user_id)
    if dek is None:
        raise VaultLocked()
    return dek


# --- Slot lifecycle (set / unlock / change) ------------------------------------------------------

def set_passphrase(user_id: str, passphrase: str) -> None:
    """Create or replace this user's passphrase slot.

    The first slot in the workspace mints the DEK. A subsequent user's slot must wrap the *existing*
    DEK, which requires that user to already hold it unlocked (co-present enrollment / invite land in
    a later phase) — otherwise there is no way to wrap the same DEK for them.
    """
    if not passphrase:
        raise ValueError("passphrase is required")

    if not vault_configured():
        dek = os.urandom(DEK_BYTES)
    else:
        existing = cdb.get_vault_slot(user_id)
        if existing is not None:
            # Re-setting your own passphrase re-wraps the DEK you can already unwrap. Require the
            # caller to be unlocked so we hold the real DEK (rather than minting a second one).
            dek = require_dek(user_id)
        else:
            # A brand-new user joining a configured vault needs the DEK from an existing member; until
            # the co-present/invite enrollment path exists, they must first be granted it.
            dek = _cache_get(user_id)
            if dek is None:
                raise VaultLocked("the workspace vault already exists; enrollment for a new user is not yet available")

    _write_passphrase_slot(user_id, passphrase, dek)
    _cache_put(user_id, dek)


def change_passphrase(user_id: str, old_passphrase: str, new_passphrase: str) -> None:
    if not new_passphrase:
        raise ValueError("new passphrase is required")
    dek = unlock(user_id, old_passphrase)  # verifies the old passphrase
    _write_passphrase_slot(user_id, new_passphrase, dek)
    _cache_put(user_id, dek)


def _write_passphrase_slot(user_id: str, passphrase: str, dek: bytes) -> None:
    salt = os.urandom(16)
    kek = _derive_kek(passphrase, salt)
    wrapped = _wrap(kek, dek, aad=_slot_aad(user_id))
    cdb.upsert_vault_slot(
        user_id,
        method="passphrase",
        wrapped_dek=wrapped,
        kdf_algo="scrypt",
        kdf_salt=_b64e(salt),
        kdf_n=SCRYPT_N,
        kdf_r=SCRYPT_R,
        kdf_p=SCRYPT_P,
        meets_production_min=passphrase_meets_production_min(passphrase),
    )


def unlock(user_id: str, passphrase: str) -> bytes:
    slot = cdb.get_vault_slot(user_id)
    if not slot:
        raise VaultLocked("no passphrase is set for this user")
    kek = _derive_kek(passphrase, _b64d(slot["kdf_salt"]), slot["kdf_n"], slot["kdf_r"], slot["kdf_p"])
    try:
        dek = _unwrap(kek, slot["wrapped_dek"], aad=_slot_aad(user_id))
    except Exception as exc:
        # The AEAD tag is the verifier: a wrong passphrase fails to decrypt.
        raise ValueError("incorrect passphrase") from exc
    _cache_put(user_id, dek)
    return dek


# --- Per-connection secret encrypt/decrypt (under the DEK) ---------------------------------------

def encrypt_secret(dek: bytes, plaintext: str, *, aad: bytes) -> str:
    return _wrap(dek, plaintext.encode("utf-8"), aad=aad)


def decrypt_secret(dek: bytes, payload: str, *, aad: bytes) -> str:
    try:
        return _unwrap(dek, payload, aad=aad).decode("utf-8")
    except Exception as exc:
        raise VaultDecryptError() from exc


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


def decrypt_connection_credential(user: dict, provider: str, external_id: str, credential: str | None, credential_enc: str | None) -> str:
    if credential_enc:
        dek = require_dek(user["id"])
        return decrypt_secret(dek, credential_enc, aad=_connection_aad(provider, external_id))
    # A legacy plaintext row (never encrypted) reads straight through — no DEK needed. New writes never
    # take this path.
    return credential or ""
