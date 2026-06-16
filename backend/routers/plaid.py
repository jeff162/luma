# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: GPL-3.0-or-later

"""
Plaid onboarding bridges Link into FinTrack's local account model.

The router treats a Plaid item as the durable credential boundary: one token
exchange can create many accounts, while the access token is stored separately
so later sync and privacy-mode changes are keyed to item lifecycle rather than account rows.
"""

import uuid
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from backend.db.database import get_db
from backend.db.demo_data import is_demo_data_loaded
from backend.routers.accounts import resolve_default_owner_id
from backend.services import crypto_service, plaid_service

router = APIRouter()


class PublicTokenExchange(BaseModel):
    public_token: str
    institution_name: str | None = None


@router.get("/link-token")
def get_link_token():
    try:
        token = plaid_service.create_link_token()
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
    try:
        result       = plaid_service.exchange_public_token(body.public_token)
        access_token = result["access_token"]
        item_id      = result["item_id"]
        accounts     = plaid_service.fetch_accounts(access_token)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    with get_db() as conn:
        default_owner_id = resolve_default_owner_id(conn, None)
        # Plaid onboarding is item-centric: one exchanged token can fan out to many
        # accounts, and later sync discovers credentials by item id rather than account id.
        for acc in accounts:
            existing = conn.execute(
                "SELECT id FROM account WHERE plaid_account_id = ?",
                (acc["plaid_account_id"],),
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
                        acc["plaid_account_id"],
                        item_id,
                        acc["name"],
                        acc["name"],
                        body.institution_name,
                        acc["type"],
                        acc["subtype"],
                        acc["mask"],
                        default_owner_id,
                    ),
                )

        # Keep the token in plaid_item even if account rows are edited later; sync needs a
        # stable credential lookup keyed by Plaid's item lifecycle, not the local account rows.
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS plaid_item (
                item_id           TEXT PRIMARY KEY,
                access_token      TEXT NOT NULL DEFAULT '',
                access_token_enc  TEXT
            )
            """
        )
        stored_access_token, stored_access_token_enc = crypto_service.encrypt_plaid_access_token(
            request.state.user, item_id, access_token
        )
        conn.execute(
            """
            INSERT OR REPLACE INTO plaid_item (item_id, access_token, access_token_enc)
            VALUES (?,?,?)
            """,
            (item_id, stored_access_token, stored_access_token_enc),
        )

    return {"ok": True, "accounts_added": len(accounts)}
