# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: GPL-3.0-or-later

"""
Account records now serve two related account-lifecycle models.

- Active root accounts are the selectable/reportable physical accounts the rest of the app works with.
- Child accounts keep historical account numbers visible on the Accounts page while sharing a parent display name elsewhere.
- Trashed child accounts stay recoverable until the trash is emptied, at which point their references are folded into the parent.
"""

import json
import uuid
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.db.database import SHARED_OWNER_NAME, SHARED_OWNER_ID, get_db

router = APIRouter()


class AccountCreate(BaseModel):
    name: str
    type: Optional[str] = None
    owner_id: Optional[str] = None


class AccountUpdate(BaseModel):
    owner_id: Optional[str] = None
    name: Optional[str] = None
    type: Optional[str] = None


class AccountAttachRequest(BaseModel):
    parent_account_id: str


def _normalize_match_value(value: Optional[str]) -> str:
    return (value or "").strip().lower()


def _serialize_account(row) -> dict:
    """Convert a db row to a dict, adding is_shared for the shared owner account."""
    d = dict(row)
    d["is_shared"] = d.get("owner_id") == SHARED_OWNER_ID
    return d


def _get_account_row(conn, account_id: str):
    return conn.execute(
        """
        SELECT
            a.id,
            a.name,
            a.display_name,
            a.institution,
            a.type,
            a.subtype,
            a.mask,
            a.owner_id,
            a.parent_account_id,
            a.trashed_at,
            a.plaid_item_id,
            o.name AS owner_name,
            o.color AS owner_color
        FROM account a
        LEFT JOIN owner o ON o.id = a.owner_id
        WHERE a.id = ?
        """,
        (account_id,),
    ).fetchone()


def _list_account_rows(conn, *, include_children: bool, include_trashed: bool):
    clauses = []
    params: list[str] = []
    if not include_children:
        clauses.append("a.parent_account_id IS NULL")
    if not include_trashed:
        clauses.append("a.trashed_at IS NULL")
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    return conn.execute(
        f"""
        SELECT
            a.id,
            a.name,
            a.display_name,
            a.institution,
            a.type,
            a.subtype,
            a.mask,
            a.owner_id,
            a.parent_account_id,
            a.trashed_at,
            a.plaid_item_id,
            o.name AS owner_name,
            o.color AS owner_color
        FROM account a
        LEFT JOIN owner o ON o.id = a.owner_id
        {where}
        ORDER BY
            CASE WHEN a.parent_account_id IS NULL THEN 0 ELSE 1 END,
            LOWER(COALESCE(a.display_name, a.name)),
            LOWER(a.name),
            a.id
        """,
        params,
    ).fetchall()


def _get_child_count(conn, account_id: str) -> int:
    return conn.execute(
        "SELECT COUNT(*) FROM account WHERE parent_account_id = ? AND trashed_at IS NULL",
        (account_id,),
    ).fetchone()[0]


def _assert_owner_exists(conn, owner_id: Optional[str]) -> Optional[str]:
    owner_val = owner_id.strip() if owner_id else None
    if not owner_val:
        return None
    owner = conn.execute("SELECT id FROM owner WHERE id = ?", (owner_val,)).fetchone()
    if not owner:
        raise HTTPException(status_code=404, detail="Owner not found")
    return owner_val


def _set_root_display_name(conn, account_id: str, display_name: str):
    conn.execute(
        "UPDATE account SET display_name = ? WHERE id = ?",
        (display_name, account_id),
    )
    conn.execute(
        "UPDATE account SET display_name = ? WHERE parent_account_id = ?",
        (display_name, account_id),
    )


def _replace_account_reference_in_profile_column_maps(conn, source_account_id: str, target_account_id: str):
    rows = conn.execute(
        "SELECT id, column_map FROM csv_import_profile"
    ).fetchall()
    for row in rows:
        column_map = {}
        try:
            parsed = json.loads(row["column_map"] or "{}")
            if isinstance(parsed, dict):
                column_map = parsed
        except Exception:
            continue
        assignments = column_map.get("account_assignments")
        if not isinstance(assignments, dict):
            continue
        changed = False
        next_assignments = {}
        for csv_value, account_id in assignments.items():
            if account_id == source_account_id:
                next_assignments[csv_value] = target_account_id
                changed = True
            else:
                next_assignments[csv_value] = account_id
        if changed:
            column_map["account_assignments"] = next_assignments
            conn.execute(
                "UPDATE csv_import_profile SET column_map = ? WHERE id = ?",
                (json.dumps(column_map), row["id"]),
            )


def _replace_account_reference_in_batch_snapshots(conn, source_account_id: str, target_account_id: str):
    rows = conn.execute(
        "SELECT id, config_snapshot FROM import_batch WHERE config_snapshot IS NOT NULL AND TRIM(config_snapshot) <> ''"
    ).fetchall()
    for row in rows:
        snapshot = {}
        try:
            parsed = json.loads(row["config_snapshot"] or "{}")
            if isinstance(parsed, dict):
                snapshot = parsed
        except Exception:
            continue

        changed = False
        if snapshot.get("account_id") == source_account_id:
            snapshot["account_id"] = target_account_id
            changed = True
        account_map = snapshot.get("account_map")
        if isinstance(account_map, dict):
            next_account_map = {}
            map_changed = False
            for csv_value, account_id in account_map.items():
                if account_id == source_account_id:
                    next_account_map[csv_value] = target_account_id
                    map_changed = True
                else:
                    next_account_map[csv_value] = account_id
            if map_changed:
                snapshot["account_map"] = next_account_map
                changed = True

        if changed:
            conn.execute(
                "UPDATE import_batch SET config_snapshot = ? WHERE id = ?",
                (json.dumps(snapshot), row["id"]),
            )


def _finalize_trashed_account(conn, account_row):
    source_account_id = account_row["id"]
    target_account_id = account_row["parent_account_id"]
    if target_account_id:
        conn.execute(
            "UPDATE txn SET account_id = ? WHERE account_id = ?",
            (target_account_id, source_account_id),
        )
        conn.execute(
            "UPDATE category_rule SET account_id = ? WHERE account_id = ?",
            (target_account_id, source_account_id),
        )
        conn.execute(
            "UPDATE csv_import_profile SET account_id = ? WHERE account_id = ?",
            (target_account_id, source_account_id),
        )
        conn.execute(
            "UPDATE import_batch_account SET account_id = ? WHERE account_id = ?",
            (target_account_id, source_account_id),
        )
        _replace_account_reference_in_profile_column_maps(conn, source_account_id, target_account_id)
        _replace_account_reference_in_batch_snapshots(conn, source_account_id, target_account_id)
    else:
        conn.execute("DELETE FROM txn WHERE account_id = ?", (source_account_id,))
        conn.execute("DELETE FROM category_rule WHERE account_id = ?", (source_account_id,))
        conn.execute("UPDATE csv_import_profile SET account_id = NULL WHERE account_id = ?", (source_account_id,))
        conn.execute("UPDATE import_batch_account SET account_id = NULL WHERE account_id = ?", (source_account_id,))
        _replace_account_reference_in_profile_column_maps(conn, source_account_id, "")
        _replace_account_reference_in_batch_snapshots(conn, source_account_id, "")

    conn.execute("DELETE FROM account WHERE id = ?", (source_account_id,))


def resolve_default_owner_id(conn, owner_id: Optional[str]) -> Optional[str]:
    # New accounts only inherit an owner automatically when the choice is unambiguous.
    # Once a household has multiple personal owners, leaving the account unassigned is
    # safer than guessing and backfilling the wrong owner across imported history.
    explicit_owner_id = owner_id.strip() if owner_id else None
    if explicit_owner_id:
        owner = conn.execute("SELECT id FROM owner WHERE id = ?", (explicit_owner_id,)).fetchone()
        if not owner:
            raise HTTPException(status_code=404, detail="Owner not found")
        return explicit_owner_id

    owners = conn.execute(
        "SELECT id FROM owner WHERE LOWER(name) <> LOWER(?) ORDER BY name",
        (SHARED_OWNER_NAME,),
    ).fetchall()
    if len(owners) == 1:
        return owners[0]["id"]
    return None


@router.get("")
def list_accounts(include_children: bool = False, include_trashed: bool = False):
    with get_db() as conn:
        rows = _list_account_rows(conn, include_children=include_children, include_trashed=include_trashed)
    return [_serialize_account(r) for r in rows]


@router.get("/trash")
def list_trashed_accounts():
    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT
                a.id,
                a.name,
                a.display_name,
                a.type,
                a.owner_id,
                a.parent_account_id,
                a.trashed_at,
                p.name AS parent_name,
                p.display_name AS parent_display_name,
                o.name AS owner_name
            FROM account a
            LEFT JOIN account p ON p.id = a.parent_account_id
            LEFT JOIN owner o ON o.id = a.owner_id
            WHERE a.trashed_at IS NOT NULL
            ORDER BY a.trashed_at DESC, LOWER(a.name), a.id
            """
        ).fetchall()
    return [dict(r) for r in rows]


@router.post("")
def create_account(body: AccountCreate):
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Account name is required")

    account_type = (body.type or "other").strip() or "other"
    with get_db() as conn:
        owner_id = resolve_default_owner_id(conn, body.owner_id)

        account_id = str(uuid.uuid4())
        conn.execute(
            """
            INSERT INTO account
                (id, plaid_account_id, plaid_item_id, name, display_name, institution, type, subtype, mask, owner_id, parent_account_id, trashed_at)
            VALUES (?, NULL, 'manual', ?, ?, NULL, ?, NULL, NULL, ?, NULL, NULL)
            """,
            (account_id, name, name, account_type, owner_id),
        )
        row = _get_account_row(conn, account_id)
    return _serialize_account(row)


@router.patch("/{account_id}")
def update_account(account_id: str, body: AccountUpdate):
    with get_db() as conn:
        acc = _get_account_row(conn, account_id)
        if not acc:
            raise HTTPException(status_code=404, detail="Account not found")

        has_children = _get_child_count(conn, account_id) > 0
        grouped = bool(acc["parent_account_id"]) or has_children

        if body.name is not None and body.name.strip():
            next_name = body.name.strip()
            conn.execute(
                "UPDATE account SET name = ? WHERE id = ?",
                (next_name, account_id),
            )
            if not acc["parent_account_id"]:
                _set_root_display_name(conn, account_id, next_name)

        if body.type is not None and body.type.strip():
            if grouped:
                raise HTTPException(status_code=400, detail="Ungroup this account before changing its type")
            conn.execute(
                "UPDATE account SET type = ? WHERE id = ?",
                (body.type.strip(), account_id),
            )

        if body.owner_id is not None:
            owner_val = _assert_owner_exists(conn, body.owner_id if body.owner_id != "" else None)
            conn.execute(
                "UPDATE account SET owner_id = ? WHERE id = ?",
                (owner_val, account_id),
            )
            # Account ownership is the default source of truth for imported rows, so
            # historical transactions stay aligned when the account owner changes.
            conn.execute(
                "UPDATE txn SET owner_id = ? WHERE account_id = ?",
                (owner_val, account_id),
            )
    return {"ok": True}


@router.post("/{account_id}/attach")
def attach_account(account_id: str, body: AccountAttachRequest):
    with get_db() as conn:
        account = _get_account_row(conn, account_id)
        parent = _get_account_row(conn, body.parent_account_id)
        if not account or not parent:
            raise HTTPException(status_code=404, detail="Account not found")
        if account["trashed_at"] or parent["trashed_at"]:
            raise HTTPException(status_code=400, detail="Restore trashed accounts before regrouping them")
        if account["id"] == parent["id"]:
            raise HTTPException(status_code=400, detail="An account cannot be merged into itself")
        if parent["parent_account_id"]:
            raise HTTPException(status_code=400, detail="Only top-level accounts can accept merged children")
        if _get_child_count(conn, account_id) > 0:
            raise HTTPException(status_code=400, detail="Ungroup this account's children before merging it")

        # Owners are compatible if they match exactly, or if either account belongs to the shared owner.
        source_owner = (account["owner_id"] or "").strip()
        parent_owner = (parent["owner_id"] or "").strip()
        owners_compatible = (
            source_owner == parent_owner
            or source_owner == SHARED_OWNER_ID
            or parent_owner == SHARED_OWNER_ID
        )
        if not owners_compatible:
            raise HTTPException(status_code=400, detail="Only accounts with the same owner can be merged")
        if _normalize_match_value(account["type"]) != _normalize_match_value(parent["type"]):
            raise HTTPException(status_code=400, detail="Only accounts with the same type can be merged")

        conn.execute(
            "UPDATE account SET parent_account_id = ?, display_name = ?, trashed_at = NULL WHERE id = ?",
            (parent["id"], parent["display_name"] or parent["name"], account["id"]),
        )
    return {"ok": True}


@router.post("/{account_id}/detach")
def detach_account(account_id: str):
    with get_db() as conn:
        account = _get_account_row(conn, account_id)
        if not account:
            raise HTTPException(status_code=404, detail="Account not found")
        conn.execute(
            "UPDATE account SET parent_account_id = NULL, display_name = name, trashed_at = NULL WHERE id = ?",
            (account_id,),
        )
    return {"ok": True}


@router.post("/{account_id}/trash")
def trash_account(account_id: str):
    with get_db() as conn:
        account = _get_account_row(conn, account_id)
        if not account:
            raise HTTPException(status_code=404, detail="Account not found")
        if account["trashed_at"]:
            return {"ok": True}
        if not account["parent_account_id"]:
            raise HTTPException(status_code=400, detail="Only merged child accounts can be sent to trash")
        conn.execute(
            "UPDATE account SET trashed_at = ? WHERE id = ?",
            (datetime.utcnow().isoformat(), account_id),
        )
    return {"ok": True}


@router.post("/{account_id}/restore")
def restore_account(account_id: str):
    with get_db() as conn:
        account = _get_account_row(conn, account_id)
        if not account:
            raise HTTPException(status_code=404, detail="Account not found")
        if not account["trashed_at"]:
            return {"ok": True}

        if account["parent_account_id"]:
            parent = _get_account_row(conn, account["parent_account_id"])
            if parent and not parent["trashed_at"]:
                conn.execute(
                    "UPDATE account SET trashed_at = NULL, display_name = ? WHERE id = ?",
                    (parent["display_name"] or parent["name"], account_id),
                )
                return {"ok": True}

        conn.execute(
            "UPDATE account SET parent_account_id = NULL, display_name = name, trashed_at = NULL WHERE id = ?",
            (account_id,),
        )
    return {"ok": True}


@router.post("/trash/empty")
def empty_account_trash():
    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT id, parent_account_id
            FROM account
            WHERE trashed_at IS NOT NULL
            ORDER BY trashed_at ASC, id ASC
            """
        ).fetchall()
        for row in rows:
            _finalize_trashed_account(conn, row)
    return {"ok": True, "emptied": len(rows)}


@router.delete("/{account_id}")
def delete_account(account_id: str):
    with get_db() as conn:
        acc = _get_account_row(conn, account_id)
        if not acc:
            raise HTTPException(status_code=404, detail="Account not found")
        if _get_child_count(conn, account_id) > 0:
            raise HTTPException(status_code=400, detail="Ungroup or trash child accounts before deleting this account")
        conn.execute("DELETE FROM txn WHERE account_id = ?", (account_id,))
        conn.execute("DELETE FROM account WHERE id = ?", (account_id,))
    return {"ok": True}
