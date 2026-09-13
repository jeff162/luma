# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

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
from backend.db.database import get_db, _seed_default_categories
from backend.services.categorizer import DEFAULT_RULE_SEEDS, seed_default_rules
from backend.json_utils import safe_json_dict
from backend.services.txn_splits import txn_effective_sql
from backend.services.excluded_categories import (
    REIMBURSABLE_SYSTEM_KEY,
    TRANSFERS_SYSTEM_KEY,
    find_reimbursable_group_id,
    reimbursable_leaf_ids,
)
from backend.services.reimbursements import links_claiming

router = APIRouter()
UNASSIGNED_CATEGORY_SYSTEM_KEY = "unassigned"

# The reimbursable holding group is machinery, not a label, and both of its guards are flat rather than
# conditional on whether it currently holds anything. Deleting it never durably worked — seeding runs on
# every start, so it returns at next launch (the behaviour `_ensure_transfers_group` documents for
# `Transfers`) having left its leaves deactivated and orphaned out of the group the feature reads.
# Clearing its `exclude_from_totals` is the likelier accident and the more damaging: every receivable
# silently starts counting toward spending again, which is the exact overstatement the feature exists to
# remove. Both refuse with an explanation rather than repairing silently, and the guards stop at the
# group — leaves inside it are the user's to rename, delete and add, because `exclude_from_totals` is
# NOT NULL so an existing parent always wins `COALESCE(parent, leaf)` and a leaf cannot opt itself back
# into totals.
REIMBURSABLE_GROUP_LOCKED = (
    "The Reimbursable group is used to hold money owed back, so it cannot be %s. "
    "The categories inside it can be renamed, removed or added to freely."
)

# `Transfers` is guarded more lightly than `Reimbursable`, and the difference is deliberate. The Amazon
# importer and wallet funding-leg suppression create leaves under it, so the group has to stay findable
# and has to stay a group — deleting it or moving it inside another group both end with the next import
# building a second one beside the first. But its exclusion is a *reporting* choice rather than
# machinery: nothing computes against it, so counting money movement toward totals is a view the user is
# entitled to, and that checkbox stays open.
TRANSFERS_GROUP_LOCKED = (
    "The Transfers group holds the money-movement categories imports file into, so it cannot be %s. "
    "It can be renamed, and its exclusion from totals can be turned off."
)


def _group_name_sort_key(name: str | None) -> tuple[str, str]:
    label = str(name or "").strip()
    return (label.casefold(), label)


def _normalize_category_name(value: str | None) -> str:
    return " ".join(str(value or "").strip().split()).casefold()


def _clean_category_name(value: str | None) -> str:
    return " ".join(str(value or "").strip().split())


def _find_category_name_conflict(conn, name: str | None, exclude_id: str | None = None, *, is_group: bool = False):
    # Names are unique *within a kind*, but a leaf and a group may share a name (e.g. a "Miscellaneous"
    # category alongside a "Miscellaneous" group). The two are never interchangeable — only leaves are
    # assignable to transactions — so a cross-kind name match is not a conflict. Resolution paths that
    # turn a name back into a category (imports, seed rules) must therefore target leaves explicitly.
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
        if (row["parent_id"] is None) != is_group:
            continue
        if _normalize_category_name(row["name"]) != normalized_name:
            continue
        return row
    return None


def _ensure_category_name_is_unique(conn, name: str | None, exclude_id: str | None = None, *, is_group: bool = False) -> str:
    cleaned_name = _clean_category_name(name)
    conflict = _find_category_name_conflict(conn, cleaned_name, exclude_id=exclude_id, is_group=is_group)
    if not conflict:
        return cleaned_name

    parent_name = str(conflict["parent_name"] or "").strip()
    if parent_name:
        location = f' under "{parent_name}"'
    else:
        location = ""
    noun = "group" if is_group else "category"
    raise HTTPException(
        status_code=400,
        detail=f'A {noun} named "{conflict["name"]}" already exists{location}.',
    )


def _require_group_parent(conn, parent_id: str):
    """The row a category is being placed under, refused unless it is an active group.

    The tree is two levels by construction, not by convention: reports roll a leaf up into its group and
    stop, so a category nested under another leaf would count in neither. Requiring every parent to be
    top-level rules out depth and cycles together, because a row that has a parent can never be one.
    """
    parent = conn.execute(
        "SELECT id, parent_id, is_active, system_key, COALESCE(category_type, 'expense') AS category_type "
        "FROM category WHERE id = ?",
        (parent_id,),
    ).fetchone()
    if not parent:
        raise HTTPException(status_code=404, detail="Parent category not found")
    if parent["parent_id"] is not None or not parent["is_active"]:
        raise HTTPException(status_code=400, detail="A category can only be placed inside a group.")
    return parent


def _reimbursements_holding(conn, category_ids) -> int:
    """How many reimbursements claim money currently allocated to any of these categories.

    A reimbursement stores its claims as amounts against transactions and reads the money behind them from
    whatever sits in a Reimbursable leaf. Moving that leaf out of the group, or deleting it, takes the money
    out from under claims that survive, and the outstanding balance silently disappears. Split parts count
    as much as whole rows, since a claim is usually on a portion of a transaction.
    """
    ids = list(category_ids)
    if not ids:
        return 0
    places = ",".join("?" for _ in ids)
    txn_ids = [
        row["id"]
        for row in conn.execute(
            f"SELECT id FROM txn WHERE category_id IN ({places}) "
            f"UNION SELECT txn_id FROM txn_split WHERE category_id IN ({places})",
            [*ids, *ids],
        )
    ]
    return len(links_claiming(conn, txn_ids))


def _claims_held_detail(count: int, *, moving: bool) -> str:
    tracked = f"{count} reimbursement{'' if count == 1 else 's'}"
    if moving:
        return (
            f"This category holds money tracked by {tracked}, so it has to stay in the Reimbursable group. "
            "Move those transactions to another category in the group, or remove them from their "
            "reimbursements, first."
        )
    return (
        f"This category holds money tracked by {tracked}. Choose another category in the Reimbursable group "
        "to move its transactions to, or remove them from their reimbursements first."
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

def _compute_empty_cleanup(conn) -> tuple[list[dict], list[dict]]:
    """Identify the removable "empty" groups and categories for the one-click cleanup.

    An **empty leaf** is an active, non-system category that isn't an import-workspace pending
    label and is referenced by nothing the user has set up: no transaction (trashed or not) points
    at it and no categorization rule targets it (a rule target is configured-but-unused, not
    clutter). An **empty group** is an active, non-system group whose every active child is itself
    an empty leaf — so nothing survives the sweep — which includes childless groups. The Unassigned
    group and any other system rows are never touched. Returns (empty_groups, empty_leaves), each a
    list of {id, name[, parent_id]}.
    """
    referenced = {
        row["category_id"]
        for row in conn.execute(
            "SELECT DISTINCT category_id FROM txn WHERE category_id IS NOT NULL"
        ).fetchall()
    }
    referenced |= {
        row["category_id"]
        for row in conn.execute(
            "SELECT DISTINCT category_id FROM category_rule WHERE category_id IS NOT NULL"
        ).fetchall()
    }
    leaf_rows = conn.execute(
        """
        SELECT id, name, parent_id
        FROM   category
        WHERE  is_active = 1 AND parent_id IS NOT NULL
          AND  system_key IS NULL AND import_pending = 0
        ORDER  BY LOWER(name), name, id
        """
    ).fetchall()
    empty_leaves = [dict(r) for r in leaf_rows if r["id"] not in referenced]
    removed_per_group: dict[str, int] = {}
    for leaf in empty_leaves:
        removed_per_group[leaf["parent_id"]] = removed_per_group.get(leaf["parent_id"], 0) + 1

    group_rows = conn.execute(
        """
        SELECT id, name
        FROM   category
        WHERE  is_active = 1 AND parent_id IS NULL AND system_key IS NULL
        ORDER  BY LOWER(name), name, id
        """
    ).fetchall()
    empty_groups = []
    for group in group_rows:
        active_children = conn.execute(
            "SELECT COUNT(*) AS n FROM category WHERE parent_id = ? AND is_active = 1",
            (group["id"],),
        ).fetchone()["n"]
        # A group is swept only if none of its active children survive the leaf removal above.
        if active_children - removed_per_group.get(group["id"], 0) <= 0:
            empty_groups.append(dict(group))
    return empty_groups, empty_leaves


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
                exclude_from_totals,
                set_aside,
                import_pending
            FROM category
            -- Deleted (inactive) categories are referentially empty and live only in the
            -- separate /categories/inactive recovery list, never the active tree. Set-aside
            -- categories stay active (set_aside = 1) so transactions and imports keep using them.
            WHERE is_active = 1
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
                exclude_from_totals,
                set_aside,
                import_pending
            FROM category
            WHERE is_active = 1
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


@router.get("/inactive")
def list_inactive_categories():
    # The recovery list is flat (no group nesting): set-aside and deleted categories are
    # referentially empty leaves/branches the user may want to reactivate. Reactivation
    # re-parents under Unassigned, so the original tree position is not meaningful here.
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
                exclude_from_totals,
                is_active
            FROM category
            WHERE is_active = 0
            ORDER BY LOWER(name), name, id
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

        # Usage counts read the split-expansion seam: a category used only by one part of a split is
        # genuinely in use, and deletion offers to rewrite what points at it, so under-reporting here
        # would present a category as unused and then quietly rewrite an allocation.
        txn_counts = {
            row["category_id"]: row["txn_count"]
            for row in conn.execute(
                f"""
                SELECT category_id, COUNT(*) AS txn_count
                FROM {txn_effective_sql(conn, expand=True)} t
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
        cleaned_name = _ensure_category_name_is_unique(conn, body.name, is_group=not body.parent_id)
        category_type = body.category_type
        reordered_top_level_ids = None
        if body.parent_id:
            # Child categories inherit the parent's type so a group cannot silently mix
            # income and expense semantics inside one reporting branch.
            category_type = _require_group_parent(conn, body.parent_id)["category_type"]
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
        if cat["system_key"] == REIMBURSABLE_SYSTEM_KEY:
            raise HTTPException(status_code=400, detail=REIMBURSABLE_GROUP_LOCKED % "deleted")
        if cat["system_key"] == TRANSFERS_SYSTEM_KEY:
            raise HTTPException(status_code=400, detail=TRANSFERS_GROUP_LOCKED % "deleted")
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
        if cat["system_key"] == REIMBURSABLE_SYSTEM_KEY:
            raise HTTPException(status_code=400, detail=REIMBURSABLE_GROUP_LOCKED % "deleted")
        if cat["system_key"] == TRANSFERS_SYSTEM_KEY:
            raise HTTPException(status_code=400, detail=TRANSFERS_GROUP_LOCKED % "deleted")
        affected_ids = _get_affected_category_ids(conn, category_id)
        placeholders = ",".join("?" for _ in affected_ids)
        replacement_category_id = body.replacement_category_id if body else None
        # Replacing into another Reimbursable category keeps the claimed money inside the group, which is
        # the one delete that leaves every claim with something to stand on.
        reimbursable_leaves = set(reimbursable_leaf_ids(conn))
        held_ids = [cid for cid in affected_ids if cid in reimbursable_leaves]
        if held_ids and replacement_category_id not in reimbursable_leaves:
            held = _reimbursements_holding(conn, held_ids)
            if held:
                raise HTTPException(status_code=400, detail=_claims_held_detail(held, moving=False))
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

        # Soft deactivate instead of hard delete: the category rows survive (recoverable via
        # /reactivate) but drop out of the active tree; their transactions were just NULLed or
        # reassigned above, so the branch is referentially empty. Deleting also *promotes* the
        # branch out of the import workspace (import_pending = 0): a deleted label has left the
        # Group Imported Categories landing spot, so recovering it later restores it as a permanent
        # system category rather than dropping it back into the workspace pool.
        conn.execute(
            f"UPDATE category SET is_active = 0, import_pending = 0 WHERE id IN ({placeholders})",
            affected_ids,
        )
        # A rule must target an active category. Drop any rule pointing into the deactivated
        # branch so a stale rule can't re-categorize new transactions into an inactive label.
        conn.execute(
            f"DELETE FROM category_rule WHERE category_id IN ({placeholders})",
            affected_ids,
        )
        # A group is an organizational container, not an import label: there is nothing to recover
        # and nothing to suppress from future imports, so a deleted group is removed outright rather
        # than parked in the Inactive list. Its child categories DO go inactive (deactivated above,
        # recoverable); deleting the group row nulls their parent_id (ON DELETE SET NULL), so
        # recovery returns them to Unassigned. Only leaf categories ever appear in the Inactive list.
        if cat["parent_id"] is None:
            conn.execute("DELETE FROM category_tag WHERE category_id = ?", (category_id,))
            conn.execute("DELETE FROM category WHERE id = ?", (category_id,))
    return {"ok": True}


@router.post("/{category_id}/reactivate")
def reactivate_category(category_id: str):
    with get_db() as conn:
        cat = conn.execute(
            "SELECT id, is_active, parent_id FROM category WHERE id = ?", (category_id,)
        ).fetchone()
        if not cat:
            raise HTTPException(status_code=404, detail="Not found")
        if cat["is_active"]:
            return {"ok": True}
        # Restore to the group the category was deleted from, when that group still exists as an
        # active top-level group; otherwise fall back to Unassigned. The row keeps the parent_id it
        # had at deletion, which is what lets recovery return a categorized category to its group and
        # an Unassigned one to Unassigned. import_pending stays 0 — a recovered category is a
        # permanent system category and must not reappear in the import workspace. (Reactivate does
        # not retro-recategorize the transactions deletion cleared — only future assignments apply.)
        target_parent_id = None
        target_type = "expense"
        if cat["parent_id"]:
            parent = conn.execute(
                "SELECT id, is_active, parent_id, category_type, system_key FROM category WHERE id = ?",
                (cat["parent_id"],),
            ).fetchone()
            if parent and parent["is_active"] and parent["parent_id"] is None:
                target_parent_id = parent["id"]
                if parent["system_key"] != UNASSIGNED_CATEGORY_SYSTEM_KEY:
                    target_type = parent["category_type"] or "expense"
        if not target_parent_id:
            unassigned = conn.execute(
                "SELECT id FROM category WHERE system_key = ?",
                (UNASSIGNED_CATEGORY_SYSTEM_KEY,),
            ).fetchone()
            target_parent_id = unassigned["id"] if unassigned else None
        conn.execute(
            "UPDATE category SET is_active = 1, set_aside = 0, import_pending = 0, parent_id = ?, category_type = ? WHERE id = ?",
            (target_parent_id, target_type, category_id),
        )
    return {"ok": True}


# Starter set: the built-in categories and rules are opt-in (init only seeds the group skeleton). These
# two endpoints back both the onboarding "Add starter categories / rules" steps and the permanent
# Categories/Rules-page entry points. The catalog is shown for selection; generate-starter applies the
# chosen subset. Both are idempotent, so a user can add to the set later without duplicating anything.
@router.get("/starter-rules")
def list_starter_rules():
    return {
        "rules": [
            {"keyword": keyword, "category_name": category_name}
            for keyword, category_name, _amt_min, _amt_max in DEFAULT_RULE_SEEDS
        ]
    }


class GenerateStarterSet(BaseModel):
    # Leaves are seeded when requested OR whenever rules are requested (a rule needs its target leaf to
    # exist), so a selected starter rule can never be silently dropped for want of its category.
    include_leaves: bool = True
    rule_keywords: Optional[list[str]] = None


@router.post("/generate-starter")
def generate_starter_set(body: GenerateStarterSet):
    need_leaves = body.include_leaves or body.rule_keywords is not None
    with get_db() as conn:
        before_leaves = conn.execute(
            "SELECT COUNT(*) FROM category WHERE parent_id IS NOT NULL AND is_active = 1"
        ).fetchone()[0]
        _seed_default_categories(conn, include_leaves=need_leaves)
        rules_added = 0
        if body.rule_keywords is not None:
            rules_added = seed_default_rules(conn, keywords=body.rule_keywords)
        after_leaves = conn.execute(
            "SELECT COUNT(*) FROM category WHERE parent_id IS NOT NULL AND is_active = 1"
        ).fetchone()[0]
    return {"categories_added": after_leaves - before_leaves, "rules_added": rules_added}


@router.delete("/{category_id}/forever")
def hard_delete_category(category_id: str):
    """Permanently remove an already-deleted (inactive) category and its inactive branch.

    The irreversible counterpart to /reactivate. Only inactive categories qualify: by the
    soft-delete invariant they are referentially empty — no live transaction or rule points at
    them (see delete_category) — so the rows can be dropped outright. Each affected row's
    transactions were already cleared at soft-delete time, but txn.imported_category *text* is
    left intact, so the only effect is that the label is no longer suppressed: a future import
    bearing it creates a fresh pending leaf instead of landing uncategorized.
    """
    with get_db() as conn:
        cat = conn.execute(
            "SELECT id, is_active FROM category WHERE id = ?", (category_id,)
        ).fetchone()
        if not cat:
            raise HTTPException(status_code=404, detail="Not found")
        if cat["is_active"]:
            raise HTTPException(
                status_code=400,
                detail="Only a deleted (inactive) category can be permanently removed",
            )
        affected_ids = _get_affected_category_ids(conn, category_id)
        placeholders = ",".join("?" for _ in affected_ids)
        # Defensive: refuse if the branch still contains an active row. An active category can have
        # live transactions, and txn.category_id is ON DELETE SET NULL, so dropping it would
        # silently uncategorize them. An all-inactive branch is referentially empty and safe.
        if conn.execute(
            f"SELECT 1 FROM category WHERE is_active = 1 AND id IN ({placeholders})",
            affected_ids,
        ).fetchone():
            raise HTTPException(
                status_code=400,
                detail="Cannot permanently remove a branch that still contains an active category",
            )
        # FK cascades would handle these, but delete explicitly so the result is correct regardless
        # of foreign-key enforcement on the connection.
        conn.execute(f"DELETE FROM category_rule WHERE category_id IN ({placeholders})", affected_ids)
        conn.execute(f"DELETE FROM category_tag WHERE category_id IN ({placeholders})", affected_ids)
        conn.execute(f"DELETE FROM category WHERE id IN ({placeholders})", affected_ids)
    return {"ok": True}


@router.get("/empty-cleanup-preview")
def empty_cleanup_preview():
    """List the empty groups and categories a cleanup sweep would remove (for the confirm dialog)."""
    with get_db() as conn:
        groups, leaves = _compute_empty_cleanup(conn)
    return {
        "groups": [{"id": g["id"], "name": g["name"]} for g in groups],
        "categories": [{"id": l["id"], "name": l["name"]} for l in leaves],
    }


@router.post("/empty-cleanup")
def empty_cleanup():
    """Remove every empty group and category in one pass.

    Empty categories are removed outright (not parked in Inactive): each is soft-deleted to clear
    rules and scrub import-snapshot references via the tested delete path, then purged. Groups left
    childless by that removal (and groups that were already childless) are then deleted. The set is
    recomputed from the DB rather than trusted from the client; see _compute_empty_cleanup.
    """
    with get_db() as conn:
        groups, leaves = _compute_empty_cleanup(conn)
    leaf_ids = [leaf["id"] for leaf in leaves]
    group_ids = [group["id"] for group in groups]
    for leaf_id in leaf_ids:
        delete_category(leaf_id, None)
        hard_delete_category(leaf_id)
    for group_id in group_ids:
        delete_category(group_id, None)
    return {"ok": True, "groups_removed": len(group_ids), "categories_removed": len(leaf_ids)}


@router.post("/{category_id}/set-aside")
def set_category_aside(category_id: str):
    """Park an imported-category leaf out of the "needs sorting" pool without deleting it.

    Set-aside is deliberately NOT a deletion: the category stays active, its existing transactions
    keep it, and future imports of that label still categorize to it. It only stops the label from
    counting as "still waiting" in the imported-category workspace. Only Delete (deactivate)
    removes a category and suppresses its label from future imports.
    """
    with get_db() as conn:
        cat = conn.execute(
            "SELECT id, is_active FROM category WHERE id = ?", (category_id,)
        ).fetchone()
        if not cat:
            raise HTTPException(status_code=404, detail="Not found")
        if not cat["is_active"]:
            raise HTTPException(status_code=400, detail="Cannot set aside a deleted category")
        conn.execute("UPDATE category SET set_aside = 1 WHERE id = ?", (category_id,))
    return {"ok": True}


@router.post("/{category_id}/restore-to-pool")
def restore_category_to_pool(category_id: str):
    """Move a set-aside category back into the active "needs sorting" pool."""
    with get_db() as conn:
        cat = conn.execute(
            "SELECT id FROM category WHERE id = ?", (category_id,)
        ).fetchone()
        if not cat:
            raise HTTPException(status_code=404, detail="Not found")
        conn.execute("UPDATE category SET set_aside = 0 WHERE id = ?", (category_id,))
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
            "SELECT id, system_key, parent_id FROM category WHERE id = ?", (category_id,)
        ).fetchone()
        if not cat:
            raise HTTPException(status_code=404, detail="Not found")
        if cat["system_key"] == UNASSIGNED_CATEGORY_SYSTEM_KEY:
            if body.name is not None:
                raise HTTPException(status_code=400, detail="The Unassigned group cannot be renamed")
            if body.parent_id is not None:
                raise HTTPException(status_code=400, detail="The Unassigned group cannot be moved")
        if cat["system_key"] == REIMBURSABLE_SYSTEM_KEY:
            # Renaming and re-sorting stay open — the feature resolves the group by key, so what it is
            # called is the user's business. Two things are not: the exclusion, and the group's place in
            # the tree. Reparenting it turns the group into a *leaf*, and every lookup that finds it
            # requires `parent_id IS NULL`, so the next write creates a second group while the
            # outstanding balance stays stranded under the moved row — the report then reads zero with
            # nothing having visibly gone wrong.
            if body.exclude_from_totals is not None:
                raise HTTPException(
                    status_code=400, detail=REIMBURSABLE_GROUP_LOCKED % "counted toward spending totals"
                )
            if body.parent_id is not None:
                raise HTTPException(
                    status_code=400, detail=REIMBURSABLE_GROUP_LOCKED % "moved inside another group"
                )
        if cat["system_key"] == TRANSFERS_SYSTEM_KEY and body.parent_id is not None:
            # Reparenting has the same consequence here as it does above: every lookup requires
            # `parent_id IS NULL`, so the next import creates a second Transfers group while the
            # existing money-movement leaves stay under the moved row. The exclusion is not guarded.
            raise HTTPException(
                status_code=400, detail=TRANSFERS_GROUP_LOCKED % "moved inside another group"
            )
        moving = body.parent_id is not None and body.parent_id != cat["parent_id"]
        target_parent = None
        if body.parent_id is not None:
            if body.parent_id == category_id:
                raise HTTPException(status_code=400, detail="A category cannot be placed inside itself.")
            target_parent = _require_group_parent(conn, body.parent_id)
        if moving:
            if conn.execute("SELECT 1 FROM category WHERE parent_id = ? LIMIT 1", (category_id,)).fetchone():
                raise HTTPException(
                    status_code=400,
                    detail="A group that still holds categories cannot be placed inside another group. "
                           "Move its categories out first.",
                )
            if cat["parent_id"] and cat["parent_id"] == find_reimbursable_group_id(conn):
                held = _reimbursements_holding(conn, [category_id])
                if held:
                    raise HTTPException(status_code=400, detail=_claims_held_detail(held, moving=True))
        # Kind for the uniqueness check is the row's kind *after* this edit: a rename keeps the
        # existing kind, while a parent_id change can move a row between leaf and group.
        resulting_parent_id = body.parent_id if body.parent_id is not None else cat["parent_id"]
        is_group = not resulting_parent_id
        # A leaf's type is its group's. Reports decide which side a bucket is on by inheritance, and a leaf
        # carrying the other side's type makes a group's total stop equalling the sum of its own slices. So a
        # move rewrites the leaf to its new group's type, a retyped group carries its categories with it, and
        # a leaf cannot be given a type of its own.
        group_type = None
        if not is_group:
            group_row = target_parent or conn.execute(
                "SELECT COALESCE(category_type, 'expense') AS category_type FROM category WHERE id = ?",
                (resulting_parent_id,),
            ).fetchone()
            group_type = group_row["category_type"] if group_row else "expense"
            if body.category_type is not None and body.category_type != group_type:
                raise HTTPException(
                    status_code=400,
                    detail="A category takes its type from its group. Change the group's type, or move the "
                           "category into a group of the other type.",
                )
        fields, params = [], []
        if body.name                is not None: fields.append("name = ?");                 params.append(_ensure_category_name_is_unique(conn, body.name, exclude_id=category_id, is_group=is_group))
        if body.parent_id           is not None: fields.append("parent_id = ?");            params.append(body.parent_id)
        # Moving a category into a real (non-Unassigned) group organizes it — it has left the
        # import workspace for good, so clear the pending flag. Moving into Unassigned does not
        # re-add it to the workspace (a category never returns once it has left).
        if target_parent and target_parent["system_key"] != UNASSIGNED_CATEGORY_SYSTEM_KEY:
            fields.append("import_pending = 0")
        if is_group and body.category_type is not None:
            fields.append("category_type = ?"); params.append(body.category_type)
        elif not is_group and (moving or body.category_type is not None):
            fields.append("category_type = ?"); params.append(group_type)
        if body.sort_order          is not None: fields.append("sort_order = ?");           params.append(body.sort_order)
        if body.exclude_from_totals is not None: fields.append("exclude_from_totals = ?");  params.append(body.exclude_from_totals)
        if fields:
            params.append(category_id)
            conn.execute(f"UPDATE category SET {', '.join(fields)} WHERE id = ?", params)
        if is_group and body.category_type is not None:
            # Inactive children too, so a recovered category comes back on the side its group is on.
            conn.execute(
                "UPDATE category SET category_type = ? WHERE parent_id = ?", (body.category_type, category_id)
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
