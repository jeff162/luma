# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: GPL-3.0-or-later

"""
Import/export is a long-lived workflow, not a single upload endpoint.

This router preserves the mapping context that produced each batch so preview,
import, undo, category review, rule suggestion review, and backup/restore can
all reopen or replay the same decisions without drifting from the original run.
"""

import csv
import hashlib
import io
import json
import uuid
import zipfile
import os
from base64 import urlsafe_b64decode, urlsafe_b64encode
from datetime import datetime, date
from typing import Optional

from fastapi import APIRouter, HTTPException, Query, UploadFile, File, Form, Request
from fastapi.responses import StreamingResponse, JSONResponse
from pydantic import BaseModel
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from backend.db.database import get_db
from backend.db.control_database import auth_required, get_local_preference_profile
from backend.json_utils import safe_json_dict
from backend.routers.accounts import resolve_default_owner_id
from backend.services import crypto_service
from backend.services.categorizer import categorize_transaction

router = APIRouter()

MAX_DISTINCT_VALUES_PER_COLUMN = 500
RULE_SUGGESTION_REVIEW_KEY = "rule_suggestion_review"
RULE_SUGGESTION_REVIEW_STATUSES = {"accepted", "skipped", "discarded"}
IMPORT_SUMMARY_KEY = "import_summary"
UNKNOWN_SOURCE_FALLBACK_KEY = "unknown_source_fallback"


def _developer_options_enabled() -> bool:
    return str(os.getenv("FINTRACK_DEVELOPER_OPTIONS", "")).strip().lower() in {"1", "true", "yes", "on"}


def _require_developer_access(request: Request):
    if not _developer_options_enabled():
        raise HTTPException(status_code=404, detail="Developer options are not enabled")
    if auth_required():
        user = getattr(request.state, "user", None)
        if not user:
            raise HTTPException(status_code=401, detail="Not authenticated")
        return user
    profile_id = (request.headers.get("X-Fintrack-Preference-Profile") or "").strip()
    if not profile_id:
        raise HTTPException(status_code=400, detail="Preference profile is required")
    profile = get_local_preference_profile(profile_id)
    if not profile:
        raise HTTPException(status_code=404, detail="Preference profile not found")
    return profile


class ColumnMap(BaseModel):
    date:         str
    amount:       Optional[str] = None
    debit:        Optional[str] = None
    credit:       Optional[str] = None
    direction:    Optional[str] = None
    pending:      Optional[str] = None
    description:  str
    category:     Optional[str] = None
    notes:        Optional[str] = None
    account:      Optional[str] = None

class ImportRunRequest(BaseModel):
    profile_id:           Optional[str] = None
    filename:             str
    account_id:           Optional[str] = None
    account_map:          Optional[dict] = None
    skip_accounts:        Optional[list] = None
    new_accounts:         Optional[list] = None
    date_format:          str = "%m/%d/%Y"
    amount_convention:    str = "single_signed"
    column_map:           ColumnMap
    skip_rows:            int = 0
    apply_categorization: bool = True
    replace_batch_id:     Optional[str] = None
    rows:                 list[dict]

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
    notes:                Optional[str] = None


class BatchCategoryMappingApplyRequest(BaseModel):
    assignments: dict[str, str]


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


class BatchCategoryWorkspaceDraftRequest(BaseModel):
    draft: Optional[dict] = None


class BatchRuleSuggestionReviewUpdateRequest(BaseModel):
    suggestion_id: str
    status: str
    rule_id: Optional[str] = None
    merchant_label: Optional[str] = None
    target_category_name: Optional[str] = None
    keyword: Optional[str] = None


class BatchRuleSuggestionMatchRequest(BaseModel):
    keyword: str
    reference_target_category_id: Optional[str] = None
    owner_id: Optional[str] = None
    account_id: Optional[str] = None
    amount_min: Optional[float] = None
    amount_max: Optional[float] = None


class BatchDuplicateImportRequest(BaseModel):
    row_numbers: Optional[list[int]] = None
    import_all: bool = False


class BackupRecipientCreate(BaseModel):
    label: str
    public_key: str
    enabled: bool = True


class BackupRecipientUpdate(BaseModel):
    label: Optional[str] = None
    enabled: Optional[bool] = None

def make_hash(date_str: str, amount: float, description: str) -> str:
    raw = f"{date_str.strip()}|{amount:.2f}|{description.strip().lower()}"
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def make_import_file_hash(text: str) -> str:
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    normalized = normalized.lstrip("\ufeff")
    normalized = normalized.rstrip("\n")
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def _normalize_import_row_values(row: dict, headers: list[str]) -> dict:
    normalized = {}
    for header in headers:
        normalized[header] = str(row.get(header, "") or "")
    return normalized


def _insert_imported_transaction(conn, batch_id: str, payload: dict) -> str:
    txn_id = str(uuid.uuid4())
    conn.execute("""
        INSERT INTO txn
          (id, account_id, owner_id, category_id, amount, merchant_name,
           display_name, raw_name, date, is_pending, content_hash, import_batch_id, imported_category, notes, category_overridden)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    """, (
        txn_id,
        payload.get("account_id"),
        payload.get("owner_id"),
        payload.get("category_id"),
        payload.get("amount"),
        payload.get("merchant_name"),
        payload.get("display_name"),
        payload.get("raw_name"),
        payload.get("date"),
        int(payload.get("is_pending") or 0),
        payload.get("content_hash"),
        batch_id,
        payload.get("imported_category"),
        payload.get("notes"),
        int(payload.get("category_overridden") or 0),
    ))
    return txn_id


def _save_batch_duplicate_rows(conn, batch_id: str, duplicate_rows: list[dict]) -> None:
    if not duplicate_rows:
        return
    conn.executemany(
        """
        INSERT OR REPLACE INTO import_batch_duplicate
          (batch_id, row_number, reason, values_json, matched_transaction_json, txn_payload_json)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        [
            (
                batch_id,
                int(entry.get("row") or 0),
                str(entry.get("reason") or "Matches an existing transaction"),
                json.dumps(entry.get("values") or {}),
                json.dumps(entry.get("matched_transaction") or {}),
                json.dumps(entry.get("txn_payload")) if isinstance(entry.get("txn_payload"), dict) else None,
            )
            for entry in duplicate_rows
        ],
    )


def _load_batch_duplicate_details(conn, batch_row) -> tuple[list[str], list[dict]]:
    rows = conn.execute(
        """
        SELECT row_number, reason, values_json, matched_transaction_json, txn_payload_json
        FROM   import_batch_duplicate
        WHERE  batch_id = ?
        ORDER  BY row_number
        """,
        (batch_row["id"],),
    ).fetchall()

    snapshot = safe_json_dict(batch_row["config_snapshot"])
    summary = snapshot.get(IMPORT_SUMMARY_KEY) if isinstance(snapshot.get(IMPORT_SUMMARY_KEY), dict) else {}
    headers = summary.get("duplicate_headers") if isinstance(summary.get("duplicate_headers"), list) else []

    if rows:
        details = []
        for row in rows:
            try:
                values = json.loads(row["values_json"]) if row["values_json"] else {}
            except Exception:
                values = {}
            try:
                matched_transaction = json.loads(row["matched_transaction_json"]) if row["matched_transaction_json"] else {}
            except Exception:
                matched_transaction = {}
            try:
                txn_payload = json.loads(row["txn_payload_json"]) if row["txn_payload_json"] else None
            except Exception:
                txn_payload = None
            details.append({
                "row": row["row_number"],
                "kind": "duplicate",
                "reason": row["reason"],
                "values": values if isinstance(values, dict) else {},
                "matched_transaction": matched_transaction if isinstance(matched_transaction, dict) else {},
                "txn_payload": txn_payload if isinstance(txn_payload, dict) else None,
            })
        return headers, details

    # Backward compatibility for batches created before duplicate details moved into their own table.
    legacy_rows = summary.get("duplicate_rows")
    if isinstance(legacy_rows, list):
        return headers, legacy_rows
    return headers, []

def summarize_category_workspace_draft(draft: Optional[dict]) -> Optional[dict]:
    """
    Return {total_count, remaining_count} for a category workspace draft,
    mirroring the summarizeCategoryWorkspaceDraft logic in the frontend.
    Returns None if there is no draft or it contains no source values.
    total_count  — all source values ever seen (pending + set-aside + placed in tree).
    remaining_count — items still in the pending (sourceOrder) bucket.
    """
    if not isinstance(draft, dict):
        return None
    snapshot = draft.get("snapshot")
    if not isinstance(snapshot, dict):
        return None

    seen: set = set()

    def add(value):
        normalized = str(value or "").strip()
        if normalized:
            seen.add(normalized)

    for v in snapshot.get("sourceOrder") or []:
        add(v)
    for v in snapshot.get("setAsideOrder") or []:
        add(v)
    tree = snapshot.get("tree") or {}
    for section in ("income", "expense"):
        for group in tree.get(section) or []:
            for child in group.get("children") or []:
                add(child.get("sourceValue") or child.get("name"))

    total_count = len(seen)
    if total_count == 0:
        return None

    remaining_count = len(snapshot.get("sourceOrder") or [])
    return {"total_count": total_count, "remaining_count": remaining_count}


def _load_live_category_workspace_seed(conn) -> tuple[dict, set[str]]:
    groups = conn.execute(
        """
        SELECT id, name, category_type
        FROM   category
        WHERE  parent_id IS NULL
        ORDER  BY name
        """
    ).fetchall()
    live_leaf_rows = conn.execute(
        """
        SELECT name
        FROM   category
        WHERE  parent_id IS NOT NULL
        """
    ).fetchall()

    tree = {"income": [], "expense": []}
    collapsed_groups = {}
    for group in groups:
        section = "income" if group["category_type"] == "income" else "expense"
        tree[section].append({
            "id": group["id"],
            "name": str(group["name"] or "").strip(),
            "categoryType": section,
            "children": [],
        })
        collapsed_groups[group["id"]] = True

    existing_leaf_names = {
        normalize_import_category(row["name"])
        for row in live_leaf_rows
        if str(row["name"] or "").strip()
    }
    return {"tree": tree, "collapsed_groups": collapsed_groups}, existing_leaf_names


def build_category_workspace_draft(conn, source_values: list[str]) -> Optional[dict]:
    seed, existing_leaf_names = _load_live_category_workspace_seed(conn)
    seen_values: set[str] = set()
    pending_values: list[str] = []

    for value in source_values or []:
        raw_value = str(value or "").strip()
        normalized = normalize_import_category(raw_value)
        if not normalized or normalized in seen_values or normalized in existing_leaf_names:
            continue
        seen_values.add(normalized)
        pending_values.append(raw_value)

    if not pending_values:
        return None

    pending_values.sort(key=lambda value: value.lower())
    return {
        "snapshot": {
            "tree": seed["tree"],
            "sourceOrder": pending_values,
            "setAsideOrder": [],
            "selectedSourceIds": [],
            "selectedNodeId": None,
            "collapsedGroups": seed["collapsed_groups"],
        },
        "undoStack": [],
        "redoStack": [],
        "selectionAnchor": None,
        "activeSection": "expense",
    }


def build_batch_category_workspace_draft(conn, batch_id: str) -> Optional[dict]:
    rows = conn.execute(
        """
        SELECT imported_category, COUNT(*) AS row_count
        FROM   txn
        WHERE  import_batch_id = ?
          AND  imported_category IS NOT NULL
          AND  TRIM(imported_category) <> ''
        GROUP  BY imported_category
        ORDER  BY COUNT(*) DESC, imported_category
        """,
        (batch_id,),
    ).fetchall()
    return build_category_workspace_draft(
        conn,
        [row["imported_category"] for row in rows],
    )


def get_rule_suggestion_review_state(snapshot: dict) -> dict:
    # Batch snapshots can predate rule-review support or contain partial state; normalize
    # the shape here so review endpoints can round-trip older imports without migrations.
    review_state = snapshot.get(RULE_SUGGESTION_REVIEW_KEY)
    if not isinstance(review_state, dict):
        review_state = {}

    suggestions = review_state.get("suggestions")
    statuses = review_state.get("statuses")
    review_state["suggestions"] = suggestions if isinstance(suggestions, dict) else {}
    review_state["statuses"] = statuses if isinstance(statuses, dict) else {}
    return review_state


def summarize_rule_suggestion_review(review_state: dict) -> dict:
    suggestions = review_state.get("suggestions") or {}
    statuses = review_state.get("statuses") or {}

    accepted_count = 0
    skipped_count = 0
    discarded_count = 0
    pending_count = 0

    for suggestion_id in suggestions:
        status = (statuses.get(suggestion_id) or {}).get("status")
        if status == "accepted":
            accepted_count += 1
        elif status == "discarded":
            discarded_count += 1
        elif status == "skipped":
            skipped_count += 1
        else:
            pending_count += 1

    summary = {
        "total_count": len(suggestions),
        "reviewed_count": accepted_count + skipped_count + discarded_count,
        "discarded_count": discarded_count,
        "accepted_count": accepted_count,
        "skipped_count": skipped_count,
        "pending_count": pending_count,
    }
    review_state["summary"] = summary
    return summary


def refresh_rule_suggestion_review(review_state: dict, suggestions: list[dict]) -> dict:
    existing_entries = review_state.get("suggestions") or {}
    statuses = review_state.get("statuses") or {}
    next_entries = {}

    for suggestion in suggestions:
        suggestion_id = suggestion["id"]
        next_entries[suggestion_id] = {
            "merchant_label": suggestion.get("merchant_label"),
            "target_category_name": suggestion.get("target_category_name"),
            "keyword": suggestion.get("keyword"),
        }

    for suggestion_id, entry in existing_entries.items():
        status = (statuses.get(suggestion_id) or {}).get("status")
        if suggestion_id not in next_entries and status in RULE_SUGGESTION_REVIEW_STATUSES:
            next_entries[suggestion_id] = entry if isinstance(entry, dict) else {}

    review_state["suggestions"] = next_entries
    now = datetime.utcnow().isoformat()
    if not review_state.get("generated_at"):
        review_state["generated_at"] = now
    review_state["last_generated_at"] = now
    return summarize_rule_suggestion_review(review_state)


def _load_profile_column_map(conn, profile_id: str) -> dict:
    row = conn.execute(
        "SELECT column_map FROM csv_import_profile WHERE id = ?",
        (profile_id,),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Profile not found")
    return safe_json_dict(row["column_map"])


def _save_profile_column_map(conn, profile_id: str, column_map: dict) -> None:
    conn.execute(
        "UPDATE csv_import_profile SET column_map = ? WHERE id = ?",
        (json.dumps(column_map or {}), profile_id),
    )


def _get_profile_rule_suggestion_review_state(column_map: dict) -> dict:
    return get_rule_suggestion_review_state(column_map if isinstance(column_map, dict) else {})


def _query_rule_suggestion_rows(conn, *, batch_id: Optional[str] = None, profile_id: Optional[str] = None):
    if batch_id:
        return conn.execute(
            """
            SELECT
                t.id,
                t.account_id,
                t.owner_id,
                t.amount,
                t.merchant_name,
                t.display_name,
                t.raw_name,
                t.imported_category,
                t.category_id,
                t.category_overridden,
                t.import_batch_id,
                a.name AS account_name,
                o.name AS owner_name
            FROM txn t
            LEFT JOIN account a ON a.id = t.account_id
            LEFT JOIN owner o ON o.id = t.owner_id
            WHERE t.import_batch_id = ?
              AND t.imported_category IS NOT NULL
              AND TRIM(t.imported_category) <> ''
              AND t.category_id IS NULL
            """,
            (batch_id,),
        ).fetchall()

    if profile_id:
        return conn.execute(
            """
            SELECT
                t.id,
                t.account_id,
                t.owner_id,
                t.amount,
                t.merchant_name,
                t.display_name,
                t.raw_name,
                t.imported_category,
                t.category_id,
                t.category_overridden,
                t.import_batch_id,
                a.name AS account_name,
                o.name AS owner_name
            FROM txn t
            JOIN import_batch b ON b.id = t.import_batch_id
            LEFT JOIN account a ON a.id = t.account_id
            LEFT JOIN owner o ON o.id = t.owner_id
            WHERE b.profile_id = ?
              AND b.status = 'completed'
              AND t.imported_category IS NOT NULL
              AND TRIM(t.imported_category) <> ''
              AND t.category_id IS NULL
            """,
            (profile_id,),
        ).fetchall()

    return []


def _build_rule_suggestion_response(conn, rows, review_state: dict, selected_owner_ids: list[str]) -> dict:
    review_statuses = review_state.get("statuses") or {}
    candidate_rows = [dict(row) for row in rows if str(row["imported_category"] or "").strip()]

    if selected_owner_ids:
        unowned_accounts = sorted({
            row["account_name"] or "Unnamed account"
            for row in candidate_rows
            if not row["owner_id"]
        })
        if unowned_accounts:
            review_summary = review_state.get("summary")
            if not isinstance(review_summary, dict):
                review_summary = summarize_rule_suggestion_review(review_state)
            return {
                "requires_owner_resolution": True,
                "unowned_accounts": unowned_accounts,
                "present_owner_ids": sorted({row["owner_id"] for row in candidate_rows if row["owner_id"]}),
                "suggestions": [],
                "suggestion_count": 0,
                "review_summary": review_summary,
                "generated_at": review_state.get("generated_at"),
                "should_persist": False,
            }

    categories_by_name, categories_by_id = _load_import_rule_target_maps(conn)
    all_by_keyword: dict[str, list[dict]] = {}

    for base_row in candidate_rows:
        row = dict(base_row)
        if selected_owner_ids and row["owner_id"] not in selected_owner_ids:
            continue

        keyword = normalize_rule_keyword(
            row["display_name"] or row["merchant_name"] or row["raw_name"] or ""
        )
        if not keyword:
            continue

        row["rule_keyword"] = keyword
        row["target_category_id"], row["target_category_name"], row["target_category_group_name"] = _resolve_import_rule_target(
            row,
            categories_by_name,
            categories_by_id,
        )
        if not row["target_category_id"]:
            continue
        all_by_keyword.setdefault(keyword, []).append(row)

    suggestions = []
    for keyword, keyword_rows in all_by_keyword.items():
        owner_targets = {}
        for row in keyword_rows:
            owner_targets.setdefault(row["owner_id"] or "__none__", set()).add(
                row["target_category_id"] or f"name:{row['target_category_name']}"
            )

        needs_owner_scope = len(owner_targets) > 1 and len({tuple(sorted(values)) for values in owner_targets.values()}) > 1
        scopes = {}
        if needs_owner_scope:
            for row in keyword_rows:
                scopes.setdefault(row["owner_id"] or "__none__", []).append(row)
        else:
            scopes["__global__"] = keyword_rows

        for scope_key, scope_rows in scopes.items():
            by_target = {}
            for row in scope_rows:
                target_key = row["target_category_id"] or f"name:{row['target_category_name']}"
                by_target.setdefault(target_key, []).append(row)

            account_sets = {
                key: {row["account_id"] for row in rows_for_target if row["account_id"]}
                for key, rows_for_target in by_target.items()
            }
            account_scoped = (
                len(by_target) > 1 and
                all(len(values) == 1 for values in account_sets.values()) and
                len({next(iter(values)) for values in account_sets.values() if values}) == len(by_target)
            )

            ranges = {
                key: (
                    min(abs(row["amount"]) for row in rows_for_target),
                    max(abs(row["amount"]) for row in rows_for_target),
                )
                for key, rows_for_target in by_target.items()
            }
            amount_scoped = len(by_target) > 1
            if amount_scoped:
                ordered = list(ranges.items())
                for i, (_, (min_a, max_a)) in enumerate(ordered):
                    for _, (min_b, max_b) in ordered[i + 1:]:
                        if max_a >= min_b and max_b >= min_a:
                            amount_scoped = False
                            break
                    if not amount_scoped:
                        break

            for target_key, target_rows in by_target.items():
                sample_row = target_rows[0]
                merchant_label = sample_row["display_name"] or sample_row["merchant_name"] or sample_row["raw_name"] or keyword
                clean_name_suggestion = suggest_rule_clean_name(merchant_label)
                amount_min, amount_max = ranges[target_key]
                needs_resolution = len(by_target) > 1 and not account_scoped and not amount_scoped
                conflict_group_id = f"{keyword}:{scope_key}" if needs_resolution else None
                conflict_group_total_rows = sum(len(rows_for_target) for rows_for_target in by_target.values()) if needs_resolution else len(target_rows)
                resolution_reason = None
                if needs_resolution:
                    conflict_names = sorted({
                        rows_for_target[0]["target_category_name"] or "Choose category"
                        for other_key, rows_for_target in by_target.items()
                        if other_key != target_key
                    })
                    resolution_reason = (
                        "Conflicts with other categories for the same merchant. "
                        f"Adjust amount, owner, or account filters to separate {', '.join(conflict_names)}."
                    )

                suggestion = {
                    "id": f"{keyword}:{scope_key}:{target_key}",
                    "keyword": keyword,
                    "merchant_label": merchant_label,
                    "clean_name_suggestion": clean_name_suggestion,
                    "target_category_id": sample_row["target_category_id"],
                    "target_category_name": sample_row["target_category_name"],
                    "target_category_group_name": sample_row.get("target_category_group_name"),
                    "owner_id": None if scope_key == "__global__" else sample_row["owner_id"],
                    "owner_name": None if scope_key == "__global__" else sample_row["owner_name"],
                    "account_id": next(iter(account_sets[target_key])) if account_scoped and account_sets[target_key] else None,
                    "account_name": sample_row["account_name"] if account_scoped else None,
                    "amount_min": amount_min if amount_scoped else None,
                    "amount_max": amount_max if amount_scoped else None,
                    "txn_count": len(target_rows),
                    "conflict_count": max(0, len(by_target) - 1) if needs_resolution else 0,
                    "conflict_group_id": conflict_group_id,
                    "conflict_group_total_rows": conflict_group_total_rows,
                    "imported_categories": sorted({row["imported_category"] for row in target_rows if row["imported_category"]}),
                    "needs_resolution": needs_resolution,
                    "resolution_reason": resolution_reason,
                }
                suggestions.append(suggestion)

    suggestions.sort(key=lambda item: (
        item["keyword"],
        item["owner_name"] or "",
        item["target_category_name"] or "",
    ))

    for suggestion in suggestions:
        suggestion["review_status"] = (review_statuses.get(suggestion["id"]) or {}).get("status") or "pending"

    review_summary = review_state.get("summary")
    should_persist = not selected_owner_ids
    if should_persist:
        review_summary = refresh_rule_suggestion_review(review_state, suggestions)
    elif not isinstance(review_summary, dict):
        review_summary = summarize_rule_suggestion_review(review_state)

    return {
        "requires_owner_resolution": False,
        "unowned_accounts": [],
        "present_owner_ids": sorted({row["owner_id"] for row in candidate_rows if row["owner_id"]}),
        "suggestions": suggestions,
        "suggestion_count": len(suggestions),
        "review_summary": review_summary,
        "generated_at": review_state.get("generated_at"),
        "should_persist": should_persist,
    }


def save_batch_snapshot(conn, batch_id: str, snapshot: dict) -> None:
    conn.execute(
        "UPDATE import_batch SET config_snapshot = ? WHERE id = ?",
        (json.dumps(snapshot), batch_id),
    )


def parse_amount(row: dict, convention: str, col_map: ColumnMap) -> Optional[float]:
    """
    Parse an amount cell and return a signed float.
    Positive = debit (money out), negative = credit (money in).

    Handles common bank CSV formats:
      -50.00        standard negative
      (50.00)       accounting/parenthetical negative (debit in some exports)
      50.00 CR      trailing CR = credit (income)
      50.00 DR      trailing DR = debit (expense)
      $1,234.56     dollar sign and thousands separators
    """
    import re

    def clean(raw: str) -> Optional[float]:
        s = raw.strip().replace(",", "").replace("$", "").replace(" ", "")
        m = re.fullmatch(r'\(([0-9.]+)\)', s)
        if m:
            return -float(m.group(1))
        if re.search(r'CR$', s, re.IGNORECASE):
            val = float(re.sub(r'CR$', '', s, flags=re.IGNORECASE))
            return -abs(val)
        if re.search(r'DR$', s, re.IGNORECASE):
            val = float(re.sub(r'DR$', '', s, flags=re.IGNORECASE))
            return abs(val)
        return float(s)

    try:
        if convention == "two_column":
            d_raw = str(row.get(col_map.debit,  "") or "")
            c_raw = str(row.get(col_map.credit, "") or "")
            debit  = clean(d_raw) if d_raw.strip() else 0.0
            credit = clean(c_raw) if c_raw.strip() else 0.0
            return debit if debit else -(credit or 0)

        raw = str(row.get(col_map.amount, "") or "").strip()
        val = clean(raw)

        if convention == "single_unsigned" and col_map.direction:
            direction = str(row.get(col_map.direction, "")).strip().lower()
            if direction in ("credit", "cr", "deposit", "income"):
                return -abs(val)
            return abs(val)

        return -val

    except (ValueError, TypeError, AttributeError):
        return None


def get_import_display_amount(amount: float, convention: str) -> float:
    """
    Convert a normalized stored amount to the conventional user-facing display
    sign used across the UI.

    Stored txn convention:
      positive = debit / money out
      negative = credit / money in

    Display convention:
      negative = money out
      positive = money in
    """
    return -amount


def parse_date(val: str, fmt: str) -> Optional[str]:
    val = val.strip()
    for f in [fmt, "%Y-%m-%d", "%Y/%m/%d", "%m/%d/%Y", "%d/%m/%Y", "%m-%d-%Y", "%d-%m-%Y", "%b-%d-%Y", "%b %d, %Y"]:
        try:
            return datetime.strptime(val, f).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return None


def parse_pending_flag(row: dict, col_map: ColumnMap) -> bool:
    if not getattr(col_map, "pending", None):
        return False
    raw = str(row.get(col_map.pending, "") or "").strip().lower()
    if not raw:
        return False
    if raw in {"pending", "p", "true", "yes", "y", "1", "hold", "held", "authorized", "authorised"}:
        return True
    if raw in {"posted", "cleared", "complete", "completed", "final", "finalized", "finalised", "false", "no", "n", "0"}:
        return False
    return "pend" in raw or "auth" in raw


def _detect_header_row_index(text: str) -> int:
    all_lines = text.splitlines()
    header_row_index = 0
    for i, line in enumerate(all_lines[:10]):
        fields = [f.strip().strip('"') for f in line.split(',')]
        if len(fields) >= 3:
            looks_like_header = sum(
                1 for f in fields
                if f and not f[0].isdigit() and not f.startswith('$')
            ) >= len(fields) * 0.6
            if looks_like_header:
                header_row_index = i
                break
    return header_row_index


def _summarize_tail_lines(all_lines: list[str], count: int = 20) -> tuple[list[str], int]:
    if not all_lines:
        return [], 0
    start = max(0, len(all_lines) - count)
    return all_lines[start:], start


def normalize_import_category(value: str) -> str:
    return " ".join((value or "").strip().lower().split())


def sanitize_rule_merchant_text(value: str) -> str:
    normalized = " ".join((value or "").strip().split())
    if not normalized:
        return ""

    tokens = normalized.split()
    while len(tokens) > 1:
        compact = "".join(ch for ch in tokens[-1] if ch.isalnum())
        if compact.isdigit() and len(compact) >= 4:
            tokens.pop()
            continue
        break

    sanitized = " ".join(tokens).strip()
    compact = "".join(ch for ch in sanitized if ch.isalnum())
    if compact and compact.isdigit():
        return ""
    return sanitized


def normalize_rule_keyword(value: str) -> str:
    return sanitize_rule_merchant_text(value).lower()


def suggest_rule_clean_name(value: str) -> Optional[str]:
    sanitized = sanitize_rule_merchant_text(value)
    if not sanitized:
        return None
    original = " ".join((value or "").strip().split())
    return sanitized if sanitized != original else None


def _load_import_rule_target_maps(conn) -> tuple[dict[str, list[dict]], dict[str, dict]]:
    live_categories = conn.execute(
        """
        SELECT c.id, c.name, p.name AS group_name
        FROM   category c
        LEFT JOIN category p ON p.id = c.parent_id
        WHERE  c.parent_id IS NOT NULL
        """
    ).fetchall()
    categories_by_name: dict[str, list[dict]] = {}
    categories_by_id: dict[str, dict] = {}
    for row in live_categories:
        row_dict = dict(row)
        categories_by_id[row["id"]] = row_dict
        categories_by_name.setdefault(normalize_import_category(row["name"]), []).append(row_dict)
    return categories_by_name, categories_by_id


def _resolve_import_rule_target(row: dict, categories_by_name: dict[str, list[dict]], categories_by_id: dict[str, dict]) -> tuple[Optional[str], Optional[str], Optional[str]]:
    imported_name = str(row.get("imported_category") or "").strip()
    normalized = normalize_import_category(imported_name)
    matches = categories_by_name.get(normalized, [])
    if len(matches) == 1:
        return matches[0]["id"], matches[0]["name"], matches[0].get("group_name")
    # Imported category labels are not globally unique. If the user already overrode a
    # row during review, prefer that concrete category over guessing by name alone.
    current_category_id = row.get("category_id")
    if row.get("category_overridden") and current_category_id and current_category_id in categories_by_id:
        current = categories_by_id[current_category_id]
        return current["id"], current["name"], current.get("group_name")
    return None, None, None


def _zip_json_bytes(filename: str, payload: dict) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(filename, json.dumps(payload, indent=2, default=str))
    return buf.getvalue()


def _zip_members_bytes(members: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for name, content in members.items():
            zf.writestr(name, content)
    return buf.getvalue()


def _load_public_key(public_key_text: str):
    key_text = (public_key_text or "").strip().encode("utf-8")
    loaders = [serialization.load_ssh_public_key, serialization.load_pem_public_key]
    last_error = None
    for loader in loaders:
        try:
            return loader(key_text)
        except Exception as exc:
            last_error = exc
    raise HTTPException(status_code=400, detail=f"Invalid public key: {last_error}")


def _load_private_key(private_key_bytes: bytes, passphrase: Optional[str]):
    password = passphrase.encode("utf-8") if passphrase else None
    loaders = [serialization.load_ssh_private_key, serialization.load_pem_private_key]
    last_error = None
    for loader in loaders:
        try:
            return loader(private_key_bytes, password=password)
        except TypeError:
            try:
                return loader(private_key_bytes, password)
            except Exception as exc:
                last_error = exc
        except Exception as exc:
            last_error = exc
    raise HTTPException(status_code=400, detail=f"Invalid private key or passphrase: {last_error}")


def _rsa_fingerprint(public_key) -> str:
    der = public_key.public_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    digest = hashes.Hash(hashes.SHA256())
    digest.update(der)
    fp = urlsafe_b64encode(digest.finalize()).decode("ascii").rstrip("=")
    return f"SHA256:{fp}"


def _validate_backup_recipient_key(public_key_text: str):
    public_key = _load_public_key(public_key_text)
    if not isinstance(public_key, rsa.RSAPublicKey):
        raise HTTPException(status_code=400, detail="Only RSA public keys are supported for encrypted backups")
    return public_key, _rsa_fingerprint(public_key)


def _b64url_decode(value: str) -> bytes:
    value = (value or "").strip()
    if not value:
        raise HTTPException(status_code=400, detail="Encrypted backup metadata is missing required key material")
    padding_needed = (-len(value)) % 4
    return urlsafe_b64decode(value + ("=" * padding_needed))


def _build_encrypted_backup_bytes(payload_bytes: bytes, recipients: list[dict]) -> bytes:
    content_key = AESGCM.generate_key(bit_length=256)
    aesgcm = AESGCM(content_key)
    nonce = os.urandom(12)
    encrypted_payload = aesgcm.encrypt(nonce, payload_bytes, None)

    manifest = {
        "format": "fintrack-encrypted-backup",
        "version": 1,
        "cipher": "AES-256-GCM",
        "wrapped_keys": [],
        "nonce": urlsafe_b64encode(nonce).decode("ascii"),
    }
    for recipient in recipients:
        public_key, fingerprint = _validate_backup_recipient_key(recipient["public_key"])
        wrapped_key = public_key.encrypt(
            content_key,
            padding.OAEP(
                mgf=padding.MGF1(algorithm=hashes.SHA256()),
                algorithm=hashes.SHA256(),
                label=None,
            ),
        )
        manifest["wrapped_keys"].append({
            "recipient_id": recipient["id"],
            "label": recipient["label"],
            "fingerprint": fingerprint,
            "algorithm": "rsa-oaep-sha256",
            "wrapped_key": urlsafe_b64encode(wrapped_key).decode("ascii"),
        })

    return _zip_members_bytes({
        "manifest.json": json.dumps(manifest, indent=2).encode("utf-8"),
        "payload.bin": encrypted_payload,
    })


def _inspect_backup_upload(content: bytes, upload_name: str, expected_member_prefix: str) -> dict:
    lower_name = (upload_name or "").lower()
    if not lower_name.endswith(".zip"):
        payload = _load_json_or_zip_payload(content, upload_name, expected_member_prefix)
        return {
            "encrypted": False,
            "container": "json",
            "version": payload.get("version"),
        }

    try:
        with zipfile.ZipFile(io.BytesIO(content)) as zf:
            members = [name for name in zf.namelist() if not name.endswith("/")]
            member_set = set(members)
            has_manifest = "manifest.json" in member_set
            has_payload = "payload.bin" in member_set
            if has_manifest or has_payload:
                if not (has_manifest and has_payload):
                    raise HTTPException(status_code=400, detail="Encrypted backup ZIP must include both manifest.json and payload.bin")
                manifest = json.loads(zf.read("manifest.json").decode("utf-8"))
                if manifest.get("format") != "fintrack-encrypted-backup":
                    raise HTTPException(status_code=400, detail="Unsupported encrypted backup format")
                wrapped_keys = manifest.get("wrapped_keys")
                if not isinstance(wrapped_keys, list) or not wrapped_keys:
                    raise HTTPException(status_code=400, detail="Encrypted backup does not contain any wrapped recipient keys")
                recipients = []
                for wrapped in wrapped_keys:
                    if not isinstance(wrapped, dict):
                        continue
                    recipients.append({
                        "recipient_id": wrapped.get("recipient_id"),
                        "label": wrapped.get("label") or "Unnamed recipient",
                        "fingerprint": wrapped.get("fingerprint"),
                        "algorithm": wrapped.get("algorithm"),
                    })
                return {
                    "encrypted": True,
                    "container": "zip",
                    "version": manifest.get("version"),
                    "cipher": manifest.get("cipher"),
                    "recipient_count": len(recipients),
                    "recipients": recipients,
                }

        payload = _load_json_or_zip_payload(content, upload_name, expected_member_prefix)
        return {
            "encrypted": False,
            "container": "zip",
            "version": payload.get("version"),
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid ZIP backup: {exc}")


def _load_json_or_zip_payload(content: bytes, upload_name: str, expected_member_prefix: str) -> dict:
    lower_name = (upload_name or "").lower()
    if lower_name.endswith(".zip"):
        try:
            with zipfile.ZipFile(io.BytesIO(content)) as zf:
                members = [name for name in zf.namelist() if not name.endswith("/")]
                if len(members) != 1:
                    raise HTTPException(status_code=400, detail="ZIP backup must contain exactly one file")
                member = members[0]
                if not member.lower().endswith(".json"):
                    raise HTTPException(status_code=400, detail="ZIP backup must contain a JSON file")
                if expected_member_prefix and expected_member_prefix not in member.lower():
                    raise HTTPException(status_code=400, detail="Unexpected backup file inside ZIP")
                return json.loads(zf.read(member).decode("utf-8"))
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"Invalid ZIP backup: {exc}")
    try:
        return json.loads(content.decode("utf-8"))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid JSON backup: {exc}")


def _load_backup_payload_from_upload(
    content: bytes,
    upload_name: str,
    expected_member_prefix: str,
    private_key_bytes: Optional[bytes] = None,
    private_key_passphrase: Optional[str] = None,
) -> dict:
    inspection = _inspect_backup_upload(content, upload_name, expected_member_prefix)
    if not inspection.get("encrypted"):
        return _load_json_or_zip_payload(content, upload_name, expected_member_prefix)

    if not private_key_bytes:
        raise HTTPException(status_code=400, detail="Encrypted backup requires a private key file for restore")

    private_key = _load_private_key(private_key_bytes, private_key_passphrase)
    if not isinstance(private_key, rsa.RSAPrivateKey):
        raise HTTPException(status_code=400, detail="Only RSA private keys are supported for encrypted backups")

    try:
        with zipfile.ZipFile(io.BytesIO(content)) as zf:
            manifest = json.loads(zf.read("manifest.json").decode("utf-8"))
            content_key = None
            for wrapped in manifest.get("wrapped_keys", []):
                wrapped_key = wrapped.get("wrapped_key")
                if not wrapped_key:
                    continue
                try:
                    content_key = private_key.decrypt(
                        _b64url_decode(wrapped_key),
                        padding.OAEP(
                            mgf=padding.MGF1(algorithm=hashes.SHA256()),
                            algorithm=hashes.SHA256(),
                            label=None,
                        ),
                    )
                    break
                except Exception:
                    continue
            if not content_key:
                raise HTTPException(status_code=400, detail="Private key does not match any recipient in this backup")
            nonce = _b64url_decode(manifest.get("nonce"))
            payload_bytes = AESGCM(content_key).decrypt(nonce, zf.read("payload.bin"), None)
            return _load_json_or_zip_payload(payload_bytes, "payload.zip", expected_member_prefix)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Unable to decrypt encrypted backup: {exc}")

@router.get("/profiles")
def list_profiles():
    with get_db() as conn:
        rows = conn.execute("""
            SELECT p.*, a.name AS account_name
            FROM   csv_import_profile p
            LEFT JOIN account a ON a.id = p.account_id
            ORDER BY p.name
        """).fetchall()
    result = []
    for r in rows:
        d = dict(r)
        d["column_map"] = safe_json_dict(d["column_map"])
        result.append(d)
    return result


@router.post("/profiles")
def create_profile(body: ProfileCreate):
    pid = str(uuid.uuid4())
    with get_db() as conn:
        normalized_name = _assert_profile_name_available(conn, body.name)
        conn.execute("""
            INSERT INTO csv_import_profile
              (id, name, filename_pattern, header_fingerprint, template_filename,
               template_file_hash, column_map,
               account_id, date_format, amount_convention, skip_rows,
               apply_categorization, notes)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        """, (pid, normalized_name, body.filename_pattern, body.header_fingerprint,
              body.template_filename, body.template_file_hash,
              json.dumps(body.column_map), body.account_id, body.date_format,
              body.amount_convention, body.skip_rows,
              1 if body.apply_categorization else 0, body.notes))
    return {"id": pid}


@router.patch("/profiles/{profile_id}")
def update_profile(profile_id: str, body: ProfileUpdate):
    with get_db() as conn:
        row = conn.execute(
            "SELECT id FROM csv_import_profile WHERE id = ?", (profile_id,)
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Profile not found")
        fields, params = [], []
        if body.name                 is not None: fields.append("name = ?");                 params.append(_assert_profile_name_available(conn, body.name, profile_id))
        if body.filename_pattern     is not None: fields.append("filename_pattern = ?");     params.append(body.filename_pattern)
        if body.header_fingerprint   is not None: fields.append("header_fingerprint = ?");   params.append(body.header_fingerprint)
        if body.template_filename    is not None: fields.append("template_filename = ?");    params.append(body.template_filename)
        if body.template_file_hash   is not None: fields.append("template_file_hash = ?");   params.append(body.template_file_hash)
        if body.column_map           is not None: fields.append("column_map = ?");           params.append(json.dumps(body.column_map))
        if body.account_id           is not None: fields.append("account_id = ?");           params.append(body.account_id)
        if body.date_format          is not None: fields.append("date_format = ?");          params.append(body.date_format)
        if body.amount_convention    is not None: fields.append("amount_convention = ?");    params.append(body.amount_convention)
        if body.skip_rows            is not None: fields.append("skip_rows = ?");            params.append(body.skip_rows)
        if body.apply_categorization is not None: fields.append("apply_categorization = ?"); params.append(1 if body.apply_categorization else 0)
        if body.notes                is not None: fields.append("notes = ?");                params.append(body.notes)
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
            snapshot["category_workspace_draft"] = build_batch_category_workspace_draft(conn, batch["id"])
            save_batch_snapshot(conn, batch["id"], snapshot)
        conn.execute("DELETE FROM csv_import_profile WHERE id = ?", (profile_id,))
    return {"ok": True}


@router.delete("/developer/import-memory")
def clear_import_memory(request: Request):
    _require_developer_access(request)
    with get_db() as conn:
        conn.execute("DELETE FROM csv_import_profile")
        conn.execute("UPDATE import_batch SET config_snapshot = NULL")
    return {"ok": True}


@router.get("/backup/recipients")
def list_backup_recipients():
    with get_db() as conn:
        rows = conn.execute("""
            SELECT id, label, public_key, fingerprint, algorithm, enabled, created_at
            FROM   backup_recipient
            ORDER  BY created_at DESC, label
        """).fetchall()
    return [dict(row) for row in rows]


@router.get("/backup/credentials/status")
def get_credentials_backup_status():
    with get_db() as conn:
        row = conn.execute("SELECT COUNT(*) AS credential_count FROM plaid_item").fetchone()
    credential_count = int(row["credential_count"] or 0) if row else 0
    return {
        "has_credentials": credential_count > 0,
        "credential_count": credential_count,
    }


@router.post("/backup/recipients")
def create_backup_recipient(body: BackupRecipientCreate):
    public_key, fingerprint = _validate_backup_recipient_key(body.public_key)
    rid = str(uuid.uuid4())
    with get_db() as conn:
        existing = conn.execute(
            "SELECT id FROM backup_recipient WHERE fingerprint = ?",
            (fingerprint,),
        ).fetchone()
        if existing:
            raise HTTPException(status_code=400, detail="That public key is already saved")
        conn.execute("""
            INSERT INTO backup_recipient (id, label, public_key, fingerprint, algorithm, enabled)
            VALUES (?, ?, ?, ?, 'rsa-oaep-sha256', ?)
        """, (rid, body.label.strip(), body.public_key.strip(), fingerprint, 1 if body.enabled else 0))
    return {
        "id": rid,
        "label": body.label.strip(),
        "public_key": body.public_key.strip(),
        "fingerprint": fingerprint,
        "algorithm": "rsa-oaep-sha256",
        "enabled": 1 if body.enabled else 0,
    }


@router.patch("/backup/recipients/{recipient_id}")
def update_backup_recipient(recipient_id: str, body: BackupRecipientUpdate):
    with get_db() as conn:
        existing = conn.execute(
            "SELECT id FROM backup_recipient WHERE id = ?",
            (recipient_id,),
        ).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Recipient not found")
        fields, params = [], []
        if body.label is not None:
            fields.append("label = ?")
            params.append(body.label.strip())
        if body.enabled is not None:
            fields.append("enabled = ?")
            params.append(1 if body.enabled else 0)
        if fields:
            params.append(recipient_id)
            conn.execute(f"UPDATE backup_recipient SET {', '.join(fields)} WHERE id = ?", params)
        row = conn.execute("""
            SELECT id, label, public_key, fingerprint, algorithm, enabled, created_at
            FROM backup_recipient WHERE id = ?
        """, (recipient_id,)).fetchone()
    return dict(row)


@router.delete("/backup/recipients/{recipient_id}")
def delete_backup_recipient(recipient_id: str):
    with get_db() as conn:
        conn.execute("DELETE FROM backup_recipient WHERE id = ?", (recipient_id,))
    return {"ok": True}

@router.post("/preview")
async def preview_csv(file: UploadFile = File(...)):
    """
    Parse the uploaded CSV and return:
    - raw_lines: first 20 raw text lines (for the file preview panel)
    - header_row_index: which line index the header was detected on
    - headers: list of column names
    - rows: first 10 data rows as dicts
    - total_rows: total data row count
    - column_distinct_values: all distinct values per column (for account mapping)
    - column_value_counts: row counts for distinct values per column (for account skip totals)
    - suggested_profile_id: best matching saved profile, or null
    - previous_batch: most recent completed batch for this filename, or null
    - previous_batch_accounts: accounts imported in previous batch (for dup warning)
    - config_snapshot: column/account config from previous batch (to restore)
    """
    content = await file.read()
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = content.decode("latin-1")

    try:
        all_lines = text.splitlines()
        raw_lines  = all_lines[:20]
        raw_tail_lines, raw_tail_start_line = _summarize_tail_lines(all_lines)

        header_row_index = _detect_header_row_index(text)
        data_text = "\n".join(all_lines[header_row_index:])
        reader = csv.DictReader(io.StringIO(data_text))
        raw_headers = reader.fieldnames or []
        # Strip leading/trailing whitespace from header names — HTML option values
        # trim whitespace, so a header like " Amount" would cause a key mismatch.
        headers = [h.strip() for h in raw_headers]
        all_rows = []
        for row in reader:
            stripped = {k.strip(): v for k, v in row.items() if k}
            all_rows.append(stripped)
        rows       = all_rows[:10]
        total_rows = len(all_rows)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not parse CSV: {e}")

    filename  = file.filename or ""
    header_fp = "|".join(headers)
    file_content_hash = make_import_file_hash(text)

    column_distinct_values: dict = {}
    column_value_counts: dict = {}
    for row in all_rows:
        for col, val in row.items():
            v = str(val or "").strip()
            if v:
                column_distinct_values.setdefault(col, set()).add(v)
                column_value_counts.setdefault(col, {})
                column_value_counts[col][v] = column_value_counts[col].get(v, 0) + 1
    column_distinct_meta = {
        col: {
            "total_count": len(vals),
            "displayed_count": min(len(vals), MAX_DISTINCT_VALUES_PER_COLUMN),
            "truncated": len(vals) > MAX_DISTINCT_VALUES_PER_COLUMN,
            "limit": MAX_DISTINCT_VALUES_PER_COLUMN,
        }
        for col, vals in column_distinct_values.items()
    }
    sorted_distinct_values = {
        col: sorted(vals)[:MAX_DISTINCT_VALUES_PER_COLUMN]
        for col, vals in column_distinct_values.items()
    }
    column_distinct_values = sorted_distinct_values
    column_value_counts = {
        col: {
            value: column_value_counts.get(col, {}).get(value, 0)
            for value in values
        }
        for col, values in sorted_distinct_values.items()
    }

    try:
        with get_db() as conn:
            profiles = conn.execute(
                "SELECT id, name, filename_pattern, header_fingerprint FROM csv_import_profile"
            ).fetchall()

            suggested_profile_id = None
            for p in profiles:
                if p["header_fingerprint"] and p["header_fingerprint"] == header_fp:
                    suggested_profile_id = p["id"]
                    break
            if not suggested_profile_id:
                for p in profiles:
                    if (
                        p["filename_pattern"]
                        and p["filename_pattern"].lower() in filename.lower()
                        and not p["header_fingerprint"]
                    ):
                        suggested_profile_id = p["id"]
                        break

            # Find most recent completed batch for this exact file content first.
            # Older databases may have imports without a stored file hash, in
            # which case there simply won't be a match.
            previous_batch = conn.execute("""
                SELECT id, imported_at, row_count, status, config_snapshot
                FROM   import_batch
                WHERE  file_content_hash = ? AND status = 'completed'
                ORDER  BY imported_at DESC LIMIT 1
            """, (file_content_hash,)).fetchone()

            previous_batch_accounts = []
            config_snapshot         = None
            if previous_batch:
                acc_rows = conn.execute("""
                    SELECT iba.csv_value, iba.row_count, iba.was_skipped,
                           a.id AS account_id, a.name AS account_name
                    FROM   import_batch_account iba
                    LEFT JOIN account a ON a.id = iba.account_id
                    WHERE  iba.batch_id = ? AND iba.was_skipped = 0
                """, (previous_batch["id"],)).fetchall()
                previous_batch_accounts = [dict(r) for r in acc_rows]

                if previous_batch["config_snapshot"]:
                    try:
                        config_snapshot = json.loads(previous_batch["config_snapshot"])
                    except Exception:
                        pass

    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not parse CSV: {e}")

    return {
        "raw_lines":              raw_lines,
        "raw_tail_lines":         raw_tail_lines,
        "raw_tail_start_line":    raw_tail_start_line,
        "header_row_index":       header_row_index,
        "headers":                headers,
        "rows":                   rows,
        "total_rows":             total_rows,
        "filename":               filename,
        "file_content_hash":      file_content_hash,
        "header_fingerprint":     header_fp,
        "suggested_profile_id":   suggested_profile_id,
        "previous_batch":         dict(previous_batch) if previous_batch else None,
        "previous_batch_accounts":previous_batch_accounts,
        "config_snapshot":        config_snapshot,
        "column_distinct_values": column_distinct_values,
        "column_value_counts":    column_value_counts,
        "column_distinct_meta":   column_distinct_meta,
    }

@router.post("/run")
async def run_import(
    file:   UploadFile = File(...),
    config: str        = Form(...),
):
    """
    Execute the import. Accepts the CSV file as a multipart upload so the full
    file is parsed server-side — the preview only returns 10 rows to the client,
    so we re-read the whole file here rather than relying on a rows list in the body.
    """
    try:
        cfg = json.loads(config)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid config JSON")

    content = await file.read()
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = content.decode("latin-1")
    file_content_hash = make_import_file_hash(text)
    all_lines = text.splitlines()

    header_row_index = _detect_header_row_index(text)
    data_text = "\n".join(all_lines[header_row_index:])

    reader   = csv.DictReader(io.StringIO(data_text))
    raw_hdrs = reader.fieldnames or []
    headers = [str(header or "").strip() for header in raw_hdrs if str(header or "").strip()]
    all_rows = []
    for row in reader:
        all_rows.append({k.strip(): v for k, v in row.items() if k})

    skip_rows = int(cfg.get("skip_rows", 0))
    data_rows = all_rows[skip_rows:]

    cm_dict       = cfg.get("column_map", {})
    col = ColumnMap(
        date        = cm_dict.get("date", ""),
        amount      = cm_dict.get("amount"),
        debit       = cm_dict.get("debit"),
        credit      = cm_dict.get("credit"),
        direction   = cm_dict.get("direction"),
        description = cm_dict.get("description", ""),
        category    = cm_dict.get("category"),
        notes       = cm_dict.get("notes"),
        account     = cm_dict.get("account"),
    )

    date_format       = cfg.get("date_format", "%m/%d/%Y")
    amount_convention = cfg.get("amount_convention", "single_signed")
    apply_cat         = bool(cfg.get("apply_categorization", True))
    account_id        = cfg.get("account_id") or None
    single_account_new = cfg.get("single_account_new") or None
    category_assignments_cfg = cm_dict.get("category_assignments") or {}
    account_map_cfg   = cfg.get("account_map") or {}
    skip_accounts_cfg = cfg.get("skip_accounts") or []
    new_accounts_cfg  = cfg.get("new_accounts") or []
    profile_id        = cfg.get("profile_id") or None
    replace_batch_id  = cfg.get("replace_batch_id") or None
    filename          = file.filename or cfg.get("filename", "upload.csv")

    batch_id = str(uuid.uuid4())
    imported = 0
    skipped  = 0
    deduped  = 0
    errors   = []
    row_results = []
    imported_category_counts: dict[str, int] = {}
    invalid_row_context_lines = None
    invalid_row_context_start_line = None
    invalid_rows_suspected = False
    invalid_rows_message = None
    zero_amount_rows = []
    validation_error_rows = []
    duplicate_rows = []
    skip_set = set(skip_accounts_cfg)

    with get_db() as conn:
        default_owner_id = resolve_default_owner_id(conn, None)
        valid_category_ids = {
            row["id"] for row in conn.execute("SELECT id FROM category").fetchall()
        }
        category_assignments_cfg = {
            raw_value: category_id
            for raw_value, category_id in category_assignments_cfg.items()
            if category_id in valid_category_ids
        }

        created_account_ids = {}
        if single_account_new:
            single_name = str(single_account_new.get("name", "")).strip()
            single_type = single_account_new.get("type", "depository")
            if single_name:
                existing = conn.execute(
                    "SELECT id FROM account WHERE LOWER(name) = LOWER(?)", (single_name,)
                ).fetchone()
                if existing:
                    created_account_ids["__single_account__"] = existing["id"]
                else:
                    new_acc_id = str(uuid.uuid4())
                    conn.execute("""
                        INSERT INTO account
                          (id, plaid_account_id, plaid_item_id, name, type, subtype, owner_id)
                        VALUES (?, ?, 'csv_import', ?, ?, ?, ?)
            """, (new_acc_id, f"csv_{new_acc_id}", single_name, single_type, "checking",
                  default_owner_id))
            created_account_ids["__single_account__"] = new_acc_id
        for na in new_accounts_cfg:
            csv_val  = na.get("csv_value", "")
            acc_name = na.get("name", csv_val).strip()
            acc_type = na.get("type", "depository")
            if not acc_name:
                continue
            # Check if an account with this name already exists — use it rather
            # than creating a duplicate. Case-insensitive match.
            existing = conn.execute(
                "SELECT id FROM account WHERE LOWER(name) = LOWER(?)", (acc_name,)
            ).fetchone()
            if existing:
                created_account_ids[csv_val] = existing["id"]
                continue
            new_acc_id = str(uuid.uuid4())
            conn.execute("""
                INSERT INTO account
                  (id, plaid_account_id, plaid_item_id, name, type, subtype, owner_id)
                VALUES (?, ?, 'csv_import', ?, ?, ?, ?)
            """, (new_acc_id, f"csv_{new_acc_id}", acc_name, acc_type, "checking",
                  default_owner_id))
            created_account_ids[csv_val] = new_acc_id

        created_account_owner_map = {}
        if created_account_ids:
            placeholders = ",".join("?" * len(set(created_account_ids.values())))
            owner_rows = conn.execute(
                f"SELECT id, owner_id FROM account WHERE id IN ({placeholders})",
                list(set(created_account_ids.values())),
            ).fetchall()
            created_account_owner_map = {
                row["id"]: row["owner_id"] for row in owner_rows
            }

        effective_map = {}
        effective_map.update(account_map_cfg)
        effective_map.update(created_account_ids)

        fallback_acc = None
        if account_id:
            fallback_acc = conn.execute(
                "SELECT id, owner_id, name FROM account WHERE id = ?", (account_id,)
            ).fetchone()
            if not fallback_acc:
                raise HTTPException(status_code=400, detail="Account not found")
        elif created_account_ids.get("__single_account__"):
            fallback_acc = conn.execute(
                "SELECT id, owner_id, name FROM account WHERE id = ?",
                (created_account_ids["__single_account__"],)
            ).fetchone()

        account_cache: dict = {}
        def get_account(aid):
            if aid not in account_cache:
                r = conn.execute("SELECT id, owner_id, name FROM account WHERE id = ?", (aid,)).fetchone()
                account_cache[aid] = dict(r) if r else None
            return account_cache[aid]

        previous_batch = None
        previously_imported_values: set[str] = set()
        if not replace_batch_id:
            previous_batch = conn.execute(
                """
                SELECT id
                FROM   import_batch
                WHERE  file_content_hash = ? AND status = 'completed'
                ORDER  BY imported_at DESC LIMIT 1
                """,
                (file_content_hash,),
            ).fetchone()
            if previous_batch:
                prior_rows = conn.execute(
                    """
                    SELECT csv_value
                    FROM   import_batch_account
                    WHERE  batch_id = ? AND was_skipped = 0
                    """,
                    (previous_batch["id"],),
                ).fetchall()
                previously_imported_values = {
                    str(row["csv_value"] or "").strip()
                    for row in prior_rows
                    if str(row["csv_value"] or "").strip()
                }

        if previous_batch:
            # Duplicate detection is file-wide, but account-column imports can still reuse
            # the same CSV for accounts that were skipped or not imported in the earlier run.
            if col.account:
                present_csv_values = {
                    str(row.get(col.account, "")).strip()
                    for row in data_rows
                    if str(row.get(col.account, "")).strip()
                }
                blocked_values = sorted((present_csv_values - skip_set) & previously_imported_values)
                if blocked_values:
                    raise HTTPException(
                        status_code=409,
                        detail={
                            "message": "Some accounts from this file were already imported and cannot be imported again.",
                            "already_imported_values": blocked_values,
                        },
                    )
            else:
                raise HTTPException(
                    status_code=409,
                    detail="This file has already been imported. Undo the earlier import first.",
                )

        # Pre-load pending rows so a posted transaction can replace the earlier
        # pending version instead of creating a second copy.
        relevant_account_ids = set()
        if account_id:
            relevant_account_ids.add(account_id)
        for aid in effective_map.values():
            if aid:
                relevant_account_ids.add(aid)
        existing_pending_rows: dict = {}
        existing_hashes_by_account: dict[str, dict[str, dict]] = {}
        if relevant_account_ids:
            ph = ",".join("?" * len(relevant_account_ids))
            rows_db = conn.execute(
                f"SELECT id, account_id, content_hash, date, raw_name, merchant_name, display_name, amount, is_pending FROM txn "
                f"WHERE account_id IN ({ph}) AND content_hash IS NOT NULL",
                list(relevant_account_ids)
            ).fetchall()
            for r in rows_db:
                if r["is_pending"]:
                    key = (r["account_id"], r["date"], (r["raw_name"] or "").strip().lower())
                    existing_pending_rows[key] = {"id": r["id"], "content_hash": r["content_hash"]}
                    continue
                if not r["content_hash"]:
                    continue
                account_hashes = existing_hashes_by_account.setdefault(r["account_id"], {})
                if r["content_hash"] not in account_hashes:
                    account_hashes[r["content_hash"]] = {
                        "id": r["id"],
                        "date": r["date"],
                        "merchant_name": r["display_name"] or r["merchant_name"] or r["raw_name"],
                        "amount": r["amount"],
                    }

        if replace_batch_id:
            conn.execute("DELETE FROM txn WHERE import_batch_id = ?", (replace_batch_id,))
            conn.execute("UPDATE import_batch SET status = 'undone' WHERE id = ?", (replace_batch_id,))

        # Snapshot the import decisions up front so undo, review, and batch-resume flows
        # can reopen the exact mapping context that produced these rows.
        config_snapshot = {
            "column_map":          cm_dict,
            "category_assignments": category_assignments_cfg,
            "account_map":         account_map_cfg,
            "skip_accounts":       list(skip_set),
            "date_format":         date_format,
            "amount_convention":   amount_convention,
            "skip_rows":           skip_rows,
            "apply_categorization":apply_cat,
            "account_id":          account_id,
            "single_account_new":  single_account_new,
            UNKNOWN_SOURCE_FALLBACK_KEY: False,
        }
        conn.execute("""
            INSERT INTO import_batch
              (id, profile_id, filename, file_content_hash, row_count, skipped_count, deduped_count, config_snapshot)
            VALUES (?, ?, ?, ?, 0, 0, 0, ?)
        """, (batch_id, profile_id, filename, file_content_hash, json.dumps(config_snapshot)))

        use_account_col = bool(col.account)
        account_counts: dict = {}
        skip_counts:    dict = {}
        consecutive_error_rows = 0
        footer_error_start_index = None
        footer_error_start_data_index = None
        footer_error_start_row = None

        def reset_footer_detection():
            nonlocal consecutive_error_rows, footer_error_start_index, footer_error_start_data_index, footer_error_start_row
            consecutive_error_rows = 0
            footer_error_start_index = None
            footer_error_start_data_index = None
            footer_error_start_row = None

        def record_footer_like_error(row_num: int, reason: str, row_index: int):
            nonlocal consecutive_error_rows, footer_error_start_index, footer_error_start_data_index, footer_error_start_row, skipped
            if consecutive_error_rows == 0:
                footer_error_start_index = len(errors)
                footer_error_start_data_index = row_index
                footer_error_start_row = row_num
            consecutive_error_rows += 1
            errors.append({"row": row_num, "reason": reason})
            validation_error_rows.append({
                "row": row_num,
                "kind": "validation_error",
                "reason": reason,
                "values": _normalize_import_row_values(row, headers),
            })
            row_results.append({"row": row_num, "status": "error", "reason": reason})
            skipped += 1
            if consecutive_error_rows >= 5:
                # Treat the rest of the file as trailing documentation/footer text.
                return True, len(data_rows) - row_index - 1
            return False, 0

        for i, row in enumerate(data_rows):
            row_num = header_row_index + skip_rows + i + 2

            if use_account_col:
                csv_val = str(row.get(col.account, "")).strip()
                if csv_val in skip_set:
                    skipped += 1
                    skip_counts[csv_val] = skip_counts.get(csv_val, 0) + 1
                    row_results.append({"row": row_num, "status": "skipped_account"})
                    reset_footer_detection()
                    continue
                row_account_id = effective_map.get(csv_val)
                if not row_account_id:
                    should_stop, remaining = record_footer_like_error(
                        row_num, f"No account mapped for '{csv_val}'", i
                    )
                    if should_stop:
                        skipped += remaining
                        break
                    continue
                acc = get_account(row_account_id)
            elif fallback_acc:
                csv_val = ""
                acc     = dict(fallback_acc)
            else:
                should_stop, remaining = record_footer_like_error(row_num, "No account configured", i)
                if should_stop:
                    skipped += remaining
                    break
                continue

            if not acc:
                should_stop, remaining = record_footer_like_error(row_num, "Account not found", i)
                if should_stop:
                    skipped += remaining
                    break
                continue

            raw_date = str(row.get(col.date, "")).strip()
            parsed_date = parse_date(raw_date, date_format)
            if not parsed_date:
                should_stop, remaining = record_footer_like_error(
                    row_num, f"Invalid date: {raw_date!r}", i
                )
                if should_stop:
                    skipped += remaining
                    break
                continue

            amount = parse_amount(row, amount_convention, col)
            if amount is None:
                should_stop, remaining = record_footer_like_error(row_num, "Invalid amount", i)
                if should_stop:
                    skipped += remaining
                    break
                continue
            if amount == 0:
                skipped += 1
                zero_amount_rows.append({
                    "row": row_num,
                    "kind": "zero_amount",
                    "reason": "Zero amount",
                    "values": _normalize_import_row_values(row, headers),
                })
                row_results.append({"row": row_num, "status": "zero_amount"})
                reset_footer_detection()
                continue

            raw_desc     = str(row.get(col.description, "")).strip()
            raw_imported_category = str(row.get(col.category, "")).strip() if col.category else ""
            notes_val    = str(row.get(col.notes, "")).strip() if col.notes else None
            is_pending = parse_pending_flag(row, col)
            content_hash = make_hash(parsed_date, amount, raw_desc)

            pending_match_key = (acc["id"], parsed_date, raw_desc.lower())
            pending_match = existing_pending_rows.get(pending_match_key)
            if pending_match and not is_pending:
                conn.execute("DELETE FROM txn WHERE id = ?", (pending_match["id"],))
                existing_pending_rows.pop(pending_match_key, None)

            if raw_imported_category:
                imported_category_counts[raw_imported_category] = imported_category_counts.get(raw_imported_category, 0) + 1

            cat_id = None
            category_from_import_mapping = False
            if raw_imported_category:
                cat_id = category_assignments_cfg.get(raw_imported_category)
                category_from_import_mapping = bool(cat_id)
            if apply_cat and not cat_id:
                result = categorize_transaction(
                    raw_desc, raw_desc, raw_desc, abs(amount), conn,
                    owner_id=acc["owner_id"],
                    account_id=acc["id"],
                )
                cat_id = result["category_id"] if isinstance(result, dict) else result

            txn_payload = {
                "account_id": acc["id"],
                "owner_id": acc["owner_id"],
                "category_id": cat_id,
                "amount": amount,
                "merchant_name": raw_desc,
                "display_name": raw_desc,
                "raw_name": raw_desc,
                "date": parsed_date,
                "is_pending": 1 if is_pending else 0,
                "content_hash": content_hash,
                "imported_category": raw_imported_category or None,
                "notes": notes_val or None,
                "category_overridden": 1 if category_from_import_mapping else 0,
                "csv_value": csv_val,
            }

            duplicate_existing = existing_hashes_by_account.get(acc["id"], {}).get(content_hash)
            if duplicate_existing:
                deduped += 1
                duplicate_rows.append({
                    "row": row_num,
                    "kind": "duplicate",
                    "reason": "Matches an existing transaction",
                    "values": _normalize_import_row_values(row, headers),
                    "matched_transaction": duplicate_existing,
                    "txn_payload": txn_payload,
                    "csv_value": csv_val,
                })
                row_results.append({"row": row_num, "status": "duplicate"})
                reset_footer_detection()
                continue

            txn_id = _insert_imported_transaction(conn, batch_id, txn_payload)
            if is_pending:
                existing_pending_rows[pending_match_key] = {"id": txn_id, "content_hash": content_hash}
            imported += 1
            row_results.append({"row": row_num, "status": "imported"})
            reset_footer_detection()

            aid = acc["id"]
            if aid not in account_counts:
                account_counts[aid] = {"csv_value": csv_val, "count": 0}
            account_counts[aid]["count"] += 1

        trailing_non_transaction_suspected = footer_error_start_row is not None

        if footer_error_start_index is not None:
            errors = errors[:footer_error_start_index]
            validation_error_rows = validation_error_rows[:footer_error_start_index]

        if errors:
            first_error_row = min((err.get("row") for err in errors if err.get("row")), default=None)
            if first_error_row is not None:
                invalid_rows_suspected = True
                error_line_idx = max(0, first_error_row - 1)
                start_idx = max(0, error_line_idx - 4)
                end_idx = min(len(all_lines), error_line_idx + 6)
                invalid_row_context_start_line = start_idx
                invalid_row_context_lines = all_lines[start_idx:end_idx]
                invalid_rows_message = (
                    f"Rows {first_error_row} onward contain validation errors. The file viewer has been opened so you can inspect the bad rows."
                )

        conn.execute(
            "UPDATE import_batch SET row_count = ?, skipped_count = ?, deduped_count = ? WHERE id = ?",
            (imported + skipped + deduped, skipped, deduped, batch_id)
        )

        trailing_non_transaction_count = (
            len(data_rows) - footer_error_start_data_index
            if footer_error_start_data_index is not None
            else 0
        )
        zero_amount_count = len(zero_amount_rows)
        validation_error_count = len(errors)
        rejected_rows = sorted(
            zero_amount_rows + validation_error_rows,
            key=lambda row: row.get("row") or 0,
        )[:20]
        import_summary = {
            "total_rows": imported + skipped + deduped,
            "imported_count": imported,
            "skipped_count": skipped,
            "deduped_count": deduped,
            "account_skipped_count": sum(skip_counts.values()),
            "zero_amount_count": zero_amount_count,
            "validation_error_count": validation_error_count,
            "trailing_non_transaction_count": trailing_non_transaction_count,
            "rejected_count": zero_amount_count + validation_error_count,
            "rejected_headers": headers,
            "rejected_rows": rejected_rows,
            "duplicate_headers": headers,
        }

        # If nothing was imported, remove the batch record entirely —
        # a zero-row import shouldn't appear in Recent imports
        if imported == 0 and deduped == 0:
            conn.execute("DELETE FROM import_batch WHERE id = ?", (batch_id,))
            batch_id = None
        else:
            _save_batch_duplicate_rows(conn, batch_id, duplicate_rows)
            config_snapshot[IMPORT_SUMMARY_KEY] = import_summary
            save_batch_snapshot(conn, batch_id, config_snapshot)
            for aid, info in account_counts.items():
                conn.execute("""
                    INSERT OR REPLACE INTO import_batch_account
                      (batch_id, csv_value, account_id, row_count, was_skipped)
                    VALUES (?, ?, ?, ?, 0)
                """, (batch_id, info["csv_value"], aid, info["count"]))
            for csv_val, row_ct in skip_counts.items():
                mapped_id = effective_map.get(csv_val)
                conn.execute("""
                    INSERT OR IGNORE INTO import_batch_account
                      (batch_id, csv_value, account_id, row_count, was_skipped)
                    VALUES (?, ?, ?, ?, 1)
                """, (batch_id, csv_val, mapped_id or None, row_ct))

        account_skipped = sum(skip_counts.values())

    trailing_non_transaction_message = None
    if trailing_non_transaction_suspected:
        start_row = footer_error_start_row or (row_results[-1]["row"] if row_results else None)
        trailing_non_transaction_message = (
            f"Rows {start_row} onward could be footer or other non-transaction text at the end of the file. Import stopped there."
        )

    return {
        "batch_id":             batch_id,
        "imported":             imported,
        "skipped":              skipped,
        "deduped":              deduped,
        "duplicate_sets":       [],
        "account_skipped":      account_skipped,
        "zero_amount_count":    zero_amount_count,
        "validation_error_count": validation_error_count,
        "rejected_count":       zero_amount_count + validation_error_count,
        "rejected_rows":        rejected_rows,
        "duplicate_count":      deduped,
        "import_summary":       import_summary,
        "new_accounts_created": len(created_account_ids),
        "new_accounts_without_owner": sum(
            1 for aid in set(created_account_ids.values())
            if not created_account_owner_map.get(aid)
        ),
        "has_imported_categories": bool(imported_category_counts),
        "imported_category_value_count": len(imported_category_counts),
        "trailing_non_transaction_suspected": trailing_non_transaction_suspected,
        "trailing_non_transaction_message": trailing_non_transaction_message,
        "trailing_error_start_row": footer_error_start_row,
        "trailing_error_count": trailing_non_transaction_count,
        "invalid_rows_suspected": invalid_rows_suspected,
        "invalid_rows_message": invalid_rows_message,
        "invalid_row_context_start_line": invalid_row_context_start_line,
        "invalid_row_context_lines": invalid_row_context_lines,
        "errors":               errors[:20],
    }


@router.get("/batches/{batch_id}/duplicates")
def get_batch_duplicates(batch_id: str):
    with get_db() as conn:
        batch = conn.execute(
            "SELECT id, filename, config_snapshot FROM import_batch WHERE id = ?",
            (batch_id,),
        ).fetchone()
        if not batch:
            raise HTTPException(status_code=404, detail="Batch not found")

        headers, duplicate_rows = _load_batch_duplicate_details(conn, batch)
        return {
            "batch_id": batch_id,
            "filename": batch["filename"],
            "headers": headers,
            "rows": duplicate_rows,
            "count": len(duplicate_rows),
        }


@router.post("/batches/{batch_id}/duplicates/import")
def import_batch_duplicates(batch_id: str, body: BatchDuplicateImportRequest):
    with get_db() as conn:
        batch = conn.execute(
            "SELECT id, row_count, skipped_count, deduped_count, config_snapshot FROM import_batch WHERE id = ?",
            (batch_id,),
        ).fetchone()
        if not batch:
            raise HTTPException(status_code=404, detail="Batch not found")

        snapshot = safe_json_dict(batch["config_snapshot"])
        summary = snapshot.get(IMPORT_SUMMARY_KEY)
        if not isinstance(summary, dict):
            raise HTTPException(status_code=400, detail="Batch does not have duplicate details")

        headers, duplicate_rows = _load_batch_duplicate_details(conn, batch)
        if not duplicate_rows:
            raise HTTPException(status_code=400, detail="Batch has no duplicate rows to import")

        selected_rows = set(int(row) for row in (body.row_numbers or []))
        if not body.import_all and not selected_rows:
            raise HTTPException(status_code=400, detail="Choose duplicates to import")

        imported_now = 0
        remaining_rows = []
        importable_selected = 0
        not_importable_count = 0
        account_increments: dict[tuple[str | None, str], int] = {}

        for entry in duplicate_rows:
            row_number = int(entry.get("row") or 0)
            chosen = body.import_all or row_number in selected_rows
            if not chosen:
                remaining_rows.append(entry)
                continue

            payload = entry.get("txn_payload")
            if not isinstance(payload, dict):
                not_importable_count += 1
                remaining_rows.append(entry)
                continue

            importable_selected += 1
            _insert_imported_transaction(conn, batch_id, payload)
            imported_now += 1
            account_key = (payload.get("account_id"), str(payload.get("csv_value") or entry.get("csv_value") or ""))
            account_increments[account_key] = account_increments.get(account_key, 0) + 1

        if importable_selected == 0:
            raise HTTPException(status_code=400, detail="Selected duplicates cannot be imported from this batch")

        chosen_rows = [int(entry.get("row") or 0) for entry in duplicate_rows if body.import_all or int(entry.get("row") or 0) in selected_rows]
        if chosen_rows:
            placeholders = ",".join("?" * len(chosen_rows))
            conn.execute(
                f"DELETE FROM import_batch_duplicate WHERE batch_id = ? AND row_number IN ({placeholders})",
                [batch_id, *chosen_rows],
            )

        for (account_id, csv_value), count in account_increments.items():
            existing = conn.execute(
                "SELECT row_count FROM import_batch_account WHERE batch_id = ? AND csv_value = ?",
                (batch_id, csv_value),
            ).fetchone()
            if existing:
                conn.execute(
                    "UPDATE import_batch_account SET row_count = row_count + ?, was_skipped = 0, account_id = COALESCE(account_id, ?) WHERE batch_id = ? AND csv_value = ?",
                    (count, account_id, batch_id, csv_value),
                )
            else:
                conn.execute(
                    """
                    INSERT INTO import_batch_account
                      (batch_id, csv_value, account_id, row_count, was_skipped)
                    VALUES (?, ?, ?, ?, 0)
                    """,
                    (batch_id, csv_value, account_id, count),
                )

        summary["duplicate_headers"] = headers
        if "duplicate_rows" in summary:
            summary["duplicate_rows"] = remaining_rows
        summary["deduped_count"] = len(remaining_rows)
        summary["duplicate_count"] = len(remaining_rows)
        summary["imported_count"] = int(summary.get("imported_count") or 0) + imported_now
        summary["total_rows"] = summary["imported_count"] + int(summary.get("skipped_count") or 0) + len(remaining_rows)
        snapshot[IMPORT_SUMMARY_KEY] = summary
        save_batch_snapshot(conn, batch_id, snapshot)
        conn.execute(
            "UPDATE import_batch SET deduped_count = ? WHERE id = ?",
            (len(remaining_rows), batch_id),
        )

    return {
        "batch_id": batch_id,
        "imported_count": imported_now,
        "remaining_duplicate_count": len(remaining_rows),
        "not_importable_count": not_importable_count,
    }

@router.get("/batches")
def list_batches():
    with get_db() as conn:
        batches = conn.execute("""
            SELECT b.id, b.profile_id, b.filename, b.file_content_hash, b.imported_at, b.row_count, b.skipped_count,
                   b.deduped_count, b.status, b.config_snapshot, p.name AS profile_name,
                   EXISTS(
                       SELECT 1
                       FROM   txn t
                       WHERE  t.import_batch_id = b.id
                         AND  t.imported_category IS NOT NULL
                         AND  TRIM(t.imported_category) <> ''
                   ) AS has_imported_categories
            FROM   import_batch b
            LEFT JOIN csv_import_profile p ON p.id = b.profile_id
            WHERE  b.status = 'completed'
            ORDER  BY b.imported_at DESC
            LIMIT  50
        """).fetchall()

        result = []
        for b in batches:
            d = dict(b)
            d.pop("config_snapshot", None)
            snapshot = safe_json_dict(b["config_snapshot"])
            review_state = get_rule_suggestion_review_state(snapshot)
            summary = review_state.get("summary")
            if not isinstance(summary, dict):
                summary = summarize_rule_suggestion_review(review_state)

            d["has_imported_categories"] = bool(d.get("has_imported_categories"))
            d["rule_suggestion_review"] = {
                "generated_at": review_state.get("generated_at"),
                "last_generated_at": review_state.get("last_generated_at"),
                **summary,
            } if d["has_imported_categories"] else None
            d["import_summary"] = (
                snapshot.get(IMPORT_SUMMARY_KEY)
                if isinstance(snapshot.get(IMPORT_SUMMARY_KEY), dict)
                else None
            )
            if isinstance(d["import_summary"], dict):
                d["import_summary"] = {
                    key: value
                    for key, value in d["import_summary"].items()
                    if key != "duplicate_rows"
                }
            d["unknown_source_fallback"] = bool(snapshot.get(UNKNOWN_SOURCE_FALLBACK_KEY))

            # For profileless batches, the category workspace draft is stored
            # directly in config_snapshot rather than in a profile. Surface a
            # summary so the frontend can show the Import categories button on
            # the individual batch row without fetching the full snapshot.
            d["category_workspace_summary"] = (
                summarize_category_workspace_draft(snapshot.get("category_workspace_draft"))
                if not d.get("profile_id")
                else None
            )

            accs = conn.execute("""
                SELECT iba.csv_value, iba.account_id, iba.row_count, iba.was_skipped,
                       COALESCE(a.name, iba.csv_value) AS account_name
                FROM   import_batch_account iba
                LEFT JOIN account a ON a.id = iba.account_id
                WHERE  iba.batch_id = ?
                ORDER BY iba.was_skipped, iba.csv_value
            """, (b["id"],)).fetchall()
            d["accounts"] = [dict(a) for a in accs]
            result.append(d)
    return result


@router.get("/batches/{batch_id}/edited")
def get_edited_transactions(batch_id: str):
    """
    Return transactions in this batch that were manually edited after import
    (category overridden or merchant renamed). Used for undo warning.
    """
    with get_db() as conn:
        rows = conn.execute("""
            SELECT t.id, t.date, COALESCE(t.display_name, t.merchant_name, t.raw_name) AS merchant_name, t.amount,
                   c.name AS category_name
            FROM   txn t
            LEFT JOIN category c ON c.id = t.category_id
            WHERE  t.import_batch_id = ?
              AND  t.category_overridden = 1
            ORDER  BY t.date DESC
        """, (batch_id,)).fetchall()
    return [dict(r) for r in rows]


@router.get("/batches/{batch_id}/category-mappings")
def get_batch_category_mappings(batch_id: str):
    with get_db() as conn:
        batch = conn.execute(
            "SELECT id, profile_id, config_snapshot FROM import_batch WHERE id = ?",
            (batch_id,),
        ).fetchone()
        if not batch:
            raise HTTPException(status_code=404, detail="Batch not found")

        snapshot = {}
        if batch["config_snapshot"]:
            snapshot = safe_json_dict(batch["config_snapshot"])

        saved_assignments = (snapshot.get("category_assignments") or
                             (snapshot.get("column_map") or {}).get("category_assignments") or {})

        category_rows = conn.execute("""
            SELECT t.imported_category AS raw_value,
                   COUNT(*) AS row_count
            FROM   txn t
            WHERE  t.import_batch_id = ?
              AND  t.imported_category IS NOT NULL
              AND  TRIM(t.imported_category) <> ''
            GROUP  BY t.imported_category
            ORDER  BY COUNT(*) DESC, t.imported_category
        """, (batch_id,)).fetchall()

        existing_categories = conn.execute("""
            SELECT c.id, c.name, c.parent_id, p.name AS group_name
            FROM   category c
            LEFT JOIN category p ON p.id = c.parent_id
            WHERE  c.parent_id IS NOT NULL
            ORDER  BY p.name, c.name
        """).fetchall()
        by_normalized_name = {
            normalize_import_category(row["name"]): row["id"]
            for row in existing_categories
        }

        values = []
        for row in category_rows:
            raw_value = row["raw_value"]
            saved_id = saved_assignments.get(raw_value)
            suggested_id = saved_id or by_normalized_name.get(normalize_import_category(raw_value))
            values.append({
                "raw_value": raw_value,
                "row_count": row["row_count"],
                "saved_category_id": saved_id,
                "suggested_category_id": suggested_id,
            })

    return {
        "values": values,
        "saved_assignments": saved_assignments,
        "unmapped_count": sum(1 for value in values if not value["saved_category_id"]),
    }


@router.post("/batches/{batch_id}/category-mappings")
def apply_batch_category_mappings(batch_id: str, body: BatchCategoryMappingApplyRequest):
    with get_db() as conn:
        batch = conn.execute(
            "SELECT id, profile_id, config_snapshot FROM import_batch WHERE id = ?",
            (batch_id,),
        ).fetchone()
        if not batch:
            raise HTTPException(status_code=404, detail="Batch not found")

        snapshot = {}
        if batch["config_snapshot"]:
            snapshot = safe_json_dict(batch["config_snapshot"])

        valid_category_ids = {
            row["id"] for row in conn.execute("SELECT id FROM category").fetchall()
        }
        current_assignments = (snapshot.get("category_assignments") or
                               (snapshot.get("column_map") or {}).get("category_assignments") or {})
        current_assignments = {
            raw_value: category_id
            for raw_value, category_id in current_assignments.items()
            if category_id in valid_category_ids
        }
        incoming_assignments = {
            raw_value: category_id
            for raw_value, category_id in body.assignments.items()
            if category_id in valid_category_ids
        }
        merged_assignments = {**current_assignments, **incoming_assignments}

        applied = 0
        for raw_value, category_id in incoming_assignments.items():
            result = conn.execute("""
                UPDATE txn
                SET    category_id = ?, category_overridden = 1
                WHERE  import_batch_id = ?
                  AND  imported_category = ?
            """, (category_id, batch_id, raw_value))
            applied += result.rowcount or 0

        snapshot["category_assignments"] = merged_assignments
        column_map = dict(snapshot.get("column_map") or {})
        column_map["category_assignments"] = merged_assignments
        snapshot["column_map"] = column_map
        config_snapshot = json.dumps(snapshot)
        conn.execute(
            "UPDATE import_batch SET config_snapshot = ? WHERE id = ?",
            (config_snapshot, batch_id),
        )

        saved_to_profile = False
        if batch["profile_id"]:
            # The batch keeps an immutable replay record, while the linked profile learns
            # the same mapping so future files start with the user's reviewed assignments.
            profile = conn.execute(
                "SELECT column_map FROM csv_import_profile WHERE id = ?",
                (batch["profile_id"],),
            ).fetchone()
            if profile:
                profile_map = safe_json_dict(profile["column_map"])
                profile_map["category_assignments"] = {
                    **(profile_map.get("category_assignments") or {}),
                    **incoming_assignments,
                }
                conn.execute(
                    "UPDATE csv_import_profile SET column_map = ? WHERE id = ?",
                    (json.dumps(profile_map), batch["profile_id"]),
                )
                saved_to_profile = True

        categorized_by_rules = 0
        if snapshot.get("apply_categorization", True):
            uncategorized_rows = conn.execute("""
                SELECT id, owner_id, account_id, amount, merchant_name, display_name, raw_name
                FROM   txn
                WHERE  import_batch_id = ?
                  AND  category_id IS NULL
                  AND  category_overridden = 0
            """, (batch_id,)).fetchall()
            for row in uncategorized_rows:
                result = categorize_transaction(
                    row["merchant_name"] or row["raw_name"] or "",
                    row["raw_name"] or row["merchant_name"] or "",
                    row["display_name"] or row["merchant_name"] or row["raw_name"] or "",
                    abs(row["amount"]),
                    conn,
                    owner_id=row["owner_id"],
                    account_id=row["account_id"],
                )
                cat_id = result["category_id"] if isinstance(result, dict) else result
                if cat_id:
                    conn.execute(
                        "UPDATE txn SET category_id = ? WHERE id = ?",
                        (cat_id, row["id"]),
                    )
                    categorized_by_rules += 1

    return {
        "ok": True,
        "applied_count": applied,
        "categorized_by_rules": categorized_by_rules,
        "saved_to_profile": saved_to_profile,
        "saved_mapping_count": len(incoming_assignments),
    }


@router.get("/batches/{batch_id}/rule-suggestions")
def get_batch_rule_suggestions(batch_id: str, owner_ids: Optional[str] = Query(None)):
    with get_db() as conn:
        batch = conn.execute(
            "SELECT id, config_snapshot FROM import_batch WHERE id = ?",
            (batch_id,),
        ).fetchone()
        if not batch:
            raise HTTPException(status_code=404, detail="Batch not found")

        snapshot = safe_json_dict(batch["config_snapshot"])
        review_state = get_rule_suggestion_review_state(snapshot)
        selected_owner_ids = [value.strip() for value in (owner_ids or "").split(",") if value.strip()]
        rows = _query_rule_suggestion_rows(conn, batch_id=batch_id)
        result = _build_rule_suggestion_response(conn, rows, review_state, selected_owner_ids)
        if result.pop("should_persist", False):
            snapshot[RULE_SUGGESTION_REVIEW_KEY] = review_state
            save_batch_snapshot(conn, batch_id, snapshot)
    return result


@router.get("/profiles/{profile_id}/rule-suggestions")
def get_profile_rule_suggestions(profile_id: str, owner_ids: Optional[str] = Query(None)):
    with get_db() as conn:
        column_map = _load_profile_column_map(conn, profile_id)
        review_state = _get_profile_rule_suggestion_review_state(column_map)
        selected_owner_ids = [value.strip() for value in (owner_ids or "").split(",") if value.strip()]
        rows = _query_rule_suggestion_rows(conn, profile_id=profile_id)
        result = _build_rule_suggestion_response(conn, rows, review_state, selected_owner_ids)
        if result.pop("should_persist", False):
            column_map[RULE_SUGGESTION_REVIEW_KEY] = review_state
            _save_profile_column_map(conn, profile_id, column_map)
    return result


@router.post("/batches/{batch_id}/rule-suggestions/review")
def update_batch_rule_suggestion_review(batch_id: str, body: BatchRuleSuggestionReviewUpdateRequest):
    status = (body.status or "").strip().lower()
    if status not in ({"pending"} | RULE_SUGGESTION_REVIEW_STATUSES):
        raise HTTPException(status_code=400, detail="Invalid review status")

    with get_db() as conn:
        batch = conn.execute(
            "SELECT id, config_snapshot FROM import_batch WHERE id = ?",
            (batch_id,),
        ).fetchone()
        if not batch:
            raise HTTPException(status_code=404, detail="Batch not found")

        snapshot = safe_json_dict(batch["config_snapshot"])
        review_state = get_rule_suggestion_review_state(snapshot)
        suggestion_entries = dict(review_state.get("suggestions") or {})
        suggestion_entries.setdefault(body.suggestion_id, {})

        if body.merchant_label:
            suggestion_entries[body.suggestion_id]["merchant_label"] = body.merchant_label
        if body.target_category_name:
            suggestion_entries[body.suggestion_id]["target_category_name"] = body.target_category_name
        if body.keyword:
            suggestion_entries[body.suggestion_id]["keyword"] = body.keyword

        statuses = dict(review_state.get("statuses") or {})
        if status == "pending":
            statuses.pop(body.suggestion_id, None)
        else:
            next_status = {
                "status": status,
                "updated_at": datetime.utcnow().isoformat(),
            }
            if body.rule_id:
                next_status["rule_id"] = body.rule_id
            statuses[body.suggestion_id] = next_status

        review_state["suggestions"] = suggestion_entries
        review_state["statuses"] = statuses
        review_summary = summarize_rule_suggestion_review(review_state)
        snapshot[RULE_SUGGESTION_REVIEW_KEY] = review_state
        save_batch_snapshot(conn, batch_id, snapshot)

    return {
        "ok": True,
        "review_summary": review_summary,
        "generated_at": review_state.get("generated_at"),
    }


@router.post("/profiles/{profile_id}/rule-suggestions/review")
def update_profile_rule_suggestion_review(profile_id: str, body: BatchRuleSuggestionReviewUpdateRequest):
    status = (body.status or "").strip().lower()
    if status not in ({"pending"} | RULE_SUGGESTION_REVIEW_STATUSES):
        raise HTTPException(status_code=400, detail="Invalid review status")

    with get_db() as conn:
        column_map = _load_profile_column_map(conn, profile_id)
        review_state = _get_profile_rule_suggestion_review_state(column_map)
        suggestion_entries = dict(review_state.get("suggestions") or {})
        suggestion_entries.setdefault(body.suggestion_id, {})

        if body.merchant_label:
            suggestion_entries[body.suggestion_id]["merchant_label"] = body.merchant_label
        if body.target_category_name:
            suggestion_entries[body.suggestion_id]["target_category_name"] = body.target_category_name
        if body.keyword:
            suggestion_entries[body.suggestion_id]["keyword"] = body.keyword

        statuses = dict(review_state.get("statuses") or {})
        if status == "pending":
            statuses.pop(body.suggestion_id, None)
        else:
            next_status = {
                "status": status,
                "updated_at": datetime.utcnow().isoformat(),
            }
            if body.rule_id:
                next_status["rule_id"] = body.rule_id
            statuses[body.suggestion_id] = next_status

        review_state["suggestions"] = suggestion_entries
        review_state["statuses"] = statuses
        review_summary = summarize_rule_suggestion_review(review_state)
        column_map[RULE_SUGGESTION_REVIEW_KEY] = review_state
        _save_profile_column_map(conn, profile_id, column_map)

    return {
        "ok": True,
        "review_summary": review_summary,
        "generated_at": review_state.get("generated_at"),
    }


@router.post("/batches/{batch_id}/rule-suggestions/matches")
def get_batch_rule_suggestion_matches(batch_id: str, body: BatchRuleSuggestionMatchRequest):
    keyword = normalize_rule_keyword(body.keyword or "")
    if not keyword:
        raise HTTPException(status_code=400, detail="keyword required")

    with get_db() as conn:
        batch = conn.execute(
            "SELECT id, filename, config_snapshot FROM import_batch WHERE id = ?",
            (batch_id,),
        ).fetchone()
        if not batch:
            raise HTTPException(status_code=404, detail="Batch not found")
        snapshot = safe_json_dict(batch["config_snapshot"])
        amount_convention = snapshot.get("amount_convention", "single_signed")

        categories_by_name, categories_by_id = _load_import_rule_target_maps(conn)
        rows = conn.execute(
            """
            SELECT
                t.id,
                t.date,
                t.amount,
                t.merchant_name,
                t.display_name,
                t.raw_name,
                t.imported_category,
                t.category_id,
                t.category_overridden,
                t.account_id,
                t.owner_id,
                a.name AS account_name,
                a.mask AS account_mask,
                o.name AS owner_name
            FROM txn t
            LEFT JOIN account a ON a.id = t.account_id
            LEFT JOIN owner o ON o.id = t.owner_id
            WHERE t.import_batch_id = ?
              AND t.imported_category IS NOT NULL
              AND TRIM(t.imported_category) <> ''
              AND t.category_id IS NULL
            ORDER BY t.date DESC, t.id DESC
            """,
            (batch_id,),
        ).fetchall()

    matching_rows = []
    for base_row in rows:
        row = dict(base_row)
        row["display_amount"] = get_import_display_amount(row["amount"], amount_convention)
        row_keyword = normalize_rule_keyword(
            row["display_name"] or row["merchant_name"] or row["raw_name"] or ""
        )
        if not row_keyword or row_keyword != keyword:
            continue
        if body.owner_id and row["owner_id"] != body.owner_id:
            continue
        if body.account_id and row["account_id"] != body.account_id:
            continue

        abs_amount = abs(row["amount"])
        if body.amount_min is not None and abs_amount < body.amount_min:
            continue
        if body.amount_max is not None and abs_amount > body.amount_max:
            continue

        target_category_id, target_category_name, target_category_group_name = _resolve_import_rule_target(
            row,
            categories_by_name,
            categories_by_id,
        )
        row["target_category_id"] = target_category_id
        row["target_category_name"] = target_category_name
        row["target_category_group_name"] = target_category_group_name
        row["conflicts_with_reference"] = bool(
            body.reference_target_category_id
            and target_category_id
            and target_category_id != body.reference_target_category_id
        )
        matching_rows.append(row)

    return {
        "batch_id": batch_id,
        "filename": batch["filename"],
        "keyword": keyword,
        "amount_convention": amount_convention,
        "count": len(matching_rows),
        "transactions": matching_rows,
    }


@router.post("/profiles/{profile_id}/rule-suggestions/matches")
def get_profile_rule_suggestion_matches(profile_id: str, body: BatchRuleSuggestionMatchRequest):
    keyword = normalize_rule_keyword(body.keyword or "")
    if not keyword:
        raise HTTPException(status_code=400, detail="keyword required")

    with get_db() as conn:
        profile = conn.execute(
            "SELECT id, name, amount_convention FROM csv_import_profile WHERE id = ?",
            (profile_id,),
        ).fetchone()
        if not profile:
            raise HTTPException(status_code=404, detail="Profile not found")
        amount_convention = profile["amount_convention"] or "single_signed"

        categories_by_name, categories_by_id = _load_import_rule_target_maps(conn)
        rows = conn.execute(
            """
            SELECT
                t.id,
                t.date,
                t.amount,
                t.merchant_name,
                t.display_name,
                t.raw_name,
                t.imported_category,
                t.category_id,
                t.category_overridden,
                t.account_id,
                t.owner_id,
                a.name AS account_name,
                a.mask AS account_mask,
                o.name AS owner_name
            FROM txn t
            JOIN import_batch b ON b.id = t.import_batch_id
            LEFT JOIN account a ON a.id = t.account_id
            LEFT JOIN owner o ON o.id = t.owner_id
            WHERE b.profile_id = ?
              AND b.status = 'completed'
              AND t.imported_category IS NOT NULL
              AND TRIM(t.imported_category) <> ''
              AND t.category_id IS NULL
            ORDER BY t.date DESC, t.id DESC
            """,
            (profile_id,),
        ).fetchall()

    matching_rows = []
    for base_row in rows:
        row = dict(base_row)
        row["display_amount"] = get_import_display_amount(row["amount"], amount_convention)
        row_keyword = normalize_rule_keyword(
            row["display_name"] or row["merchant_name"] or row["raw_name"] or ""
        )
        if not row_keyword or row_keyword != keyword:
            continue
        if body.owner_id and row["owner_id"] != body.owner_id:
            continue
        if body.account_id and row["account_id"] != body.account_id:
            continue

        abs_amount = abs(row["amount"])
        if body.amount_min is not None and abs_amount < body.amount_min:
            continue
        if body.amount_max is not None and abs_amount > body.amount_max:
            continue

        target_category_id, target_category_name, target_category_group_name = _resolve_import_rule_target(
            row,
            categories_by_name,
            categories_by_id,
        )
        row["target_category_id"] = target_category_id
        row["target_category_name"] = target_category_name
        row["target_category_group_name"] = target_category_group_name
        row["conflicts_with_reference"] = bool(
            body.reference_target_category_id
            and target_category_id
            and target_category_id != body.reference_target_category_id
        )
        matching_rows.append(row)

    return {
        "profile_id": profile_id,
        "profile_name": profile["name"],
        "keyword": keyword,
        "amount_convention": amount_convention,
        "count": len(matching_rows),
        "transactions": matching_rows,
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


@router.get("/batches/{batch_id}/category-workspace-draft")
def get_batch_category_workspace_draft(batch_id: str):
    with get_db() as conn:
        batch = conn.execute(
            "SELECT id, profile_id, config_snapshot FROM import_batch WHERE id = ?",
            (batch_id,),
        ).fetchone()
        if not batch:
            raise HTTPException(status_code=404, detail="Batch not found")
        snapshot = safe_json_dict(batch["config_snapshot"])
        draft = snapshot.get("category_workspace_draft")
        summary = summarize_category_workspace_draft(draft)
    return {"draft": draft, "summary": summary}


@router.patch("/batches/{batch_id}/category-workspace-draft")
def save_batch_category_workspace_draft(batch_id: str, body: BatchCategoryWorkspaceDraftRequest):
    """
    Persist a category workspace draft into a batch's config_snapshot.
    Used for profileless imports where there is no data source profile to
    store the draft in. The draft is stored under the same
    'category_workspace_draft' key used by profile column_map, so the
    frontend category workspace machinery works identically in both cases.
    Only valid for profileless batches (profile_id IS NULL); batches linked
    to a profile store their draft in the profile instead.
    """
    with get_db() as conn:
        batch = conn.execute(
            "SELECT id, profile_id, config_snapshot FROM import_batch WHERE id = ?",
            (batch_id,),
        ).fetchone()
        if not batch:
            raise HTTPException(status_code=404, detail="Batch not found")
        if batch["profile_id"]:
            raise HTTPException(
                status_code=400,
                detail="Category workspace draft is stored on the profile for profile-linked batches",
            )
        snapshot = safe_json_dict(batch["config_snapshot"])
        if body.draft is None:
            snapshot.pop("category_workspace_draft", None)
        else:
            snapshot["category_workspace_draft"] = body.draft
        save_batch_snapshot(conn, batch_id, snapshot)
    return {"ok": True}


@router.delete("/batches/{batch_id}")
def undo_batch(batch_id: str, force: bool = Query(False)):
    """
    Undo an import batch. If any transactions were manually edited, returns 409
    with the list unless force=true.
    """
    with get_db() as conn:
        batch = conn.execute(
            "SELECT id, status FROM import_batch WHERE id = ?", (batch_id,)
        ).fetchone()
        if not batch:
            raise HTTPException(status_code=404, detail="Batch not found")
        if batch["status"] == "undone":
            raise HTTPException(status_code=400, detail="Batch already undone")

        if not force:
            edited = conn.execute("""
                SELECT t.id, t.date, COALESCE(t.display_name, t.merchant_name, t.raw_name) AS merchant_name, t.amount,
                       c.name AS category_name
                FROM   txn t
                LEFT JOIN category c ON c.id = t.category_id
                WHERE  t.import_batch_id = ? AND t.category_overridden = 1
            """, (batch_id,)).fetchall()

            if edited:
                return JSONResponse(status_code=409, content={
                    "detail": "Some transactions were manually edited after import",
                    "edited_transactions": [dict(r) for r in edited],
                })

        conn.execute("DELETE FROM txn WHERE import_batch_id = ?", (batch_id,))
        conn.execute(
            "UPDATE import_batch SET status = 'undone' WHERE id = ?", (batch_id,)
        )

    return {"ok": True}

EXPORT_COLUMNS = {
    "date":          ("t.date",            "Date"),
    "merchant_name": ("COALESCE(t.display_name, t.merchant_name, t.raw_name)",   "Merchant"),
    "raw_name":      ("t.raw_name",        "Raw description"),
    "amount":        ("t.amount",          "Amount"),
    "account":       ("a.name",            "Account"),
    "category":      ("c.name",            "Category"),
    "group":         ("p.name",            "Group"),
    "owner":         ("o.name",            "Owner"),
    "notes":         ("t.notes",           "Notes"),
    "is_pending":    ("t.is_pending",      "Pending"),
    "overridden":    ("t.category_overridden", "Manually categorized"),
    "import_batch":  ("t.import_batch_id", "Import batch"),
}


@router.get("/transactions.csv")
def export_transactions_csv(
    columns:      str           = Query("date,merchant_name,amount,account,category"),
    date_start:   Optional[str] = Query(None),
    date_end:     Optional[str] = Query(None),
    account_ids:  Optional[str] = Query(None),
    owner_ids:    Optional[str] = Query(None),
    group_ids:    Optional[str] = Query(None),
    category_ids: Optional[str] = Query(None),
    search:       Optional[str] = Query(None),
):
    col_keys = [c.strip() for c in columns.split(",") if c.strip() in EXPORT_COLUMNS]
    if not col_keys:
        col_keys = ["date", "merchant_name", "amount", "account", "category"]

    select_exprs = [f"{EXPORT_COLUMNS[k][0]} AS {k}" for k in col_keys]
    headers      = [EXPORT_COLUMNS[k][1] for k in col_keys]

    clauses, params = [], []
    if date_start and date_end:
        clauses.append("t.date BETWEEN ? AND ?"); params.extend([date_start, date_end])
    elif date_start:
        clauses.append("t.date >= ?"); params.append(date_start)
    elif date_end:
        clauses.append("t.date <= ?"); params.append(date_end)
    if account_ids:
        ids = [i.strip() for i in account_ids.split(",") if i.strip()]
        clauses.append(f"t.account_id IN ({','.join('?'*len(ids))})"); params.extend(ids)
    if owner_ids:
        ids = [i.strip() for i in owner_ids.split(",") if i.strip()]
        clauses.append(f"t.owner_id IN ({','.join('?'*len(ids))})"); params.extend(ids)
    if group_ids:
        ids = [i.strip() for i in group_ids.split(",") if i.strip()]
        clauses.append(
            f"t.category_id IN (SELECT id FROM category WHERE parent_id IN ({','.join('?'*len(ids))}))"
        ); params.extend(ids)
    if category_ids:
        ids = [i.strip() for i in category_ids.split(",") if i.strip()]
        clauses.append(f"t.category_id IN ({','.join('?'*len(ids))})"); params.extend(ids)
    if search:
        clauses.append("(t.display_name LIKE ? OR t.merchant_name LIKE ? OR t.raw_name LIKE ?)")
        params.extend([f"%{search}%", f"%{search}%", f"%{search}%"])

    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""

    with get_db() as conn:
        rows = conn.execute(f"""
            SELECT {', '.join(select_exprs)}
            FROM   txn t
            JOIN   account   a ON a.id  = t.account_id
            LEFT JOIN category c ON c.id  = t.category_id
            LEFT JOIN category p ON p.id  = c.parent_id
            LEFT JOIN owner    o ON o.id  = t.owner_id
            {where}
            ORDER  BY t.date DESC, t.id DESC
        """, params).fetchall()

    def generate():
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(headers)
        yield buf.getvalue(); buf.seek(0); buf.truncate()
        for row in rows:
            w.writerow([row[k] for k in col_keys])
            yield buf.getvalue(); buf.seek(0); buf.truncate()

    return StreamingResponse(
        generate(),
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="fintrack_export.csv"'},
    )

@router.get("/backup")
def export_backup(encrypted: bool = Query(False)):
    with get_db() as conn:
        def dump(table, query=None):
            q = query or f"SELECT * FROM {table} ORDER BY rowid"
            return [dict(r) for r in conn.execute(q).fetchall()]

        payload = {
            "version":        3,
            "exported_at":    datetime.utcnow().isoformat(),
            "owners":         dump("owner"),
            "accounts":       dump("account",
                                   "SELECT id, plaid_account_id, plaid_item_id, name, "
                                   "institution, type, subtype, mask, owner_id FROM account"),
            "categories":     dump("category"),
            "category_rules": dump("category_rule"),
            "merchant_renames": dump("merchant_rename"),
            "csv_profiles":   dump("csv_import_profile"),
            "import_batches": dump("import_batch"),
            "import_batch_accounts": dump("import_batch_account"),
            "import_batch_duplicates": dump("import_batch_duplicate"),
            "transactions":   dump("txn",
                                   "SELECT id, plaid_transaction_id, account_id, owner_id, "
                                   "category_id, amount, merchant_name, display_name, raw_name, date, "
                                   "is_pending, category_overridden, imported_category, notes, content_hash, "
                                   "import_batch_id FROM txn ORDER BY date DESC"),
        }
        recipients = []
        if encrypted:
            recipients = [dict(r) for r in conn.execute("""
                SELECT id, label, public_key
                FROM   backup_recipient
                WHERE  enabled = 1
                ORDER  BY created_at DESC, label
            """).fetchall()]

    if encrypted:
        if not recipients:
            raise HTTPException(status_code=400, detail="No enabled backup recipients are configured")
        content = _build_encrypted_backup_bytes(
            _zip_json_bytes("fintrack_backup.json", payload),
            recipients,
        )
        filename = "fintrack_backup.encrypted.zip"
    else:
        content = _zip_json_bytes("fintrack_backup.json", payload)
        filename = "fintrack_backup.zip"
    return StreamingResponse(
        iter([content]),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/backup/credentials")
def export_credentials(request: Request, encrypted: bool = Query(False)):
    """Export Plaid credentials — treat this file like a password."""
    with get_db() as conn:
        items = conn.execute("SELECT * FROM plaid_item").fetchall()
        recipients = []
        if encrypted:
            recipients = [dict(r) for r in conn.execute("""
                SELECT id, label, public_key
                FROM   backup_recipient
                WHERE  enabled = 1
                ORDER  BY created_at DESC, label
            """).fetchall()]
    user = getattr(request.state, "user", None)
    exported_items = []
    for row in items:
        item = dict(row)
        item["access_token"] = crypto_service.decrypt_plaid_access_token(
            user,
            item["item_id"],
            item.get("access_token"),
            item.get("access_token_enc"),
        )
        item.pop("access_token_enc", None)
        exported_items.append(item)
    payload = {
        "version":     1,
        "exported_at": datetime.utcnow().isoformat(),
        "warning":     "This file contains sensitive Plaid access tokens. Store securely.",
        "plaid_items": exported_items,
    }
    if encrypted:
        if not recipients:
            raise HTTPException(status_code=400, detail="No enabled backup recipients are configured")
        content = _build_encrypted_backup_bytes(
            _zip_json_bytes("fintrack_credentials.json", payload),
            recipients,
        )
        filename = "fintrack_credentials.encrypted.zip"
    else:
        content = _zip_json_bytes("fintrack_credentials.json", payload)
        filename = "fintrack_credentials.zip"
    return StreamingResponse(
        iter([content]),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


class RestoreRequest(BaseModel):
    data:             dict


@router.post("/restore")
def restore_backup(body: RestoreRequest):
    """
    Destructive restore. Wipes all non-credential data and replaces with backup.
    Plaid items / access tokens are NOT touched.
    """
    d = body.data
    if d.get("version") not in (1, 2, 3):
        raise HTTPException(status_code=400, detail="Unrecognised backup version")

    owners = [dict(row) for row in d.get("owners", [])]
    accounts = [dict(row) for row in d.get("accounts", [])]
    categories = [dict(row) for row in d.get("categories", [])]
    category_rules = [dict(row) for row in d.get("category_rules", [])]
    merchant_renames = [dict(row) for row in d.get("merchant_renames", [])]
    csv_profiles = [dict(row) for row in d.get("csv_profiles", [])]
    import_batches = [dict(row) for row in d.get("import_batches", [])]
    import_batch_accounts = [dict(row) for row in d.get("import_batch_accounts", [])]
    import_batch_duplicates = [dict(row) for row in d.get("import_batch_duplicates", [])]
    transactions = [dict(row) for row in d.get("transactions", [])]

    owner_ids = {row.get("id") for row in owners if row.get("id")}
    account_ids = {row.get("id") for row in accounts if row.get("id")}
    category_ids = {row.get("id") for row in categories if row.get("id")}
    csv_profile_ids = {row.get("id") for row in csv_profiles if row.get("id")}
    import_batch_ids = {row.get("id") for row in import_batches if row.get("id")}

    # Backups can outlive later deletions or schema tightening. Normalize broken foreign
    # keys to NULL so restore stays best-effort instead of failing the entire archive.
    def normalize_nullable_fk(rows, key, valid_ids):
        for row in rows:
            value = row.get(key)
            if value and value not in valid_ids:
                row[key] = None

    normalize_nullable_fk(accounts, "owner_id", owner_ids)
    normalize_nullable_fk(categories, "owner_id", owner_ids)
    normalize_nullable_fk(csv_profiles, "account_id", account_ids)
    normalize_nullable_fk(import_batches, "profile_id", csv_profile_ids)

    for row in categories:
        parent_id = row.get("parent_id")
        if parent_id and parent_id not in category_ids:
            row["parent_id"] = None

    category_rules = [
        row for row in category_rules
        if row.get("category_id") in category_ids
    ]

    normalize_nullable_fk(transactions, "owner_id", owner_ids)
    normalize_nullable_fk(transactions, "category_id", category_ids)
    normalize_nullable_fk(transactions, "import_batch_id", import_batch_ids)
    transactions = [
        row for row in transactions
        if row.get("account_id") in account_ids
    ]

    import_batch_accounts = [
        row for row in import_batch_accounts
        if row.get("batch_id") in import_batch_ids
        and (not row.get("account_id") or row.get("account_id") in account_ids)
    ]
    import_batch_duplicates = [
        row for row in import_batch_duplicates
        if row.get("batch_id") in import_batch_ids
    ]

    # Categories are a two-level hierarchy; insert groups before leaves so
    # self-referential parent_id constraints are satisfied during restore.
    categories.sort(key=lambda row: (0 if not row.get("parent_id") else 1, row.get("sort_order", 0), row.get("name", "")))

    with get_db() as conn:
        # Wipe in dependency order (children before parents)
        conn.execute("DELETE FROM txn")
        conn.execute("DELETE FROM import_batch_duplicate")
        conn.execute("DELETE FROM import_batch_account")
        conn.execute("DELETE FROM import_batch")
        conn.execute("DELETE FROM category_rule")
        conn.execute("DELETE FROM merchant_rename")
        conn.execute("DELETE FROM csv_import_profile")
        conn.execute("DELETE FROM category")
        conn.execute("DELETE FROM account")
        conn.execute("DELETE FROM owner")

        def insert_rows(table, rows, exclude=()):
            if not rows:
                return
            sample = {k: v for k, v in rows[0].items() if k not in exclude}
            cols = list(sample.keys())
            placeholders = ",".join("?" * len(cols))
            for row in rows:
                vals = [row.get(c) for c in cols]
                conn.execute(
                    f"INSERT OR IGNORE INTO {table} ({','.join(cols)}) VALUES ({placeholders})",
                    vals
                )

        insert_rows("owner",            owners)
        insert_rows("account",          accounts)
        insert_rows("category",         categories)
        insert_rows("category_rule",    category_rules)
        insert_rows("merchant_rename",  merchant_renames)
        insert_rows("csv_import_profile", csv_profiles)
        insert_rows("import_batch", import_batches)
        insert_rows("import_batch_account", import_batch_accounts)
        insert_rows("import_batch_duplicate", import_batch_duplicates)
        insert_rows("txn",          transactions)

    return {
        "ok": True,
        "restored_at": datetime.utcnow().isoformat(),
        "restored_counts": {
            "owners": len(owners),
            "accounts": len(accounts),
            "categories": len(categories),
            "category_rules": len(category_rules),
            "merchant_renames": len(merchant_renames),
            "csv_profiles": len(csv_profiles),
            "import_batches": len(import_batches),
            "import_batch_accounts": len(import_batch_accounts),
            "import_batch_duplicates": len(import_batch_duplicates),
            "transactions": len(transactions),
        },
    }


class CredentialsRestoreRequest(BaseModel):
    data: dict


@router.post("/restore-file/inspect")
async def inspect_backup_file(file: UploadFile = File(...)):
    content = await file.read()
    return _inspect_backup_upload(content, file.filename or "", "backup")


@router.post("/restore/credentials")
def restore_credentials(body: CredentialsRestoreRequest, request: Request):
    d = body.data
    if d.get("version") != 1:
        raise HTTPException(status_code=400, detail="Unrecognised credentials backup version")
    items = d.get("plaid_items", [])
    user = getattr(request.state, "user", None)
    with get_db() as conn:
        conn.execute("DELETE FROM plaid_item")
        for item in items:
            access_token, access_token_enc = crypto_service.encrypt_plaid_access_token(
                user,
                item["item_id"],
                item["access_token"],
            )
            conn.execute(
                "INSERT OR IGNORE INTO plaid_item (item_id, access_token, access_token_enc) VALUES (?, ?, ?)",
                (item["item_id"], access_token, access_token_enc)
            )
    return {"ok": True, "restored": len(items)}


@router.post("/restore-file")
async def restore_backup_file(
    file: UploadFile = File(...),
    private_key_file: UploadFile | None = File(None),
    private_key_passphrase: str | None = Form(None),
):
    content = await file.read()
    private_key_bytes = await private_key_file.read() if private_key_file else None
    payload = _load_backup_payload_from_upload(
        content,
        file.filename or "",
        "backup",
        private_key_bytes=private_key_bytes,
        private_key_passphrase=private_key_passphrase,
    )
    return restore_backup(RestoreRequest(data=payload))


@router.post("/restore/credentials-file")
async def restore_credentials_file(request: Request, file: UploadFile = File(...)):
    content = await file.read()
    payload = _load_json_or_zip_payload(content, file.filename or "", "credentials")
    return restore_credentials(CredentialsRestoreRequest(data=payload), request)
