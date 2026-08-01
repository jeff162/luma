# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
App-level provider credentials: the aggregator's own app secret (Plaid's client_id + secret + env),
one per provider, moved out of `.env` into the vaulted DB (security-and-deployment-model phase 6b).

Only the secret is sensitive — it is vault-encrypted under the workspace DEK; client_id/env are
semi-public and stored plaintext. A saved `provider_config` row is authoritative; until one exists the
resolver falls back to the `.env` bootstrap, so a fresh install with `.env` creds still connects, and
re-entering the credential once via the Configure card is all the migration there is (decided
2026-08-01, no `.env` -> DB copy).
"""

from __future__ import annotations

import os

from backend.db.database import get_db
from backend.services import crypto_service

VALID_ENVS = {"sandbox", "development", "production"}

# Per-provider `.env` bootstrap fallback — consulted only until the app credential is saved into the DB.
_ENV_FALLBACK = {
    "plaid": {"client_id": "PLAID_CLIENT_ID", "secret": "PLAID_SECRET", "env": "PLAID_ENV"},
}


def _row(conn, provider: str):
    return conn.execute(
        "SELECT provider, client_id, secret, secret_enc, env FROM provider_config WHERE provider = ?",
        (provider,),
    ).fetchone()


def _env_fallback(provider: str) -> dict | None:
    keys = _ENV_FALLBACK.get(provider)
    if not keys:
        return None
    return {
        "client_id": (os.getenv(keys["client_id"]) or "").strip(),
        "secret":    (os.getenv(keys["secret"]) or "").strip(),
        "env":       (os.getenv(keys["env"]) or "sandbox").strip() or "sandbox",
    }


def get_provider_config_status(provider: str) -> dict:
    """Non-secret view for the Configure UI: whether the app credential is set and from where (vaulted DB
    vs. `.env` bootstrap), the client_id and env, and whether a secret is on file — never the secret itself."""
    with get_db() as conn:
        row = _row(conn, provider)
    if row and (row["secret_enc"] or row["secret"] or row["client_id"]):
        return {
            "provider":   provider,
            "configured": True,
            "source":     "vault",
            "client_id":  row["client_id"],
            "env":        row["env"],
            "has_secret": bool(row["secret_enc"] or row["secret"]),
        }
    env = _env_fallback(provider)
    if env and (env["client_id"] or env["secret"]):
        return {
            "provider":   provider,
            "configured": True,
            "source":     "env",
            "client_id":  env["client_id"],
            "env":        env["env"],
            "has_secret": bool(env["secret"]),
        }
    return {"provider": provider, "configured": False, "source": None,
            "client_id": "", "env": "sandbox", "has_secret": False}


def list_connections(provider: str) -> list[dict]:
    """Non-secret view of a provider's linked connections (for the Connections cards + disconnect). Returns
    the stable external handle and institution only — never the credential."""
    with get_db() as conn:
        rows = conn.execute(
            "SELECT external_id, institution FROM connection WHERE provider = ? ORDER BY rowid",
            (provider,),
        ).fetchall()
    return [{"external_id": r["external_id"], "institution": r["institution"]} for r in rows]


def resolve_app_config(user: dict, provider: str) -> dict | None:
    """The decrypted app credential the adapter needs to call the provider: {client_id, secret, env}.
    A saved `provider_config` row is authoritative — its secret decrypts under the vault (raises
    VaultLocked if locked) — otherwise fall back to the `.env` bootstrap. None when neither has creds."""
    with get_db() as conn:
        row = _row(conn, provider)
    if row and (row["secret_enc"] or row["secret"] or row["client_id"]):
        secret = crypto_service.decrypt_app_credential(user, provider, row["secret"], row["secret_enc"])
        return {"client_id": row["client_id"], "secret": secret, "env": row["env"]}
    env = _env_fallback(provider)
    if env and (env["client_id"] or env["secret"]):
        return env
    return None


def set_provider_config(user: dict, provider: str, *, client_id=None, secret=None, env=None) -> None:
    """Upsert the app credential. client_id/env store plaintext; a provided secret is vault-encrypted
    (requires the vault unlocked). `secret=None` leaves the stored secret unchanged; `secret=''` clears it.
    A field left None keeps its current value (or the default on a fresh row)."""
    normalized_env = None
    if env is not None:
        normalized_env = (env or "sandbox").strip() or "sandbox"
        if normalized_env not in VALID_ENVS:
            raise ValueError("env must be sandbox, development, or production")

    with get_db() as conn:
        row = _row(conn, provider)
        new_client_id = client_id.strip() if client_id is not None else (row["client_id"] if row else "")
        new_env = normalized_env if normalized_env is not None else (row["env"] if row else "sandbox")
        if secret is None:
            new_secret, new_secret_enc = (row["secret"], row["secret_enc"]) if row else ("", None)
        elif secret == "":
            new_secret, new_secret_enc = "", None
        else:
            new_secret, new_secret_enc = crypto_service.encrypt_app_credential(user, provider, secret)
        conn.execute(
            """
            INSERT INTO provider_config (provider, client_id, secret, secret_enc, env, updated_at)
            VALUES (?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(provider) DO UPDATE SET
                client_id  = excluded.client_id,
                secret     = excluded.secret,
                secret_enc = excluded.secret_enc,
                env        = excluded.env,
                updated_at = excluded.updated_at
            """,
            (provider, new_client_id, new_secret, new_secret_enc, new_env),
        )
