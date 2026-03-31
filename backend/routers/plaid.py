import uuid
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from db.database import get_db
from services import plaid_service, crypto_service
from routers.accounts import resolve_default_owner_id

router = APIRouter()


class PublicTokenExchange(BaseModel):
    public_token: str
    institution_name: str | None = None


@router.get("/link-token")
def get_link_token():
    """Get a Plaid Link token to initialise the Link UI."""
    try:
        token = plaid_service.create_link_token()
        return {"link_token": token}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/exchange")
def exchange_token(body: PublicTokenExchange, request: Request):
    """
    Exchange the public token from Plaid Link for a stored access token,
    then immediately fetch and persist the accounts.
    """
    try:
        result       = plaid_service.exchange_public_token(body.public_token)
        access_token = result["access_token"]
        item_id      = result["item_id"]
        accounts     = plaid_service.fetch_accounts(access_token)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    with get_db() as conn:
        default_owner_id = resolve_default_owner_id(conn, None)
        # Store access token on the item (we reuse the item table via account rows)
        for acc in accounts:
            existing = conn.execute(
                "SELECT id FROM account WHERE plaid_account_id = ?",
                (acc["plaid_account_id"],),
            ).fetchone()
            if not existing:
                conn.execute(
                    """
                    INSERT INTO account
                        (id, plaid_account_id, plaid_item_id, name, institution, type, subtype, mask, owner_id)
                    VALUES (?,?,?,?,?,?,?,?,?)
                    """,
                    (
                        str(uuid.uuid4()),
                        acc["plaid_account_id"],
                        item_id,
                        acc["name"],
                        body.institution_name,
                        acc["type"],
                        acc["subtype"],
                        acc["mask"],
                        default_owner_id,
                    ),
                )

        # Persist access token so sync can find it later
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
