import uuid
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional
from db.database import get_db

router = APIRouter()


class AccountCreate(BaseModel):
    name:     str
    type:     Optional[str] = None
    owner_id: Optional[str] = None


class AccountUpdate(BaseModel):
    owner_id: Optional[str] = None
    name:     Optional[str] = None
    type:     Optional[str] = None


@router.get("")
def list_accounts():
    with get_db() as conn:
        rows = conn.execute(
            """SELECT a.id, a.name, a.institution, a.type, a.subtype, a.mask,
                      a.owner_id, a.plaid_item_id, o.name AS owner_name, o.color AS owner_color
               FROM account a
               LEFT JOIN owner o ON o.id = a.owner_id
               ORDER BY a.name"""
        ).fetchall()
    return [dict(r) for r in rows]


@router.post("")
def create_account(body: AccountCreate):
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Account name is required")

    account_type = (body.type or "other").strip() or "other"
    owner_id = body.owner_id.strip() if body.owner_id else None

    with get_db() as conn:
        if owner_id:
            owner = conn.execute("SELECT id FROM owner WHERE id = ?", (owner_id,)).fetchone()
            if not owner:
                raise HTTPException(status_code=404, detail="Owner not found")

        account_id = str(uuid.uuid4())
        conn.execute(
            """
            INSERT INTO account
                (id, plaid_account_id, plaid_item_id, name, institution, type, subtype, mask, owner_id)
            VALUES (?, NULL, 'manual', ?, NULL, ?, NULL, NULL, ?)
            """,
            (account_id, name, account_type, owner_id),
        )
        row = conn.execute(
            """SELECT a.id, a.name, a.institution, a.type, a.subtype, a.mask,
                      a.owner_id, a.plaid_item_id, o.name AS owner_name, o.color AS owner_color
               FROM account a
               LEFT JOIN owner o ON o.id = a.owner_id
               WHERE a.id = ?""",
            (account_id,),
        ).fetchone()
    return dict(row)


@router.patch("/{account_id}")
def update_account(account_id: str, body: AccountUpdate):
    with get_db() as conn:
        acc = conn.execute(
            "SELECT id FROM account WHERE id = ?", (account_id,)
        ).fetchone()
        if not acc:
            raise HTTPException(status_code=404, detail="Account not found")

        if body.name is not None and body.name.strip():
            conn.execute(
                "UPDATE account SET name = ? WHERE id = ?",
                (body.name.strip(), account_id),
            )

        if body.type is not None and body.type.strip():
            conn.execute(
                "UPDATE account SET type = ? WHERE id = ?",
                (body.type.strip(), account_id),
            )

        if body.owner_id is not None:
            owner_val = body.owner_id if body.owner_id != "" else None
            conn.execute(
                "UPDATE account SET owner_id = ? WHERE id = ?",
                (owner_val, account_id),
            )
            # Propagate owner to all transactions on this account
            conn.execute(
                "UPDATE txn SET owner_id = ? WHERE account_id = ?",
                (owner_val, account_id),
            )
    return {"ok": True}


@router.delete("/{account_id}")
def delete_account(account_id: str):
    with get_db() as conn:
        acc = conn.execute(
            "SELECT id FROM account WHERE id = ?", (account_id,)
        ).fetchone()
        if not acc:
            raise HTTPException(status_code=404, detail="Account not found")
        conn.execute("DELETE FROM txn WHERE account_id = ?", (account_id,))
        conn.execute("DELETE FROM account WHERE id = ?", (account_id,))
    return {"ok": True}
