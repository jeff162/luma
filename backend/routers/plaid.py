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
from backend.routers.accounts import resolve_default_owner_id
from backend.services import crypto_service
from backend.services.providers import get_adapter

router = APIRouter()

PROVIDER = "plaid"


class PublicTokenExchange(BaseModel):
    public_token: str
    institution_name: str | None = None


@router.get("/link-token")
def get_link_token():
    try:
        token = get_adapter(PROVIDER).create_link_token()
        return {"link_token": token}
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
    adapter = get_adapter(PROVIDER)
    try:
        result      = adapter.exchange(body.public_token)
        credential  = result["credential"]
        external_id = result["external_id"]
        accounts    = adapter.fetch_accounts(credential)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    with get_db() as conn:
        default_owner_id = resolve_default_owner_id(conn, None)
        # A connection is item/connection-centric: one exchange can fan out to many accounts, and later
        # sync discovers the credential by connection, matching transactions to accounts by external id.
        for acc in accounts:
            existing = conn.execute(
                "SELECT id FROM account WHERE plaid_account_id = ?",
                (acc["external_account_id"],),
            ).fetchone()
            if not existing:
                conn.execute(
                    """
                    INSERT INTO account
                        (id, plaid_account_id, plaid_item_id, name, display_name, institution, type, subtype, mask, owner_id, parent_account_id, trashed_at)
                    VALUES (?,?,?,?,?,?,?,?,?,?,NULL,NULL)
                    """,
                    (
                        str(uuid.uuid4()),
                        acc["external_account_id"],
                        external_id,
                        acc["name"],
                        acc["name"],
                        body.institution_name,
                        acc["type"],
                        acc["subtype"],
                        acc["mask"],
                        default_owner_id,
                    ),
                )

        # Store the credential on the connection even if account rows are edited later; sync needs a
        # stable credential lookup keyed by the connection's provider handle, not the local account rows.
        stored_credential, stored_credential_enc = crypto_service.encrypt_connection_credential(
            request.state.user, PROVIDER, external_id, credential
        )
        existing_conn = conn.execute(
            "SELECT id FROM connection WHERE provider = ? AND external_id = ?",
            (PROVIDER, external_id),
        ).fetchone()
        if existing_conn:
            conn.execute(
                "UPDATE connection SET credential = ?, credential_enc = ?, institution = COALESCE(?, institution) WHERE id = ?",
                (stored_credential, stored_credential_enc, body.institution_name, existing_conn["id"]),
            )
        else:
            conn.execute(
                """
                INSERT INTO connection (id, provider, external_id, credential, credential_enc, institution)
                VALUES (?,?,?,?,?,?)
                """,
                (str(uuid.uuid4()), PROVIDER, external_id, stored_credential, stored_credential_enc, body.institution_name),
            )

    return {"ok": True, "accounts_added": len(accounts)}
