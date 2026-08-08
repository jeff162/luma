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
from backend.routers.providers import establish_connection, require_app_config
from backend.services.providers import get_adapter

router = APIRouter()

PROVIDER = "plaid"


class PublicTokenExchange(BaseModel):
    public_token: str
    institution_name: str | None = None


@router.get("/link-token")
def get_link_token(request: Request):
    app_config = require_app_config(request, PROVIDER)
    try:
        token = get_adapter(PROVIDER).create_link_token(app_config)
        return {"link_token": token}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/exchange")
def exchange_token(body: PublicTokenExchange, request: Request):
    # Link's own callback shape, mapped onto the neutral connect payload. Everything past this line is the
    # shared flow every provider runs — see `providers.establish_connection`.
    return establish_connection(request, PROVIDER, {
        "public_token": body.public_token,
        "institution_name": body.institution_name,
    })
