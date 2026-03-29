import uuid
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional
from db.database import get_db

router = APIRouter()


def _get_affected_category_ids(conn, category_id: str) -> list[str]:
    return [
        row["id"]
        for row in conn.execute(
            """
            WITH RECURSIVE category_descendants(id) AS (
                SELECT id
                FROM category
                WHERE id = ?
                UNION ALL
                SELECT c.id
                FROM category c
                JOIN category_descendants d ON c.parent_id = d.id
            )
            SELECT id FROM category_descendants
            """,
            (category_id,),
        ).fetchall()
    ]


class CategoryCreate(BaseModel):
    name:          str
    color:         str = "#888888"
    icon:          str = "📦"
    parent_id:     Optional[str] = None
    category_type: Optional[str] = None
    sort_order:    Optional[int] = None


class CategoryDelete(BaseModel):
    replacement_category_id: Optional[str] = None


@router.get("")
def list_categories():
    """
    Returns a nested structure: each top-level group has a `children` list.
    Leaf categories (no children) can also appear at the top level if they
    have no parent.
    """
    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT
                id,
                parent_id,
                name,
                color,
                icon,
                COALESCE(category_type, CASE WHEN parent_id IS NULL THEN 'expense' END) AS category_type,
                sort_order,
                exclude_from_totals
            FROM category
            ORDER BY
                CASE
                    WHEN parent_id IS NULL AND COALESCE(category_type, 'expense') = 'income' THEN 0
                    WHEN parent_id IS NULL THEN 1
                    ELSE 2
                END,
                sort_order,
                name
            """
        ).fetchall()

    cats = [dict(r) for r in rows]
    by_id = {c["id"]: {**c, "children": []} for c in cats}

    roots = []
    for c in cats:
        if c["parent_id"] and c["parent_id"] in by_id:
            by_id[c["parent_id"]]["children"].append(by_id[c["id"]])
        else:
            roots.append(by_id[c["id"]])

    return roots


@router.get("/flat")
def list_categories_flat():
    """Flat list of all categories, including parent_id and owner_id. Used by dropdowns."""
    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT
                id,
                parent_id,
                name,
                color,
                icon,
                owner_id,
                COALESCE(category_type, CASE WHEN parent_id IS NULL THEN 'expense' END) AS category_type,
                sort_order,
                exclude_from_totals
            FROM category
            ORDER BY
                CASE
                    WHEN parent_id IS NULL AND COALESCE(category_type, 'expense') = 'income' THEN 0
                    WHEN parent_id IS NULL THEN 1
                    ELSE 2
                END,
                sort_order,
                name
            """
        ).fetchall()
    return [dict(r) for r in rows]


@router.post("")
def create_category(body: CategoryCreate):
    cid = str(uuid.uuid4())
    with get_db() as conn:
        category_type = body.category_type
        if body.parent_id:
            parent = conn.execute(
                "SELECT COALESCE(category_type, 'expense') AS category_type FROM category WHERE id = ?",
                (body.parent_id,),
            ).fetchone()
            if not parent:
                raise HTTPException(status_code=404, detail="Parent category not found")
            category_type = parent["category_type"]
        elif category_type is None:
            category_type = "expense"

        sort_order = body.sort_order
        if sort_order is None:
            if body.parent_id:
                row = conn.execute(
                    "SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_sort FROM category WHERE parent_id = ?",
                    (body.parent_id,),
                ).fetchone()
            else:
                row = conn.execute(
                    """
                    SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_sort
                    FROM category
                    WHERE parent_id IS NULL AND COALESCE(category_type, 'expense') = ?
                    """,
                    (category_type,),
                ).fetchone()
            sort_order = row["next_sort"] if row else 0

        conn.execute(
            """
            INSERT INTO category (id, parent_id, name, color, icon, category_type, sort_order)
            VALUES (?,?,?,?,?,?,?)
            """,
            (cid, body.parent_id, body.name, body.color, body.icon, category_type, sort_order),
        )
    return {
        "id": cid,
        **body.model_dump(),
        "category_type": category_type,
        "sort_order": sort_order,
    }


@router.get("/{category_id}/delete-preview")
def delete_category_preview(category_id: str):
    with get_db() as conn:
        cat = conn.execute(
            "SELECT id, name FROM category WHERE id = ?", (category_id,)
        ).fetchone()
        if not cat:
            raise HTTPException(status_code=404, detail="Not found")
        affected_ids = _get_affected_category_ids(conn, category_id)
        placeholders = ",".join("?" for _ in affected_ids)
        row = conn.execute(
            f"SELECT COUNT(*) AS txn_count FROM txn WHERE category_id IN ({placeholders})",
            affected_ids,
        ).fetchone()
    return {
        "category_id": cat["id"],
        "category_name": cat["name"],
        "txn_count": row["txn_count"] if row else 0,
        "affected_category_ids": affected_ids,
    }


@router.delete("/{category_id}")
def delete_category(category_id: str, body: CategoryDelete | None = None):
    with get_db() as conn:
        cat = conn.execute(
            "SELECT id, parent_id FROM category WHERE id = ?", (category_id,)
        ).fetchone()
        if not cat:
            raise HTTPException(status_code=404, detail="Not found")
        affected_ids = _get_affected_category_ids(conn, category_id)
        placeholders = ",".join("?" for _ in affected_ids)
        replacement_category_id = body.replacement_category_id if body else None
        if replacement_category_id:
            replacement = conn.execute(
                "SELECT id FROM category WHERE id = ?",
                (replacement_category_id,),
            ).fetchone()
            if not replacement:
                raise HTTPException(status_code=404, detail="Replacement category not found")
            if replacement_category_id in affected_ids:
                raise HTTPException(status_code=400, detail="Replacement category cannot be deleted in the same operation")
            conn.execute(
                f"""
                UPDATE txn
                SET category_id = ?,
                    category_overridden = 0
                WHERE category_id IN ({placeholders})
                """,
                [replacement_category_id, *affected_ids],
            )
        else:
            conn.execute(
                f"""
                UPDATE txn
                SET category_id = NULL,
                    category_overridden = 0
                WHERE category_id IN ({placeholders})
                """,
                affected_ids,
            )
        # Re-parent children to the deleted category's parent
        conn.execute(
            """UPDATE category SET parent_id = (
                SELECT parent_id FROM category WHERE id = ?
            ) WHERE parent_id = ?""",
            (category_id, category_id),
        )
        conn.execute("DELETE FROM category WHERE id = ?", (category_id,))
    return {"ok": True}




class CategoryUpdate(BaseModel):
    name:                 Optional[str] = None
    parent_id:            Optional[str] = None
    color:                Optional[str] = None
    icon:                 Optional[str] = None
    owner_id:             Optional[str] = None
    category_type:        Optional[str] = None
    sort_order:           Optional[int] = None
    clear_owner:          bool = False
    exclude_from_totals:  Optional[int] = None


@router.patch("/{category_id}")
def update_category(category_id: str, body: CategoryUpdate):
    with get_db() as conn:
        cat = conn.execute(
            "SELECT id FROM category WHERE id = ?", (category_id,)
        ).fetchone()
        if not cat:
            raise HTTPException(status_code=404, detail="Not found")
        fields, params = [], []
        if body.name                is not None: fields.append("name = ?");                 params.append(body.name)
        if body.parent_id           is not None: fields.append("parent_id = ?");            params.append(body.parent_id)
        if body.color               is not None: fields.append("color = ?");                params.append(body.color)
        if body.icon                is not None: fields.append("icon = ?");                 params.append(body.icon)
        if body.owner_id            is not None: fields.append("owner_id = ?");             params.append(body.owner_id)
        if body.category_type       is not None: fields.append("category_type = ?");        params.append(body.category_type)
        if body.sort_order          is not None: fields.append("sort_order = ?");           params.append(body.sort_order)
        if body.exclude_from_totals is not None: fields.append("exclude_from_totals = ?");  params.append(body.exclude_from_totals)
        if body.clear_owner:                     fields.append("owner_id = NULL")
        if fields:
            params.append(category_id)
            conn.execute(f"UPDATE category SET {', '.join(fields)} WHERE id = ?", params)
    return {"ok": True}


@router.patch("/{category_id}/ungroup")
def ungroup_category(category_id: str):
    """Promote a child category to a top-level group."""
    with get_db() as conn:
        conn.execute(
            "UPDATE category SET parent_id = NULL WHERE id = ?", (category_id,)
        )
    return {"ok": True}
