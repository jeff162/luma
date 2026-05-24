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
UNASSIGNED_CATEGORY_SYSTEM_KEY = "unassigned"


def _group_name_sort_key(name: str | None) -> tuple[str, str]:
    label = str(name or "").strip()
    return (label.casefold(), label)


def _normalize_category_name(value: str | None) -> str:
    return " ".join(str(value or "").strip().split()).casefold()


def _clean_category_name(value: str | None) -> str:
    return " ".join(str(value or "").strip().split())


def _find_category_name_conflict(conn, name: str | None, exclude_id: str | None = None):
    normalized_name = _normalize_category_name(name)
    if not normalized_name:
        raise HTTPException(status_code=400, detail="Category names cannot be empty")

    rows = conn.execute(
        """
        SELECT c.id, c.name, c.parent_id, p.name AS parent_name
        FROM category c
        LEFT JOIN category p ON p.id = c.parent_id
        WHERE (? IS NULL OR c.id <> ?)
        ORDER BY c.parent_id IS NOT NULL, c.sort_order, c.name, c.id
        """,
        (exclude_id, exclude_id),
    ).fetchall()
    for row in rows:
        if _normalize_category_name(row["name"]) != normalized_name:
            continue
        return row
    return None


def _ensure_category_name_is_unique(conn, name: str | None, exclude_id: str | None = None) -> str:
    cleaned_name = _clean_category_name(name)
    conflict = _find_category_name_conflict(conn, cleaned_name, exclude_id=exclude_id)
    if not conflict:
        return cleaned_name

    parent_name = str(conflict["parent_name"] or "").strip()
    if parent_name:
        location = f' under "{parent_name}"'
    else:
        location = ""
    raise HTTPException(
        status_code=400,
        detail=f'A category or group named "{conflict["name"]}" already exists{location}.',
    )


def _load_top_level_group_rows(conn, category_type: str):
    return conn.execute(
        """
        SELECT id, name
        FROM category
        WHERE parent_id IS NULL
          AND COALESCE(category_type, 'expense') = ?
        ORDER BY sort_order, LOWER(name), id
        """,
        (category_type,),
    ).fetchall()


def _top_level_groups_are_name_sorted(rows) -> bool:
    expected_ids = [
        row["id"]
        for row in sorted(
            rows,
            key=lambda row: (
                *_group_name_sort_key(row["name"]),
                row["id"],
            ),
        )
    ]
    current_ids = [row["id"] for row in rows]
    return current_ids == expected_ids


def _find_top_level_group_insert_index(rows, name: str) -> int:
    new_key = _group_name_sort_key(name)
    for index, row in enumerate(rows):
        if new_key < _group_name_sort_key(row["name"]):
            return index
    return len(rows)


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
                system_key,
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
        tag_rows = conn.execute("SELECT category_id, tag_id FROM category_tag").fetchall()

    tag_map: dict[str, list[str]] = {}
    for row in tag_rows:
        tag_map.setdefault(row["category_id"], []).append(row["tag_id"])

    cats = [{**dict(r), "tag_ids": tag_map.get(r["id"], [])} for r in rows]
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
                system_key,
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
        tag_rows = conn.execute("SELECT category_id, tag_id FROM category_tag").fetchall()
    tag_map: dict[str, list[str]] = {}
    for row in tag_rows:
        tag_map.setdefault(row["category_id"], []).append(row["tag_id"])
    return [{**dict(r), "tag_ids": tag_map.get(r["id"], [])} for r in rows]


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
        cleaned_name = _ensure_category_name_is_unique(conn, body.name)
        category_type = body.category_type
        reordered_top_level_ids = None
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
                sibling_rows = _load_top_level_group_rows(conn, category_type)
                # Top-level group order is shared across the editor and pickers. When the
                # current section is still in its default alphabetical order, unnamed insert
                # requests should stay alphabetized instead of silently appending to the end.
                if _top_level_groups_are_name_sorted(sibling_rows):
                    sort_order = _find_top_level_group_insert_index(sibling_rows, cleaned_name)
                    reordered_top_level_ids = [row["id"] for row in sibling_rows]
                    reordered_top_level_ids.insert(sort_order, cid)
            if sort_order is None:
                sort_order = row["next_sort"] if row else 0

        conn.execute(
            """
            INSERT INTO category (id, parent_id, name, category_type, sort_order)
            VALUES (?,?,?,?,?)
            """,
            (cid, body.parent_id, cleaned_name, category_type, sort_order),
        )
        if reordered_top_level_ids is not None:
            for index, category_id in enumerate(reordered_top_level_ids):
                conn.execute(
                    "UPDATE category SET sort_order = ? WHERE id = ?",
                    (index, category_id),
                )
    return {
        "id": cid,
        **body.model_dump(),
        "name": cleaned_name,
        "category_type": category_type,
        "sort_order": sort_order,
    }


@router.get("/{category_id}/delete-preview")
def delete_category_preview(category_id: str):
    with get_db() as conn:
        cat = conn.execute(
            "SELECT id, name, system_key FROM category WHERE id = ?", (category_id,)
        ).fetchone()
        if not cat:
            raise HTTPException(status_code=404, detail="Not found")
        if cat["system_key"] == UNASSIGNED_CATEGORY_SYSTEM_KEY:
            raise HTTPException(status_code=400, detail="The Unassigned group cannot be deleted")
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
            "SELECT id, parent_id, system_key FROM category WHERE id = ?", (category_id,)
        ).fetchone()
        if not cat:
            raise HTTPException(status_code=404, detail="Not found")
        if cat["system_key"] == UNASSIGNED_CATEGORY_SYSTEM_KEY:
            raise HTTPException(status_code=400, detail="The Unassigned group cannot be deleted")
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
                    category_overridden = 0,
                    category_source = 'rule'
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
                    category_overridden = 0,
                    category_source = NULL
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
    category_type:        Optional[str] = None
    sort_order:           Optional[int] = None
    exclude_from_totals:  Optional[int] = None


@router.patch("/{category_id}")
def update_category(category_id: str, body: CategoryUpdate):
    with get_db() as conn:
        cat = conn.execute(
            "SELECT id, system_key FROM category WHERE id = ?", (category_id,)
        ).fetchone()
        if not cat:
            raise HTTPException(status_code=404, detail="Not found")
        if cat["system_key"] == UNASSIGNED_CATEGORY_SYSTEM_KEY:
            if body.name is not None:
                raise HTTPException(status_code=400, detail="The Unassigned group cannot be renamed")
            if body.parent_id is not None:
                raise HTTPException(status_code=400, detail="The Unassigned group cannot be moved")
        fields, params = [], []
        if body.name                is not None: fields.append("name = ?");                 params.append(_ensure_category_name_is_unique(conn, body.name, exclude_id=category_id))
        if body.parent_id           is not None: fields.append("parent_id = ?");            params.append(body.parent_id)
        if body.category_type       is not None: fields.append("category_type = ?");        params.append(body.category_type)
        if body.sort_order          is not None: fields.append("sort_order = ?");           params.append(body.sort_order)
        if body.exclude_from_totals is not None: fields.append("exclude_from_totals = ?");  params.append(body.exclude_from_totals)
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


# Category tag attachments. Tags applied to a category propagate additively to
# every transaction in that category, and (if applied to a group) to every
# transaction in any of the group's leaf categories. The list returned mirrors
# the tag shape used by transactions so the same tag pill UI can render it.
class CategoryTagsUpdate(BaseModel):
    tag_ids: list[str]


@router.get("/{category_id}/tags")
def list_category_tags(category_id: str):
    with get_db() as conn:
        cat = conn.execute("SELECT id FROM category WHERE id = ?", (category_id,)).fetchone()
        if not cat:
            raise HTTPException(status_code=404, detail="Not found")
        rows = conn.execute(
            """
            SELECT g.id, g.name, g.color
            FROM category_tag ct
            JOIN tag g ON g.id = ct.tag_id
            WHERE ct.category_id = ?
            ORDER BY g.sort_order, LOWER(g.name), g.name, g.id
            """,
            (category_id,),
        ).fetchall()
    return [dict(r) for r in rows]


@router.put("/{category_id}/tags")
def set_category_tags(category_id: str, body: CategoryTagsUpdate):
    cleaned = [str(tag_id).strip() for tag_id in body.tag_ids if tag_id and str(tag_id).strip()]
    with get_db() as conn:
        cat = conn.execute("SELECT id FROM category WHERE id = ?", (category_id,)).fetchone()
        if not cat:
            raise HTTPException(status_code=404, detail="Not found")
        if cleaned:
            placeholders = ",".join("?" * len(cleaned))
            valid_rows = conn.execute(
                f"SELECT id FROM tag WHERE id IN ({placeholders})",
                cleaned,
            ).fetchall()
            valid_ids = {row["id"] for row in valid_rows}
        else:
            valid_ids = set()
        conn.execute("DELETE FROM category_tag WHERE category_id = ?", (category_id,))
        for tag_id in valid_ids:
            conn.execute(
                "INSERT OR IGNORE INTO category_tag (category_id, tag_id) VALUES (?, ?)",
                (category_id, tag_id),
            )
    return {"ok": True}
