# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: GPL-3.0-or-later

import base64
import hashlib
import json
import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from db.control_database import get_user_secret_material, update_user_secret_material


def _b64e(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def _b64d(data: str) -> bytes:
    return base64.b64decode(data.encode("ascii"))


def _master_key() -> bytes:
    configured = os.getenv("APP_MASTER_KEY", "").strip()
    if configured:
        try:
            key = _b64d(configured)
        except Exception as exc:
            raise RuntimeError("APP_MASTER_KEY must be base64-encoded") from exc
    else:
        fallback = os.getenv("SESSION_SECRET", "dev-session-secret-change-me").encode("utf-8")
        key = hashlib.sha256(fallback).digest()
    if len(key) != 32:
        raise RuntimeError("Master key must decode to 32 bytes")
    return key


def _aad(*parts) -> bytes:
    return "|".join("" if part is None else str(part) for part in parts).encode("utf-8")


def _encrypt_bytes(key: bytes, plaintext: bytes, *, aad: bytes) -> str:
    nonce = os.urandom(12)
    ciphertext = AESGCM(key).encrypt(nonce, plaintext, aad)
    return json.dumps({"v": 1, "n": _b64e(nonce), "c": _b64e(ciphertext)})


def _decrypt_bytes(key: bytes, payload: str, *, aad: bytes) -> bytes:
    data = json.loads(payload)
    return AESGCM(key).decrypt(_b64d(data["n"]), _b64d(data["c"]), aad)


def privacy_mode_enabled(user: dict | None) -> bool:
    return bool(user and user.get("privacy_mode") and user.get("privacy_mode") != "off")


def _ensure_server_managed_user_key(user: dict) -> bytes:
    material = get_user_secret_material(user["id"])
    wrapped = material.get("wrapped_user_key")
    if wrapped:
        return _decrypt_bytes(_master_key(), wrapped, aad=_aad("user-key", user["id"]))

    dek = os.urandom(32)
    wrapped = _encrypt_bytes(_master_key(), dek, aad=_aad("user-key", user["id"]))
    update_user_secret_material(
        user["id"],
        key_mode="server_managed",
        wrapped_user_key=wrapped,
    )
    return dek


def encrypt_plaid_access_token(user: dict, item_id: str, access_token: str) -> tuple[str, str | None]:
    if not privacy_mode_enabled(user):
        return access_token, None
    dek = _ensure_server_managed_user_key(user)
    payload = _encrypt_bytes(dek, access_token.encode("utf-8"), aad=_aad("plaid_item", item_id, "access_token"))
    return "", payload


def decrypt_plaid_access_token(user: dict, item_id: str, access_token: str | None, access_token_enc: str | None) -> str:
    if access_token_enc:
        dek = _ensure_server_managed_user_key(user)
        return _decrypt_bytes(dek, access_token_enc, aad=_aad("plaid_item", item_id, "access_token")).decode("utf-8")
    return access_token or ""


def reencrypt_plaid_items(conn, user: dict, enable_privacy: bool):
    rows = conn.execute("SELECT item_id, access_token, access_token_enc FROM plaid_item").fetchall()
    if enable_privacy:
        for row in rows:
            if row["access_token_enc"]:
                continue
            plaintext = row["access_token"] or ""
            if not plaintext:
                continue
            access_token, access_token_enc = encrypt_plaid_access_token(user, row["item_id"], plaintext)
            conn.execute(
                "UPDATE plaid_item SET access_token = ?, access_token_enc = ? WHERE item_id = ?",
                (access_token, access_token_enc, row["item_id"]),
            )
    else:
        for row in rows:
            if not row["access_token_enc"]:
                continue
            plaintext = decrypt_plaid_access_token(user, row["item_id"], row["access_token"], row["access_token_enc"])
            conn.execute(
                "UPDATE plaid_item SET access_token = ?, access_token_enc = NULL WHERE item_id = ?",
                (plaintext, row["item_id"]),
            )
