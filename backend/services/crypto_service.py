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

# Production vault-passphrase floor (real, live bank tokens). Sandbox accepts any passphrase; this is the
# *vault* minimum, separate from the app-login password policy. Length is the main lever — the passphrase
# is meant to live in a password manager (a passkey/biometric is the everyday unlock, phase 4), so a long
# floor costs no typing. A small distinct-character requirement rejects degenerate inputs (a single char
# repeated, trivial alternations) that pass a length check but have almost no entropy. Both are enforced
# only at the Production gate; the frontend also shows an advisory strength meter that blocks nothing.
VAULT_PRODUCTION_MIN_LEN = 20
VAULT_PRODUCTION_MIN_DISTINCT = 6


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
    p = passphrase or ""
    return len(p) >= VAULT_PRODUCTION_MIN_LEN and len(set(p)) >= VAULT_PRODUCTION_MIN_DISTINCT


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


def unwrap_dek_from_slot(slot: dict, passphrase: str, *, user_id: str) -> bytes:
    """The DEK a passphrase unwraps from an **arbitrary** slot — this install's, or one carried in a
    credentials backup taken on another machine.

    `user_id` is the id the slot was wrapped *for*, not necessarily the caller: `_slot_aad` binds the
    wrap to it, so a foreign slot only opens when its own id comes along with it. That is why the
    credentials backup carries the exporting user's id beside the wrapped DEK.

    Deliberately does **not** populate the unlock cache. The DEK this returns belongs to whatever
    workspace produced the slot; caching it under the local user would quietly install a foreign key as
    this workspace's own.
    """
    kek = _derive_kek(passphrase, _b64d(slot["kdf_salt"]), slot["kdf_n"], slot["kdf_r"], slot["kdf_p"])
    try:
        return _unwrap(kek, slot["wrapped_dek"], aad=_slot_aad(user_id))
    except Exception as exc:
        # The AEAD tag is the verifier: a wrong passphrase fails to decrypt.
        raise ValueError("incorrect passphrase") from exc


def unlock(user_id: str, passphrase: str) -> bytes:
    slot = cdb.get_vault_slot(user_id)
    if not slot:
        raise VaultLocked("no passphrase is set for this user")
    dek = unwrap_dek_from_slot(slot, passphrase, user_id=user_id)
    _cache_put(user_id, dek)
    return dek


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
    if not slot:
        return None
    return {
        "user_id":              user_id,   # the slot's AAD — see `unwrap_dek_from_slot`
        "method":               slot["method"],
        "wrapped_dek":          slot["wrapped_dek"],
        "kdf_algo":             slot["kdf_algo"],
        "kdf_salt":             slot["kdf_salt"],
        "kdf_n":                slot["kdf_n"],
        "kdf_r":                slot["kdf_r"],
        "kdf_p":                slot["kdf_p"],
        "meets_production_min": bool(slot["meets_production_min"]),
    }


def vault_slot_is_local(exported: dict | None, user_id: str) -> bool:
    """Whether an exported slot is this workspace's own — same user and the identical wrap.

    When it is, a backup's ciphertext is already valid against the live DEK and can be restored
    verbatim: no passphrase, no unlock, no re-encryption. That is the ordinary "restore my own backup
    onto the machine that made it" case, and it should not demand a passphrase to do nothing.
    """
    if not exported:
        return False
    local = cdb.get_vault_slot(user_id)
    return bool(
        local
        and exported.get("user_id") == user_id
        and exported.get("wrapped_dek") == local["wrapped_dek"]
    )


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


def decrypt_connection_credential_with_dek(dek: bytes, provider: str, external_id: str,
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
            require_dek(user["id"]), provider, external_id, credential, credential_enc,
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


def decrypt_app_credential_with_dek(dek: bytes, provider: str, secret: str | None, secret_enc: str | None) -> str:
    """The app-credential twin of `decrypt_connection_credential_with_dek` — see there."""
    if secret_enc:
        return decrypt_secret(dek, secret_enc, aad=_app_credential_aad(provider))
    return secret or ""


def decrypt_app_credential(user: dict, provider: str, secret: str | None, secret_enc: str | None) -> str:
    if secret_enc:
        return decrypt_app_credential_with_dek(require_dek(user["id"]), provider, secret, secret_enc)
    return secret or ""
