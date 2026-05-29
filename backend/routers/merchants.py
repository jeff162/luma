# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: GPL-3.0-or-later

"""
merchants.py — Merchant rename rules.

DESIGN PRINCIPLES:
- Plaid merchant names are often garbled (e.g. 'WHOLEFDS #1234 MKT').
  Rename rules let users define a pattern → clean name mapping that is applied
  automatically during sync, before categorization runs.
- raw_pattern is matched as a case-insensitive substring of raw_name.
  merchant_name is set to clean_name when a match is found.
- raw_name is never modified — it always holds the original Plaid string.
  Only merchant_name is updated by rename rules.
- The /apply endpoint retroactively applies all rules to existing transactions.
  This is called automatically when a user saves a rename from the TransactionDetail
  panel, so historical transactions get cleaned up immediately.
- Rules created from the UI are pre-populated with the transaction's raw_name
  as the pattern and the user's edited name as the clean name. The user can
  adjust the pattern before saving (e.g. to match a broader substring).

The key contract is that raw source text stays untouched while cleaned names can
be applied both prospectively during sync and retroactively when a manual edit is
promoted into a reusable rename rule from transaction detail.
"""

import uuid
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional
from backend.db.database import get_db

router = APIRouter()


class RenameCreate(BaseModel):
    raw_pattern: str
    clean_name:  str


class RenameUpdate(BaseModel):
    raw_pattern: Optional[str] = None
    clean_name:  Optional[str] = None


@router.get("")
def list_renames():
    with get_db() as conn:
        rows = conn.execute(
            "SELECT id, raw_pattern, clean_name FROM merchant_rename ORDER BY raw_pattern"
        ).fetchall()
    return [dict(r) for r in rows]


@router.post("")
def create_rename(body: RenameCreate):
    rid = str(uuid.uuid4())
    with get_db() as conn:
        try:
            conn.execute(
                "INSERT INTO merchant_rename (id, raw_pattern, clean_name) VALUES (?,?,?)",
                (rid, body.raw_pattern.strip(), body.clean_name.strip()),
            )
        except Exception:
            raise HTTPException(status_code=409, detail="Pattern already exists")
    return {"id": rid, **body.model_dump()}


@router.patch("/{rename_id}")
def update_rename(rename_id: str, body: RenameUpdate):
    with get_db() as conn:
        fields, params = [], []
        if body.raw_pattern is not None:
            fields.append("raw_pattern = ?"); params.append(body.raw_pattern.strip())
        if body.clean_name is not None:
            fields.append("clean_name = ?");  params.append(body.clean_name.strip())
        if fields:
            params.append(rename_id)
            conn.execute(f"UPDATE merchant_rename SET {', '.join(fields)} WHERE id = ?", params)
    return {"ok": True}


@router.delete("/{rename_id}")
def delete_rename(rename_id: str):
    with get_db() as conn:
        conn.execute("DELETE FROM merchant_rename WHERE id = ?", (rename_id,))
    return {"ok": True}


@router.post("/apply")
def apply_renames():
    with get_db() as conn:
        rules = conn.execute(
            "SELECT raw_pattern, clean_name FROM merchant_rename"
        ).fetchall()
        updated = 0
        for rule in rules:
            # This is the historical backfill path after a user turns one manual cleanup
            # into a reusable rename rule from transaction detail.
            result = conn.execute(
                """UPDATE txn SET merchant_name = ?
                   WHERE raw_name LIKE ? AND merchant_name != ?""",
                (rule["clean_name"], f"%{rule['raw_pattern']}%", rule["clean_name"]),
            )
            updated += result.rowcount
    return {"updated": updated}
