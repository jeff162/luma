# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Saved data-source / import-profile CRUD.

A data source (`csv_import_profile`) is reusable mapping/setup configuration for a recurring CSV
format: column map, date/amount conventions, target account, and default imported-category
behavior. This module owns the user-facing lifecycle of those records — list/create/update/delete,
plus the two paths that turn a previously-imported (profileless) batch into a saved source
(`create-from-batch`, `set-profile`) and the compatibility check that finds historical batches a
profile could adopt.

Source-of-truth helpers it leans on (imported-category settings, batch snapshots, the workflow
constants) live in `core`; this module only depends on `core`, never the reverse.
"""

import json
import uuid
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.db.database import get_db
from backend.json_utils import safe_json_dict

from .core import (
    IMPORTED_CATEGORY_SCOPE_ALL,
    UNKNOWN_SOURCE_FALLBACK_KEY,
    _annotate_imported_category_settings,
    _get_imported_category_settings,
    _store_imported_category_settings,
    save_batch_snapshot,
)

router = APIRouter()


class ProfileCreate(BaseModel):
    name:                 str
    filename_pattern:     Optional[str] = None
    header_fingerprint:   Optional[str] = None
    template_filename:    Optional[str] = None
    template_file_hash:   Optional[str] = None
    column_map:           dict
    account_id:           Optional[str] = None
    date_format:          str = "%m/%d/%Y"
    amount_convention:    str = "single_signed"
    skip_rows:            int = 0
    apply_categorization: bool = True
    use_imported_categories: bool = False
    imported_category_scope_mode: str = IMPORTED_CATEGORY_SCOPE_ALL
    imported_category_owner_ids: list[str] = []
    imported_category_unassigned_account_tokens: list[str] = []
    notes:                Optional[str] = None

class ProfileUpdate(BaseModel):
    name:                 Optional[str] = None
    filename_pattern:     Optional[str] = None
    header_fingerprint:   Optional[str] = None
    template_filename:    Optional[str] = None
    template_file_hash:   Optional[str] = None
    column_map:           Optional[dict] = None
    account_id:           Optional[str] = None
    date_format:          Optional[str] = None
    amount_convention:    Optional[str] = None
    skip_rows:            Optional[int] = None
    apply_categorization: Optional[bool] = None
    use_imported_categories: Optional[bool] = None
    imported_category_scope_mode: Optional[str] = None
    imported_category_owner_ids: Optional[list[str]] = None
    imported_category_unassigned_account_tokens: Optional[list[str]] = None
    notes:                Optional[str] = None


class BatchCreateProfileRequest(BaseModel):
    name: str
    # Derived from the file name by the caller (the frontend's `inferFilenamePattern`, same helper the
    # "Save as data source" flow uses) so the new source auto-matches future files the same way.
    filename_pattern: Optional[str] = None


def _normalized_profile_name(value: Optional[str]) -> str:
    return str(value or "").strip()


def _assert_profile_name_available(conn, name: Optional[str], exclude_profile_id: Optional[str] = None) -> str:
    normalized_name = _normalized_profile_name(name)
    if not normalized_name:
        raise HTTPException(status_code=400, detail="Data source name is required")

    existing = conn.execute(
        """
            SELECT id
            FROM   csv_import_profile
            WHERE  lower(trim(name)) = lower(trim(?))
              AND  (? IS NULL OR id != ?)
            LIMIT  1
        """,
        (normalized_name, exclude_profile_id, exclude_profile_id),
    ).fetchone()
    if existing:
        raise HTTPException(
            status_code=409,
            detail=f'A data source named "{normalized_name}" already exists. Choose a different name.',
        )
    return normalized_name


# Source "signature" comparison powers `compatible-batches`: a profile and a profileless batch are
# compatible when their mapping/format/account setup agree closely enough that the profile could own
# the historical file. The normalizer flattens both into the same shape; the comparator is
# deliberately asymmetric in places (e.g. a single-account profile vs. a per-row-account batch).
def _normalize_import_source_signature(source: dict) -> dict:
    column_map = safe_json_dict(source.get("column_map"))
    account_assignments = {
        str(key): str(value)
        for key, value in safe_json_dict(column_map.get("account_assignments")).items()
        if key and value
    }
    account_skips = {
        str(value)
        for value in (column_map.get("account_skips") or [])
        if str(value or "").strip()
    }
    account_new = {
        str(key): {
            "name": str((value or {}).get("name") or "").strip(),
            "type": str((value or {}).get("type") or "depository").strip() or "depository",
        }
        for key, value in safe_json_dict(column_map.get("account_new")).items()
        if key
    }
    single_account_new = safe_json_dict(column_map.get("single_account_new") or source.get("single_account_new"))
    if single_account_new:
        single_account_new = {
            "name": str(single_account_new.get("name") or "").strip(),
            "type": str(single_account_new.get("type") or "depository").strip() or "depository",
        }
    else:
        single_account_new = None

    return {
        "header_fingerprint": str(source.get("header_fingerprint") or "").strip(),
        "date_format": str(source.get("date_format") or "%m/%d/%Y").strip() or "%m/%d/%Y",
        "amount_convention": str(source.get("amount_convention") or "single_signed").strip() or "single_signed",
        "skip_rows": int(source.get("skip_rows") or 0),
        "apply_categorization": bool(source.get("apply_categorization") is not False),
        "account_id": str(source.get("account_id") or "").strip(),
        "column_map": {
            key: str(column_map.get(key) or "").strip()
            for key in ("date", "amount", "debit", "credit", "direction", "description", "category", "notes", "pending", "account")
        },
        "account_assignments": account_assignments,
        "account_skips": account_skips,
        "account_new": account_new,
        "single_account_new": single_account_new,
    }


def _signatures_are_compatible(profile_signature: dict, batch_signature: dict) -> bool:
    if not profile_signature.get("header_fingerprint"):
        return False
    if profile_signature["header_fingerprint"] != batch_signature.get("header_fingerprint"):
        return False
    if profile_signature["date_format"] != batch_signature.get("date_format"):
        return False
    if profile_signature["amount_convention"] != batch_signature.get("amount_convention"):
        return False
    if profile_signature["skip_rows"] != batch_signature.get("skip_rows"):
        return False
    if profile_signature["apply_categorization"] != batch_signature.get("apply_categorization"):
        return False

    profile_map = profile_signature.get("column_map") or {}
    batch_map = batch_signature.get("column_map") or {}
    for key, profile_value in profile_map.items():
        if profile_value != str(batch_map.get(key) or "").strip():
            return False

    profile_account_id = profile_signature.get("account_id") or ""
    batch_account_id = batch_signature.get("account_id") or ""
    if profile_account_id and batch_account_id and profile_account_id != batch_account_id:
        return False

    profile_single_account = profile_signature.get("single_account_new")
    batch_single_account = batch_signature.get("single_account_new")
    if profile_single_account and batch_single_account and profile_single_account != batch_single_account:
        return False
    if profile_single_account and batch_account_id:
        return False
    if batch_single_account and profile_account_id:
        return False

    profile_assignments = profile_signature.get("account_assignments") or {}
    batch_assignments = batch_signature.get("account_assignments") or {}
    profile_skips = profile_signature.get("account_skips") or set()
    batch_skips = batch_signature.get("account_skips") or set()
    profile_new_accounts = profile_signature.get("account_new") or {}
    batch_new_accounts = batch_signature.get("account_new") or {}

    shared_assignment_keys = set(profile_assignments) & set(batch_assignments)
    for key in shared_assignment_keys:
        if profile_assignments[key] != batch_assignments[key]:
            return False

    for key in profile_skips & (set(batch_assignments) | set(batch_new_accounts)):
        return False
    for key in batch_skips & (set(profile_assignments) | set(profile_new_accounts)):
        return False

    shared_new_account_keys = set(profile_new_accounts) & set(batch_new_accounts)
    for key in shared_new_account_keys:
        if profile_new_accounts[key] != batch_new_accounts[key]:
            return False

    if set(profile_new_accounts) & set(batch_assignments):
        return False
    if set(batch_new_accounts) & set(profile_assignments):
        return False

    return True


@router.get("/profiles")
def list_profiles():
    # A data source is user-owned configuration; its visibility must NOT be coupled to the trash
    # state of any account it happens to map. A mapped account can be trashed as a side effect of
    # an account merge (the child is trashed and folds into its parent) or ordinary cleanup, and a
    # stale mapping entry is harmless — the import flow re-resolves accounts at import time. Hiding
    # the profile instead turned it into a ghost: invisible here, yet still blocking its own name
    # in `_assert_profile_name_available` (which scans all rows), so it could be neither edited,
    # deleted, nor recreated. List every profile and let the user manage it.
    with get_db() as conn:
        rows = conn.execute("""
            SELECT p.*, COALESCE(a.display_name, a.name) AS account_name
            FROM   csv_import_profile p
            LEFT JOIN account a ON a.id = p.account_id
            ORDER BY p.name
        """).fetchall()
    result = []
    for r in rows:
        d = dict(r)
        d["column_map"] = safe_json_dict(d["column_map"])
        d = _annotate_imported_category_settings(d, _get_imported_category_settings(d))
        result.append(d)
    return result


@router.post("/profiles")
def create_profile(body: ProfileCreate):
    pid = str(uuid.uuid4())
    with get_db() as conn:
        normalized_name = _assert_profile_name_available(conn, body.name)
        column_map = _store_imported_category_settings(
            body.column_map,
            {
                "scope_mode": body.imported_category_scope_mode,
                "owner_ids": body.imported_category_owner_ids,
                "unassigned_account_tokens": body.imported_category_unassigned_account_tokens,
            },
        )
        conn.execute("""
            INSERT INTO csv_import_profile
              (id, name, filename_pattern, header_fingerprint, template_filename,
               template_file_hash, column_map,
               account_id, date_format, amount_convention, skip_rows,
               apply_categorization, use_imported_categories, notes)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """, (pid, normalized_name, body.filename_pattern, body.header_fingerprint,
              body.template_filename, body.template_file_hash,
              json.dumps(column_map), body.account_id, body.date_format,
              body.amount_convention, body.skip_rows,
              1 if body.apply_categorization else 0,
              1 if body.use_imported_categories else 0,
              body.notes))
    return {"id": pid}


@router.patch("/profiles/{profile_id}")
def update_profile(profile_id: str, body: ProfileUpdate):
    with get_db() as conn:
        row = conn.execute(
            "SELECT id, column_map FROM csv_import_profile WHERE id = ?", (profile_id,)
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Profile not found")
        fields, params = [], []
        if body.name                 is not None: fields.append("name = ?");                 params.append(_assert_profile_name_available(conn, body.name, profile_id))
        if body.filename_pattern     is not None: fields.append("filename_pattern = ?");     params.append(body.filename_pattern)
        if body.header_fingerprint   is not None: fields.append("header_fingerprint = ?");   params.append(body.header_fingerprint)
        if body.template_filename    is not None: fields.append("template_filename = ?");    params.append(body.template_filename)
        if body.template_file_hash   is not None: fields.append("template_file_hash = ?");   params.append(body.template_file_hash)
        if body.account_id           is not None: fields.append("account_id = ?");           params.append(body.account_id)
        if body.date_format          is not None: fields.append("date_format = ?");          params.append(body.date_format)
        if body.amount_convention    is not None: fields.append("amount_convention = ?");    params.append(body.amount_convention)
        if body.skip_rows            is not None: fields.append("skip_rows = ?");            params.append(body.skip_rows)
        if body.apply_categorization is not None: fields.append("apply_categorization = ?"); params.append(1 if body.apply_categorization else 0)
        if body.use_imported_categories is not None: fields.append("use_imported_categories = ?"); params.append(1 if body.use_imported_categories else 0)
        if body.notes                is not None: fields.append("notes = ?");                params.append(body.notes)
        imported_category_fields_present = (
            body.imported_category_scope_mode is not None or
            body.imported_category_owner_ids is not None or
            body.imported_category_unassigned_account_tokens is not None
        )
        if imported_category_fields_present:
            current_column_map = safe_json_dict(row["column_map"])
            current_settings = _get_imported_category_settings({"column_map": current_column_map})
            next_settings = {
                "scope_mode": body.imported_category_scope_mode if body.imported_category_scope_mode is not None else current_settings["scope_mode"],
                "owner_ids": body.imported_category_owner_ids if body.imported_category_owner_ids is not None else current_settings["owner_ids"],
                "unassigned_account_tokens": (
                    body.imported_category_unassigned_account_tokens
                    if body.imported_category_unassigned_account_tokens is not None
                    else current_settings["unassigned_account_tokens"]
                ),
            }
            if body.column_map is not None:
                current_column_map = body.column_map
            fields.append("column_map = ?")
            params.append(json.dumps(_store_imported_category_settings(current_column_map, next_settings)))
        elif body.column_map is not None:
            settings = _get_imported_category_settings({"column_map": safe_json_dict(row["column_map"])})
            fields.append("column_map = ?")
            params.append(json.dumps(_store_imported_category_settings(body.column_map, settings)))
        if fields:
            params.append(profile_id)
            conn.execute(f"UPDATE csv_import_profile SET {', '.join(fields)} WHERE id = ?", params)
    return {"ok": True}


@router.delete("/profiles/{profile_id}")
def delete_profile(profile_id: str):
    with get_db() as conn:
        batches = conn.execute(
            "SELECT id, config_snapshot FROM import_batch WHERE profile_id = ?",
            (profile_id,),
        ).fetchall()
        for batch in batches:
            snapshot = safe_json_dict(batch["config_snapshot"])
            snapshot[UNKNOWN_SOURCE_FALLBACK_KEY] = True
            save_batch_snapshot(conn, batch["id"], snapshot)
        conn.execute("DELETE FROM csv_import_profile WHERE id = ?", (profile_id,))
    return {"ok": True}


@router.get("/profiles/{profile_id}/compatible-batches")
def get_profile_compatible_batches(profile_id: str):
    with get_db() as conn:
        profile = conn.execute(
            """
            SELECT id, name, header_fingerprint, column_map, account_id, date_format,
                   amount_convention, skip_rows, apply_categorization
            FROM   csv_import_profile
            WHERE  id = ?
            """,
            (profile_id,),
        ).fetchone()
        if not profile:
            raise HTTPException(status_code=404, detail="Profile not found")

        profile_signature = _normalize_import_source_signature(dict(profile))
        rows = conn.execute(
            """
            SELECT id, filename, imported_at, row_count, skipped_count, deduped_count,
                   file_content_hash, config_snapshot
            FROM   import_batch
            WHERE  profile_id IS NULL
              AND  status = 'completed'
            ORDER  BY imported_at DESC
            """
        ).fetchall()

    compatible_batches = []
    for row in rows:
        snapshot = safe_json_dict(row["config_snapshot"])
        batch_signature = _normalize_import_source_signature({
            "header_fingerprint": snapshot.get("header_fingerprint"),
            "column_map": snapshot.get("column_map"),
            "account_id": snapshot.get("account_id"),
            "date_format": snapshot.get("date_format"),
            "amount_convention": snapshot.get("amount_convention"),
            "skip_rows": snapshot.get("skip_rows"),
            "apply_categorization": snapshot.get("apply_categorization"),
            "single_account_new": snapshot.get("single_account_new"),
        })
        if not _signatures_are_compatible(profile_signature, batch_signature):
            continue
        compatible_batches.append({
            "id": row["id"],
            "filename": row["filename"],
            "imported_at": row["imported_at"],
            "row_count": row["row_count"],
            "skipped_count": row["skipped_count"],
            "deduped_count": row["deduped_count"],
            "file_content_hash": row["file_content_hash"],
        })

    return {
        "profile_id": profile["id"],
        "profile_name": profile["name"],
        "batches": compatible_batches,
    }


@router.patch("/batches/{batch_id}/profile")
def set_batch_profile(batch_id: str, body: dict):
    """
    Link a previously profileless batch to a newly created profile.
    Used when the user saves a temporary draft as a data source after import —
    the batch record is updated so the file card moves under the new profile
    in the history list.
    Only valid for profileless batches; batches already linked to a profile
    are left unchanged.
    """
    profile_id = (body.get("profile_id") or "").strip()
    if not profile_id:
        raise HTTPException(status_code=400, detail="profile_id is required")
    with get_db() as conn:
        batch = conn.execute(
            "SELECT id, profile_id, config_snapshot FROM import_batch WHERE id = ?", (batch_id,)
        ).fetchone()
        if not batch:
            raise HTTPException(status_code=404, detail="Batch not found")
        if batch["profile_id"]:
            raise HTTPException(status_code=400, detail="Batch is already linked to a profile")
        profile = conn.execute(
            "SELECT id FROM csv_import_profile WHERE id = ?", (profile_id,)
        ).fetchone()
        if not profile:
            raise HTTPException(status_code=404, detail="Profile not found")
        conn.execute(
            "UPDATE import_batch SET profile_id = ? WHERE id = ?",
            (profile_id, batch_id),
        )
        snapshot = safe_json_dict(batch["config_snapshot"])
        if snapshot.get(UNKNOWN_SOURCE_FALLBACK_KEY):
            snapshot[UNKNOWN_SOURCE_FALLBACK_KEY] = False
            save_batch_snapshot(conn, batch_id, snapshot)
    return {"ok": True}


@router.post("/batches/{batch_id}/create-profile")
def create_profile_from_batch(batch_id: str, body: BatchCreateProfileRequest):
    """Create a saved data source from a previously-imported (profileless) batch and link the batch
    to it — the historical-file counterpart to "Create data source" on the active import card. The
    mapping is taken from the batch's own `config_snapshot` (where the live `/batches` payload has
    stripped it), so the new source reuses exactly the column/account/date/amount setup the file was
    imported with. Only valid for profileless batches."""
    with get_db() as conn:
        batch = conn.execute(
            "SELECT id, profile_id, filename, file_content_hash, config_snapshot, use_imported_categories "
            "FROM import_batch WHERE id = ?",
            (batch_id,),
        ).fetchone()
        if not batch:
            raise HTTPException(status_code=404, detail="Batch not found")
        if batch["profile_id"]:
            raise HTTPException(status_code=400, detail="Batch is already linked to a data source")
        normalized_name = _assert_profile_name_available(conn, body.name)
        snapshot = safe_json_dict(batch["config_snapshot"])
        # The snapshot's column_map already carries any imported-category settings from the import,
        # so it is reused as-is rather than re-derived.
        column_map = snapshot.get("column_map") if isinstance(snapshot.get("column_map"), dict) else {}
        pid = str(uuid.uuid4())
        conn.execute("""
            INSERT INTO csv_import_profile
              (id, name, filename_pattern, header_fingerprint, template_filename,
               template_file_hash, column_map,
               account_id, date_format, amount_convention, skip_rows,
               apply_categorization, use_imported_categories, notes)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """, (
            pid, normalized_name, (body.filename_pattern or None), snapshot.get("header_fingerprint"),
            batch["filename"], batch["file_content_hash"],
            json.dumps(column_map), snapshot.get("account_id"),
            snapshot.get("date_format") or "%m/%d/%Y",
            snapshot.get("amount_convention") or "single_signed",
            int(snapshot.get("skip_rows") or 0),
            1 if snapshot.get("apply_categorization", True) else 0,
            1 if batch["use_imported_categories"] else 0,
            None,
        ))
        conn.execute("UPDATE import_batch SET profile_id = ? WHERE id = ?", (pid, batch_id))
        if snapshot.get(UNKNOWN_SOURCE_FALLBACK_KEY):
            snapshot[UNKNOWN_SOURCE_FALLBACK_KEY] = False
            save_batch_snapshot(conn, batch_id, snapshot)
    return {"id": pid}
