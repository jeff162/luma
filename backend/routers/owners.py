"""
owners.py — Owner CRUD endpoints

Owners represent people (or the concept of "Shared") in a household.
Accounts are assigned to an owner; transactions inherit that owner from
their account. Category groups are tagged with an owner to indicate whose
spending domain they belong to.

DESIGN:
- Owners are simple name + color records. No auth — this is a local app.
- Deleting an owner NULLs out owner_id on related accounts, categories,
  and transactions (via ON DELETE SET NULL foreign keys in the schema).
- The /api/owners/summary endpoint returns per-owner spending totals for
  the Dashboard split-by-owner view, respecting the same date/account
  filters the rest of the app uses.
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional
import uuid
from db.database import get_db

router = APIRouter()


class OwnerCreate(BaseModel):
    name: str
    color: str = "#6366f1"


class OwnerUpdate(BaseModel):
    name: Optional[str] = None
    color: Optional[str] = None


@router.get("")
def list_owners():
    with get_db() as conn:
        rows = conn.execute(
            "SELECT id, name, color FROM owner ORDER BY name"
        ).fetchall()
    return [dict(r) for r in rows]


@router.post("")
def create_owner(body: OwnerCreate):
    new_id = str(uuid.uuid4())
    with get_db() as conn:
        conn.execute(
            "INSERT INTO owner (id, name, color) VALUES (?, ?, ?)",
            (new_id, body.name.strip(), body.color),
        )
    return {"id": new_id, "name": body.name.strip(), "color": body.color}


@router.patch("/{owner_id}")
def update_owner(owner_id: str, body: OwnerUpdate):
    with get_db() as conn:
        row = conn.execute("SELECT id FROM owner WHERE id = ?", (owner_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Owner not found")
        if body.name is not None:
            conn.execute("UPDATE owner SET name = ? WHERE id = ?", (body.name.strip(), owner_id))
        if body.color is not None:
            conn.execute("UPDATE owner SET color = ? WHERE id = ?", (body.color, owner_id))
    return {"ok": True}


@router.delete("/{owner_id}")
def delete_owner(owner_id: str):
    with get_db() as conn:
        row = conn.execute("SELECT id FROM owner WHERE id = ?", (owner_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Owner not found")
        conn.execute("DELETE FROM owner WHERE id = ?", (owner_id,))
    return {"ok": True}


@router.get("/summary")
def owner_summary(
    date_start:  Optional[str] = None,
    date_end:    Optional[str] = None,
    month:       Optional[str] = None,
    account_ids: Optional[str] = None,
):
    """Per-owner spending totals for the Dashboard split view."""
    clauses = ["t.amount > 0", "t.is_pending = 0"]
    params  = []

    if date_start and date_end:
        clauses.append("t.date BETWEEN ? AND ?")
        params.extend([date_start, date_end])
    elif date_start:
        clauses.append("t.date >= ?")
        params.append(date_start)
    elif date_end:
        clauses.append("t.date <= ?")
        params.append(date_end)
    elif month:
        clauses.append("t.date LIKE ?")
        params.append(f"{month}%")

    if account_ids:
        ids = [i.strip() for i in account_ids.split(",") if i.strip()]
        placeholders = ",".join("?" * len(ids))
        clauses.append(f"t.account_id IN ({placeholders})")
        params.extend(ids)

    where = "WHERE " + " AND ".join(clauses)

    with get_db() as conn:
        rows = conn.execute(
            f"""
            SELECT
                COALESCE(o.id,    'unassigned')   AS owner_id,
                COALESCE(o.name,  'Unassigned')   AS owner_name,
                COALESCE(o.color, '#9E9E9E')       AS owner_color,
                SUM(t.amount)                      AS total,
                COUNT(*)                           AS count
            FROM   txn t
            LEFT JOIN owner o ON o.id = t.owner_id
            {where}
            GROUP BY owner_id
            ORDER BY total DESC
            """,
            params,
        ).fetchall()

    return [dict(r) for r in rows]
