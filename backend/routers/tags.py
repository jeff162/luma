# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
User-defined transaction tags.

Tags are lightweight cross-cutting labels rather than part of the category tree,
so this router keeps them globally unique and simple to manage from Settings.
"""

from __future__ import annotations

import re
import uuid

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.db.database import get_db

router = APIRouter()

HEX_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


def _normalize_tag_name(value: str | None) -> str:
    return " ".join(str(value or "").strip().split())


def _validate_tag_name(conn, name: str, *, exclude_id: str | None = None):
    normalized = _normalize_tag_name(name)
    if not normalized:
        raise HTTPException(status_code=400, detail="Tag name is required")
    params = [normalized.casefold()]
    sql = "SELECT id FROM tag WHERE LOWER(TRIM(name)) = ?"
    if exclude_id:
        sql += " AND id != ?"
        params.append(exclude_id)
    existing = conn.execute(sql, params).fetchone()
    if existing:
        raise HTTPException(status_code=400, detail="A tag with that name already exists")
    return normalized


def _validate_tag_color(color: str | None) -> str:
    value = str(color or "").strip()
    if not HEX_COLOR_RE.fullmatch(value):
        raise HTTPException(status_code=400, detail="Tag color must be a hex color like #3b82f6")
    return value.lower()


class TagCreate(BaseModel):
    name: str
    color: str


class TagUpdate(BaseModel):
    name: str | None = None
    color: str | None = None


@router.get("")
def list_tags():
    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT
                t.id,
                t.name,
                t.color,
                t.sort_order
            FROM tag t
            ORDER BY t.sort_order, LOWER(t.name), t.name, t.id
            """
        ).fetchall()
    return [dict(row) for row in rows]


@router.post("")
def create_tag(body: TagCreate):
    with get_db() as conn:
        name = _validate_tag_name(conn, body.name)
        color = _validate_tag_color(body.color)
        sort_order = conn.execute("SELECT COALESCE(MAX(sort_order), -1) + 1 FROM tag").fetchone()[0]
        tag_id = str(uuid.uuid4())
        conn.execute(
            """
            INSERT INTO tag (id, name, color, sort_order)
            VALUES (?, ?, ?, ?)
            """,
            (tag_id, name, color, sort_order),
        )
        row = conn.execute(
            "SELECT id, name, color, sort_order FROM tag WHERE id = ?",
            (tag_id,),
        ).fetchone()
    return dict(row)


@router.patch("/{tag_id}")
def update_tag(tag_id: str, body: TagUpdate):
    with get_db() as conn:
        existing = conn.execute(
            "SELECT id, name, color, sort_order FROM tag WHERE id = ?",
            (tag_id,),
        ).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Tag not found")

        fields = []
        params = []
        if body.name is not None:
            fields.append("name = ?")
            params.append(_validate_tag_name(conn, body.name, exclude_id=tag_id))
        if body.color is not None:
            fields.append("color = ?")
            params.append(_validate_tag_color(body.color))
        if fields:
            params.append(tag_id)
            conn.execute(
                f"UPDATE tag SET {', '.join(fields)} WHERE id = ?",
                params,
            )
        row = conn.execute(
            "SELECT id, name, color, sort_order FROM tag WHERE id = ?",
            (tag_id,),
        ).fetchone()
    return dict(row)


@router.delete("/{tag_id}")
def delete_tag(tag_id: str):
    with get_db() as conn:
        conn.execute("DELETE FROM tag WHERE id = ?", (tag_id,))
    return {"ok": True}
