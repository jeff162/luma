# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Owners model household attribution across accounts, categories, rules, and reports.

This router maintains the special "Shared" semantics the UI depends on: it is a
built-in bucket rather than a normal user record, and it is collapsed away again
when the household no longer has enough personal owners to make shared ownership meaningful.
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional
import uuid
from backend.db.database import SHARED_OWNER_NAME, ensure_shared_owner, get_db, get_shared_owner_id
from backend.services.account_settings_followups import settle_account_change

router = APIRouter()


class OwnerCreate(BaseModel):
    name: str
    color: str = "#6366f1"


class OwnerUpdate(BaseModel):
    name: Optional[str] = None
    color: Optional[str] = None
    # Whether this owner's transactions arrive flagged for review (`services/review_flagging.py`).
    flag_new_for_review: Optional[bool] = None


@router.get("")
def list_owners():
    with get_db() as conn:
        ensure_shared_owner(conn)
        rows = conn.execute(
            """
            SELECT id, name, color, flag_new_for_review,
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
            "INSERT INTO owner (id, name, color, flag_new_for_review) VALUES (?, ?, ?, 1)",
            (new_id, body.name.strip(), body.color),
        )
    return {"id": new_id, "name": body.name.strip(), "color": body.color, "flag_new_for_review": 1}


@router.patch("/{owner_id}")
def update_owner(owner_id: str, body: OwnerUpdate):
    with get_db() as conn:
        row = conn.execute("SELECT id, name FROM owner WHERE id = ?", (owner_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Owner not found")
        # Shared keeps its built-in name and color, but whether its rows arrive flagged is a choice
        # like any other owner's.
        is_shared = row["name"].strip().lower() == SHARED_OWNER_NAME.lower()
        if is_shared and (body.name is not None or body.color is not None):
            raise HTTPException(status_code=400, detail="Shared is a built-in owner")
        if body.flag_new_for_review is not None:
            conn.execute(
                "UPDATE owner SET flag_new_for_review = ? WHERE id = ?",
                (1 if body.flag_new_for_review else 0, owner_id),
            )
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
        # The owner's accounts are left with none (the foreign key clears it), which changes what their
        # owner-scoped rules and PayPal pairings see.
        orphaned = [r["id"] for r in conn.execute("SELECT id FROM account WHERE owner_id = ?", (owner_id,))]
        conn.execute("DELETE FROM owner WHERE id = ?", (owner_id,))
        shared_owner_id = get_shared_owner_id(conn)
        remaining_personal_owner_count = conn.execute(
            "SELECT COUNT(*) FROM owner WHERE LOWER(name) <> LOWER(?)",
            (SHARED_OWNER_NAME,),
        ).fetchone()[0]
        if shared_owner_id and remaining_personal_owner_count <= 1:
            # "Shared" only has meaning when more than one personal owner exists. Once
            # the household collapses back to one person, shared assignments become noise.
            orphaned += [r["id"] for r in conn.execute("SELECT id FROM account WHERE owner_id = ?", (shared_owner_id,))]
            conn.execute("UPDATE account SET owner_id = NULL WHERE owner_id = ?", (shared_owner_id,))
            conn.execute("UPDATE txn SET owner_id = NULL WHERE owner_id = ?", (shared_owner_id,))
            # Categories no longer carry an owner (column dropped in m19_drop_category_owner_id);
            # owner-style category attribution now lives in tags, so there is nothing to clear here.
            conn.execute("UPDATE category_rule SET owner_id = NULL WHERE owner_id = ?", (shared_owner_id,))
    settle_account_change(orphaned)
    return {"ok": True}
