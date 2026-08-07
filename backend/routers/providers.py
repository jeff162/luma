# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Per-provider app-credential configuration — the Configure card's backend (security-and-deployment-model
phase 6b). Admin-gated to configure; the app credential lives in the vaulted DB (`provider_config`), the
secret encrypted under the workspace DEK. Reading status never returns the secret, only whether one is on
file and from where (vaulted DB vs. `.env` bootstrap). The secret is readable in exactly one place, and
only on request: `GET /{provider}/secret`, the Configure dialog's reveal (see its docstring for why that
is a narrow exception rather than a hole in the write-only rule). This is where provider configuration
moves to, out of the Settings environment form.
"""

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from backend import transport
from backend.db.control_database import auth_required
from backend.db.database import get_db
from backend.routers.accounts import resolve_default_owner_id, upsert_connection_accounts
from backend.routers.auth import _require_admin_or_local
from backend.services import crypto_service
from backend.services.providers import (
    UnknownProviderError,
    get_adapter,
    get_provider_config_status,
    resolve_app_config,
    set_provider_config,
    supported_providers,
)
from backend.services.providers.config import list_connections

router = APIRouter()


class ProviderConfigRequest(BaseModel):
    client_id: str | None = None
    secret: str | None = None
    env: str | None = None


class DisconnectRequest(BaseModel):
    external_id: str


class RefreshAccountsRequest(BaseModel):
    external_id: str


def _validate_provider(provider: str):
    try:
        get_adapter(provider)
    except UnknownProviderError:
        raise HTTPException(status_code=404, detail=f"Unknown provider {provider!r}")


@router.get("")
def list_providers(request: Request):
    _require_admin_or_local(request)
    return {"providers": [
        {**get_provider_config_status(p), "connections": list_connections(p)}
        for p in supported_providers()
    ]}


@router.get("/{provider}/config")
def get_config(provider: str, request: Request):
    _require_admin_or_local(request)
    _validate_provider(provider)
    return get_provider_config_status(provider)


@router.post("/{provider}/config")
def save_config(provider: str, body: ProviderConfigRequest, request: Request):
    _require_admin_or_local(request)
    _validate_provider(provider)
    # Switching to Production holds real, live bank tokens, so every vault slot must meet the Production
    # passphrase minimum first — the DEK can never sit behind a weak wrap. Same all-slots gate the legacy
    # environment endpoint enforced; Sandbox stays lax.
    if (body.env or "").strip() == "production" and not crypto_service.ready_for_production():
        raise HTTPException(status_code=400, detail=(
            "Set a strong vault passphrase before switching to Production. Every vault passphrase "
            f"must be at least {crypto_service.VAULT_PRODUCTION_MIN_LEN} characters with at least "
            f"{crypto_service.VAULT_PRODUCTION_MIN_DISTINCT} distinct characters, so live bank tokens "
            "are never protected by a weak secret."
        ))
    try:
        set_provider_config(
            request.state.user, provider,
            client_id=body.client_id, secret=body.secret, env=body.env,
        )
    except crypto_service.VaultLocked:
        # The secret is vault-encrypted, so storing one needs the vault configured and unlocked.
        raise HTTPException(status_code=423, detail={
            "code": "vault_locked",
            "message": "Set and unlock a vault passphrase before saving this data source's secret.",
        })
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    result = get_provider_config_status(provider)
    # Configuring a provider puts a live bank secret in play; warn (don't force) when this instance is
    # reachable over a cleartext network link — the connect gate is where HTTPS is actually enforced.
    warning = transport.cleartext_warning(request, perimeter_on=auth_required(), provider_intended=True)
    if warning:
        result["transport_warning"] = warning
    return result


@router.get("/{provider}/secret")
def get_secret(provider: str, request: Request):
    """Return the app secret in the clear, for the Configure dialog's reveal.

    A diagnostic, not part of the normal flow: the one thing it answers is "does the secret stored here
    match the one on the provider's dashboard", which nothing else can settle — the value is write-only
    everywhere else (`get_provider_config_status` returns `has_secret` and never the secret, and the
    Configure field keeps its blank-means-unchanged semantics).

    It deliberately does **not** re-prompt for the vault passphrase when the vault is already unlocked.
    An unlocked vault is the app's authorization boundary and sync/disconnect/refresh all ride it; a
    second challenge only here would be inconsistent without raising the bar. The reveal is a separate
    call rather than a field on the status payload precisely so a plaintext secret can only ever appear
    in a response the user explicitly asked for.

    Reuses `resolve_app_config` — the same decryption path a sync takes — so there is one way to turn a
    stored credential back into plaintext. A `.env`-sourced secret needs no unlock: nothing is encrypted,
    and it is already readable by anyone who can read the file.
    """
    _require_admin_or_local(request)
    _validate_provider(provider)
    try:
        app_config = resolve_app_config(request.state.user, provider)
    except crypto_service.VaultLocked:
        raise HTTPException(status_code=423, detail={
            "code": "vault_locked",
            "message": "Unlock the vault to view this data source's secret.",
        })
    if not app_config or not app_config.get("secret"):
        raise HTTPException(status_code=409, detail={
            "code": "no_secret",
            "message": "This data source has no secret on file.",
        })
    return {"secret": app_config["secret"], "source": get_provider_config_status(provider)["source"]}


@router.post("/{provider}/disconnect")
def disconnect(provider: str, body: DisconnectRequest, request: Request):
    # Revoke a linked connection *at the provider* (so any leaked copy of the token dies too — the
    # mitigation the threat model relies on), then drop the local connection row. Needs the vault unlocked
    # to decrypt the credential; not admin-gated (symmetric with connect/sync). Accounts + their
    # transactions are preserved — they simply stop being backed by a live connection.
    _validate_provider(provider)
    user = request.state.user
    with get_db() as conn:
        row = conn.execute(
            "SELECT external_id, credential, credential_enc FROM connection WHERE provider = ? AND external_id = ?",
            (provider, body.external_id),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Connection not found")
    try:
        app_config = resolve_app_config(user, provider)
        credential = crypto_service.decrypt_connection_credential(
            user, provider, row["external_id"], row["credential"], row["credential_enc"]
        )
    except crypto_service.VaultLocked:
        raise HTTPException(status_code=423, detail={
            "code": "vault_locked",
            "message": "Unlock the vault to disconnect this data source.",
        })
    if not app_config:
        raise HTTPException(status_code=409, detail={
            "code": "provider_not_configured",
            "message": "This data source has no configured credentials.",
        })
    try:
        get_adapter(provider).remove(app_config, credential)
    except Exception as exc:
        # Keep the local connection if provider-side revocation failed, so the user can retry rather than
        # believe the token is dead when it may still be live.
        raise HTTPException(status_code=502, detail=f"Could not revoke the connection at the provider: {exc}")
    with get_db() as conn:
        conn.execute("DELETE FROM connection WHERE provider = ? AND external_id = ?", (provider, body.external_id))
    return {"ok": True}


@router.post("/{provider}/refresh-accounts")
def refresh_accounts(provider: str, body: RefreshAccountsRequest, request: Request):
    # Rebuild the local account rows for an existing connection from its still-valid credential — no
    # re-linking, no token churn. The recovery path when a backup restore rolls back the ledger (account
    # rows included) but leaves the live connection intact (connections are credential data the restore
    # never carries — see import_export/backup.py), leaving a connection whose accounts are gone and whose
    # sync therefore skips every fetched transaction for lack of a matching account. Needs the vault
    # unlocked to decrypt the credential; not admin-gated (symmetric with connect/sync/disconnect). Never
    # revokes anything. The caller then backfills history via POST /sync?connection_id=…&days=0.
    _validate_provider(provider)
    user = request.state.user
    with get_db() as conn:
        row = conn.execute(
            "SELECT id, external_id, credential, credential_enc, institution FROM connection WHERE provider = ? AND external_id = ?",
            (provider, body.external_id),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Connection not found")
    try:
        app_config = resolve_app_config(user, provider)
        credential = crypto_service.decrypt_connection_credential(
            user, provider, row["external_id"], row["credential"], row["credential_enc"]
        )
    except crypto_service.VaultLocked:
        raise HTTPException(status_code=423, detail={
            "code": "vault_locked",
            "message": "Unlock the vault to refresh this data source.",
        })
    if not app_config:
        raise HTTPException(status_code=409, detail={
            "code": "provider_not_configured",
            "message": "This data source has no configured credentials.",
        })
    try:
        accounts = get_adapter(provider).fetch_accounts(app_config, credential)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Could not fetch accounts from the provider: {exc}")
    with get_db() as conn:
        default_owner_id = resolve_default_owner_id(conn, None)
        upsert_connection_accounts(
            conn, connection_id=row["id"], provider=provider,
            institution=row["institution"], accounts=accounts, default_owner_id=default_owner_id,
        )
    return {"ok": True, "accounts_added": len(accounts), "connection_id": row["id"]}
