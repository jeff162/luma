from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional
from db.database import get_db

router = APIRouter()


class AccountUpdate(BaseModel):
    owner_id: Optional[str] = None
    name:     Optional[str] = None


@router.get("")
def list_accounts():
    with get_db() as conn:
        rows = conn.execute(
            """SELECT a.id, a.name, a.institution, a.type, a.subtype, a.mask,
                      a.owner_id, o.name AS owner_name, o.color AS owner_color
               FROM account a
               LEFT JOIN owner o ON o.id = a.owner_id
               ORDER BY a.name"""
        ).fetchall()
    return [dict(r) for r in rows]


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
