# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: GPL-3.0-or-later

"""
Categories are not just a tree for display: the same ids also live inside rules,
import drafts, and historical transactions. Category edits therefore have to keep
taxonomy, reporting metadata, and saved import state in sync.
"""

import uuid
import json
from collections import Counter
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional
from backend.db.database import get_db
from backend.json_utils import safe_json_dict

router = APIRouter()


def _get_affected_category_ids(conn, category_id: str) -> list[str]:
    # Deletion/replacement acts on the whole branch because descendant ids may already
    # be persisted in rules, imports, and transaction history.
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

def _extract_category_assignments(payload: dict) -> dict[str, str]:
    if not isinstance(payload, dict):
        return {}
    assignments = payload.get("category_assignments")
    if not isinstance(assignments, dict):
        column_map = payload.get("column_map")
        if isinstance(column_map, dict):
            assignments = column_map.get("category_assignments")
    if not isinstance(assignments, dict):
        return {}
    return {
        str(raw_value): str(category_id)
        for raw_value, category_id in assignments.items()
        if raw_value is not None and category_id
    }


def _collect_mapping_counts(conn, table: str, json_column: str) -> Counter:
    counts: Counter = Counter()
    rows = conn.execute(
        f"SELECT {json_column} AS payload_json FROM {table}"
    ).fetchall()
    for row in rows:
        payload = safe_json_dict(row["payload_json"])
        for category_id in _extract_category_assignments(payload).values():
            counts[category_id] += 1
    return counts


def _rewrite_category_assignments_in_payload(payload: dict, affected_ids: set[str], replacement_category_id: str | None) -> tuple[dict, bool]:
    if not isinstance(payload, dict):
        return payload, False

    changed = False

    def rewrite(assignments: dict | None) -> dict | None:
        nonlocal changed
        if not isinstance(assignments, dict):
            return assignments
        next_assignments = {}
        for raw_value, category_id in assignments.items():
            category_id_str = str(category_id) if category_id is not None else None
            if category_id_str and category_id_str in affected_ids:
                changed = True
                if replacement_category_id:
                    next_assignments[raw_value] = replacement_category_id
                continue
            next_assignments[raw_value] = category_id
        return next_assignments

    if "category_assignments" in payload:
        payload["category_assignments"] = rewrite(payload.get("category_assignments"))

    column_map = payload.get("column_map")
    if isinstance(column_map, dict) and "category_assignments" in column_map:
        column_map = dict(column_map)
        column_map["category_assignments"] = rewrite(column_map.get("category_assignments"))
        payload["column_map"] = column_map

    return payload, changed


def _collect_delete_impact(conn, affected_ids: list[str]) -> dict:
    placeholders = ",".join("?" for _ in affected_ids)
    txn_row = conn.execute(
        f"SELECT COUNT(*) AS txn_count FROM txn WHERE category_id IN ({placeholders})",
        affected_ids,
    ).fetchone()
    rule_row = conn.execute(
        f"SELECT COUNT(*) AS rule_count FROM category_rule WHERE category_id IN ({placeholders})",
        affected_ids,
    ).fetchone()
    profile_mapping_count = sum(_collect_mapping_counts(conn, "csv_import_profile", "column_map").get(category_id, 0) for category_id in affected_ids)
    batch_mapping_count = sum(_collect_mapping_counts(conn, "import_batch", "config_snapshot").get(category_id, 0) for category_id in affected_ids)
    txn_count = int(txn_row["txn_count"] if txn_row else 0)
    rule_count = int(rule_row["rule_count"] if rule_row else 0)
    return {
        "txn_count": txn_count,
        "rule_count": rule_count,
        "profile_mapping_count": int(profile_mapping_count),
        "batch_mapping_count": int(batch_mapping_count),
        "is_in_use": any([txn_count, rule_count, profile_mapping_count, batch_mapping_count]),
    }


class CategoryCreate(BaseModel):
    name:          str
    color:         str = "#888888"
    parent_id:     Optional[str] = None
    category_type: Optional[str] = None
    sort_order:    Optional[int] = None


class CategoryDelete(BaseModel):
    replacement_category_id: Optional[str] = None


@router.get("")
def list_categories():
    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT
                id,
                parent_id,
                name,
                color,
                COALESCE(category_type, CASE WHEN parent_id IS NULL THEN 'expense' END) AS category_type,
                sort_order,
                exclude_from_totals
            FROM category
            -- The category editor and reporting UI both treat top-level income groups as
            -- a distinct section, so the API bakes that ordering in instead of leaving it
            -- to each client to reconstruct.
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
    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT
                id,
                parent_id,
                name,
                color,
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


@router.get("/usage-summary")
def get_category_usage_summary():
    with get_db() as conn:
        category_ids = [
            row["id"]
            for row in conn.execute("SELECT id FROM category").fetchall()
        ]

        txn_counts = {
            row["category_id"]: row["txn_count"]
            for row in conn.execute(
                """
                SELECT category_id, COUNT(*) AS txn_count
                FROM txn
                WHERE category_id IS NOT NULL
                GROUP BY category_id
                """
            ).fetchall()
        }
        rule_counts = {
            row["category_id"]: row["rule_count"]
            for row in conn.execute(
                """
                SELECT category_id, COUNT(*) AS rule_count
                FROM category_rule
                GROUP BY category_id
                """
            ).fetchall()
        }
        profile_mapping_counts = _collect_mapping_counts(conn, "csv_import_profile", "column_map")
        batch_mapping_counts = _collect_mapping_counts(conn, "import_batch", "config_snapshot")

    summary = {}
    for category_id in category_ids:
        txn_count = int(txn_counts.get(category_id, 0) or 0)
        rule_count = int(rule_counts.get(category_id, 0) or 0)
        profile_mapping_count = int(profile_mapping_counts.get(category_id, 0) or 0)
        batch_mapping_count = int(batch_mapping_counts.get(category_id, 0) or 0)
        summary[category_id] = {
            "txn_count": txn_count,
            "rule_count": rule_count,
            "profile_mapping_count": profile_mapping_count,
            "batch_mapping_count": batch_mapping_count,
            "is_in_use": any([
                txn_count,
                rule_count,
                profile_mapping_count,
                batch_mapping_count,
            ]),
        }
    return summary


@router.post("")
def create_category(body: CategoryCreate):
    cid = str(uuid.uuid4())
    with get_db() as conn:
        category_type = body.category_type
        if body.parent_id:
            # Child categories inherit the parent's type so a group cannot silently mix
            # income and expense semantics inside one reporting branch.
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
            INSERT INTO category (id, parent_id, name, color, category_type, sort_order)
            VALUES (?,?,?,?,?,?)
            """,
            (cid, body.parent_id, body.name, body.color, category_type, sort_order),
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
        impact = _collect_delete_impact(conn, affected_ids)
    return {
        "category_id": cat["id"],
        "category_name": cat["name"],
        **impact,
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
            # Replacements are taxonomy maintenance, not manual recategorization, so the
            # affected transactions are unlocked for future rule-based updates.
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
            # Clearing a deleted branch also clears the manual override bit so later rule
            # runs are free to classify the now-uncategorized transactions again.
            conn.execute(
                f"""
                UPDATE txn
                SET category_id = NULL,
                    category_overridden = 0
                WHERE category_id IN ({placeholders})
                """,
                affected_ids,
            )

        affected_id_set = set(affected_ids)
        # Import drafts store category ids inside JSON snapshots, so deletes have to
        # rewrite both saved profiles and already-imported batch state to avoid dangling ids.
        profile_rows = conn.execute(
            "SELECT id, column_map FROM csv_import_profile"
        ).fetchall()
        for row in profile_rows:
            payload, changed = _rewrite_category_assignments_in_payload(
                safe_json_dict(row["column_map"]),
                affected_id_set,
                replacement_category_id,
            )
            if changed:
                conn.execute(
                    "UPDATE csv_import_profile SET column_map = ? WHERE id = ?",
                    (json.dumps(payload), row["id"]),
                )

        batch_rows = conn.execute(
            "SELECT id, config_snapshot FROM import_batch"
        ).fetchall()
        for row in batch_rows:
            payload, changed = _rewrite_category_assignments_in_payload(
                safe_json_dict(row["config_snapshot"]),
                affected_id_set,
                replacement_category_id,
            )
            if changed:
                conn.execute(
                    "UPDATE import_batch SET config_snapshot = ? WHERE id = ?",
                    (json.dumps(payload), row["id"]),
                )

        # Preserve the visible tree shape after a group delete even though historical
        # references to the deleted branch have already been rewritten above.
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
    with get_db() as conn:
        conn.execute(
            "UPDATE category SET parent_id = NULL WHERE id = ?", (category_id,)
        )
    return {"ok": True}
