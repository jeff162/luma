# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: GPL-3.0-or-later

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
from db.database import SHARED_OWNER_NAME, ensure_shared_owner, get_db, get_shared_owner_id

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
        ensure_shared_owner(conn)
        rows = conn.execute(
            """
            SELECT id, name, color,
                   CASE WHEN LOWER(name) = LOWER(?) THEN 1 ELSE 0 END AS is_shared
            FROM owner
            ORDER BY CASE WHEN LOWER(name) = LOWER(?) THEN 0 ELSE 1 END, name
            """,
            (SHARED_OWNER_NAME, SHARED_OWNER_NAME),
        ).fetchall()
    return [dict(r) for r in rows]


@router.post("")
def create_owner(body: OwnerCreate):
    if body.name.strip().lower() == SHARED_OWNER_NAME.lower():
        raise HTTPException(status_code=400, detail="Shared is a built-in owner")
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
        row = conn.execute("SELECT id, name FROM owner WHERE id = ?", (owner_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Owner not found")
        if row["name"].strip().lower() == SHARED_OWNER_NAME.lower():
            raise HTTPException(status_code=400, detail="Shared is a built-in owner")
        if body.name is not None:
            if body.name.strip().lower() == SHARED_OWNER_NAME.lower():
                raise HTTPException(status_code=400, detail="Shared is a built-in owner")
            conn.execute("UPDATE owner SET name = ? WHERE id = ?", (body.name.strip(), owner_id))
        if body.color is not None:
            conn.execute("UPDATE owner SET color = ? WHERE id = ?", (body.color, owner_id))
    return {"ok": True}


@router.delete("/{owner_id}")
def delete_owner(owner_id: str):
    with get_db() as conn:
        row = conn.execute("SELECT id, name FROM owner WHERE id = ?", (owner_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Owner not found")
        if row["name"].strip().lower() == SHARED_OWNER_NAME.lower():
            raise HTTPException(status_code=400, detail="Shared is a built-in owner")
        conn.execute("DELETE FROM owner WHERE id = ?", (owner_id,))
        shared_owner_id = get_shared_owner_id(conn)
        remaining_personal_owner_count = conn.execute(
            "SELECT COUNT(*) FROM owner WHERE LOWER(name) <> LOWER(?)",
            (SHARED_OWNER_NAME,),
        ).fetchone()[0]
        if shared_owner_id and remaining_personal_owner_count <= 1:
            conn.execute("UPDATE account SET owner_id = NULL WHERE owner_id = ?", (shared_owner_id,))
            conn.execute("UPDATE txn SET owner_id = NULL WHERE owner_id = ?", (shared_owner_id,))
            conn.execute("UPDATE category SET owner_id = NULL WHERE owner_id = ?", (shared_owner_id,))
            conn.execute("UPDATE category_rule SET owner_id = NULL WHERE owner_id = ?", (shared_owner_id,))
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
