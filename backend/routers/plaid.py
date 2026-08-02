# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Plaid onboarding bridges Link into Luma's local account model.

The router treats a connection as the durable credential boundary: one token exchange can create many
accounts, while the per-connection credential is stored separately (vault-encrypted at rest) so later
sync is keyed to connection lifecycle rather than account rows. It reaches Plaid only through the
provider-adapter seam (`get_adapter`), so the same flow generalizes to Teller/SimpleFIN later; the
`/plaid/*` route prefix is retained for the frontend Link integration in this phase.
"""

import uuid
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from backend.db.database import get_db
from backend.db.demo_data import is_demo_data_loaded
from backend.routers.accounts import resolve_default_owner_id, upsert_connection_accounts
from backend.services import crypto_service
from backend.services.providers import get_adapter, resolve_app_config

router = APIRouter()

PROVIDER = "plaid"


class PublicTokenExchange(BaseModel):
    public_token: str
    institution_name: str | None = None


def _require_app_config(request: Request):
    """Resolve the provider's app credential (vaulted DB or `.env` bootstrap). 409 when the provider is
    unconfigured; 423 when its secret is vaulted but the vault is locked (resolve raises VaultLocked)."""
    try:
        app_config = resolve_app_config(request.state.user, PROVIDER)
    except crypto_service.VaultLocked:
        raise HTTPException(status_code=423, detail={
            "code": "vault_locked",
            "message": "Unlock the vault to use this data source.",
        })
    if not app_config:
        raise HTTPException(status_code=409, detail={
            "code": "provider_not_configured",
            "message": "Configure this data source's credentials before connecting.",
        })
    return app_config


@router.get("/link-token")
def get_link_token(request: Request):
    app_config = _require_app_config(request)
    try:
        token = get_adapter(PROVIDER).create_link_token(app_config)
        return {"link_token": token}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/exchange")
def exchange_token(body: PublicTokenExchange, request: Request):
    with get_db() as conn:
        if is_demo_data_loaded(conn):
            raise HTTPException(status_code=409, detail={
                "code": "demo_data_loaded",
                "message": "Clear the demo data before connecting a data source.",
            })
    # A connected bank stores a live access token, which must never sit unencrypted — so connecting
    # always requires a vault, unlocked, regardless of the app-login perimeter (they are orthogonal).
    user = request.state.user
    if not crypto_service.vault_configured():
        raise HTTPException(status_code=409, detail={
            "code": "vault_not_configured",
            "message": "Set a vault passphrase before connecting a data source.",
        })
    if not crypto_service.is_unlocked(user["id"]):
        raise HTTPException(status_code=423, detail={
            "code": "vault_locked",
            "message": "Unlock the vault to connect a data source.",
        })
    app_config = _require_app_config(request)
    adapter = get_adapter(PROVIDER)
    try:
        result      = adapter.exchange(app_config, body.public_token)
        credential  = result["credential"]
        external_id = result["external_id"]
        accounts    = adapter.fetch_accounts(app_config, credential)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    with get_db() as conn:
        default_owner_id = resolve_default_owner_id(conn, None)
        # Store the credential on the connection even if account rows are edited later; sync needs a
        # stable credential lookup keyed by the connection's provider handle, not the local account rows.
        # The connection is upserted first so its id is available to stamp on the account rows below.
        stored_credential, stored_credential_enc = crypto_service.encrypt_connection_credential(
            request.state.user, PROVIDER, external_id, credential
        )
        # Upsert the connection atomically on its (provider, external_id) unique key. A user can complete
        # Link more than once for the same bank (Plaid's onSuccess may fire twice; a re-link re-exchanges),
        # and those calls can race — a check-then-insert would let the loser hit the UNIQUE constraint and
        # 500. ON CONFLICT makes a duplicate exchange a clean credential-refresh instead.
        conn.execute(
            """
            INSERT INTO connection (id, provider, external_id, credential, credential_enc, institution)
            VALUES (?,?,?,?,?,?)
            ON CONFLICT(provider, external_id) DO UPDATE SET
                credential = excluded.credential,
                credential_enc = excluded.credential_enc,
                institution = COALESCE(excluded.institution, connection.institution)
            """,
            (str(uuid.uuid4()), PROVIDER, external_id, stored_credential, stored_credential_enc, body.institution_name),
        )
        connection_id = conn.execute(
            "SELECT id FROM connection WHERE provider = ? AND external_id = ?",
            (PROVIDER, external_id),
        ).fetchone()["id"]

        # A connection is item/connection-centric: one exchange can fan out to many accounts, and later
        # sync discovers the credential by connection, matching transactions to accounts by external id.
        # The shared upsert (also idempotent under the duplicate/racing exchange above) re-stamps only the
        # connection linkage, so a re-link of a previously-disconnected bank re-attaches cleanly.
        upsert_connection_accounts(
            conn, connection_id=connection_id, provider=PROVIDER,
            institution=body.institution_name, accounts=accounts, default_owner_id=default_owner_id,
        )

    # Returning the connection id lets the frontend scope the initial full-history backfill to just this
    # bank (POST /sync?connection_id=…&days=0), rather than re-pulling every other connection too.
    return {"ok": True, "accounts_added": len(accounts), "connection_id": connection_id, "provider": PROVIDER}
