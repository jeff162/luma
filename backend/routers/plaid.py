# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
The Link-specific edge of connecting a bank — the only part of the flow Plaid does differently.

Link needs two things no other provider shape does: a short-lived link token minted server-side before
the widget opens, and a callback that hands back a public token rather than a credential the user typed.
Those are what this router is. Everything after the callback — credential custody, the connection upsert,
account recording — is provider-agnostic and lives in `providers.establish_connection`, which the token
based providers reach through `POST /api/providers/{provider}/connect`. The two routes converge on the
first line of the handler for that reason: a second copy of the tail would be free to drift on exactly
the questions (what gets encrypted, what adopts an existing account) that must not vary by provider.
"""

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from backend.db.database import get_db
from backend.routers.accounts import upsert_connection_accounts, resolve_default_owner_id
from backend.routers.providers import establish_connection, require_app_config
from backend.services import crypto_service
from backend.services.connection_mapping import unmapped_count
from backend.services.providers import get_adapter

router = APIRouter()

PROVIDER = "plaid"


class PublicTokenExchange(BaseModel):
    public_token: str
    institution_name: str | None = None


class RepairRequest(BaseModel):
    connection_id: str


def _connection(connection_id: str) -> dict:
    with get_db() as conn:
        row = conn.execute(
            "SELECT id, provider, external_id, institution, credential, credential_enc "
            "FROM connection WHERE id = ? AND provider = ?",
            (connection_id, PROVIDER),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Connection not found")
    return dict(row)


def _credential(request: Request, connection: dict) -> str:
    try:
        return crypto_service.decrypt_connection_credential(
            request.state.user, PROVIDER, connection["external_id"],
            connection["credential"], connection["credential_enc"],
        )
    except crypto_service.VaultLocked:
        raise HTTPException(status_code=423, detail={
            "code": "vault_locked",
            "message": "Unlock the vault to reconnect this data source.",
        })
    except (crypto_service.MissingCredential, crypto_service.VaultDecryptError):
        # The stored credential cannot be produced, so there is no Item to re-authorize — update mode is
        # not available and a fresh connect is the only way back. Said plainly rather than surfaced as a
        # Link failure the user would read as the bank's fault.
        # Both cases mean the same thing to the user and lead to the same place: there is no Item to
        # re-authorize, so update mode is unavailable and a fresh connect is the only way back.
        raise HTTPException(status_code=409, detail={
            "code": "credential_unreadable",
            "message": "This connection has no usable credential, so it cannot be reconnected in place. "
                       "Connect the data source again, then disconnect this one.",
        })


@router.get("/link-token")
def get_link_token(request: Request, connection_id: str | None = None):
    """Mint the token Link opens with — in **update mode** when `connection_id` names a connection.

    The distinction matters more than it looks. Without update mode, "reconnect this bank" opens a plain
    Link session, which creates a *new* Item with a new `item_id` and new per-account ids: the credential
    lands on a second connection row, the original is stranded with its coverage and cursor, and its
    `reauth_required` badge can never clear because nothing will ever sync it again. Update mode
    re-authorizes the Item Luma already holds, so the repair lands on the row that needed it.
    """
    app_config = require_app_config(request, PROVIDER)
    access_token = _credential(request, _connection(connection_id)) if connection_id else None
    try:
        token = get_adapter(PROVIDER).create_link_token(app_config, access_token=access_token)
        return {"link_token": token, "mode": "update" if access_token else "create"}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/repair")
def repair_connection(body: RepairRequest, request: Request):
    """Finish an update-mode Link session.

    **No token is exchanged.** Update mode does not issue a new credential — Link returns a public token
    that Plaid's own guidance says not to exchange — so the connection keeps the `access_token` it always
    had, and this endpoint's job is only to confirm the Item is live again and record it.

    Confirmation is a real fetch, not the fact that Link reported success: `reauth_required` is retired by
    **proof** everywhere else in the app (a sync that returned data), and clearing it on a client callback
    would put the badge back the moment the next sync disagreed. Fetching the accounts is the cheapest
    call that can only succeed on a working Item, and it doubles as the refresh that picks up whatever the
    user changed about which accounts are shared — which is the other half of what a repair is for.
    """
    connection = _connection(body.connection_id)
    app_config = require_app_config(request, PROVIDER)
    credential = _credential(request, connection)
    try:
        accounts = get_adapter(PROVIDER).fetch_accounts(app_config, credential)
    except Exception as e:
        raise HTTPException(status_code=502, detail={
            "code": "provider_error",
            "message": str(e) or "The connection could not be verified with Plaid.",
        })

    with get_db() as conn:
        upsert_connection_accounts(
            conn, connection_id=connection["id"], provider=PROVIDER,
            institution=connection["institution"], accounts=accounts,
            default_owner_id=resolve_default_owner_id(conn, None),
        )
        # Only now, and together: the Item answered, so the flag and the failure streak that accompanied
        # it both describe a state that no longer exists.
        conn.execute(
            "UPDATE connection SET reauth_required = 0, consecutive_sync_failures = 0, "
            "last_sync_error = NULL, last_sync_error_at = NULL WHERE id = ?",
            (connection["id"],),
        )
        pending_mapping = unmapped_count(conn, connection["id"])
    return {
        "ok": True, "connection_id": connection["id"], "accounts": len(accounts),
        "unmapped": pending_mapping,
    }


@router.post("/exchange")
def exchange_token(body: PublicTokenExchange, request: Request):
    # Link's own callback shape, mapped onto the neutral connect payload. Everything past this line is the
    # shared flow every provider runs — see `providers.establish_connection`.
    return establish_connection(request, PROVIDER, {
        "public_token": body.public_token,
        "institution_name": body.institution_name,
    })
