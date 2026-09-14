# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
The cohesive core of the import/export package.

Import/export is a long-lived workflow, not a single upload endpoint. The defining requirement is
that the mapping/dedupe/category decisions made on one import stay reconstructable later: the run
endpoint persists a `config_snapshot` per batch so import, undo, the duplicate report, category
review, and rule-suggestion review can all reopen or replay the original run without drifting from
it. Those stages share that snapshot and a web of helpers, so they are kept together here on purpose
(see `docs/architecture.md` — "the module is large … intentional") rather than scattered for the
sake of smaller files. The cleanly-separable concerns that do NOT share that web — saved-profile
CRUD, backup/restore, the read-only preview — live in the sibling modules (`profiles`, `backup`,
`preview`), which import from this module; `core` never imports them, so the package stays a DAG.

This file also owns the shared low-level primitives the workflow (and those siblings) reuse:
content/file hashing, amount/date/pending and header parsing, and the imported-category settings
codec. The parse primitives in particular stay here because `run_import` is their primary caller.

Duplicate detection is **not** owned here. A CSV import is one of two ingestion paths — the other is
data-source sync — so the rule ladder, its candidate/coverage primitives, and the context builder all
live in `services/duplicate_detection.py`, and this module is a caller like any other: it hands
`build_dedupe_context` its account-column values and their mapped accounts, then runs each parsed row
through `evaluate_duplicate`.

Rough reading order: request models → normalization/settings helpers → import-row insertion +
batch-duplicate persistence → category-workspace and rule-suggestion-review state → profile
signature/column-map helpers → import-source/category primitives → the endpoints (`/run`, the
duplicate-report family, `/batches…`, category-mappings, the rule-suggestion family, undo).
"""

import csv
import hashlib
import io
import json
import sqlite3
import uuid
import os
import re
from contextlib import nullcontext
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Query, UploadFile, File, Form, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from backend import app_config
from backend.app_logging import log_warning
from backend.db.database import SHARED_OWNER_ID, get_db, get_tenant_workflow_state, set_tenant_workflow_state
from backend.db.demo_data import is_demo_data_loaded
from backend.services.restore_state import require_no_pending_restore
from backend.json_utils import safe_json_dict
from backend.time_utils import utcnow_iso
from backend.routers.accounts import resolve_default_owner_id
from backend.services.categorizer import (
    categorize_transaction,
    category_lock_for,
    extract_source_match_text,
    load_categorization_rules,
    load_rule_tags_by_id,
    recategorize_all,
    rule_scalar_effects,
    source_match_text_from_json,
    effect_rule_ids,
    bump_rule_effect_dates,
)
from backend.services.recurring_detection import payee_keys_for_ids, scan_imported_payees
from backend.services.import_evidence import (
    EVIDENCE_ROLE_CATEGORICAL,
    EVIDENCE_ROLE_DESCRIPTIVE,
)
from backend.services.duplicate_detection import (
    build_dedupe_context,
    DEFAULT_TERMINAL_WINDOW_DAYS,
    compute_import_coverage_window,
    evaluate_duplicate,
    get_effective_account_row,
    list_unified_batch_duplicates,
    mark_import_suspects,
    record_account_pair_distinct,
    unresolved_account_pairs,
    MIN_TERMINAL_WINDOW_DAYS,
    sweep_import_suspects,
    refresh_unexplained_coverage_candidates,
)
from backend.text_utils import sanitize_rule_merchant_text
from backend.services.transaction_tags import sync_rule_tags_for_transaction
from backend.services.ledger_currency import currency_matches, get_ledger_currency
from backend.runtime_config import app_name
from backend.services.source_capabilities import (
    CURRENCY_REJECTION_KIND,
    SOURCE_CSV,
    ZERO_AMOUNT_REJECTION_KIND,
    ZERO_AMOUNT_REJECTION_REASON,
    rejects_zero_amount,
    zero_amount_policy_for_source,
)
from backend.services.import_enrichment import enrich_duplicate_row, undo_duplicate_enrichment, reverse_batch_enrichments
from backend.services.money_movement import (
    suppress_batch_funding_legs,
    reverse_batch_money_movement_links,
    money_movement_type_proposals,
    money_movement_type_proposals_for_profile,
    create_money_movement_rules,
    delete_money_movement_rules,
    money_movement_category_id_if_exists,
    ensure_paypal_account_type,
    batch_account_ids,
    profile_account_ids,
    profile_effective_account_ids,
)

router = APIRouter()

MAX_DISTINCT_VALUES_PER_COLUMN = 500
RULE_SUGGESTION_REVIEW_KEY = "rule_suggestion_review"
RULE_SUGGESTION_REVIEW_STATUSES = {"accepted", "skipped", "discarded"}
IMPORT_SUMMARY_KEY = "import_summary"
UNKNOWN_SOURCE_FALLBACK_KEY = "unknown_source_fallback"
SYSTEM_RULE_SUGGESTION_REVIEW_STATE_KEY = "system_rule_suggestion_review"
SYSTEM_CATEGORY_WORKSPACE_DRAFT_KEY = "system_category_workspace_draft"
UNASSIGNED_CATEGORY_SYSTEM_KEY = "unassigned"
IMPORTED_CATEGORY_SETTINGS_KEY = "imported_category_settings"
IMPORTED_CATEGORY_SCOPE_ALL = "all"
IMPORTED_CATEGORY_SCOPE_FILTERED = "filtered"
FIXED_ACCOUNT_CATEGORY_SCOPE_TOKEN_PREFIX = "account:"
NEW_ACCOUNT_CATEGORY_SCOPE_TOKEN_PREFIX = "new-account:"
UNCATEGORIZED_IMPORT_CATEGORY_NAMES = {"uncategorized", "uncategorised", "unassigned"}
MAX_IMPORT_EVIDENCE_TEXT_FIELDS = 6
EXACT_DUPLICATE_STRATEGY_KEY = "exact_hash"
COVERAGE_DUPLICATE_STRATEGY_KEY = "coverage_window"
TEXT_DUPLICATE_STRATEGY_KEY = "cross_source_text"
# Columns whose header matches one of these keywords (substring, case-insensitive) are captured into
# import evidence beyond the mapped account/description, so the transaction detail can surface them
# when a row is too cryptic to recognize. The list is intentionally limited to *descriptive free
# text* — memos, narratives, counterparty/payee names, payment purpose — i.e. the things that help a
# user decode "what was this?". It deliberately excludes identifiers and figures (check/balance/
# transaction type/status/location), which don't aid recognition and would add noise to the text
# duplicate-matcher that also consumes these fields. See _build_import_evidence.
IMPORT_EVIDENCE_HEADER_KEYWORDS = (
    "original statement",
    "statement",
    "memo",
    "details",
    "detail",
    "reference",
    "ref",
    "payee",
    "merchant",
    "description",
    "note",
    "narrative",
    "particulars",
    "remittance",
    "comment",
    "purpose",
    "counterparty",
    "beneficiary",
    "originator",
)


def _require_developer_access(request: Request):
    if not app_config.developer_options_enabled():
        raise HTTPException(status_code=404, detail="Developer options are not enabled")
    # Identity is uniform in both modes now: the middleware resolves the session identity onto
    # request.state.user (perimeter on or off), so there is no separate local-profile header path.
    user = getattr(request.state, "user", None)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user


class AmountColumnMap(BaseModel):
    """
    The columns an amount can be read from — the whole input `parse_amount` needs. Split out of
    `ColumnMap` so the preview's amount endpoint can ask what a row's amount will be without
    also having to claim a date and description column it has no use for.
    """
    amount:       Optional[str] = None
    debit:        Optional[str] = None
    credit:       Optional[str] = None
    direction:    Optional[str] = None

class ColumnMap(AmountColumnMap):
    date:         str
    pending:      Optional[str] = None
    # The column stating each row's currency, for a file that can mix them (a wallet export). Unmapped,
    # every row is taken to be in the ledger's currency, which is what nearly every export is.
    currency:     Optional[str] = None
    description:  str
    category:     Optional[str] = None
    notes:        Optional[str] = None
    account:      Optional[str] = None
    # Headers the user explicitly picked to capture into import evidence beyond the keyword auto-detect
    # (e.g. PayPal "Item Title"). Honored over MAX_IMPORT_EVIDENCE_TEXT_FIELDS; each is role-classified.
    evidence_columns: Optional[list[str]] = None

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
    enrich_from_source:   bool = False
    replace_batch_id:     Optional[str] = None
    rows:                 list[dict]


class BatchCategoryMappingApplyRequest(BaseModel):
    assignments: dict[str, str]


def _normalize_imported_category_scope_mode(value: Optional[str]) -> str:
    return (
        IMPORTED_CATEGORY_SCOPE_FILTERED
        if str(value or "").strip().lower() == IMPORTED_CATEGORY_SCOPE_FILTERED
        else IMPORTED_CATEGORY_SCOPE_ALL
    )


def _normalize_string_list(values) -> list[str]:
    normalized: list[str] = []
    seen: set[str] = set()
    for value in values or []:
        item = str(value or "").strip()
        if not item or item in seen:
            continue
        seen.add(item)
        normalized.append(item)
    return normalized


def _normalize_imported_category_settings(raw) -> dict:
    payload = safe_json_dict(raw)
    return {
        "scope_mode": _normalize_imported_category_scope_mode(payload.get("scope_mode")),
        "owner_ids": _normalize_string_list(payload.get("owner_ids")),
        "unassigned_account_tokens": _normalize_string_list(payload.get("unassigned_account_tokens")),
    }


def _get_imported_category_settings(source: dict | None) -> dict:
    source = source if isinstance(source, dict) else {}
    if isinstance(source.get(IMPORTED_CATEGORY_SETTINGS_KEY), dict):
        payload = source.get(IMPORTED_CATEGORY_SETTINGS_KEY)
    elif isinstance(source.get("column_map"), dict) and isinstance(source["column_map"].get(IMPORTED_CATEGORY_SETTINGS_KEY), dict):
        payload = source["column_map"].get(IMPORTED_CATEGORY_SETTINGS_KEY)
    else:
        payload = {
            "scope_mode": source.get("imported_category_scope_mode"),
            "owner_ids": source.get("imported_category_owner_ids"),
            "unassigned_account_tokens": source.get("imported_category_unassigned_account_tokens"),
        }
    return _normalize_imported_category_settings(payload)


def _store_imported_category_settings(container: dict | None, settings: dict) -> dict:
    next_container = dict(container or {})
    next_container[IMPORTED_CATEGORY_SETTINGS_KEY] = _normalize_imported_category_settings(settings)
    return next_container


def _annotate_imported_category_settings(target: dict | None, settings: dict) -> dict:
    next_target = dict(target or {})
    normalized = _normalize_imported_category_settings(settings)
    next_target["imported_category_scope_mode"] = normalized["scope_mode"]
    next_target["imported_category_owner_ids"] = normalized["owner_ids"]
    next_target["imported_category_unassigned_account_tokens"] = normalized["unassigned_account_tokens"]
    return next_target


def _normalize_new_account_category_scope_token(name: Optional[str]) -> Optional[str]:
    normalized = " ".join(str(name or "").strip().split()).casefold()
    return f"{NEW_ACCOUNT_CATEGORY_SCOPE_TOKEN_PREFIX}{normalized}" if normalized else None


def _category_scope_token_for_import_row(
    csv_value: str,
    account_id: Optional[str],
    has_account_column: bool,
    single_account_new: Optional[dict] = None,
) -> Optional[str]:
    if has_account_column:
        token = str(csv_value or "").strip()
        return token or None
    named_token = _normalize_new_account_category_scope_token((single_account_new or {}).get("name"))
    if named_token:
        return named_token
    token = str(account_id or "").strip()
    return f"{FIXED_ACCOUNT_CATEGORY_SCOPE_TOKEN_PREFIX}{token}" if token else None


def _row_uses_imported_categories(is_enabled: bool, settings: dict, owner_id: Optional[str], account_token: Optional[str]) -> bool:
    if not is_enabled:
        return False
    if settings["scope_mode"] != IMPORTED_CATEGORY_SCOPE_FILTERED:
        return True
    if owner_id and owner_id in settings["owner_ids"]:
        return True
    if not owner_id and account_token and account_token in settings["unassigned_account_tokens"]:
        return True
    return False


class BatchImportedCategoryUsageUpdateRequest(BaseModel):
    use_imported_categories: bool
    imported_category_scope_mode: Optional[str] = None
    imported_category_owner_ids: Optional[list[str]] = None
    imported_category_unassigned_account_tokens: Optional[list[str]] = None


class BatchRuleSuggestionReviewUpdateRequest(BaseModel):
    suggestion_id: str
    status: str
    rule_id: Optional[str] = None
    created_rule_id: Optional[str] = None
    merchant_label: Optional[str] = None
    target_category_name: Optional[str] = None
    target_category_id: Optional[str] = None
    keyword: Optional[str] = None
    owner_id: Optional[str] = None
    account_id: Optional[str] = None
    amount_min: Optional[float] = None
    amount_max: Optional[float] = None
    clean_name_suggestion: Optional[str] = None
    match_source_text: Optional[bool] = None
    latest_txn_date: Optional[str] = None
    txn_count: Optional[int] = None
    source_row_ids: Optional[list[str]] = None
    accepted_prior_rows: Optional[list[dict]] = None
    review_action: Optional[dict] = None


class RuleSuggestionClearRequest(BaseModel):
    status: str
    suggestion_ids: Optional[list[str]] = None


class BatchRuleSuggestionRefineSourceRequest(BaseModel):
    id: str
    merchant_label: Optional[str] = None
    target_category_id: Optional[str] = None
    target_category_name: Optional[str] = None
    target_category_group_name: Optional[str] = None
    owner_id: Optional[str] = None
    owner_name: Optional[str] = None
    account_id: Optional[str] = None
    account_name: Optional[str] = None
    clean_name_suggestion: Optional[str] = None
    imported_categories: Optional[list[str]] = None
    source_row_ids: list[str]


class BatchRuleSuggestionMatchRefineRequest(BaseModel):
    source_suggestions: list[BatchRuleSuggestionRefineSourceRequest]
    keyword: str
    owner_id: Optional[str] = None
    account_id: Optional[str] = None
    amount_min: Optional[float] = None
    amount_max: Optional[float] = None
    match_source_text: bool = False


class RuleSuggestionDebugTraceRequest(BaseModel):
    correlation_id: str
    client_sequence: int
    event: str
    phase: str
    context_type: str
    context_id: Optional[str] = None
    suggestion_ids: list[str] = Field(default_factory=list)
    transaction_ids: list[str] = Field(default_factory=list)
    rule_ids: list[str] = Field(default_factory=list)
    keywords: list[str] = Field(default_factory=list)
    undo_snapshot: Optional[dict[str, Any]] = None
    details: dict[str, Any] = Field(default_factory=dict)


class BatchRuleSuggestionMatchRequest(BaseModel):
    keyword: str
    reference_target_category_id: Optional[str] = None
    owner_id: Optional[str] = None
    account_id: Optional[str] = None
    amount_min: Optional[float] = None
    amount_max: Optional[float] = None
    match_source_text: bool = False
    # When provided, the report is limited to exactly these transaction ids (the card's own source rows),
    # so a generic suggestion's report doesn't sweep in same-keyword rows owned by other (e.g. discarded)
    # suggestions. Omitted -> the keyword/scope match defines the set (legacy behavior).
    row_ids: Optional[list[str]] = None


class BatchDuplicateImportRequest(BaseModel):
    row_numbers: Optional[list[int]] = None
    import_all: bool = False


class BatchDuplicateReviewRequest(BaseModel):
    # Mark advisory hard-reject rows (coverage "review" items) as reviewed/acknowledged, or clear
    # that acknowledgment (reviewed=False). Identified by their CSV row_number within the batch.
    row_numbers: list[int]
    reviewed: bool = True


class BatchDuplicateEnrichRequest(BaseModel):
    # Fold the incoming detail of these duplicate rows into the existing transaction each matched
    # (enrich-on-duplicate), or undo that. Identified by CSV row_number within the batch; omitted /
    # empty means the whole batch (the file card's enrich toggle).
    row_numbers: list[int] = []


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












def _header_matches_import_evidence_keyword(header: str) -> bool:
    normalized = " ".join(re.sub(r"[^a-z0-9]+", " ", str(header or "").strip().lower()).split())
    return any(keyword in normalized for keyword in IMPORT_EVIDENCE_HEADER_KEYWORDS)


def _import_evidence_reserved_headers(col: ColumnMap) -> set[str]:
    return {
        str(header or "").strip()
        for header in (
            col.date,
            col.amount,
            col.debit,
            col.credit,
            col.direction,
            col.pending,
            col.currency,
            col.description,
            col.category,
            col.notes,
            col.account,
        )
        if str(header or "").strip()
    }


# How a CSV column earns its evidence role (services/import_evidence.py defines what the roles mean
# and why text matching must exclude the categorical ones). A file gives us the one signal a sync
# can't: the column's cardinality across every row. A column drawing from a small, repeated
# vocabulary is categorical; anything else is free text where a match between two rows means something.
CATEGORICAL_MAX_DISTINCT = 12
CATEGORICAL_MAX_DISTINCT_RATIO = 0.5
CATEGORICAL_MIN_REPEATS = 2


def _classify_evidence_column_role(values: list[str]) -> str:
    nonempty = [value for value in values if value]
    distinct = {value.casefold() for value in nonempty}
    n, d = len(nonempty), len(distinct)
    if d and d <= CATEGORICAL_MAX_DISTINCT and (n - d) >= CATEGORICAL_MIN_REPEATS and (d / n) <= CATEGORICAL_MAX_DISTINCT_RATIO:
        return EVIDENCE_ROLE_CATEGORICAL
    return EVIDENCE_ROLE_DESCRIPTIVE


# PayPal Activity CSV recognition. The export header is stable and distinctive across years — no
# bank/card/Amazon CSV carries this combination — so a header-only sniff identifies it. A recognized
# PayPal file force-captures `Type`/`Item Title` (see `_forced_evidence_headers`) and is stamped
# `source_kind = 'source:paypal'`. See docs/data-model.md -> "PayPal source recognition +
# `Type`-based money-movement categorization".
_PAYPAL_HEADER_MARKERS = frozenset({"timezone", "type", "status", "currency", "receipt id", "transaction id"})
PAYPAL_SOURCE_KIND = "source:paypal"
# Fields always worth keeping from a PayPal export regardless of what the user mapped/checked: `Type`
# drives money-movement categorization; `Item Title` is the richest enrichment detail. Matched on header,
# case-insensitively.
_PAYPAL_FORCED_EVIDENCE = ("type", "item title")


def _clean_header_key(header) -> str:
    """Normalize a header for source sniffing: strip a leading UTF-8 BOM (present on PayPal/AZAD exports)
    and surrounding whitespace, then casefold."""
    return str(header or "").lstrip("﻿").strip().lower()


def sniff_paypal_activity(headers) -> bool:
    """True when `headers` are a PayPal Activity export, by a distinctive header-marker subset."""
    cols = {_clean_header_key(h) for h in (headers or [])}
    return _PAYPAL_HEADER_MARKERS.issubset(cols)


def _forced_evidence_headers(headers: list[str]) -> list[str]:
    """Headers to capture into evidence regardless of the user's mapping/selection, for a recognized
    source. Today: PayPal's `Type` + `Item Title`. Empty for any other file, so nothing else changes."""
    if not sniff_paypal_activity(headers):
        return []
    forced = []
    for header in headers:
        if _clean_header_key(header) in _PAYPAL_FORCED_EVIDENCE:
            forced.append(str(header or "").strip())
    return forced


def _get_or_create_paypal_profile(conn, *, header_fingerprint: str, column_map: dict,
                                  date_format: str, amount_convention: str) -> str:
    """The single system PayPal data source (`source_kind = 'source:paypal'`), created on first use so all
    PayPal imports attach to one header — a home for the shared money-movement review. It behaves like any
    data source (visible, renamable, auto-matches future PayPal files by fingerprint), except it can't be
    deleted. Name defaults to "PayPal", disambiguated ("PayPal 2", …) if the user already has that name.
    `account_id` is left NULL — PayPal files carry no account column, so the target account is picked per
    import (a source can span accounts, like any CSV source)."""
    existing = conn.execute(
        "SELECT id FROM csv_import_profile WHERE source_kind = ? ORDER BY created_at LIMIT 1",
        (PAYPAL_SOURCE_KIND,),
    ).fetchone()
    if existing:
        return existing["id"]
    name, suffix = "PayPal", 1
    while conn.execute("SELECT 1 FROM csv_import_profile WHERE LOWER(name) = LOWER(?)", (name,)).fetchone():
        suffix += 1
        name = f"PayPal {suffix}"
    profile_id = str(uuid.uuid4())
    conn.execute(
        # PayPal is the textbook first-party source: it publishes records it created itself, so only the
        # export day can be partial and it is one of the few sources that genuinely warrants the
        # narrowest trailing window. Stated outright rather than inherited from a column default.
        """INSERT INTO csv_import_profile
             (id, name, header_fingerprint, column_map, date_format, amount_convention, source_kind,
              terminal_window_days)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (profile_id, name, header_fingerprint, json.dumps(column_map), date_format, amount_convention,
         PAYPAL_SOURCE_KIND, MIN_TERMINAL_WINDOW_DAYS),
    )
    return profile_id


def _build_evidence_column_plan(data_rows: list[dict], headers: list[str], col: ColumnMap) -> list[tuple[str, str]]:
    """Decide which non-mapped columns to capture into import evidence and each one's role.

    Role is inferred from the column's cardinality across the file so the duplicate text-matcher can
    later ignore categorical columns. Reserved (mapped) headers never appear. Returns ordered
    (header, role) pairs; the per-row builder walks this and pulls each row's value.

    `col.evidence_columns` is authoritative when provided: the import UI seeds its capture checkboxes
    from the keyword auto-detect, so the list it sends is the user's resolved choice (including any
    keyword default they unchecked). We capture exactly those, uncapped — the user asked for them. When
    it is None (a saved profile with no capture config, or an API caller), we fall back to the zero-
    effort keyword auto-detect, capped so an unmapped file can't flood evidence.

    A recognized source's **forced** columns (PayPal `Type`/`Item Title`) are always captured on top of
    either path — the user can't accidentally drop the fields money-movement categorization + enrichment
    depend on. They don't count against the keyword cap.
    """
    reserved = _import_evidence_reserved_headers(col)
    forced = {name for name in _forced_evidence_headers(headers) if name not in reserved}

    def column_role(header: str) -> str:
        return _classify_evidence_column_role([str(row.get(header, "") or "").strip() for row in data_rows])

    plan: list[tuple[str, str]] = []
    used: set[str] = set()

    def add(name: str) -> None:
        if name and name not in reserved and name not in used:
            plan.append((name, column_role(name)))
            used.add(name)

    if col.evidence_columns is not None:
        explicit = set(_normalize_string_list(col.evidence_columns))
        for header in headers:
            name = str(header or "").strip()
            if name in explicit or name in forced:
                add(name)
        return plan

    keyword_added = 0
    for header in headers:
        if keyword_added >= MAX_IMPORT_EVIDENCE_TEXT_FIELDS:
            break
        name = str(header or "").strip()
        # Reserved/forced/already-used headers don't consume a keyword slot (forced land below regardless).
        if name in used or name in reserved or name in forced or not _header_matches_import_evidence_keyword(name):
            continue
        add(name)
        keyword_added += 1
    # Forced columns always land, even if the keyword heuristic missed them or the cap was reached.
    for header in headers:
        name = str(header or "").strip()
        if name in forced:
            add(name)
    return plan


def _build_import_evidence(row: dict, col: ColumnMap, csv_value: str, raw_desc: str, evidence_plan: list[tuple[str, str]]) -> Optional[dict]:
    evidence: dict[str, object] = {}
    if col.account and csv_value:
        evidence["account"] = {"header": col.account, "value": csv_value}
    if col.description and raw_desc:
        evidence["description"] = {"header": col.description, "value": raw_desc}

    # Don't keep a second copy of text we already show: a column whose value equals the description
    # or the account label (e.g. a file carrying both "Merchant" and an unedited "Original Merchant")
    # is skipped, and extras dedupe against each other below.
    seen_values = {value.casefold() for value in (raw_desc, csv_value) if value}
    extra_text_fields: list[dict[str, str]] = []
    for header, role in evidence_plan:
        value = str(row.get(header, "") or "").strip()
        if not value or value.casefold() in seen_values:
            continue
        field: dict[str, str] = {"header": header, "value": value}
        # Only categorical is stamped; descriptive stays unmarked (lean shape, and the matcher's
        # default-descriptive read keeps legacy evidence behaving unchanged).
        if role == EVIDENCE_ROLE_CATEGORICAL:
            field["role"] = role
        extra_text_fields.append(field)
        seen_values.add(value.casefold())
    if extra_text_fields:
        evidence["extra_text_fields"] = extra_text_fields
    return evidence or None


# "check"/"cheque" as a whole word — so "CHECKCARD" debit-card lines are NOT treated as paper checks.
_CHECK_WORD_RE = re.compile(r"\bche(?:ck|que)\b", re.IGNORECASE)


def _extract_check_number(raw_desc: str, row: dict, headers: list[str]) -> Optional[str]:
    """Return a check number to append to a bare check description (e.g. "Check" -> "Check #1042").

    A lone "CHECK" line is otherwise unrecognizable, yet many files carry the number in a separate
    column. Rather than store that column, we fold it into the merchant when the row is actually a
    paper check ("check"/"cheque" as a whole word, excluding "CHECKCARD" debit purchases) and the
    number isn't already in the description. Returns the digits, or None when unavailable/redundant.
    """
    if not raw_desc or not _CHECK_WORD_RE.search(raw_desc):
        return None
    for header in headers:
        header_name = str(header or "").strip()
        if not header_name or not _CHECK_WORD_RE.search(header_name):
            continue
        digits = re.sub(r"\D", "", str(row.get(header_name, "") or ""))
        if not digits or digits in raw_desc:
            continue
        return digits
    return None


























def _normalize_account_type(value: Optional[str]) -> str:
    return str(value or "").strip().lower()




def _owners_are_group_compatible(source_owner_id: Optional[str], target_owner_id: Optional[str]) -> bool:
    source_owner = str(source_owner_id or "").strip()
    target_owner = str(target_owner_id or "").strip()
    return (
        source_owner == target_owner
        or source_owner == SHARED_OWNER_ID
        or target_owner == SHARED_OWNER_ID
    )


def _attach_import_created_account_to_group(conn, account_id: str, target_account_id: str) -> Optional[str]:
    account = conn.execute(
        """
        SELECT id, type, owner_id
        FROM account
        WHERE id = ?
        """,
        (account_id,),
    ).fetchone()
    target = get_effective_account_row(conn, target_account_id)
    if not account:
        raise HTTPException(status_code=400, detail="Account not found")
    if not target:
        raise HTTPException(status_code=400, detail="Group target account not found")
    if _normalize_account_type(account["type"]) != _normalize_account_type(target["type"]):
        raise HTTPException(status_code=400, detail="Only accounts with the same type can be grouped")
    if account["owner_id"] and target["owner_id"] and not _owners_are_group_compatible(account["owner_id"], target["owner_id"]):
        raise HTTPException(status_code=400, detail="Only accounts with the same owner can be grouped")
    conn.execute(
        """
        UPDATE account
        SET parent_account_id = ?,
            display_name = ?,
            owner_id = COALESCE(owner_id, ?)
        WHERE id = ?
        """,
        (target["id"], target["display_name"] or target["name"], target["owner_id"], account_id),
    )
    return target["id"]


def _insert_imported_transaction(conn, batch_id: str, payload: dict) -> str:
    txn_id = str(uuid.uuid4())
    conn.execute("""
        INSERT INTO txn
          (id, account_id, owner_id, category_id, amount, merchant_name,
           display_name, raw_name, date, is_pending, content_hash, import_evidence_json, import_batch_id, imported_category, notes, category_overridden, category_source, display_name_source, needs_review)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)
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
        json.dumps(payload.get("import_evidence")) if isinstance(payload.get("import_evidence"), dict) else None,
        batch_id,
        payload.get("imported_category"),
        payload.get("notes"),
        # A held duplicate's payload was captured when it was rejected, so it can predate trusted-import
        # rows being unlocked — see category_lock_for.
        category_lock_for(payload.get("category_source"), payload.get("category_overridden")),
        payload.get("category_source"),
        payload.get("display_name_source") or "import",
    ))
    return txn_id


def save_batch_duplicate_rows(conn, batch_id: str, duplicate_rows: list[dict]) -> None:
    """The one writer for a batch's duplicate report, shared by CSV import and data-source sync so both
    produce records the same report, "Import anyway", and Restore paths can read."""
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


def get_rule_suggestion_review_state(snapshot: dict) -> dict:
    # Batch snapshots can predate rule-review support or contain partial state; normalize
    # the shape here so review endpoints can round-trip older imports without migrations.
    review_state = snapshot.get(RULE_SUGGESTION_REVIEW_KEY)
    if not isinstance(review_state, dict):
        review_state = {}

    suggestions = review_state.get("suggestions")
    statuses = review_state.get("statuses")
    trash_sets = review_state.get("trash_sets")
    review_state["suggestions"] = suggestions if isinstance(suggestions, dict) else {}
    review_state["statuses"] = statuses if isinstance(statuses, dict) else {}
    review_state["trash_sets"] = trash_sets if isinstance(trash_sets, list) else []
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
        "trash_set_count": len(review_state.get("trash_sets") or []),
    }
    review_state["summary"] = summary
    return summary


def _public_rule_suggestion_trash_sets(review_state: dict) -> list[dict]:
    sets = []
    for item in review_state.get("trash_sets") or []:
        if not isinstance(item, dict):
            continue
        sets.append({
            "id": item.get("id"),
            "status": item.get("status"),
            "cleared_at": item.get("cleared_at"),
            "count": item.get("count") or len(item.get("suggestions") or {}),
        })
    return sorted(sets, key=lambda item: item.get("cleared_at") or "", reverse=True)


def _rule_suggestion_trash_ids(review_state: dict) -> set[str]:
    ids: set[str] = set()
    for item in review_state.get("trash_sets") or []:
        if not isinstance(item, dict):
            continue
        ids.update(str(suggestion_id) for suggestion_id in (item.get("suggestions") or {}).keys())
    return ids


def _clear_rule_suggestion_review_status(review_state: dict, status: str, suggestion_ids: Optional[list[str]] = None) -> dict:
    status = (status or "").strip().lower()
    if status not in RULE_SUGGESTION_REVIEW_STATUSES:
        raise HTTPException(status_code=400, detail="Invalid clear status")

    suggestions = dict(review_state.get("suggestions") or {})
    statuses = dict(review_state.get("statuses") or {})
    requested_ids = {
        str(suggestion_id)
        for suggestion_id in (suggestion_ids or [])
        if str(suggestion_id or "").strip()
    }
    clear_ids = [
        suggestion_id
        for suggestion_id, status_entry in statuses.items()
        if isinstance(status_entry, dict)
        and status_entry.get("status") == status
        and isinstance(suggestions.get(suggestion_id), dict)
        and (not requested_ids or suggestion_id in requested_ids)
    ]
    if not clear_ids:
        review_summary = summarize_rule_suggestion_review(review_state)
        return {
            "ok": True,
            "cleared_count": 0,
            "review_summary": review_summary,
            "trash_sets": _public_rule_suggestion_trash_sets(review_state),
        }

    trashed_suggestions = {suggestion_id: suggestions.pop(suggestion_id) for suggestion_id in clear_ids}
    trashed_statuses = {suggestion_id: statuses.pop(suggestion_id) for suggestion_id in clear_ids}
    trash_sets = list(review_state.get("trash_sets") or [])
    trash_set = {
        "id": str(uuid.uuid4()),
        "kind": "import_rule_suggestions",
        "status": status,
        "cleared_at": utcnow_iso(),
        "count": len(clear_ids),
        "suggestions": trashed_suggestions,
        "statuses": trashed_statuses,
    }
    trash_sets.append(trash_set)
    review_state["suggestions"] = suggestions
    review_state["statuses"] = statuses
    review_state["trash_sets"] = trash_sets
    review_summary = summarize_rule_suggestion_review(review_state)
    return {
        "ok": True,
        "cleared_count": len(clear_ids),
        "trash_set": _public_rule_suggestion_trash_sets({"trash_sets": [trash_set]})[0],
        "review_summary": review_summary,
        "trash_sets": _public_rule_suggestion_trash_sets(review_state),
    }


def _restore_rule_suggestion_trash_set(review_state: dict, trash_set_id: str) -> dict:
    trash_sets = list(review_state.get("trash_sets") or [])
    target = None
    remaining = []
    for item in trash_sets:
        if isinstance(item, dict) and item.get("id") == trash_set_id:
            target = item
        else:
            remaining.append(item)
    if not target:
        raise HTTPException(status_code=404, detail="Trash set not found")

    suggestions = dict(review_state.get("suggestions") or {})
    statuses = dict(review_state.get("statuses") or {})
    suggestions.update(target.get("suggestions") or {})
    statuses.update(target.get("statuses") or {})
    review_state["suggestions"] = suggestions
    review_state["statuses"] = statuses
    review_state["trash_sets"] = remaining
    review_summary = summarize_rule_suggestion_review(review_state)
    return {
        "ok": True,
        "restored_count": target.get("count") or len(target.get("suggestions") or {}),
        "review_summary": review_summary,
        "trash_sets": _public_rule_suggestion_trash_sets(review_state),
    }


def _build_rule_suggestion_review_entry(payload: dict) -> dict:
    return {
        "merchant_label": payload.get("merchant_label"),
        "target_category_name": payload.get("target_category_name"),
        "target_category_id": payload.get("target_category_id"),
        "keyword": normalize_rule_keyword(payload.get("keyword") or ""),
        "owner_id": payload.get("owner_id"),
        "owner_name": payload.get("owner_name"),
        "account_id": payload.get("account_id"),
        "account_name": payload.get("account_name"),
        "amount_min": payload.get("amount_min"),
        "amount_max": payload.get("amount_max"),
        "latest_txn_date": payload.get("latest_txn_date"),
        "clean_name_suggestion": payload.get("clean_name_suggestion"),
        "match_source_text": bool(payload.get("match_source_text")),
        "target_category_group_name": payload.get("target_category_group_name"),
        "txn_count": payload.get("txn_count"),
        "conflict_count": payload.get("conflict_count"),
        "conflict_group_id": payload.get("conflict_group_id"),
        "conflict_group_total_rows": payload.get("conflict_group_total_rows"),
        "imported_categories": list(payload.get("imported_categories") or []),
        "needs_resolution": bool(payload.get("needs_resolution")),
        "resolution_reason": payload.get("resolution_reason"),
        "synthetic": bool(payload.get("synthetic")),
        "pending_override": bool(payload.get("pending_override")),
        "derived_from_suggestion_id": payload.get("derived_from_suggestion_id"),
        "source_row_ids": sorted({str(value) for value in (payload.get("source_row_ids") or payload.get("_row_ids") or []) if str(value).strip()}),
    }


def _rule_suggestion_range_covers(
    covering_min: Optional[float],
    covering_max: Optional[float],
    covered_min: Optional[float],
    covered_max: Optional[float],
) -> bool:
    if covering_min is not None and (covered_min is None or covering_min > covered_min):
        return False
    if covering_max is not None and (covered_max is None or covering_max < covered_max):
        return False
    return True


def _rule_suggestion_entry_covers(covering: dict, covered: dict, *, allow_equal_keyword: bool = False) -> bool:
    covering_keyword = normalize_rule_keyword(covering.get("keyword") or "")
    covered_keyword = normalize_rule_keyword(covered.get("keyword") or "")
    if not covering_keyword or not covered_keyword:
        return False
    if covering_keyword == covered_keyword:
        if not allow_equal_keyword:
            return False
    elif covering_keyword not in covered_keyword:
        return False

    covering_target_id = str(covering.get("target_category_id") or "").strip()
    covered_target_id = str(covered.get("target_category_id") or "").strip()
    if covering_target_id and covered_target_id:
        if covering_target_id != covered_target_id:
            return False
    elif str(covering.get("target_category_name") or "").strip().lower() != str(covered.get("target_category_name") or "").strip().lower():
        return False

    covering_owner_id = str(covering.get("owner_id") or "").strip()
    covered_owner_id = str(covered.get("owner_id") or "").strip()
    if covering_owner_id and covering_owner_id != covered_owner_id:
        return False

    covering_account_id = str(covering.get("account_id") or "").strip()
    covered_account_id = str(covered.get("account_id") or "").strip()
    if covering_account_id and covering_account_id != covered_account_id:
        return False

    return _rule_suggestion_range_covers(
        covering.get("amount_min"),
        covering.get("amount_max"),
        covered.get("amount_min"),
        covered.get("amount_max"),
    )


def _discard_covered_rule_suggestions(review_state: dict, suggestion_id: str, source_entry: dict) -> list[str]:
    statuses = dict(review_state.get("statuses") or {})
    suggestions = dict(review_state.get("suggestions") or {})
    changed_ids: list[str] = []
    now = utcnow_iso()
    source_row_ids = {str(value) for value in (source_entry.get("source_row_ids") or []) if str(value).strip()}

    for other_suggestion_id, entry in suggestions.items():
        if other_suggestion_id == suggestion_id or not isinstance(entry, dict):
            continue
        other_status = (statuses.get(other_suggestion_id) or {}).get("status")
        if other_status in {"accepted", "discarded"}:
            continue
        if not _rule_suggestion_entry_covers(source_entry, entry):
            continue
        statuses[other_suggestion_id] = {
            "status": "discarded",
            "updated_at": now,
        }
        source_row_ids.update({str(value) for value in (entry.get("source_row_ids") or []) if str(value).strip()})
        changed_ids.append(other_suggestion_id)

    if source_row_ids:
        source_entry["source_row_ids"] = sorted(source_row_ids)
        suggestions[suggestion_id] = source_entry
        review_state["suggestions"] = suggestions
    review_state["statuses"] = statuses
    return changed_ids


def _remove_pending_derived_rule_suggestions(review_state: dict, suggestion_id: str) -> None:
    suggestions = dict(review_state.get("suggestions") or {})
    statuses = dict(review_state.get("statuses") or {})

    for other_suggestion_id, entry in list(suggestions.items()):
        if not isinstance(entry, dict) or entry.get("derived_from_suggestion_id") != suggestion_id:
            continue
        status = (statuses.get(other_suggestion_id) or {}).get("status")
        if status == "accepted":
            continue
        suggestions.pop(other_suggestion_id, None)
        statuses.pop(other_suggestion_id, None)

    review_state["suggestions"] = suggestions
    review_state["statuses"] = statuses


def _prune_phantom_rule_suggestion_entry(review_state: dict, suggestion_id: str, status: str) -> None:
    """Guard a review update from leaving a phantom suggestion behind. The review endpoints `setdefault`
    an entry for whatever `suggestion_id` they're given and only fill fields that arrive in the request,
    so a data-less call (notably undo, which replays just `{suggestion_id, status}`) could persist an
    empty `{}` entry — which then renders as a blank card and inflates `total_count` (the summary counts
    `len(suggestions)`). Two cases get dropped here, entry and status together:

      - returning a suggestion to `pending` (it belongs back in the generated pool, where it regenerates
        from live rows with its real row count and sorts correctly) — except a synthetic follow-up, which
        has no live rows to regenerate from and must persist;
      - any entry left without identifying content (no keyword, merchant, or rows), which is never a
        real suggestion and is only ever the residue of a data-less restore.
    """
    suggestions = review_state.get("suggestions") or {}
    statuses = review_state.get("statuses") or {}
    entry = suggestions.get(suggestion_id)
    is_synthetic = isinstance(entry, dict) and entry.get("synthetic")
    is_pending_override = isinstance(entry, dict) and entry.get("pending_override")
    has_content = isinstance(entry, dict) and (
        entry.get("keyword") or entry.get("merchant_label") or entry.get("source_row_ids")
    )
    if (status == "pending" and not is_synthetic and not is_pending_override) or not has_content:
        suggestions.pop(suggestion_id, None)
        statuses.pop(suggestion_id, None)
    review_state["suggestions"] = suggestions
    review_state["statuses"] = statuses


def refresh_rule_suggestion_review(review_state: dict, suggestions: list[dict]) -> dict:
    existing_entries = review_state.get("suggestions") or {}
    statuses = review_state.get("statuses") or {}
    trashed_ids = _rule_suggestion_trash_ids(review_state)
    next_entries = {}

    for suggestion in suggestions:
        suggestion_id = suggestion["id"]
        if suggestion_id in trashed_ids:
            continue
        existing_entry = existing_entries.get(suggestion_id)
        if isinstance(existing_entry, dict) and existing_entry.get("pending_override"):
            next_entries[suggestion_id] = existing_entry
            continue
        next_entry = _build_rule_suggestion_review_entry(suggestion)
        if isinstance(existing_entry, dict) and existing_entry.get("review_action"):
            next_entry["review_action"] = existing_entry.get("review_action")
        next_entries[suggestion_id] = next_entry

    for suggestion_id, entry in existing_entries.items():
        status = (statuses.get(suggestion_id) or {}).get("status")
        if suggestion_id not in next_entries and (
            status in RULE_SUGGESTION_REVIEW_STATUSES
            or (isinstance(entry, dict) and (entry.get("synthetic") or entry.get("pending_override")))
        ):
            next_entries[suggestion_id] = entry if isinstance(entry, dict) else {}

    review_state["suggestions"] = next_entries
    now = utcnow_iso()
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


def _query_rule_suggestion_rows(conn, *, batch_id: Optional[str] = None, profile_id: Optional[str] = None, system_wide: bool = False):
    if batch_id:
        return conn.execute(
            """
            SELECT
                t.id,
                t.date,
                COALESCE(a.parent_account_id, t.account_id) AS account_id,
                t.owner_id,
                t.amount,
                t.merchant_name,
                t.display_name,
                t.raw_name,
                t.import_evidence_json,
                t.imported_category,
                t.category_id,
                t.category_overridden,
                t.category_source,
                t.import_batch_id,
                COALESCE(a.display_name, a.name) AS account_name,
                o.name AS owner_name
            FROM txn t
            LEFT JOIN account a ON a.id = t.account_id
            LEFT JOIN owner o ON o.id = t.owner_id
            WHERE t.import_batch_id = ?
              -- 'manual' counts rows the user reconciled toward the suggestion, like the matching-rows report
              AND t.category_source IN ('import', 'manual')
              AND t.category_id IS NOT NULL
            """,
            (batch_id,),
        ).fetchall()

    if profile_id:
        return conn.execute(
            """
            SELECT
                t.id,
                t.date,
                COALESCE(a.parent_account_id, t.account_id) AS account_id,
                t.owner_id,
                t.amount,
                t.merchant_name,
                t.display_name,
                t.raw_name,
                t.import_evidence_json,
                t.imported_category,
                t.category_id,
                t.category_overridden,
                t.category_source,
                t.import_batch_id,
                COALESCE(a.display_name, a.name) AS account_name,
                o.name AS owner_name
            FROM txn t
            JOIN import_batch b ON b.id = t.import_batch_id
            LEFT JOIN account a ON a.id = t.account_id
            LEFT JOIN owner o ON o.id = t.owner_id
            WHERE b.profile_id = ?
              AND b.status = 'completed'
              -- 'manual' counts rows the user reconciled toward the suggestion, like the matching-rows report
              AND t.category_source IN ('import', 'manual')
              AND t.category_id IS NOT NULL
            """,
            (profile_id,),
        ).fetchall()

    if system_wide:
        return conn.execute(
            """
            SELECT
                t.id,
                t.date,
                COALESCE(a.parent_account_id, t.account_id) AS account_id,
                t.owner_id,
                t.amount,
                t.merchant_name,
                t.display_name,
                t.raw_name,
                t.import_evidence_json,
                t.imported_category,
                t.category_id,
                t.category_overridden,
                t.category_source,
                t.import_batch_id,
                COALESCE(a.display_name, a.name) AS account_name,
                o.name AS owner_name
            FROM txn t
            JOIN import_batch b ON b.id = t.import_batch_id
            LEFT JOIN account a ON a.id = t.account_id
            LEFT JOIN owner o ON o.id = t.owner_id
            WHERE b.status = 'completed'
              AND b.use_imported_categories = 1
              -- 'manual' counts rows the user reconciled toward the suggestion, like the matching-rows report
              AND t.category_source IN ('import', 'manual')
              AND t.category_id IS NOT NULL
            """
        ).fetchall()

    return []


def _calculate_rule_suggestion_threshold(rows) -> dict:
    months = set()
    total_rows = 0
    for row in rows:
        date_value = str(row.get("date") or "").strip()
        if len(date_value) >= 7:
            months.add(date_value[:7])
        total_rows += 1

    minimum_txn_count = 1
    if len(months) >= 6 or total_rows >= 100:
        minimum_txn_count = 2
    if len(months) >= 12 or total_rows >= 250:
        minimum_txn_count = 3
    if len(months) >= 24 or total_rows >= 500:
        minimum_txn_count = 4

    return {
        "distinct_month_count": len(months),
        "candidate_transaction_count": total_rows,
        "minimum_txn_count": minimum_txn_count,
    }


def _rule_suggestion_action_signature(suggestion: dict) -> tuple:
    return (
        suggestion.get("target_category_id"),
        suggestion.get("owner_id"),
        suggestion.get("account_id"),
        suggestion.get("amount_min"),
        suggestion.get("amount_max"),
        suggestion.get("clean_name_suggestion"),
    )


def _suggestion_is_more_specific(left: dict, right: dict) -> bool:
    left_keyword = str(left.get("keyword") or "")
    right_keyword = str(right.get("keyword") or "")
    return (
        left_keyword != right_keyword
        and right_keyword in left_keyword
        and len(left_keyword) > len(right_keyword)
    )


def _prune_redundant_rule_suggestions(suggestions: list[dict]) -> list[dict]:
    keep_flags = [True] * len(suggestions)

    for index, suggestion in enumerate(suggestions):
        if not keep_flags[index]:
            continue

        suggestion_row_ids = suggestion.get("_row_ids") or set()
        if not suggestion_row_ids:
            continue

        for other_index, other in enumerate(suggestions):
            if index == other_index or not keep_flags[other_index]:
                continue
            if _rule_suggestion_action_signature(suggestion) != _rule_suggestion_action_signature(other):
                continue
            if suggestion_row_ids != (other.get("_row_ids") or set()):
                continue
            if _suggestion_is_more_specific(other, suggestion):
                keep_flags[index] = False
                break

    return [
        suggestion
        for index, suggestion in enumerate(suggestions)
        if keep_flags[index]
    ]


def _row_matches_rule_suggestion_entry(row: dict, entry: dict) -> bool:
    entry_keyword = normalize_rule_keyword(entry.get("keyword") or "")
    row_text = normalize_rule_keyword(
        row.get("display_name") or row.get("merchant_name") or row.get("raw_name") or ""
    )
    matched = bool(entry_keyword) and bool(row_text) and entry_keyword in row_text
    if not matched and entry.get("match_source_text"):
        matched = entry_keyword in source_match_text_from_json(row.get("import_evidence_json"))
    if not matched:
        return False
    if entry.get("owner_id") and row.get("owner_id") != entry.get("owner_id"):
        return False
    if entry.get("account_id") and row.get("account_id") != entry.get("account_id"):
        return False

    abs_amount = abs(float(row.get("amount") or 0))
    amount_min = entry.get("amount_min")
    amount_max = entry.get("amount_max")
    if amount_min is not None and abs_amount < amount_min:
        return False
    if amount_max is not None and abs_amount > amount_max:
        return False
    return True


def _row_matches_rule_suggestion_report_keyword(row: dict, keyword: str, match_source_text: bool) -> bool:
    row_keyword = normalize_rule_keyword(
        row.get("display_name") or row.get("merchant_name") or row.get("raw_name") or ""
    )
    if row_keyword and row_keyword == keyword:
        return True
    if match_source_text and keyword in source_match_text_from_json(row.get("import_evidence_json")):
        return True
    return False


def _rule_suggestion_match_scope(body: BatchRuleSuggestionMatchRequest) -> tuple[list[str], str, str]:
    row_ids = sorted({str(value) for value in (body.row_ids or []) if str(value).strip()})
    if not row_ids:
        return [], "", """
              -- 'manual' keeps rows the user reconciled in this view visible alongside the still-from-file ones
              AND t.category_source IN ('import', 'manual')
              AND t.category_id IS NOT NULL
        """
    placeholders = ",".join("?" for _ in row_ids)
    return row_ids, f"AND t.id IN ({placeholders})", ""


def _partition_rule_suggestion_source_rows(rows: list[dict], source_row_ids: list[str], matcher_entry: dict) -> tuple[list[dict], list[dict]]:
    source_row_id_set = {str(value) for value in source_row_ids if str(value).strip()}
    source_rows = [
        dict(row)
        for row in rows
        if str(row.get("id") or "").strip() and str(row.get("id")) in source_row_id_set
    ]
    matched_rows = [row for row in source_rows if _row_matches_rule_suggestion_entry(row, matcher_entry)]
    matched_row_ids = {str(row["id"]) for row in matched_rows if row.get("id")}
    remaining_rows = [row for row in source_rows if str(row.get("id") or "") not in matched_row_ids]
    return matched_rows, remaining_rows


def _generate_rule_suggestions(conn, candidate_rows: list[dict], selected_owner_ids: list[str]) -> tuple[list[dict], dict]:
    threshold_meta = _calculate_rule_suggestion_threshold(candidate_rows)
    categories_by_name, categories_by_id = _load_import_rule_target_maps(conn)
    all_by_keyword: dict[str, list[dict]] = {}

    # Owner-scoping is decided below from who maps a keyword to which category. That signal must be
    # stable: it has to reflect every owner who uses the keyword, not just the ones whose rows are still
    # awaiting a rule. Once an owner's rows are claimed by an accepted rule they leave `candidate_rows`,
    # so a keyword that two owners share would look single-owner and silently drop the owner filter from
    # the remaining owner's suggestion — broadening an owner-scoped set into a global rule that overlaps
    # the accepted one. So fold existing owner-scoped rules for the keyword back into the signal; the
    # decision then no longer depends on accept order.
    rule_owner_targets: dict[str, dict[str, set]] = {}
    for rule_row in conn.execute(
        "SELECT keyword, owner_id, category_id FROM category_rule WHERE owner_id IS NOT NULL AND category_id IS NOT NULL"
    ).fetchall():
        rule_keyword = normalize_rule_keyword(rule_row["keyword"] or "")
        if not rule_keyword:
            continue
        rule_owner_targets.setdefault(rule_keyword, {}).setdefault(rule_row["owner_id"], set()).add(rule_row["category_id"])

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
        # Only a target evidenced by at least one file-derived ('import') row is a real suggestion. Manual
        # rows reinforce such a target's count — e.g. rows the user reconciled onto it via "set all to" —
        # but a target seen *only* through manual edits (e.g. a Preserved one-off kept on a different
        # category) is dropped, so manual rows never spawn a fresh suggestion or re-create a conflict.
        import_backed_targets = {
            (row["target_category_id"] or f"name:{row['target_category_name']}")
            for row in keyword_rows
            if row.get("category_source") == "import"
        }
        keyword_rows = [
            row for row in keyword_rows
            if (row["target_category_id"] or f"name:{row['target_category_name']}") in import_backed_targets
        ]
        if not keyword_rows:
            continue

        owner_targets = {}
        for row in keyword_rows:
            owner_targets.setdefault(row["owner_id"] or "__none__", set()).add(
                row["target_category_id"] or f"name:{row['target_category_name']}"
            )
        # Fold in owners who already hold an owner-scoped rule for this keyword (see note at the top), so
        # an accepted rule keeps the keyword "multi-owner" even after its rows have left the candidate pool.
        for rule_owner_id, rule_targets in rule_owner_targets.get(keyword, {}).items():
            owner_targets.setdefault(rule_owner_id, set()).update(rule_targets)

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
                if len(target_rows) < threshold_meta["minimum_txn_count"] and not needs_resolution:
                    continue
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

                suggestions.append({
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
                    # Most-recent activity for this suggestion, so the review's look-back lens can hide
                    # stale patterns by recency while counts/threshold stay computed from full history.
                    "latest_txn_date": max((row["date"] for row in target_rows if row.get("date")), default=None),
                    "conflict_count": max(0, len(by_target) - 1) if needs_resolution else 0,
                    "conflict_group_id": conflict_group_id,
                    "conflict_group_total_rows": conflict_group_total_rows,
                    "imported_categories": sorted({row["imported_category"] for row in target_rows if row["imported_category"]}),
                    "needs_resolution": needs_resolution,
                    "resolution_reason": resolution_reason,
                    "_row_ids": {str(row["id"]) for row in target_rows if row.get("id")},
                    # The rows this suggestion was generated from — accepting it applies the rule's
                    # outputs (rename/tags/category) to exactly these, leaving conflicting rows alone.
                    "source_row_ids": sorted(str(row["id"]) for row in target_rows if row.get("id")),
                })

    suggestions = _prune_redundant_rule_suggestions(suggestions)
    suggestions.sort(key=lambda item: (
        item["keyword"],
        item["owner_name"] or "",
        item["target_category_name"] or "",
    ))
    return suggestions, threshold_meta


def _build_synthetic_rule_suggestion_entries(
    conn,
    review_state: dict,
    suggestion_id: str,
    source_entry: dict,
    rows: list[dict],
) -> list[dict]:
    _, remaining_rows = _partition_rule_suggestion_source_rows(
        rows,
        source_entry.get("source_row_ids") or [],
        source_entry,
    )
    if not remaining_rows:
        return []

    suggestions, _ = _generate_rule_suggestions(conn, remaining_rows, [])
    synthetic_entries = []
    for suggestion in suggestions:
        synthetic_entries.append({
            **_build_rule_suggestion_review_entry({
                **suggestion,
                "synthetic": True,
                "derived_from_suggestion_id": suggestion_id,
            }),
            "id": f"{suggestion['id']}:followup:{suggestion_id}",
        })
    return synthetic_entries


def _merge_review_state_suggestions(generated_suggestions: list[dict], review_state: dict, selected_owner_ids: list[str]) -> list[dict]:
    merged = list(generated_suggestions)
    generated_ids = {suggestion["id"] for suggestion in generated_suggestions}
    review_statuses = review_state.get("statuses") or {}

    for suggestion_id, entry in (review_state.get("suggestions") or {}).items():
        if suggestion_id in generated_ids or not isinstance(entry, dict):
            continue
        # Re-add entries that no longer regenerate from live rows but still belong in the review:
        #   - synthetic pending follow-ups (created when an accept only partially covered its rows), and
        #   - reviewed entries (accepted / discarded / skipped) whose rows have left the candidate pool
        #     (accepting makes the rows rule-sourced; discard-and-clear drops their category), so
        #     _generate_rule_suggestions no longer rebuilds them.
        # These are exactly the entries refresh_rule_suggestion_review keeps, and the summary pills count
        # them; without re-adding here the accepted/discarded filters showed only the few suggestions
        # whose rows happened to still regenerate while the pills counted the full reviewed set.
        status = (review_statuses.get(suggestion_id) or {}).get("status")
        if not (entry.get("synthetic") or entry.get("pending_override") or status in RULE_SUGGESTION_REVIEW_STATUSES):
            continue
        if selected_owner_ids and entry.get("owner_id") not in selected_owner_ids:
            continue
        merged.append({
            "id": suggestion_id,
            "keyword": entry.get("keyword"),
            "merchant_label": entry.get("merchant_label"),
            "clean_name_suggestion": entry.get("clean_name_suggestion"),
            "target_category_id": entry.get("target_category_id"),
            "target_category_name": entry.get("target_category_name"),
            "target_category_group_name": entry.get("target_category_group_name"),
            "owner_id": entry.get("owner_id"),
            "owner_name": entry.get("owner_name"),
            "account_id": entry.get("account_id"),
            "account_name": entry.get("account_name"),
            "amount_min": entry.get("amount_min"),
            "amount_max": entry.get("amount_max"),
            "latest_txn_date": entry.get("latest_txn_date"),
            "txn_count": entry.get("txn_count") or len(entry.get("source_row_ids") or []),
            "conflict_count": entry.get("conflict_count") or 0,
            "conflict_group_id": entry.get("conflict_group_id"),
            "conflict_group_total_rows": entry.get("conflict_group_total_rows") or entry.get("txn_count") or len(entry.get("source_row_ids") or []),
            "imported_categories": list(entry.get("imported_categories") or []),
            "needs_resolution": bool(entry.get("needs_resolution")),
            "resolution_reason": entry.get("resolution_reason"),
            "match_source_text": bool(entry.get("match_source_text")),
            "pending_override": bool(entry.get("pending_override")),
            "review_status": (review_statuses.get(suggestion_id) or {}).get("status") or "pending",
            # The rule this suggestion was accepted into, so editing it later updates that rule in place
            # instead of spawning a duplicate (see the matching field on the generated path below).
            "rule_id": (review_statuses.get(suggestion_id) or {}).get("rule_id"),
            "created_rule_id": (review_statuses.get(suggestion_id) or {}).get("created_rule_id"),
            "accepted_prior_rows": list((review_statuses.get(suggestion_id) or {}).get("accepted_prior_rows") or []),
            "review_action": (review_statuses.get(suggestion_id) or {}).get("review_action") or entry.get("review_action"),
            # Carried so the matching-transactions report can scope to this suggestion's own rows.
            "source_row_ids": list(entry.get("source_row_ids") or []),
        })

    merged.sort(key=lambda item: (
        item["keyword"] or "",
        item.get("owner_name") or "",
        item.get("target_category_name") or "",
    ))
    return merged


def _build_rule_suggestion_response(conn, rows, review_state: dict, selected_owner_ids: list[str]) -> dict:
    review_statuses = review_state.get("statuses") or {}
    pending_partition_row_ids = {
        str(row_id)
        for suggestion_id, entry in (review_state.get("suggestions") or {}).items()
        if isinstance(entry, dict)
        and (entry.get("synthetic") or entry.get("pending_override"))
        and not (review_statuses.get(suggestion_id) or {}).get("status")
        for row_id in (entry.get("source_row_ids") or [])
        if str(row_id).strip()
    }
    candidate_rows = [
        dict(row)
        for row in rows
        if str(row["imported_category"] or "").strip()
        and str(row["id"]) not in pending_partition_row_ids
    ]
    threshold_meta = _calculate_rule_suggestion_threshold(candidate_rows)

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
                "trash_sets": _public_rule_suggestion_trash_sets(review_state),
                "generated_at": review_state.get("generated_at"),
                "should_persist": False,
            }

    suggestions, _ = _generate_rule_suggestions(conn, candidate_rows, selected_owner_ids)
    trashed_ids = _rule_suggestion_trash_ids(review_state)
    suggestions = [suggestion for suggestion in suggestions if suggestion["id"] not in trashed_ids]

    for suggestion in suggestions:
        status_entry = review_statuses.get(suggestion["id"]) or {}
        review_entry = (review_state.get("suggestions") or {}).get(suggestion["id"]) or {}
        suggestion["review_status"] = status_entry.get("status") or "pending"
        # Carry the accepted rule's id so the editor updates that rule in place rather than creating a
        # new one (and orphaning the original) when an already-accepted suggestion is edited.
        suggestion["rule_id"] = status_entry.get("rule_id")
        suggestion["created_rule_id"] = status_entry.get("created_rule_id")
        suggestion["accepted_prior_rows"] = list(status_entry.get("accepted_prior_rows") or [])
        suggestion["review_action"] = status_entry.get("review_action") or review_entry.get("review_action")
        suggestion["match_source_text"] = bool(review_entry.get("match_source_text"))

    review_summary = review_state.get("summary")
    should_persist = False
    if not selected_owner_ids:
        # Only the unfiltered (canonical) view owns the persisted review state. Reconcile it against the
        # freshly generated suggestions, but persist ONLY when that actually changes the stored entries.
        # refresh_rule_suggestion_review otherwise bumps last_generated_at every call, which made this GET
        # rewrite its row on every page load — and concurrent loads then fought the SQLite write lock.
        before = json.dumps(review_state.get("suggestions") or {}, sort_keys=True)
        had_generated_at = bool(review_state.get("generated_at"))
        review_summary = refresh_rule_suggestion_review(review_state, suggestions)
        after = json.dumps(review_state.get("suggestions") or {}, sort_keys=True)
        should_persist = (before != after) or not had_generated_at
    elif not isinstance(review_summary, dict):
        review_summary = summarize_rule_suggestion_review(review_state)

    suggestions = _merge_review_state_suggestions(suggestions, review_state, selected_owner_ids)

    return {
        "requires_owner_resolution": False,
        "unowned_accounts": [],
        "present_owner_ids": sorted({row["owner_id"] for row in candidate_rows if row["owner_id"]}),
        "suggestions": suggestions,
        "suggestion_count": len(suggestions),
        "review_summary": review_summary,
        "trash_sets": _public_rule_suggestion_trash_sets(review_state),
        "generated_at": review_state.get("generated_at"),
        "minimum_txn_count": threshold_meta["minimum_txn_count"],
        "distinct_month_count": threshold_meta["distinct_month_count"],
        "should_persist": should_persist,
    }


def _build_pending_override_entry(suggestion: dict) -> dict:
    return _build_rule_suggestion_review_entry({
        **suggestion,
        "pending_override": True,
    })


def _rule_suggestion_rows_use_canonical_keyword(rows: list[dict], keyword: str) -> bool:
    normalized_keyword = normalize_rule_keyword(keyword or "")
    if not normalized_keyword or not rows:
        return False
    for row in rows:
        row_keyword = normalize_rule_keyword(
            row.get("display_name") or row.get("merchant_name") or row.get("raw_name") or ""
        )
        if row_keyword != normalized_keyword:
            return False
    return True


def _refined_match_can_rejoin_canonical_generation(
    matcher_entry: dict,
    matched_rows: list[dict],
    source_suggestions: list[BatchRuleSuggestionRefineSourceRequest],
    review_state: dict,
) -> bool:
    if matcher_entry.get("match_source_text") or matcher_entry.get("account_id"):
        return False
    if matcher_entry.get("amount_min") is not None or matcher_entry.get("amount_max") is not None:
        return False
    if not _rule_suggestion_rows_use_canonical_keyword(matched_rows, matcher_entry.get("keyword") or ""):
        return False
    if not matcher_entry.get("owner_id"):
        return True

    # A refined one-row/card suggestion may carry an owner scope only because the source conflict did.
    # When the user broadens that refined card back to the merchant's ordinary keyword, release it to the
    # canonical generator so it can recompute owner scoping and conflicts with the rest of the merchant.
    suggestions = review_state.get("suggestions") or {}
    return bool(source_suggestions) and all(
        isinstance(suggestions.get(source.id), dict) and suggestions[source.id].get("pending_override")
        for source in source_suggestions
    )


def _refine_pending_conflict_group(
    conn,
    review_state: dict,
    rows: list[dict],
    body: BatchRuleSuggestionMatchRefineRequest,
) -> dict:
    source_suggestions = [source for source in body.source_suggestions if source.source_row_ids]
    if not source_suggestions:
        raise HTTPException(status_code=400, detail="No source suggestions supplied")

    matcher_entry = {
        "keyword": normalize_rule_keyword(body.keyword or ""),
        "owner_id": body.owner_id or None,
        "account_id": body.account_id or None,
        "amount_min": body.amount_min,
        "amount_max": body.amount_max,
        "match_source_text": bool(body.match_source_text),
    }
    if not matcher_entry["keyword"]:
        raise HTTPException(status_code=400, detail="Keyword is required")

    source_row_ids = []
    for source in source_suggestions:
        source_row_ids.extend(str(row_id) for row_id in source.source_row_ids if str(row_id).strip())
    source_row_ids = sorted(set(source_row_ids))

    matched_rows, remaining_rows = _partition_rule_suggestion_source_rows(rows, source_row_ids, matcher_entry)
    matched_suggestions, _ = _generate_rule_suggestions(conn, matched_rows, [])
    remaining_suggestions, _ = _generate_rule_suggestions(conn, remaining_rows, [])

    matched_owner_name = None
    if matcher_entry["owner_id"]:
        matched_owner_name = next(
            (
                row.get("owner_name")
                for row in matched_rows
                if row.get("owner_id") == matcher_entry["owner_id"] and row.get("owner_name")
            ),
            None,
        )
    matched_account_name = None
    if matcher_entry["account_id"]:
        matched_account_name = next(
            (
                row.get("account_name")
                for row in matched_rows
                if row.get("account_id") == matcher_entry["account_id"] and row.get("account_name")
            ),
            None,
        )
    refined_conflict_group_id = (
        f"{source_suggestions[0].id}:refined"
        if len(matched_suggestions) > 1
        else None
    )
    for suggestion in matched_suggestions:
        suggestion["keyword"] = matcher_entry["keyword"]
        suggestion["owner_id"] = matcher_entry["owner_id"]
        suggestion["owner_name"] = matched_owner_name if matcher_entry["owner_id"] else None
        suggestion["account_id"] = matcher_entry["account_id"]
        suggestion["account_name"] = matched_account_name if matcher_entry["account_id"] else None
        suggestion["amount_min"] = matcher_entry["amount_min"]
        suggestion["amount_max"] = matcher_entry["amount_max"]
        suggestion["match_source_text"] = matcher_entry["match_source_text"]
        if refined_conflict_group_id:
            suggestion["conflict_group_id"] = refined_conflict_group_id
            suggestion["conflict_group_total_rows"] = len(matched_rows)
            suggestion["conflict_count"] = max(0, len(matched_suggestions) - 1)
            suggestion["needs_resolution"] = True
        else:
            suggestion["conflict_group_id"] = None
            suggestion["conflict_group_total_rows"] = suggestion.get("txn_count") or len(suggestion.get("source_row_ids") or [])
            suggestion["conflict_count"] = 0
            suggestion["needs_resolution"] = False

    suggestions = dict(review_state.get("suggestions") or {})
    statuses = dict(review_state.get("statuses") or {})

    for source in source_suggestions:
        _remove_pending_derived_rule_suggestions(review_state, source.id)
    suggestions = dict(review_state.get("suggestions") or {})
    statuses = dict(review_state.get("statuses") or {})

    for source in source_suggestions:
        source_id = source.id
        suggestions.pop(source_id, None)
        statuses.pop(source_id, None)

    release_matched_rows = _refined_match_can_rejoin_canonical_generation(
        matcher_entry,
        matched_rows,
        source_suggestions,
        review_state,
    )
    if not release_matched_rows:
        for suggestion in matched_suggestions:
            suggestion_id = suggestion["id"]
            suggestions[suggestion_id] = _build_pending_override_entry(suggestion)
            statuses.pop(suggestion_id, None)

    # The canonical generator rebuilds non-matching rows on the next read, together with analogous rows
    # outside this conflict card. Persist a synthetic remainder only when its natural id collides with a
    # refined override; otherwise persisting a card-local remainder would strand equivalent owner slices
    # as duplicate global suggestions instead of letting them coalesce.
    matched_suggestion_ids = {suggestion["id"] for suggestion in matched_suggestions} if not release_matched_rows else set()
    seed_suggestion_id = source_suggestions[0].id
    for suggestion in remaining_suggestions:
        if suggestion["id"] not in matched_suggestion_ids:
            continue
        suggestions[f"{suggestion['id']}:followup:{seed_suggestion_id}"] = _build_rule_suggestion_review_entry({
            **suggestion,
            "synthetic": True,
            "derived_from_suggestion_id": seed_suggestion_id,
        })

    review_state["suggestions"] = suggestions
    review_state["statuses"] = statuses
    review_summary = summarize_rule_suggestion_review(review_state)
    return {
        "ok": True,
        "review_summary": review_summary,
        "generated_at": review_state.get("generated_at"),
    }


def save_batch_snapshot(conn, batch_id: str, snapshot: dict) -> None:
    conn.execute(
        "UPDATE import_batch SET config_snapshot = ? WHERE id = ?",
        (json.dumps(snapshot), batch_id),
    )


def _reconcile_batch_history(conn, batch_ids: list[str]) -> None:
    for batch_id in [str(value or "").strip() for value in (batch_ids or []) if str(value or "").strip()]:
        conn.execute(
            """
            DELETE FROM import_batch_account
            WHERE batch_id = ?
              AND was_skipped = 0
              AND account_id IS NOT NULL
              AND NOT EXISTS (
                  SELECT 1
                  FROM account a
                  WHERE a.id = import_batch_account.account_id
              )
            """,
            (batch_id,),
        )
        conn.execute(
            """
            UPDATE import_batch_account
            SET account_id = NULL
            WHERE batch_id = ?
              AND was_skipped = 1
              AND account_id IS NOT NULL
              AND NOT EXISTS (
                  SELECT 1
                  FROM account a
                  WHERE a.id = import_batch_account.account_id
              )
            """,
            (batch_id,),
        )

        batch = conn.execute(
            "SELECT row_count, skipped_count, deduped_count, config_snapshot FROM import_batch WHERE id = ?",
            (batch_id,),
        ).fetchone()
        if not batch:
            continue

        imported_count = int(conn.execute(
            "SELECT COUNT(*) FROM txn WHERE import_batch_id = ?",
            (batch_id,),
        ).fetchone()[0] or 0)
        skipped_count = int(batch["skipped_count"] or 0)
        deduped_count = int(batch["deduped_count"] or 0)
        total_rows = imported_count + skipped_count + deduped_count

        snapshot = safe_json_dict(batch["config_snapshot"])
        summary = snapshot.get(IMPORT_SUMMARY_KEY)
        summary_changed = False
        if isinstance(summary, dict):
            if int(summary.get("imported_count") or 0) != imported_count:
                summary["imported_count"] = imported_count
                summary_changed = True
            if int(summary.get("total_rows") or 0) != total_rows:
                summary["total_rows"] = total_rows
                summary_changed = True

        row_count_changed = int(batch["row_count"] or 0) != total_rows
        if row_count_changed:
            conn.execute(
                "UPDATE import_batch SET row_count = ? WHERE id = ?",
                (total_rows, batch_id),
            )
        if summary_changed:
            snapshot[IMPORT_SUMMARY_KEY] = summary
            save_batch_snapshot(conn, batch_id, snapshot)


def parse_amount(row: dict, convention: str, col_map: AmountColumnMap) -> Optional[float]:
    """
    Parse an amount cell and return a signed float.
    Positive = debit (money out), negative = credit (money in).

    Handles common bank CSV formats:
      -50.00        standard negative
      (50.00)       accounting/parenthetical negative (debit in some exports)
      50.00 CR      trailing CR = credit (income)
      50.00 DR      trailing DR = debit (expense)
      $1,234.56     dollar sign and thousands separators

    A cell carries at most one of two direction signals, and they are read in separate steps because
    they disagree about which way is positive: a `DR`/`CR` suffix names the direction outright, while a
    bare sign is in the *file's* convention (positive = money in), which is the opposite of what this
    function returns. Reading the suffix as if it were the latter is what made `50.00 CR` import as a
    debit — the suffix survived one flip too many.
    """
    import re

    # The cell's numeric value in FILE convention, plus its explicit direction marker if it has one.
    # Callers apply the direction; nothing here is in stored convention yet.
    def clean(raw: str) -> tuple[float, Optional[str]]:
        s = raw.strip().replace(",", "").replace("$", "").replace(" ", "")
        m = re.fullmatch(r'\(([0-9.]+)\)', s)
        if m:
            return -float(m.group(1)), None
        for marker in ("CR", "DR"):
            if re.search(f'{marker}$', s, re.IGNORECASE):
                return abs(float(re.sub(f'{marker}$', '', s, flags=re.IGNORECASE))), marker
        return float(s), None

    # Resolve one cell to stored convention (positive = debit). An explicit marker wins; otherwise the
    # cell's own sign decides, oriented by where it was read from — `column_sign` is -1 for a value in
    # file convention (a single signed amount, or a credit-column cell) and +1 for a debit-column cell.
    def to_stored(value: float, marker: Optional[str], column_sign: int) -> float:
        if marker == "CR":
            return -abs(value)
        if marker == "DR":
            return abs(value)
        return column_sign * value

    try:
        if convention == "two_column":
            d_raw = str(row.get(col_map.debit,  "") or "")
            c_raw = str(row.get(col_map.credit, "") or "")
            d_value, d_marker = clean(d_raw) if d_raw.strip() else (0.0, None)
            c_value, c_marker = clean(c_raw) if c_raw.strip() else (0.0, None)
            debit  = to_stored(d_value, d_marker,  1)
            credit = to_stored(c_value, c_marker, -1)
            # `or 0.0` so a blank/blank row is a plain zero rather than the -0.0 the credit side yields.
            return debit or credit or 0.0

        raw = str(row.get(col_map.amount, "") or "").strip()
        val, marker = clean(raw)

        if convention == "single_unsigned" and col_map.direction:
            direction = str(row.get(col_map.direction, "")).strip().lower()
            if direction in ("credit", "cr", "deposit", "income"):
                return -abs(val)
            return abs(val)

        return to_stored(val, marker, -1)

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


def normalize_import_category(value: str) -> str:
    return " ".join((value or "").strip().lower().split())


def normalize_effective_imported_category(value: str) -> str:
    normalized = normalize_import_category(value)
    if normalized in UNCATEGORIZED_IMPORT_CATEGORY_NAMES:
        return ""
    return " ".join((value or "").strip().split())


# Thin import-module aliases over the shared tenant-state KV accessors (the canonical pair lives in
# db.database, since this store is shared app-wide state — demo marker, workspace draft, tag-report
# catalog — not an import-only concern). Kept as names the import flows already call.
_get_import_workflow_state = get_tenant_workflow_state
_save_import_workflow_state = set_tenant_workflow_state


# The "Group Imported Categories" workspace draft is shared tenant-wide state, not a per-user
# preference: it stages how the one shared category tree is being organized, so every user/profile
# must see the same in-progress draft. It therefore lives in `import_workflow_state` (shared, in the
# data DB, carried by backups) rather than the scoped `ui_preference` store. The payload is the
# opaque frontend draft snapshot; the backend only persists and returns it.
class CategoryWorkspaceDraftBody(BaseModel):
    draft: Optional[dict] = None
    # The revision this draft was edited from, as the last read or save returned it.
    base_revision: int = 0


def _workspace_draft_revision(state: dict) -> int:
    try:
        return max(int(state.get("revision") or 0), 0)
    except (TypeError, ValueError):
        return 0


@router.get("/category-workspace-draft")
def get_category_workspace_draft():
    with get_db() as conn:
        state = _get_import_workflow_state(conn, SYSTEM_CATEGORY_WORKSPACE_DRAFT_KEY)
    draft = state.get("draft")
    return {"draft": draft if isinstance(draft, dict) else None, "revision": _workspace_draft_revision(state)}


@router.put("/category-workspace-draft")
def save_category_workspace_draft(body: CategoryWorkspaceDraftBody):
    """Store the draft only if nobody has stored another since it was read.

    The draft is one shared record, and it used to be overwritten by whichever save arrived last — so two tabs,
    or two members, silently erased each other's arranging. Every save now names the revision it was edited
    from; a save based on an older one is refused with the stored draft, for the browser to offer back. The
    read and the write share one immediate transaction, so two saves racing on the same revision cannot both
    pass the check.
    """
    draft = body.draft if isinstance(body.draft, dict) else None
    with get_db() as conn:
        conn.execute("BEGIN IMMEDIATE")
        state = _get_import_workflow_state(conn, SYSTEM_CATEGORY_WORKSPACE_DRAFT_KEY)
        current = _workspace_draft_revision(state)
        stored = state.get("draft")
        if body.base_revision != current:
            if draft == stored:
                # Nothing would be lost either way, so there is nothing to ask about.
                return {"ok": True, "revision": current}
            raise HTTPException(status_code=409, detail={
                "code": "draft_conflict",
                "message": "The imported-category draft was changed somewhere else.",
                "draft": stored if isinstance(stored, dict) else None,
                "revision": current,
            })
        _save_import_workflow_state(
            conn, SYSTEM_CATEGORY_WORKSPACE_DRAFT_KEY, {"draft": draft, "revision": current + 1}
        )
    return {"ok": True, "revision": current + 1}


def _get_system_rule_suggestion_review_state(conn) -> dict:
    return get_rule_suggestion_review_state(
        _get_import_workflow_state(conn, SYSTEM_RULE_SUGGESTION_REVIEW_STATE_KEY)
    )


def _save_system_rule_suggestion_review_state(conn, review_state: dict) -> None:
    _save_import_workflow_state(
        conn,
        SYSTEM_RULE_SUGGESTION_REVIEW_STATE_KEY,
        {RULE_SUGGESTION_REVIEW_KEY: review_state},
    )


# Temporary Generate Rules diagnostic trail:
# - The client supplies workflow identities and correlation metadata, never transaction descriptions.
# - The server enriches each event from committed SQLite state so optimistic UI cannot mask the cause.
# - Output is a fixed local JSONL file under data/ui (or a test-only environment override).
def _rule_suggestion_trace_path() -> Path:
    override = os.getenv("LUMA_RULE_SUGGESTION_TRACE_PATH")
    if override:
        return Path(override)
    return Path(__file__).resolve().parents[3] / "data" / "ui" / "import-rule-suggestion-debug.jsonl"


def _load_rule_suggestion_trace_review_state(conn, body: RuleSuggestionDebugTraceRequest) -> dict:
    if body.context_type == "batch" and body.context_id:
        row = conn.execute(
            "SELECT config_snapshot FROM import_batch WHERE id = ?",
            (body.context_id,),
        ).fetchone()
        return get_rule_suggestion_review_state(safe_json_dict(row["config_snapshot"])) if row else {}
    if body.context_type == "profile" and body.context_id:
        row = conn.execute(
            "SELECT column_map FROM csv_import_profile WHERE id = ?",
            (body.context_id,),
        ).fetchone()
        return _get_profile_rule_suggestion_review_state(safe_json_dict(row["column_map"])) if row else {}
    return _get_system_rule_suggestion_review_state(conn)


def _build_rule_suggestion_trace_record(conn, body: RuleSuggestionDebugTraceRequest) -> dict:
    transaction_ids = list(dict.fromkeys(str(value) for value in body.transaction_ids if str(value).strip()))[:5000]
    rule_ids = list(dict.fromkeys(str(value) for value in body.rule_ids if str(value).strip()))[:500]
    keywords = list(dict.fromkeys(normalize_rule_keyword(value) for value in body.keywords if normalize_rule_keyword(value)))[:500]
    suggestion_ids = list(dict.fromkeys(str(value) for value in body.suggestion_ids if str(value).strip()))[:5000]

    transactions = []
    if transaction_ids:
        placeholders = ",".join("?" * len(transaction_ids))
        transactions = [
            dict(row)
            for row in conn.execute(
                f"""
                SELECT
                    t.id,
                    t.category_id,
                    t.category_source,
                    t.category_overridden,
                    t.import_batch_id,
                    b.use_imported_categories
                FROM txn t
                LEFT JOIN import_batch b ON b.id = t.import_batch_id
                WHERE t.id IN ({placeholders})
                ORDER BY t.id
                """,
                transaction_ids,
            ).fetchall()
        ]

    rules = []
    rule_where = []
    rule_params = []
    if rule_ids:
        rule_where.append(f"r.id IN ({','.join('?' * len(rule_ids))})")
        rule_params.extend(rule_ids)
    if keywords:
        rule_where.append(f"lower(r.keyword) IN ({','.join('?' * len(keywords))})")
        rule_params.extend(keywords)
    if rule_where:
        rules = [
            dict(row)
            for row in conn.execute(
                f"""
                SELECT
                    r.id,
                    r.keyword,
                    r.category_id,
                    r.amount_min,
                    r.amount_max,
                    r.debit_credit,
                    r.owner_id,
                    r.account_id,
                    r.match_source_text
                FROM category_rule r
                WHERE {" OR ".join(rule_where)}
                ORDER BY r.id
                """,
                rule_params,
            ).fetchall()
        ]

    review_state = _load_rule_suggestion_trace_review_state(conn, body)
    review_statuses = review_state.get("statuses") or {}
    review_entries = review_state.get("suggestions") or {}
    suggestions = {
        suggestion_id: {
            "status": (review_statuses.get(suggestion_id) or {}).get("status") or "pending",
            "rule_id": (review_statuses.get(suggestion_id) or {}).get("rule_id"),
            "source_row_count": len((review_entries.get(suggestion_id) or {}).get("source_row_ids") or []),
            "synthetic": bool((review_entries.get(suggestion_id) or {}).get("synthetic")),
            "pending_override": bool((review_entries.get(suggestion_id) or {}).get("pending_override")),
        }
        for suggestion_id in suggestion_ids
    }

    return {
        "server_timestamp": utcnow_iso(),
        "correlation_id": body.correlation_id,
        "client_sequence": body.client_sequence,
        "event": body.event,
        "phase": body.phase,
        "context": {"type": body.context_type, "id": body.context_id},
        "suggestion_ids": suggestion_ids,
        "transaction_ids": transaction_ids,
        "rule_ids": rule_ids,
        "keywords": keywords,
        "undo_snapshot": body.undo_snapshot,
        "details": body.details,
        "database": {
            "transactions": transactions,
            "rules": rules,
            "suggestions": suggestions,
        },
    }


def _get_unassigned_group(conn):
    return conn.execute(
        """
        SELECT id, name, category_type, sort_order, system_key
        FROM   category
        WHERE  parent_id IS NULL
          AND  system_key = ?
        LIMIT  1
        """,
        (UNASSIGNED_CATEGORY_SYSTEM_KEY,),
    ).fetchone()


def _get_next_child_sort_order(conn, parent_id: str) -> int:
    row = conn.execute(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_sort FROM category WHERE parent_id = ?",
        (parent_id,),
    ).fetchone()
    return int(row["next_sort"] or 0) if row else 0


def _find_category_by_normalized_name(conn, normalized_name: str):
    # Imported category labels resolve to assignable *leaves* only. A top-level group that happens to
    # share the label must not capture the imported transactions — that would assign them to a group,
    # which the data model forbids. With no matching leaf, the caller creates one under Unassigned, even
    # when a same-named group exists (now allowed: see _find_category_name_conflict in categories.py).
    if not normalized_name:
        return None
    rows = conn.execute(
        """
        SELECT id, parent_id, name, category_type, sort_order, system_key, import_source_batch_id, is_active
        FROM   category
        WHERE  parent_id IS NOT NULL
        ORDER  BY name
        """
    ).fetchall()
    for row in rows:
        if normalize_import_category(row["name"]) == normalized_name:
            return row
    return None


def _ensure_imported_batch_category(conn, batch_id: str, raw_name: str):
    unassigned_group = _get_unassigned_group(conn)
    if not unassigned_group:
        raise HTTPException(status_code=500, detail="The system Unassigned group is missing")
    normalized_name = normalize_import_category(raw_name)
    if not normalized_name:
        return None
    if normalized_name in UNCATEGORIZED_IMPORT_CATEGORY_NAMES:
        return None
    existing = _find_category_by_normalized_name(conn, normalized_name)
    if existing:
        if not existing["is_active"]:
            # Set-aside / deleted label: the row imports uncategorized (caller leaves
            # category_id / category_source NULL, keeps imported_category). Never resurrect
            # the inactive leaf or create a fresh one for the same label.
            return None
        if existing["import_source_batch_id"]:
            conn.execute(
                "UPDATE category SET import_source_batch_id = NULL WHERE id = ?",
                (existing["id"],),
            )
        return existing

    category_id = str(uuid.uuid4())
    conn.execute(
        """
        INSERT INTO category (
            id, parent_id, name, category_type, sort_order, exclude_from_totals,
            system_key, import_source_batch_id, import_pending
        )
        VALUES (?, ?, ?, NULL, ?, 0, NULL, ?, 1)
        """,
        (
            category_id,
            unassigned_group["id"],
            raw_name,
            _get_next_child_sort_order(conn, unassigned_group["id"]),
            batch_id,
        ),
    )
    return conn.execute(
        """
        SELECT id, parent_id, name, category_type, sort_order, system_key, import_source_batch_id
        FROM   category
        WHERE  id = ?
        """,
        (category_id,),
    ).fetchone()


def _apply_imported_batch_categories(conn, batch_id: str) -> None:
    category_rows = conn.execute(
        """
        SELECT DISTINCT imported_category
        FROM   txn
        WHERE  import_batch_id = ?
          AND  category_source = 'import'
          AND  imported_category IS NOT NULL
          AND  TRIM(imported_category) <> ''
        ORDER  BY imported_category
        """,
        (batch_id,),
    ).fetchall()

    for row in category_rows:
        _ensure_imported_batch_category(conn, batch_id, str(row["imported_category"] or "").strip())


def _remove_imported_batch_categories(conn, batch_id: str) -> None:
    rows = conn.execute(
        """
        SELECT c.id
        FROM   category c
        LEFT JOIN category p ON p.id = c.parent_id
        WHERE  c.import_source_batch_id = ?
          AND  c.parent_id IS NOT NULL
          AND  p.system_key = ?
          AND  c.import_pending = 1
        """,
        (batch_id, UNASSIGNED_CATEGORY_SYSTEM_KEY),
    ).fetchall()
    if not rows:
        return

    category_ids = [row["id"] for row in rows]
    placeholders = ",".join("?" for _ in category_ids)
    usage_rows = conn.execute(
        f"""
        SELECT c.id
        FROM   category c
        WHERE  c.id IN ({placeholders})
          AND (
            EXISTS (SELECT 1 FROM txn t WHERE t.category_id = c.id)
            OR EXISTS (SELECT 1 FROM category_rule r WHERE r.category_id = c.id)
          )
        """,
        category_ids,
    ).fetchall()
    in_use_ids = {row["id"] for row in usage_rows}
    removable_ids = [category_id for category_id in category_ids if category_id not in in_use_ids]
    if removable_ids:
        delete_placeholders = ",".join("?" for _ in removable_ids)
        conn.execute(
            f"DELETE FROM category WHERE id IN ({delete_placeholders})",
            removable_ids,
        )
    if in_use_ids:
        keep_placeholders = ",".join("?" for _ in in_use_ids)
        conn.execute(
            f"UPDATE category SET import_source_batch_id = NULL WHERE id IN ({keep_placeholders})",
            list(in_use_ids),
        )


def stamp_batch_rule_effects(conn, batch_id: str) -> None:
    """Advance category_rule.last_effect_date for the rules that own a live effect on this batch's rows
    (the newest owned transaction date). Bounded to one batch, so cheap — called after the per-batch
    re-categorization paths that don't stamp inline (the imported-categories toggle and the mapping apply),
    so those keep the stale-rule signal current without waiting for a Run categorization."""
    rules = load_categorization_rules(conn)
    if not rules:
        return
    rules_by_id = {r["id"]: r for r in rules}
    rule_tags_by_id = load_rule_tags_by_id(conn)
    needs_source_text = any(r["match_source_text"] for r in rules)
    rows = conn.execute(
        """SELECT t.id, t.date, t.merchant_name, t.display_name, t.raw_name, t.amount, t.owner_id, t.account_id,
                  t.import_evidence_json, COALESCE(a.parent_account_id, t.account_id) AS effective_account_id,
                  COALESCE(p.type, a.type) AS effective_account_type
           FROM   txn t
           JOIN   account a ON a.id = t.account_id
           LEFT   JOIN account p ON p.id = a.parent_account_id
           WHERE  t.import_batch_id = ?""",
        (batch_id,),
    ).fetchall()
    effect_dates: dict = {}
    for row in rows:
        if not row["date"]:
            continue
        source_text = source_match_text_from_json(row["import_evidence_json"]) if needs_source_text else None
        result = categorize_transaction(
            row["merchant_name"], row["raw_name"], row["display_name"], row["amount"], conn,
            owner_id=row["owner_id"], account_id=row["account_id"], effective_account_id=row["effective_account_id"],
            effective_account_type=row["effective_account_type"], rules=rules, rule_tags_by_id=rule_tags_by_id,
            source_text=source_text,
        )
        for rid in effect_rule_ids(result, rules_by_id, rule_tags_by_id):
            if rid not in effect_dates or row["date"] > effect_dates[rid]:
                effect_dates[rid] = row["date"]
    bump_rule_effect_dates(conn, effect_dates)


def _adopt_batch_file_labels(conn, batch_id: str, txn_ids: Optional[list[str]] = None) -> None:
    """Give a batch's unclaimed rows the category their file label names — the last step of import's
    precedence (mapping -> rule -> file label -> uncategorized), run after the fact. `txn_ids` narrows it
    to specific rows; None is the whole batch. The caller decides the batch is trusted for categories."""
    batch = conn.execute(
        "SELECT config_snapshot FROM import_batch WHERE id = ?",
        (batch_id,),
    ).fetchone()
    snapshot = safe_json_dict(batch["config_snapshot"]) if batch else {}
    imported_category_settings = _get_imported_category_settings(snapshot)
    batch_account_rows = conn.execute(
        """
        SELECT csv_value, account_id
        FROM   import_batch_account
        WHERE  batch_id = ?
          AND  account_id IS NOT NULL
        """,
        (batch_id,),
    ).fetchall()
    batch_account_tokens_by_id: dict[str, list[str]] = {}
    for account_row in batch_account_rows:
        account_id = str(account_row["account_id"] or "").strip()
        csv_value = str(account_row["csv_value"] or "").strip()
        if not account_id or not csv_value:
            continue
        batch_account_tokens_by_id.setdefault(account_id, []).append(csv_value)
    row_scope, row_params = "", []
    if txn_ids is not None:
        if not txn_ids:
            return
        row_scope = f"AND id IN ({','.join('?' * len(txn_ids))})"
        row_params = list(txn_ids)
    rows = conn.execute(
        f"""
        SELECT id, imported_category, owner_id, account_id, category_source
        FROM   txn
        WHERE  import_batch_id = ?
          AND  imported_category IS NOT NULL
          AND  TRIM(imported_category) <> ''
          {row_scope}
        """,
        (batch_id, *row_params),
    ).fetchall()
    for row in rows:
        # Same precedence as import: the file label only fills rows nothing else has claimed.
        # Skip manual mappings, rule-categorized rows, AND user-cleared rows — adopting file labels
        # must not override a category the user's rules already chose, must not mint an unused label
        # category for a row a rule has placed, and must not resurrect a label the user deliberately
        # discarded (`category_source = 'cleared'`; see set_rejected_suggestion_disposition). The label is
        # only a bootstrap fallback for rows nothing else owns; `cleared` is a distinct source from NULL
        # precisely so this re-grab can tell "user discarded this" apart from "ordinary uncategorized"
        # (which it still fills). A feature-owned row is skipped for the reason every automatic pass
        # skips it: an `enrichment` row's excluded category is reversible link state, and a `split` row's
        # category is only the pre-split value its allocations replaced.
        if row["category_source"] in ("manual", "rule", "cleared", "enrichment", "split"):
            continue
        scope_tokens = batch_account_tokens_by_id.get(row["account_id"]) or [
            _category_scope_token_for_import_row("", row["account_id"], False, snapshot.get("single_account_new"))
        ]
        if not any(
            _row_uses_imported_categories(True, imported_category_settings, row["owner_id"], token)
            for token in scope_tokens
            if token
        ):
            continue
        category = _ensure_imported_batch_category(conn, batch_id, str(row["imported_category"] or "").strip())
        if not category:
            continue
        conn.execute(
            """
            UPDATE txn
            SET    category_id = ?,
                   category_overridden = 0,
                   category_source = 'import'
            WHERE  id = ?
            """,
            (category["id"], row["id"]),
        )


def adopt_file_categories(conn, txn_ids: list[str]) -> None:
    """Fall the given uncategorized rows back to their file category wherever their batch is trusted for
    categories — what import would have given them had no rule claimed them. Used by the scoped reconcile
    in `recategorize_all`, so a row a deleted or narrowed rule lets go of lands where the import would have
    put it rather than in the uncategorized pile, whichever of the rule and the file arrived first."""
    ids = [str(i) for i in txn_ids if i]
    if not ids:
        return
    ids_by_batch: dict[str, list[str]] = {}
    for start in range(0, len(ids), 500):
        chunk = ids[start:start + 500]
        for row in conn.execute(
            f"""SELECT t.id, t.import_batch_id
                FROM   txn t JOIN import_batch b ON b.id = t.import_batch_id
                WHERE  t.id IN ({','.join('?' * len(chunk))})
                  AND  b.use_imported_categories = 1""",
            chunk,
        ).fetchall():
            ids_by_batch.setdefault(row["import_batch_id"], []).append(row["id"])
    for batch_id, batch_ids in ids_by_batch.items():
        _adopt_batch_file_labels(conn, batch_id, batch_ids)


def _set_batch_imported_category_usage(conn, batch_id: str, is_enabled: bool) -> None:
    batch = conn.execute(
        "SELECT config_snapshot FROM import_batch WHERE id = ?",
        (batch_id,),
    ).fetchone()
    snapshot = safe_json_dict(batch["config_snapshot"]) if batch else {}
    conn.execute(
        "UPDATE import_batch SET use_imported_categories = ? WHERE id = ?",
        (1 if is_enabled else 0, batch_id),
    )
    if is_enabled:
        _apply_imported_batch_categories(conn, batch_id)
        _adopt_batch_file_labels(conn, batch_id)
    else:
        conn.execute(
            """
            UPDATE txn
            SET    category_id = NULL,
                   category_overridden = 0,
                   category_source = NULL
            WHERE  import_batch_id = ?
              AND  category_source = 'import'
            """,
            (batch_id,),
        )
        if snapshot.get("apply_categorization", True):
            uncategorized_rows = conn.execute(
                """
                SELECT id, owner_id, account_id, amount, merchant_name, display_name, raw_name, import_evidence_json
                FROM   txn
                WHERE  import_batch_id = ?
                  AND  category_id IS NULL
                  AND  category_overridden = 0
                """,
                (batch_id,),
            ).fetchall()
            rules = load_categorization_rules(conn)
            rule_tags_by_id = load_rule_tags_by_id(conn)
            needs_source_text = any(rule["match_source_text"] for rule in rules)
            for row in uncategorized_rows:
                source_text = source_match_text_from_json(row["import_evidence_json"]) if needs_source_text else None
                result = categorize_transaction(
                    row["merchant_name"] or row["raw_name"] or "",
                    row["raw_name"] or row["merchant_name"] or "",
                    row["display_name"] or row["merchant_name"] or row["raw_name"] or "",
                    row["amount"],
                    conn,
                    owner_id=row["owner_id"],
                    account_id=row["account_id"],
                    rules=rules,
                    rule_tags_by_id=rule_tags_by_id,
                    source_text=source_text,
                )
                cat_id = result["category_id"] if isinstance(result, dict) else result
                rule_tag_ids = result.get("tag_ids", []) if isinstance(result, dict) else []
                source = "rule" if cat_id else None
                conn.execute(
                    "UPDATE txn SET category_id = ?, category_source = ? WHERE id = ?",
                    (cat_id, source, row["id"]),
                )
                sync_rule_tags_for_transaction(conn, row["id"], rule_tag_ids)
        _remove_imported_batch_categories(conn, batch_id)
        stamp_batch_rule_effects(conn, batch_id)




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
    current_category_id = row.get("category_id")
    if current_category_id and current_category_id in categories_by_id:
        current = categories_by_id[current_category_id]
        return current["id"], current["name"], current.get("group_name")

    imported_name = str(row.get("imported_category") or "").strip()
    normalized = normalize_import_category(imported_name)
    matches = categories_by_name.get(normalized, [])
    if len(matches) == 1:
        return matches[0]["id"], matches[0]["name"], matches[0].get("group_name")
    return None, None, None


@router.delete("/developer/import-memory")
def clear_import_memory(request: Request):
    _require_developer_access(request)
    with get_db() as conn:
        conn.execute("DELETE FROM csv_import_profile")
        conn.execute("UPDATE import_batch SET config_snapshot = NULL")
        conn.execute("DELETE FROM import_workflow_state")
    return {"ok": True}


@router.post("/run")
async def run_import(
    file:   UploadFile = File(...),
    config: str        = Form(...),
):
    """
    Execute the import from a multipart upload. The CSV is parsed server-side (the preview only returns
    10 rows), so we re-read the whole file here. This endpoint only handles the HTTP/multipart envelope
    and the demo guard; the actual import is `run_import_core`, so the same logic is reusable in-process
    (e.g. the demo loader builds its data through the real pipeline) without going through HTTP.
    """
    try:
        cfg = json.loads(config)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid config JSON")

    with get_db() as conn:
        if is_demo_data_loaded(conn):
            raise HTTPException(status_code=409, detail={
                "code": "demo_data_loaded",
                "message": "Clear the demo data before importing your own data.",
            })
        require_no_pending_restore(conn, "importing")

    content = await file.read()
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = content.decode("latin-1")
    result = run_import_core(text, cfg, filename=file.filename or cfg.get("filename", "upload.csv"))

    # A completed import is new data, so refresh recurring detection now instead of waiting for a manual
    # scan. Use the cheap scoped path: reprocess only the payees this batch touched, not the whole ledger
    # (the daily app-load catch-up is the global safety net). Triggered here, not in run_import_core,
    # because the core also runs inside the demo loader's own transaction; the user-import path is where a
    # scan belongs. A detection hiccup must never fail an import that already committed, hence the guard.
    if result.get("imported") and result.get("batch_id"):
        try:
            with get_db() as conn:
                ids = [
                    r["id"] for r in conn.execute(
                        "SELECT id FROM txn WHERE import_batch_id = ?", (result["batch_id"],)
                    ).fetchall()
                ]
                scan_imported_payees(conn, payee_keys_for_ids(conn, ids))
        except Exception as e:
            log_warning(f"[import] recurring auto-scan failed: {e}")

    return result


def run_import_core(text: str, cfg: dict, *, filename: str = "upload.csv", conn=None) -> dict:
    """Core import logic, independent of HTTP/multipart. Given the raw file text and a config dict, it
    parses rows, creates/resolves accounts, inserts + dedupes + categorizes transactions, writes the
    batch and its account-coverage rows, runs the post-import suspect sweep, and returns the result
    summary. The /run endpoint is a thin wrapper around this. A caller may pass its own `conn` to run
    inside an existing transaction (the demo loader does, so its owners/accounts/profiles are visible to
    the import and everything commits together); when omitted, the core opens and commits its own."""
    # The parse seam: everything from here to `headers`/`rows` is CSV-specific, and everything after it
    # is format-agnostic. It is inlined here and again in `preview.py::preview_csv`, so the two agree by
    # construction today and would agree only by discipline once a second format exists -- see
    # docs/building-a-connector.md -> Adding a file importer, which also names the four CSV assumptions
    # buried in it.
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
        pending     = cm_dict.get("pending"),
        currency    = cm_dict.get("currency"),
        description = cm_dict.get("description", ""),
        category    = cm_dict.get("category"),
        notes       = cm_dict.get("notes"),
        account     = cm_dict.get("account"),
        evidence_columns = cm_dict.get("evidence_columns"),
    )

    date_format       = cfg.get("date_format", "%m/%d/%Y")
    amount_convention = cfg.get("amount_convention", "single_signed")
    apply_cat         = bool(cfg.get("apply_categorization", True))
    enrich_from_source = bool(cfg.get("enrich_from_source", False))
    use_imported_categories = bool(cfg.get("use_imported_categories", False))
    imported_category_settings = _get_imported_category_settings(cfg)
    account_id        = cfg.get("account_id") or None
    single_account_new = cfg.get("single_account_new") or None
    category_assignments_cfg = cm_dict.get("category_assignments") or {}
    account_map_cfg   = cfg.get("account_map") or {}
    skip_accounts_cfg = cfg.get("skip_accounts") or []
    new_accounts_cfg  = cfg.get("new_accounts") or []
    duplicate_strategies_cfg = safe_json_dict(cfg.get("duplicate_strategies"))
    coverage_strategy_enabled = duplicate_strategies_cfg.get(COVERAGE_DUPLICATE_STRATEGY_KEY, True) is not False
    text_strategy_enabled = duplicate_strategies_cfg.get(TEXT_DUPLICATE_STRATEGY_KEY, True) is not False
    profile_id        = cfg.get("profile_id") or None
    replace_batch_id  = cfg.get("replace_batch_id") or None

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
    currency_rows = []
    # Resolved once per import rather than per row: the policy is a property of the source, and reading it
    # inside the loop would invite a future edit that varies it by row.
    reject_zero_amount_rows = rejects_zero_amount(zero_amount_policy_for_source(SOURCE_CSV))
    validation_error_rows = []
    duplicate_rows = []
    skip_set = set(skip_accounts_cfg)

    # Run inside the caller's transaction when one is supplied (demo loader); otherwise own the connection.
    # Kept under its own name because `conn` is rebound below: the post-import sweep, which runs *after*
    # this transaction, has to know whether there is a transaction of ours to have committed.
    caller_conn = conn
    with (nullcontext(conn) if conn is not None else get_db()) as conn:
        default_owner_id = resolve_default_owner_id(conn, None)
        # Read once, like the zero-amount policy: one import is judged against one ledger currency.
        ledger_currency = get_ledger_currency(conn)
        # A recognized PayPal import groups under the single system PayPal data source, so all PayPal
        # imports share one header + one money-movement review. With no source picked, get-or-create it;
        # with a source picked (a hand-created PayPal source), *adopt* it — tag it `source:paypal` so it
        # gets the same treatment (non-deletable, money-movement review) as an auto-created one.
        if not replace_batch_id and sniff_paypal_activity(headers):
            if profile_id is None:
                profile_id = _get_or_create_paypal_profile(
                    conn, header_fingerprint="|".join(headers), column_map=cm_dict,
                    date_format=date_format, amount_convention=amount_convention,
                )
            else:
                conn.execute(
                    "UPDATE csv_import_profile SET source_kind = ? WHERE id = ? AND source_kind IS NULL",
                    (PAYPAL_SOURCE_KIND, profile_id),
                )
        valid_category_ids = {
            row["id"] for row in conn.execute("SELECT id FROM category").fetchall()
        }
        category_assignments_cfg = {
            raw_value: category_id
            for raw_value, category_id in category_assignments_cfg.items()
            if category_id in valid_category_ids
        }

        created_account_ids = {}
        # csv_value → the linked-group root its new account was attached to, so exact-hash matches
        # resolve across the group. Populated only by a group attachment now: the "compare-only alias"
        # mapping choice (keep a separate account, but hard-dedupe it against an existing one) was
        # removed — it had no analogue anywhere else in the app and asserted two accounts were the same
        # physical account while deliberately keeping them apart. Mapping onto the existing account
        # expresses that properly; grouping expresses "related but distinct".
        account_duplicate_compare_targets: dict[str, str] = {}
        # An explicit alias is the strictly stronger assertion — "this IS that account in another
        # system" — and is what unlocks the coverage rules. A CSV import can no longer make it (that
        # was the compare choice); a data connection still can, by mapping a provider account onto an
        # existing one. Kept as a set rather than inlined so the two ingestion paths keep one shape.
        explicit_alias_csv_values: set[str] = set()
        if single_account_new:
            single_name = str(single_account_new.get("name", "")).strip()
            single_type = single_account_new.get("type", "depository")
            # A new account created by a recognized PayPal import is a PayPal wallet — mark its type so the
            # account-type rule criterion (money movement, and any user rule) covers it. Only when the type
            # is generic, so an explicit non-generic choice is respected; existing accounts are never touched.
            if sniff_paypal_activity(headers) and single_type in (None, "", "depository", "other"):
                single_type = "paypal"
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
                          (id, external_account_id, connection_id, provider, name, display_name, type, subtype, owner_id, parent_account_id, trashed_at)
                        VALUES (?, ?, NULL, 'csv', ?, ?, ?, ?, ?, NULL, NULL)
            """, (new_acc_id, f"csv_{new_acc_id}", single_name, single_name, single_type, "checking",
                  default_owner_id))
            created_account_ids["__single_account__"] = new_acc_id
        # What the user ruled out by giving a CSV account value its own new account: every existing
        # account the mapping row offered as a possible match. Recorded after the loop so every account
        # named in them exists. The user compared the account names and said they are different accounts;
        # that is the assertion the cross-account sweep needs, and discarding it meant the same question
        # returned as a flagged transaction for every coincidence between the pair.
        #
        # A set per new account rather than one id: "is this any of these?" is a question about a set, and
        # answering it recorded only one arbitrarily-chosen pair — or, when the candidates tied and no
        # suggestion was offered at all, nothing.
        declined_matches: list[tuple[str, str]] = []
        for na in new_accounts_cfg:
            csv_val  = na.get("csv_value", "")
            acc_name = na.get("name", csv_val).strip()
            acc_type = na.get("type", "depository")
            requested_group_target_id = str(na.get("group_with_account_id") or "").strip()
            declined_match_ids = {
                str(d).strip() for d in (na.get("distinct_from_account_ids") or []) if str(d or "").strip()
            }
            if not acc_name:
                continue
            # Check if an account with this name already exists — use it rather
            # than creating a duplicate. Case-insensitive match.
            existing = conn.execute(
                "SELECT id FROM account WHERE LOWER(name) = LOWER(?)", (acc_name,)
            ).fetchone()
            if existing:
                # A later file in a multi-file import (or a re-import into the same account) finds the
                # account already created and reuses it by name. Nothing to re-assert: a *grouping*
                # relationship persists on the account itself (`parent_account_id`), so its dedupe scope
                # is restored automatically. (The per-import compare alias used to need re-asserting
                # here; it no longer exists.)
                created_account_ids[csv_val] = existing["id"]
                declined_matches.extend(
                    (existing["id"], declined) for declined in declined_match_ids if declined != existing["id"]
                )
                continue
            new_acc_id = str(uuid.uuid4())
            conn.execute("""
                INSERT INTO account
                  (id, external_account_id, connection_id, provider, name, display_name, type, subtype, owner_id, parent_account_id, trashed_at)
                VALUES (?, ?, NULL, 'csv', ?, ?, ?, ?, ?, NULL, NULL)
            """, (new_acc_id, f"csv_{new_acc_id}", acc_name, acc_name, acc_type, "checking",
                  default_owner_id))
            created_account_ids[csv_val] = new_acc_id
            declined_matches.extend(
                (new_acc_id, declined) for declined in declined_match_ids if declined != new_acc_id
            )
            if requested_group_target_id:
                group_root_id = _attach_import_created_account_to_group(conn, new_acc_id, requested_group_target_id) or ""
                if group_root_id:
                    account_duplicate_compare_targets[csv_val] = group_root_id

        for created_id, declined_id in declined_matches:
            record_account_pair_distinct(conn, created_id, declined_id)

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
                SELECT id, filename
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
            # Re-importing an identical file (same content hash) is blocked only when it would add
            # *nothing*. For a plain single-scope file that means always. For an account-column file it
            # means every account this run would import was already imported from the earlier run — the
            # file can still be re-used for accounts that were skipped/not-imported before, so if any such
            # new account is present we fall through and import it, and the already-imported accounts' rows
            # are caught by ordinary row-level dedup (no special handling or warning needed).
            nothing_new = True
            if col.account:
                present_csv_values = {
                    str(row.get(col.account, "")).strip()
                    for row in data_rows
                    if str(row.get(col.account, "")).strip()
                }
                new_values = (present_csv_values - skip_set) - previously_imported_values
                nothing_new = not new_values
            if nothing_new:
                # Structured so a multi-file import can skip this one file and carry on (naming the file
                # it duplicates), while a single-file import still shows the readable message. `reason`
                # is the stable code the frontend branches on.
                raise HTTPException(
                    status_code=409,
                    detail={
                        "message": "This file has already been imported. Undo the earlier import first.",
                        "reason": "already_imported",
                        "already_imported_filename": previous_batch["filename"],
                    },
                )

        # Pre-load pending rows so a posted transaction can replace the earlier pending version
        # instead of creating a second copy. Kept separate from the dedupe context: pending rows are
        # deliberately NOT dedupe candidates (a pending row is superseded in place when it posts, so
        # matching against it would reject the very row meant to replace it).
        relevant_account_ids = {str(aid) for aid in effective_map.values() if aid}
        if account_id:
            relevant_account_ids.add(str(account_id))
        existing_pending_rows: dict = {}
        if relevant_account_ids:
            ph = ",".join("?" * len(relevant_account_ids))
            for r in conn.execute(
                f"SELECT id, account_id, content_hash, date, raw_name FROM txn "
                f"WHERE account_id IN ({ph}) AND is_pending = 1 AND content_hash IS NOT NULL",
                list(relevant_account_ids),
            ).fetchall():
                key = (r["account_id"], r["date"], (r["raw_name"] or "").strip().lower())
                existing_pending_rows[key] = {"id": r["id"], "content_hash": r["content_hash"]}

        current_csv_values = (
            {
                str(row.get(col.account, "")).strip()
                for row in data_rows
                if str(row.get(col.account, "")).strip()
            }
            if col.account
            else {""}
        )

        if replace_batch_id:
            # The replaced batch's rows go away exactly as they would under Undo, so it takes the same
            # path: reversing what they did to rows outside the batch, and restoring any row trashed as
            # a confirmed duplicate of one of them (the twin's "duplicate of that" no longer has a that).
            undo_batches(conn, [replace_batch_id])
            conn.execute("UPDATE import_batch SET status = 'undone' WHERE id = ?", (replace_batch_id,))

        # Snapshot the import decisions up front so undo, review, and batch-resume flows
        # can reopen the exact mapping context that produced these rows.
        config_snapshot = {
            "column_map":          cm_dict,
            "category_assignments": category_assignments_cfg,
            "account_map":         account_map_cfg,
            "skip_accounts":       list(skip_set),
            # Persist the header fingerprint (same "|".join(headers) form the preview/profiles use)
            # so a data source later created from this batch can auto-match future files by column
            # structure, matching the "Save as data source" flow. Older batches imported before this
            # was stored simply won't have it (the raw header isn't otherwise recoverable).
            "header_fingerprint":  "|".join(headers),
            "date_format":         date_format,
            "amount_convention":   amount_convention,
            "skip_rows":           skip_rows,
            "apply_categorization":apply_cat,
            "enrich_from_source":  enrich_from_source,
            "use_imported_categories": use_imported_categories,
            IMPORTED_CATEGORY_SETTINGS_KEY: imported_category_settings,
            "account_id":          account_id,
            "single_account_new":  single_account_new,
            "duplicate_strategies": {
                COVERAGE_DUPLICATE_STRATEGY_KEY: True,
                TEXT_DUPLICATE_STRATEGY_KEY: True,
            },
            UNKNOWN_SOURCE_FALLBACK_KEY: False,
        }
        # `account_duplicate_compare` is deliberately no longer written into the snapshot. It existed so
        # the client could restore the compare-only choice into a resumed draft; with that choice gone,
        # the only thing left in the dict is a group root, which is already durable on the account
        # (`parent_account_id`) and needs no snapshot to survive. Old batches keep the key harmlessly.
        conn.execute("""
            INSERT INTO import_batch
              (id, profile_id, filename, file_content_hash, row_count, skipped_count, deduped_count, use_imported_categories, config_snapshot, source_kind)
            VALUES (?, ?, ?, ?, 0, 0, 0, ?, ?, ?)
        """, (batch_id, profile_id, filename, file_content_hash, 1 if use_imported_categories else 0, json.dumps(config_snapshot),
              PAYPAL_SOURCE_KIND if sniff_paypal_activity(headers) else None))

        if not profile_id:
            previous_profileless_batches = conn.execute(
                """
                SELECT id, config_snapshot
                FROM   import_batch
                WHERE  profile_id IS NULL
                  AND  id <> ?
                  AND  status = 'completed'
                """,
                (batch_id,),
            ).fetchall()
            for prior_batch in previous_profileless_batches:
                prior_snapshot = safe_json_dict(prior_batch["config_snapshot"])
                if prior_snapshot.get(UNKNOWN_SOURCE_FALLBACK_KEY):
                    continue
                prior_snapshot[UNKNOWN_SOURCE_FALLBACK_KEY] = True
                save_batch_snapshot(conn, prior_batch["id"], prior_snapshot)

        use_account_col = bool(col.account)
        batch_account_stats: dict[str, dict] = {}
        skip_counts:    dict = {}
        batch_terminal_date = None
        consecutive_error_rows = 0
        footer_error_start_index = None
        footer_error_start_data_index = None
        footer_error_start_row = None

        # One shared ladder for every ingestion path: the CSV account-column values are this pass's
        # "source values", and the accounts they resolve to are the mapping. A data-source sync builds
        # the same context from its provider account labels (see routers/sync.py).
        dedupe_context = build_dedupe_context(
            conn,
            source_values=current_csv_values,
            account_by_source_value=effective_map,
            fallback_account_id=account_id or (fallback_acc["id"] if fallback_acc else None),
            compare_targets=account_duplicate_compare_targets,
            alias_values=explicit_alias_csv_values,
            exclude_batch_ids=[replace_batch_id] if replace_batch_id else None,
            coverage_strategy_enabled=coverage_strategy_enabled,
            text_strategy_enabled=text_strategy_enabled,
        )

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

        # Rules are stable across an import; load once so the per-row matcher below doesn't re-query them.
        rules = load_categorization_rules(conn)
        rule_tags_by_id = load_rule_tags_by_id(conn)
        # Accumulate the newest transaction date each rule supplies an effect for, flushed after the row
        # loop so imports keep category_rule.last_effect_date current (drives the stale-rule cleanup).
        _rules_by_id = {r["id"]: r for r in rules}
        _rule_effect_dates: dict = {}
        # Which columns to capture as evidence, and each one's role, is a file-level decision (roles come
        # from cardinality across the whole file) — compute once, then apply per row.
        evidence_plan = _build_evidence_column_plan(data_rows, headers, col)
        for i, row in enumerate(data_rows):
            row_num = header_row_index + skip_rows + i + 2
            skip_account_row = False

            if use_account_col:
                csv_val = str(row.get(col.account, "")).strip()
                skip_account_row = csv_val in skip_set
                row_account_id = effective_map.get(csv_val)
                if not skip_account_row and not row_account_id:
                    should_stop, remaining = record_footer_like_error(
                        row_num, f"No account mapped for '{csv_val}'", i
                    )
                    if should_stop:
                        skipped += remaining
                        break
                    continue
                acc = get_account(row_account_id) if row_account_id else None
            elif fallback_acc:
                csv_val = ""
                acc     = dict(fallback_acc)
            else:
                should_stop, remaining = record_footer_like_error(row_num, "No account configured", i)
                if should_stop:
                    skipped += remaining
                    break
                continue

            if not skip_account_row and not acc:
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
            # The ledger holds one currency and stores a bare number, so a row the file says is in another
            # is refused rather than added into every total at face value — the rule a sync applies too
            # (see `services/ledger_currency.py`). A blank cell states nothing and reads as the ledger's.
            if col.currency:
                row_currency = str(row.get(col.currency, "")).strip()
                if row_currency and not currency_matches(ledger_currency, row_currency):
                    skipped += 1
                    currency_rows.append({
                        "row": row_num,
                        "kind": CURRENCY_REJECTION_KIND,
                        "reason": f"In {row_currency} — every amount in {app_name()} is {ledger_currency}",
                        "values": _normalize_import_row_values(row, headers),
                    })
                    row_results.append({"row": row_num, "status": "currency"})
                    reset_footer_detection()
                    continue
            # Declared rather than decided here: a $0 row means different things from different sources,
            # and the rule (plus what goes wrong either way) lives in `services/source_capabilities.py`.
            # For a CSV it is a pending charge published before it settled, and nothing can ever revise it
            # — no identity carries between files — so the settled charge arrives in a later file as an
            # ordinary new row while the placeholder lingers as a permanent near-miss for duplicate
            # detection. Refused, and reported on the card rather than silently discarded.
            if reject_zero_amount_rows and amount == 0:
                skipped += 1
                zero_amount_rows.append({
                    "row": row_num,
                    "kind": ZERO_AMOUNT_REJECTION_KIND,
                    "reason": ZERO_AMOUNT_REJECTION_REASON,
                    "values": _normalize_import_row_values(row, headers),
                })
                row_results.append({"row": row_num, "status": "zero_amount"})
                reset_footer_detection()
                continue
            if not batch_terminal_date or parsed_date > batch_terminal_date:
                batch_terminal_date = parsed_date
            if skip_account_row:
                skipped += 1
                skip_counts[csv_val] = skip_counts.get(csv_val, 0) + 1
                row_results.append({"row": row_num, "status": "skipped_account"})
                reset_footer_detection()
                continue

            raw_desc     = str(row.get(col.description, "")).strip()
            # Enrich a bare check line with its number for the merchant/display fields only; raw_name
            # and content_hash stay literal so the raw source text and dedupe are untouched.
            check_number = _extract_check_number(raw_desc, row, headers)
            display_desc = f"{raw_desc} #{check_number}" if check_number else raw_desc
            raw_imported_category = normalize_effective_imported_category(row.get(col.category, "")) if col.category else ""
            notes_val    = str(row.get(col.notes, "")).strip() if col.notes else None
            is_pending = parse_pending_flag(row, col)
            content_hash = make_hash(parsed_date, amount, raw_desc)
            import_evidence = _build_import_evidence(row, col, csv_val, raw_desc, evidence_plan)
            batch_account_stat = batch_account_stats.setdefault(
                csv_val,
                {"account_id": acc["id"], "count": 0, "coverage_dates": set()},
            )
            if not batch_account_stat.get("account_id"):
                batch_account_stat["account_id"] = acc["id"]
            batch_account_stat["coverage_dates"].add(parsed_date)

            pending_match_key = (acc["id"], parsed_date, raw_desc.lower())
            pending_match = existing_pending_rows.get(pending_match_key)
            if pending_match and not is_pending:
                # A posted row supersedes a pending one imported earlier (matched by account + date + source
                # text). Convert that row in place — clear pending, take the posted amount + refreshed hash,
                # re-home it to this batch — so the user's category / rename / tag / note edits on the pending
                # row survive, instead of deleting it and inserting a fresh row that would drop them. The row
                # is a known transaction transitioning state, so it skips the dedupe chain below. (Mirrors the
                # provider-sync pending→posted conversion, which matches on the explicit pending id.)
                conn.execute(
                    "UPDATE txn SET is_pending = 0, amount = ?, content_hash = ?, import_batch_id = ? WHERE id = ?",
                    (amount, content_hash, batch_id, pending_match["id"]),
                )
                existing_pending_rows.pop(pending_match_key, None)
                imported += 1
                row_results.append({"row": row_num, "status": "imported"})
                reset_footer_detection()
                continue

            if raw_imported_category:
                imported_category_counts[raw_imported_category] = imported_category_counts.get(raw_imported_category, 0) + 1

            # Category precedence is intentional: mapping -> rule -> imported file label -> uncategorized.
            #   1. An explicit per-label mapping from the review screen always wins.
            #   2. The user's own rules run BEFORE the file's category. If a rule categorizes the row
            #      we store it under the rule's category and intentionally do NOT create a category
            #      from the file label — that label category would be empty and unused. Luma's
            #      rules are the source of truth; the file label is only a bootstrap fallback (see
            #      docs/data-model.md "imported categories"). Tag-only rules still apply their tags
            #      while leaving the category open for the fallback below.
            #   3. Only if nothing above claimed the row do we adopt (and lazily create) the file's
            #      imported category, and only when this source is flagged to use imported categories.
            # The raw label is always retained on the row as imported_category text regardless.
            cat_id = None
            category_source = None
            category_overridden = 0
            rule_tag_ids = []
            rule_result = None
            if raw_imported_category:
                mapped_category_id = category_assignments_cfg.get(raw_imported_category)
                if mapped_category_id:
                    cat_id = mapped_category_id
                    category_source = "manual"
                    category_overridden = 1
            if apply_cat and not cat_id:
                rule_result = categorize_transaction(
                    raw_desc, raw_desc, raw_desc, amount, conn,
                    owner_id=acc["owner_id"],
                    account_id=acc["id"],
                    rules=rules,
                    rule_tags_by_id=rule_tags_by_id,
                    source_text=extract_source_match_text(import_evidence),
                )
                rule_cat_id = rule_result["category_id"] if isinstance(rule_result, dict) else rule_result
                rule_tag_ids = rule_result.get("tag_ids", []) if isinstance(rule_result, dict) else []
                if rule_cat_id:
                    cat_id = rule_cat_id
                    category_source = "rule"
            if raw_imported_category and not cat_id:
                category_scope_token = _category_scope_token_for_import_row(csv_val, acc["id"], use_account_col, single_account_new)
                if _row_uses_imported_categories(
                    use_imported_categories,
                    imported_category_settings,
                    acc["owner_id"],
                    category_scope_token,
                ):
                    imported_category = _ensure_imported_batch_category(conn, batch_id, raw_imported_category)
                    if imported_category:
                        cat_id = imported_category["id"]
                        category_source = "import"

            name_effects = rule_scalar_effects(rule_result, fallback_name=display_desc)
            txn_payload = {
                "account_id": acc["id"],
                "owner_id": acc["owner_id"],
                "category_id": cat_id,
                "amount": amount,
                "merchant_name": display_desc,
                "display_name": name_effects["display_name"],
                # 'rule' when a rule's clean_name authored the name, else 'import' (the file's own name).
                "display_name_source": "rule" if name_effects["renamed_by_rule"] else "import",
                "raw_name": raw_desc,
                "date": parsed_date,
                "is_pending": 1 if is_pending else 0,
                "content_hash": content_hash,
                "import_evidence": import_evidence,
                "imported_category": raw_imported_category or None,
                "notes": notes_val or None,
                "category_overridden": category_overridden,
                "category_source": category_source,
                "csv_value": csv_val,
            }

            # Run the consolidated dedupe rule chain. The verdict carries either a hard-reject
            # decision (with matched row + reason text) or a passthrough decision. The rule chain
            # itself lives in `backend/services/duplicate_detection.py` — see that module's
            # docstring for the confidence ladder and the precondition for the medium-confidence
            # rules.
            verdict = evaluate_duplicate(
                context=dedupe_context,
                receiving_account_id=acc["id"],
                csv_value=csv_val,
                content_hash=content_hash,
                parsed_date=parsed_date,
                amount=amount,
                scope_id=dedupe_context.scope_id_for(acc["id"], csv_val),
                txn_payload=txn_payload,
            )
            duplicate_existing = verdict.matched if verdict.hard_reject else None
            duplicate_reason = verdict.reason if verdict.hard_reject else ""
            if duplicate_existing:
                deduped += 1
                duplicate_rows.append({
                    "row": row_num,
                    "kind": "duplicate",
                    "reason": duplicate_reason,
                    "values": _normalize_import_row_values(row, headers),
                    "matched_transaction": duplicate_existing,
                    "txn_payload": txn_payload,
                    "csv_value": csv_val,
                })
                row_results.append({"row": row_num, "status": "duplicate"})
                reset_footer_detection()
                continue

            txn_id = _insert_imported_transaction(conn, batch_id, txn_payload)
            sync_rule_tags_for_transaction(conn, txn_id, rule_tag_ids)
            if parsed_date:
                for _rid in effect_rule_ids(rule_result, _rules_by_id, rule_tags_by_id):
                    if _rid not in _rule_effect_dates or parsed_date > _rule_effect_dates[_rid]:
                        _rule_effect_dates[_rid] = parsed_date
            if is_pending:
                existing_pending_rows[pending_match_key] = {"id": txn_id, "content_hash": content_hash}
            imported += 1
            row_results.append({"row": row_num, "status": "imported"})
            reset_footer_detection()

            batch_account_stats[csv_val]["count"] += 1

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

        bump_rule_effect_dates(conn, _rule_effect_dates)

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
        currency_rejected_count = len(currency_rows)
        validation_error_count = len(errors)
        rejected_rows = sorted(
            zero_amount_rows + currency_rows + validation_error_rows,
            key=lambda row: row.get("row") or 0,
        )[:20]
        import_summary = {
            "total_rows": imported + skipped + deduped,
            "imported_count": imported,
            "skipped_count": skipped,
            "deduped_count": deduped,
            "account_skipped_count": sum(skip_counts.values()),
            "zero_amount_count": zero_amount_count,
            "currency_rejected_count": currency_rejected_count,
            "validation_error_count": validation_error_count,
            "trailing_non_transaction_count": trailing_non_transaction_count,
            "rejected_count": zero_amount_count + currency_rejected_count + validation_error_count,
            "rejected_headers": headers,
            "rejected_rows": rejected_rows,
            "duplicate_headers": headers,
            "enriched_count": 0,
            "money_movement_suppressed_count": 0,
            "money_movement_unrecognized_types": [],
        }

        enriched_count = 0
        money_movement_suppressed_count = 0
        # If nothing was imported, remove the batch record entirely —
        # a zero-row import shouldn't appear in Recent imports
        if imported == 0 and deduped == 0:
            conn.execute("DELETE FROM import_batch WHERE id = ?", (batch_id,))
            batch_id = None
        else:
            save_batch_duplicate_rows(conn, batch_id, duplicate_rows)
            # Per-source auto-enrich: for a trusted source, fold each hard-rejected duplicate's novel
            # detail into the existing row it matched — silently, but reported. Only unambiguous rows are
            # touched and only a non-empty delta counts (so a re-import of the same file is a no-op).
            if enrich_from_source and duplicate_rows:
                auto_enriched, _auto_skipped = _enrich_duplicate_rows(
                    conn, batch_id, [int(entry.get("row") or 0) for entry in duplicate_rows]
                )
                enriched_count = len(auto_enriched)
            import_summary["enriched_count"] = enriched_count
            # Suppress wallet funding legs: a nameless deposit paired with its equal-and-opposite same-day
            # purchase (both rows this batch just imported) is money movement, not income — move the leg
            # into the excluded "Money movement" category and link it to the purchase. Always on; safe
            # because only an unambiguous structural 1:1 pair acts. See services/money_movement.py.
            money_movement = suppress_batch_funding_legs(conn, batch_id)
            money_movement_suppressed_count = len(money_movement["suppressed"])
            import_summary["money_movement_suppressed_count"] = money_movement_suppressed_count
            import_summary["money_movement_unrecognized_types"] = money_movement["unrecognized_types"]
            config_snapshot[IMPORT_SUMMARY_KEY] = import_summary
            save_batch_snapshot(conn, batch_id, config_snapshot)
            # A saved data source declares how many trailing days it lags its bank; a one-off file
            # import has no source and keeps the default of 1 (just the export day).
            source_terminal_window = DEFAULT_TERMINAL_WINDOW_DAYS
            if profile_id:
                profile_row = conn.execute(
                    "SELECT terminal_window_days FROM csv_import_profile WHERE id = ?", (profile_id,)
                ).fetchone()
                if profile_row and profile_row["terminal_window_days"]:
                    source_terminal_window = max(1, int(profile_row["terminal_window_days"]))
            for csv_val, info in batch_account_stats.items():
                coverage_start_date, coverage_end_date = compute_import_coverage_window(
                    info.get("coverage_dates"),
                    batch_terminal_date,
                    source_terminal_window,
                )
                terminal_date = batch_terminal_date
                conn.execute("""
                    INSERT OR REPLACE INTO import_batch_account
                      (batch_id, csv_value, account_id, row_count, was_skipped, coverage_start_date, coverage_end_date, terminal_date)
                    VALUES (?, ?, ?, ?, 0, ?, ?, ?)
                """, (batch_id, csv_val, info.get("account_id"), info.get("count", 0), coverage_start_date, coverage_end_date, terminal_date))
            for csv_val, row_ct in skip_counts.items():
                mapped_id = effective_map.get(csv_val)
                conn.execute("""
                    INSERT OR IGNORE INTO import_batch_account
                      (batch_id, csv_value, account_id, row_count, was_skipped, coverage_start_date, coverage_end_date, terminal_date)
                    VALUES (?, ?, ?, ?, 1, NULL, NULL, NULL)
                """, (batch_id, csv_val, mapped_id or None, row_ct))

        account_skipped = sum(skip_counts.values())

    # Cross-account soft-flag sweep — catches matches between this batch's rows and existing rows on
    # different accounts that the exact-content-hash dedup didn't see, and promotes the ones whose accounts
    # the user has already merged (so merge-then-import settles identically to import-then-merge).
    #
    # **After the import transaction, never inside it**: it is analysis across the whole ledger rather than
    # part of writing the rows, and reading that much inside the write transaction blocks every other writer
    # for as long as it takes (see `sweep_import_suspects`). No batch id means nothing was imported and
    # there is nothing to sweep. A caller that supplied its own connection (the demo loader) is importing
    # inside a transaction of its own that only it can end, so the sweep necessarily stays within it —
    # a one-shot bulk load, not a path the user runs into repeatedly.
    if batch_id:
        with (nullcontext(caller_conn) if caller_conn is not None else get_db()) as sweep_conn:
            sweep_import_suspects(sweep_conn, batch_id)

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
        "currency_rejected_count": currency_rejected_count,
        "validation_error_count": validation_error_count,
        "rejected_count":       zero_amount_count + currency_rejected_count + validation_error_count,
        "rejected_rows":        rejected_rows,
        "duplicate_count":      deduped,
        "enriched_count":       enriched_count,
        "money_movement_suppressed_count": money_movement_suppressed_count,
        "is_paypal":            sniff_paypal_activity(headers),
        "profile_id":           profile_id,
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


class MoneyMovementRulesRequest(BaseModel):
    add: list[str] = Field(default_factory=list)
    remove: list[str] = Field(default_factory=list)


@router.get("/batches/{batch_id}/money-movement-types")
def get_money_movement_types(batch_id: str):
    """The distinct captured `Type` values in a (PayPal) batch, with counts and a money-movement pre-flag,
    so the user can review which types to route to the excluded Money movement category."""
    with get_db() as conn:
        batch = conn.execute("SELECT id, filename FROM import_batch WHERE id = ?", (batch_id,)).fetchone()
        if not batch:
            raise HTTPException(status_code=404, detail="Batch not found")
        return {
            "batch_id": batch_id,
            "filename": batch["filename"],
            "proposals": money_movement_type_proposals(conn, batch_id),
        }


def _recategorize_after_money_movement_change(conn, *, created: int, deleted: int) -> int:
    """Recategorize after adding/removing money-movement `Type` rules. Because `recategorize_all` now
    *retains* a category when no rule matches, removing a type would otherwise strand its rows in the
    excluded "Money movement" category. So a removal triggers a **scoped reconcile** over just the Money
    movement leaf's rows: the ones still matching a surviving type stay, the removed ones fall back out —
    without disturbing any other rule-categorized row. The following retain pass then applies any newly
    added types to their matching rows. Returns the retain pass's changed-row count."""
    if not (created or deleted):
        return 0
    if deleted:
        mm_leaf = money_movement_category_id_if_exists(conn)
        if mm_leaf:
            ids = [
                r["id"] for r in conn.execute(
                    "SELECT id FROM txn WHERE category_id = ? AND category_overridden = 0", (mm_leaf,)
                ).fetchall()
            ]
            recategorize_all(conn, txn_ids=ids, retain_unmatched=False)
    return recategorize_all(conn)


@router.post("/batches/{batch_id}/money-movement-rules")
def apply_money_movement_rules(batch_id: str, body: MoneyMovementRulesRequest):
    """Add and/or remove money-movement rules (scoped to the PayPal account *type*) for the given `Type`
    values, then recategorize so this batch and existing rows update. `add` creates the routing to Money
    movement; `remove` deletes it (the "changed my mind" path)."""
    with get_db() as conn:
        batch = conn.execute("SELECT id FROM import_batch WHERE id = ?", (batch_id,)).fetchone()
        if not batch:
            raise HTTPException(status_code=404, detail="Batch not found")
        # Approving PayPal money-movement types declares the batch's accounts PayPal, so type them (when
        # generic) — the now-type-scoped rules match by account type.
        if body.add:
            ensure_paypal_account_type(conn, batch_account_ids(conn, batch_id))
        created = create_money_movement_rules(conn, body.add)
        deleted = delete_money_movement_rules(conn, body.remove)
        recategorized = _recategorize_after_money_movement_change(conn, created=created, deleted=deleted)
    return {"created": created, "deleted": deleted, "recategorized": recategorized}


@router.get("/profiles/{profile_id}/money-movement-types")
def get_profile_money_movement_types(profile_id: str):
    """The distinct captured `Type` values across a data source's imports (source-level review) — the one
    surface for all its money-movement types, each with count + money-movement + already_ruled flags."""
    with get_db() as conn:
        profile = conn.execute("SELECT id, name FROM csv_import_profile WHERE id = ?", (profile_id,)).fetchone()
        if not profile:
            raise HTTPException(status_code=404, detail="Data source not found")
        return {
            "profile_id": profile_id,
            "name": profile["name"],
            "proposals": money_movement_type_proposals_for_profile(conn, profile_id),
            # The source's accounts — so a per-Type drill-down report can scope its transaction fetch to
            # exactly the rows the count reflects (same scope as _type_row_counts_for_accounts). Group
            # roots, not stored ids: a merged PayPal account keeps its rows under the child id, and the
            # `account_ids` filter compares against the resolved row side, so the raw id matched nothing
            # and the report came back empty under a non-zero count.
            "account_ids": profile_effective_account_ids(conn, profile_id),
        }


@router.post("/profiles/{profile_id}/money-movement-rules")
def apply_profile_money_movement_rules(profile_id: str, body: MoneyMovementRulesRequest):
    """Add/remove money-movement rules for a data source's `Type` values, scoped to the PayPal account
    type, then recategorize."""
    with get_db() as conn:
        profile = conn.execute("SELECT id FROM csv_import_profile WHERE id = ?", (profile_id,)).fetchone()
        if not profile:
            raise HTTPException(status_code=404, detail="Data source not found")
        # Approving PayPal money-movement types declares the source's accounts PayPal, so type them (when
        # generic) — the now-type-scoped rules match by account type.
        if body.add:
            ensure_paypal_account_type(conn, profile_account_ids(conn, profile_id))
        created = create_money_movement_rules(conn, body.add)
        deleted = delete_money_movement_rules(conn, body.remove)
        recategorized = _recategorize_after_money_movement_change(conn, created=created, deleted=deleted)
    return {"created": created, "deleted": deleted, "recategorized": recategorized}


# Combined view of duplicate decisions made for this batch — both the hard-rejects that never
# entered the ledger (from `import_batch_duplicate`) and the soft-flagged rows that landed in the
# ledger with `suspect_duplicate_of` set. The shape is uniform across the two pools so the file
# card can render a single unified report. See `backend/services/duplicate_detection.py` for the
# rule/confidence classification.
@router.get("/batches/{batch_id}/duplicates-unified")
def get_batch_duplicates_unified(batch_id: str):
    with get_db() as conn:
        batch = conn.execute(
            "SELECT id, filename FROM import_batch WHERE id = ?",
            (batch_id,),
        ).fetchone()
        if not batch:
            raise HTTPException(status_code=404, detail="Batch not found")

        # Fill in explanations the import couldn't produce, before rendering. The report replays a
        # stored verdict, so a coverage reject that named no twin at import time would otherwise show
        # "no specific match" forever — even once the candidate lookup improves, or once a later import
        # brings in the twin. Costs one cheap query when there is nothing to fill in, which is the
        # normal case; it only ever adds a candidate to an entry that had none.
        refresh_unexplained_coverage_candidates(conn, batch_id)
        entries = list_unified_batch_duplicates(conn, batch_id)
        hard = sum(1 for e in entries if e["kind"] == "hard_reject")
        soft = sum(1 for e in entries if e["kind"] == "soft_flag")
        # Per-rule rollup so the UI can show a clickable breakdown of which rules contributed
        # how many entries. Each item carries the rule_key, the human label, the confidence
        # band, and the count. Order is by descending count so the dominant rules surface first.
        rule_counts: dict[str, dict] = {}
        for e in entries:
            key = e.get("rule_key") or "other_hard"
            if key not in rule_counts:
                rule_counts[key] = {
                    "rule_key": key,
                    "rule_label": e.get("rule_label") or key,
                    "rule_description": e.get("rule_description") or "",
                    "confidence": e.get("confidence") or "medium",
                    "kind": e.get("kind"),
                    "count": 0,
                }
            rule_counts[key]["count"] += 1
        rule_breakdown = sorted(rule_counts.values(), key=lambda r: (-r["count"], r["rule_key"]))
        return {
            "batch_id": batch_id,
            "filename": batch["filename"],
            "entries": entries,
            "hard_reject_count": hard,
            "soft_flag_count": soft,
            "total_count": len(entries),
            "rule_breakdown": rule_breakdown,
            # The account pairs the unresolved cross-account flags span. A pile of flags between one pair
            # is one question — are these the same account? — and answering it settles all of them, so
            # the report offers that instead of asking the user to work through the pile a row at a time.
            "account_pairs": unresolved_account_pairs(conn, batch_id),
        }


# Rows this batch imported that were later removed as confirmed duplicates — via the duplicate
# report's Reject/Replace or an account merge. The file-scoped ledger drawer surfaces these as an
# audit trail ("removed → kept on <account>") instead of dropping them silently: a Replace done
# from another file's report trashes THIS file's matching row, which would otherwise just vanish
# from the file view. The surviving row is resolved through `suspect_duplicate_of`.
@router.get("/batches/{batch_id}/deduped-rows")
def get_batch_deduped_rows(batch_id: str):
    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT
                t.id, t.date, t.amount,
                COALESCE(NULLIF(t.display_name,''), NULLIF(t.merchant_name,''), NULLIF(t.raw_name,'')) AS merchant,
                t.dedupe_resolved_by AS resolved_by,
                s.id                 AS surviving_id,
                sa.name              AS surviving_account_name,
                COALESCE(NULLIF(sap.display_name,''), sap.name) AS surviving_account_merged_into
            FROM   txn t
            LEFT JOIN txn     s   ON s.id = t.suspect_duplicate_of
            LEFT JOIN account sa  ON sa.id = s.account_id
            LEFT JOIN account sap ON sap.id = sa.parent_account_id
            WHERE  t.import_batch_id = ?
              AND  t.trashed_at IS NOT NULL
              AND  t.rejection_reason = 'duplicate_confirmed'
            ORDER  BY t.date DESC, t.id
            """,
            (batch_id,),
        ).fetchall()
    return {"batch_id": batch_id, "rows": [dict(r) for r in rows], "count": len(rows)}


@router.post("/batches/{batch_id}/duplicates/mark-reviewed")
def mark_batch_duplicates_reviewed(batch_id: str, body: BatchDuplicateReviewRequest):
    """Acknowledge (or un-acknowledge) advisory hard-reject rows. Sets/clears `reviewed_at` on the
    given `import_batch_duplicate` rows so they leave (or rejoin) the duplicate report's
    needs-attention count. Does not change the rejection itself — the rows stay un-imported."""
    row_numbers = [int(n) for n in (body.row_numbers or [])]
    if not row_numbers:
        return {"updated": 0}
    placeholders = ",".join("?" * len(row_numbers))
    reviewed_value = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')" if body.reviewed else "NULL"
    with get_db() as conn:
        cursor = conn.execute(
            f"""
            UPDATE import_batch_duplicate
            SET    reviewed_at = {reviewed_value}
            WHERE  batch_id = ?
              AND  row_number IN ({placeholders})
            """,
            [batch_id, *row_numbers],
        )
    return {"updated": cursor.rowcount or 0, "reviewed": body.reviewed}


def _duplicate_match_txn_id(matched: dict) -> tuple[Optional[str], Optional[str]]:
    """The single existing transaction a duplicate matched, if unambiguous. Handles both shapes: a
    coverage reject carries `candidates` (enrichable only when exactly one), a terminal/exact reject
    carries the matched transaction directly. Returns (txn_id, None) or (None, skip_reason).

    A **transfer counterpart** is never the answer, however unambiguous. The coverage lookup names the
    other leg of a movement (`cross_account` without `payment_match` — a wallet's funding deposit against
    the bank or card withdrawal that paid it) so the report can explain the rejection, but that row is a
    different transaction: enriching it stamps one side's source detail onto the other, which is how a
    wallet's "General Card Deposit" and "General Currency Conversion" types came to sit on a credit-card
    charge. A payment match is the same outflow seen from a second account, so it stays enrichable."""
    candidates = matched.get("candidates")
    if isinstance(candidates, list):
        if len(candidates) == 1 and (candidates[0] or {}).get("id"):
            only = candidates[0]
            if only.get("cross_account") and not only.get("payment_match"):
                return None, "transfer counterpart"
            return only["id"], None
        return None, ("ambiguous match" if candidates else "no matched transaction")
    if matched.get("id"):
        return matched["id"], None
    return None, "no matched transaction"


def _duplicate_match_txn_ids(matched: dict) -> list[str]:
    """Every existing transaction a duplicate row was rejected against.

    The plural is the point, and it is why this is not `_duplicate_match_txn_id` above: that one answers
    "is there exactly one row to enrich", so it deliberately gives up on an ambiguous match. Here an
    ambiguous match means the user overruled the rejection against *all* of the candidates it named, and
    every one of those pairs is a settled question.
    """
    candidates = matched.get("candidates")
    if isinstance(candidates, list):
        return [c["id"] for c in candidates if isinstance(c, dict) and c.get("id")]
    return [matched["id"]] if matched.get("id") else []


def _enrich_duplicate_rows(conn, batch_id: str, row_numbers: list[int]) -> tuple[list[dict], list[dict]]:
    """Fold each given duplicate row's incoming detail into the existing transaction it matched. Only
    unambiguous rows are touched — a row with exactly one matched candidate; rows with no match (nothing
    to enrich) or several (the user must pick) are reported as skipped. Additive and reversible: it only
    appends novel detail to the existing row's evidence (see `import_enrichment`), recorded per row for
    undo. Shared by the manual endpoint and the per-source auto-enrich in the import path."""
    enriched, skipped = [], []
    for row_number in row_numbers:
        dup = conn.execute(
            "SELECT matched_transaction_json, enriched_at FROM import_batch_duplicate WHERE batch_id = ? AND row_number = ?",
            (batch_id, row_number),
        ).fetchone()
        if dup is None:
            skipped.append({"row": row_number, "reason": "not found"})
            continue
        if dup["enriched_at"]:
            skipped.append({"row": row_number, "reason": "already enriched"})
            continue
        txn_id, skip_reason = _duplicate_match_txn_id(safe_json_dict(dup["matched_transaction_json"]))
        if not txn_id:
            skipped.append({"row": row_number, "reason": skip_reason})
            continue
        delta = enrich_duplicate_row(conn, batch_id, row_number, txn_id)
        if delta:
            enriched.append({"row": row_number, "txn_id": txn_id, "added": delta})
        else:
            skipped.append({"row": row_number, "reason": "no new detail"})
    return enriched, skipped


@router.post("/batches/{batch_id}/duplicates/enrich")
def enrich_batch_duplicates(batch_id: str, body: BatchDuplicateEnrichRequest):
    """Fold the given duplicate rows' incoming detail into the transactions they matched (manual action
    from the duplicate report). Omitting ``row_numbers`` means the batch's *entire* duplicate set — the
    file card's "Enrich existing transactions from this source" toggle; idempotent, since already-enriched
    / unmatched / nothing-new rows are skipped. Returns what was folded in and what was skipped and why."""
    row_numbers = [int(n) for n in (body.row_numbers or [])]
    with get_db() as conn:
        if not row_numbers:
            row_numbers = [r["row_number"] for r in conn.execute(
                "SELECT row_number FROM import_batch_duplicate WHERE batch_id = ?", (batch_id,)
            ).fetchall()]
        enriched, skipped = _enrich_duplicate_rows(conn, batch_id, row_numbers)
    return {"enriched": enriched, "skipped": skipped}


@router.post("/batches/{batch_id}/duplicates/enrich/undo")
def undo_batch_duplicate_enrichment_endpoint(batch_id: str, body: BatchDuplicateEnrichRequest):
    """Reverse a prior enrich on the given duplicate rows — remove exactly the detail that was folded in
    and clear the enriched marker. Omitting ``row_numbers`` reverses every enriched row of the batch
    (the file card toggle switching off)."""
    row_numbers = [int(n) for n in (body.row_numbers or [])]
    undone = 0
    with get_db() as conn:
        if not row_numbers:
            row_numbers = [r["row_number"] for r in conn.execute(
                "SELECT row_number FROM import_batch_duplicate WHERE batch_id = ? AND enriched_at IS NOT NULL",
                (batch_id,),
            ).fetchall()]
        for row_number in row_numbers:
            if undo_duplicate_enrichment(conn, batch_id, row_number):
                undone += 1
    return {"undone": undone}


@router.post("/batches/{batch_id}/mark-reviewed")
def mark_batch_reviewed(batch_id: str):
    """Clear the needs-review flag on every still-flagged transaction in this batch — the one-click
    "I've looked these over (or don't need to)" for a whole import card — a file, or a data connection's
    initial or monthly sync card, since synced rows carry the card's `import_batch_id` too. The per-card
    counterpart to bulk Mark reviewed on the Transactions filter. It clears only the rows flagged now, so
    a sync card's count returns when later rows land on it."""
    with get_db() as conn:
        cursor = conn.execute(
            "UPDATE txn SET needs_review = 0 WHERE import_batch_id = ? AND needs_review = 1",
            (batch_id,),
        )
    return {"updated": cursor.rowcount or 0}


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
        imported_ids: list[str] = []   # scopes the post-commit duplicate sweep to what this call added
        # (forced row, the existing row it was rejected against) — the pairs the user has just overruled,
        # which the sweep below must not put back in front of them as review work.
        settled_pairs: set[tuple[str, str]] = set()
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
            txn_id = _insert_imported_transaction(conn, batch_id, payload)
            imported_ids.append(txn_id)
            settled_pairs.update(
                (txn_id, existing_id)
                for existing_id in _duplicate_match_txn_ids(entry.get("matched_transaction") or {})
            )
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

    # The same soft-duplicate sweep the main import path runs, so user-driven "force import these
    # duplicates" rows are cross-checked against unrelated accounts too — after the transaction above has
    # committed, for the reason given on `sweep_import_suspects`, and told exactly the rows this call
    # inserted. Scoping matters more here than anywhere: this endpoint adds to a batch that has already
    # been imported and already been swept, so a whole-batch sweep would re-examine every row of it to
    # check the few just forced in.
    #
    # Two deliberate narrowings, both about not re-litigating what the user just decided.
    #
    # `mark_import_suspects` rather than the full `sweep_import_suspects`, because the promotion half
    # **trashes** what it promotes (`trashed_at` + `rejection_reason='duplicate_confirmed'`) and promotes
    # same-account pairs as readily as cross-account ones. A forced row is byte-identical to the row it was
    # rejected against and lands on the same account from a different batch — precisely the shape it
    # promotes — so running it here would trash the rows the user just insisted on importing, in the same
    # request that imported them.
    #
    # And `exclude_pairs`, so the sweep does not hand back the very pair "import anyway" answered. The
    # pair, not the row: a forced row is an ordinary transaction that may duplicate something *else*, and
    # this is its only backward look at what already existed.
    if imported_ids:
        with get_db() as conn:
            mark_import_suspects(conn, batch_id, txn_ids=imported_ids, exclude_pairs=settled_pairs)

    return {
        "batch_id": batch_id,
        "imported_count": imported_now,
        "remaining_duplicate_count": len(remaining_rows),
        "not_importable_count": not_importable_count,
    }

@router.get("/batches")
def list_batches():
    with get_db() as conn:
        # Recent window feeding the best-effort reconcile below ONLY — deliberately capped. The reconcile
        # writes per batch on every load, so running it over all history would rewrite every batch on each
        # call and worsen lock contention; the newest imports are where stale batch-account rows actually
        # arise. This cap does NOT bound the returned history (that query is unbounded, see below).
        batch_rows = conn.execute("""
            SELECT b.id
            FROM   import_batch b
            WHERE  b.status = 'completed'
            ORDER  BY b.imported_at DESC
            LIMIT  50
        """).fetchall()
        # Best-effort cleanup of stale batch-account rows. It writes, but this is a read endpoint, so a
        # transient "database is locked" (another request mid-write) must not fail the whole listing — the
        # next call reconciles. See the manage-sources refetch-loop fix that made this contention possible.
        try:
            _reconcile_batch_history(conn, [row["id"] for row in batch_rows])
        except sqlite3.OperationalError as exc:
            log_warning(f"[import] batch-history reconcile skipped (transient): {exc}")
        # Full completed history, unbounded. A prior global `LIMIT 50` here silently dropped older imports
        # — and because the cap was global-most-recent, an actively-fed source could push another source's
        # cards (and their Undo/rename/review affordances) entirely out of the window with no indication.
        # Cardinality is one row per imported *file* (not per transaction), so returning all of them is
        # tolerable in the interim. The real bound belongs per-source with a reachable "Older imports"
        # archive — see docs/backlog/import-history-windowing.md — which will reintroduce paging here.
        batches = conn.execute("""
            SELECT b.id, b.profile_id, b.filename, b.file_content_hash, b.imported_at, b.row_count, b.skipped_count,
                   b.deduped_count, b.status, b.use_imported_categories, b.config_snapshot, b.source_kind,
                   b.connection_id, p.name AS profile_name,
                   -- Connection provenance for data-source (sync) cards: the provider disambiguates two
                   -- connections at the same institution (e.g. one "Northgate" via Plaid, another via a
                   -- different provider), and institution is the stable label the group header shows.
                   -- The card's own provider stands in once the connection is removed.
                   COALESCE(conn.provider, b.provider) AS connection_provider,
                   conn.institution AS connection_institution,
                   EXISTS(
                       SELECT 1
                       FROM   txn t
                       WHERE  t.import_batch_id = b.id
                         AND  t.imported_category IS NOT NULL
                         AND  TRIM(t.imported_category) <> ''
                   ) AS has_imported_categories
            FROM   import_batch b
            LEFT JOIN csv_import_profile p ON p.id = b.profile_id
            LEFT JOIN connection conn ON conn.id = b.connection_id
            WHERE  b.status = 'completed'
            ORDER  BY b.imported_at DESC
        """).fetchall()

        # Lazy import: amazon.py imports from this module, so a top-level import would be circular.
        from .amazon import BATCH_SOURCE_KIND, reconciliation_attention_count, unmatched_parked_order_count

        result = []
        for b in batches:
            d = dict(b)
            d.pop("config_snapshot", None)
            snapshot = safe_json_dict(b["config_snapshot"])
            # Surfaced so the client can tell whether a profileless batch's file shape actually
            # matches a data source before auto-attaching it (Save as data source guard).
            d["header_fingerprint"] = snapshot.get("header_fingerprint") or None
            review_state = get_rule_suggestion_review_state(snapshot)
            summary = review_state.get("summary")
            if not isinstance(summary, dict):
                summary = summarize_rule_suggestion_review(review_state)

            d["has_imported_categories"] = bool(d.get("has_imported_categories"))
            d["use_imported_categories"] = bool(d.get("use_imported_categories"))
            d = _annotate_imported_category_settings(d, _get_imported_category_settings(snapshot))
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
            d["single_account_new"] = safe_json_dict(snapshot.get("single_account_new"))

            accs = conn.execute("""
                SELECT iba.csv_value, iba.account_id, iba.row_count, iba.was_skipped,
                       COALESCE(a.name, a.display_name, iba.csv_value) AS account_name
                FROM   import_batch_account iba
                LEFT JOIN account a ON a.id = iba.account_id
                WHERE  iba.batch_id = ?
                ORDER BY iba.was_skipped, iba.csv_value
            """, (b["id"],)).fetchall()
            d["accounts"] = [dict(a) for a in accs]
            # Enrich-on-duplicate state for the file card's "Enrich existing transactions from this
            # source" toggle: how many duplicate rows the batch recorded, and how many have folded
            # their detail into the transaction they matched.
            dup_counts = conn.execute("""
                SELECT COUNT(*) AS total,
                       COALESCE(SUM(CASE WHEN enriched_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS enriched
                FROM   import_batch_duplicate
                WHERE  batch_id = ?
            """, (b["id"],)).fetchone()
            d["duplicate_row_count"] = int(dup_counts["total"] or 0)
            d["enriched_duplicate_count"] = int(dup_counts["enriched"] or 0)
            d["suspect_duplicate_count"] = int(conn.execute("""
                SELECT COUNT(*) AS n
                FROM   txn
                WHERE  import_batch_id = ?
                  AND  suspect_duplicate_of IS NOT NULL
                  AND  suspect_resolved_at  IS NULL
                  AND  trashed_at           IS NULL
            """, (b["id"],)).fetchone()["n"] or 0)
            d["needs_review_count"] = int(conn.execute("""
                SELECT COUNT(*) AS n
                FROM   txn
                WHERE  import_batch_id = ?
                  AND  needs_review = 1
                  AND  trashed_at    IS NULL
            """, (b["id"],)).fetchone()["n"] or 0)
            # Amazon marketplace batches carry an actionable-reconciliation count (a duplicate to merge, or a
            # split suggestion to accept/dismiss) so the card can warn without opening the report.
            if d.get("source_kind") == BATCH_SOURCE_KIND:
                d["recon_attention_count"] = reconciliation_attention_count(conn, b["id"])
                # Live "still waiting for its orders file" count for an items-before-orders card, so its
                # "no match" pill resolves to zero once a later orders import attaches the parked items.
                d["unmatched_item_count"] = unmatched_parked_order_count(conn, d.get("import_summary"))
                # Newest transaction date the card covers, so the history can order marketplace cards by
                # data recency (most recent first) rather than import time — a multi-year historical drop
                # then reads the way it would have if each year had been imported as it happened. Falls back
                # to the newest date among an orphan items-only card's still-waiting rows (it has no txns).
                newest = conn.execute(
                    "SELECT MAX(date) AS d FROM txn WHERE import_batch_id = ? AND trashed_at IS NULL", (b["id"],)
                ).fetchone()["d"]
                if not newest:
                    dates = [x.get("date") for x in (d.get("import_summary") or {}).get("discarded_items") or []
                             if isinstance(x, dict) and x.get("date")]
                    newest = max(dates) if dates else None
                d["newest_txn_date"] = newest
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
                SET    category_id = ?, category_overridden = 1, category_source = 'manual'
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
                SELECT id, owner_id, account_id, amount, merchant_name, display_name, raw_name, import_evidence_json
                FROM   txn
                WHERE  import_batch_id = ?
                  AND  category_id IS NULL
                  AND  category_overridden = 0
            """, (batch_id,)).fetchall()
            rules = load_categorization_rules(conn)
            rule_tags_by_id = load_rule_tags_by_id(conn)
            needs_source_text = any(rule["match_source_text"] for rule in rules)
            for row in uncategorized_rows:
                source_text = source_match_text_from_json(row["import_evidence_json"]) if needs_source_text else None
                result = categorize_transaction(
                    row["merchant_name"] or row["raw_name"] or "",
                    row["raw_name"] or row["merchant_name"] or "",
                    row["display_name"] or row["merchant_name"] or row["raw_name"] or "",
                    row["amount"],
                    conn,
                    owner_id=row["owner_id"],
                    account_id=row["account_id"],
                    rules=rules,
                    rule_tags_by_id=rule_tags_by_id,
                    source_text=source_text,
                )
                cat_id = result["category_id"] if isinstance(result, dict) else result
                rule_tag_ids = result.get("tag_ids", []) if isinstance(result, dict) else []
                if cat_id:
                    conn.execute(
                        "UPDATE txn SET category_id = ?, category_source = 'rule' WHERE id = ?",
                        (cat_id, row["id"]),
                    )
                    categorized_by_rules += 1
                sync_rule_tags_for_transaction(conn, row["id"], rule_tag_ids)
            stamp_batch_rule_effects(conn, batch_id)

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
        auto_discarded_suggestion_ids: list[str] = []
        old_entry = dict(suggestion_entries.get(body.suggestion_id) or {})
        if status == "pending":
            _remove_pending_derived_rule_suggestions(review_state, body.suggestion_id)
        suggestion_entries = dict(review_state.get("suggestions") or {})
        suggestion_entries.setdefault(body.suggestion_id, {})

        if body.merchant_label:
            suggestion_entries[body.suggestion_id]["merchant_label"] = body.merchant_label
        if body.target_category_name:
            suggestion_entries[body.suggestion_id]["target_category_name"] = body.target_category_name
        if body.target_category_id is not None:
            suggestion_entries[body.suggestion_id]["target_category_id"] = body.target_category_id
        if body.keyword is not None:
            suggestion_entries[body.suggestion_id]["keyword"] = normalize_rule_keyword(body.keyword)
        # Use model_fields_set so an explicit null clears the field (generalizing a rule by removing its
        # owner/account). Without this an explicit "clear to none" was dropped and the suggestion kept
        # its old scope even though the created rule was generalized.
        if body.owner_id is not None or "owner_id" in body.model_fields_set:
            suggestion_entries[body.suggestion_id]["owner_id"] = body.owner_id or None
        if body.account_id is not None or "account_id" in body.model_fields_set:
            suggestion_entries[body.suggestion_id]["account_id"] = body.account_id or None
        if body.amount_min is not None or "amount_min" in body.model_fields_set:
            suggestion_entries[body.suggestion_id]["amount_min"] = body.amount_min
        if body.amount_max is not None or "amount_max" in body.model_fields_set:
            suggestion_entries[body.suggestion_id]["amount_max"] = body.amount_max
        if body.clean_name_suggestion is not None or "clean_name_suggestion" in body.model_fields_set:
            suggestion_entries[body.suggestion_id]["clean_name_suggestion"] = body.clean_name_suggestion
        if body.match_source_text is not None or "match_source_text" in body.model_fields_set:
            suggestion_entries[body.suggestion_id]["match_source_text"] = bool(body.match_source_text)
        if body.latest_txn_date is not None or "latest_txn_date" in body.model_fields_set:
            suggestion_entries[body.suggestion_id]["latest_txn_date"] = body.latest_txn_date
        if body.txn_count is not None or "txn_count" in body.model_fields_set:
            suggestion_entries[body.suggestion_id]["txn_count"] = body.txn_count
        if body.source_row_ids is not None or "source_row_ids" in body.model_fields_set:
            suggestion_entries[body.suggestion_id]["source_row_ids"] = sorted({
                str(value) for value in (body.source_row_ids or []) if str(value).strip()
            })
        if body.review_action is not None or "review_action" in body.model_fields_set:
            if isinstance(body.review_action, dict):
                suggestion_entries[body.suggestion_id]["review_action"] = body.review_action
            else:
                suggestion_entries[body.suggestion_id].pop("review_action", None)

        statuses = dict(review_state.get("statuses") or {})
        synthetic_entries: list[dict] = []
        if status == "pending":
            statuses.pop(body.suggestion_id, None)
        else:
            next_status = {
                "status": status,
                "updated_at": utcnow_iso(),
            }
            if body.rule_id:
                next_status["rule_id"] = body.rule_id
            if body.created_rule_id:
                next_status["created_rule_id"] = body.created_rule_id
            if body.accepted_prior_rows is not None or "accepted_prior_rows" in body.model_fields_set:
                next_status["accepted_prior_rows"] = list(body.accepted_prior_rows or [])
            if body.review_action is not None or "review_action" in body.model_fields_set:
                next_status["review_action"] = body.review_action if isinstance(body.review_action, dict) else None
            statuses[body.suggestion_id] = next_status
            review_state["statuses"] = statuses
            if status == "accepted":
                auto_discarded_suggestion_ids = _discard_covered_rule_suggestions(
                    review_state,
                    body.suggestion_id,
                    suggestion_entries[body.suggestion_id],
                )
                statuses = dict(review_state.get("statuses") or {})
                rows = _query_rule_suggestion_rows(conn, batch_id=batch_id)
                if (
                    old_entry
                    and old_entry.get("source_row_ids")
                    and _rule_suggestion_entry_covers(old_entry, suggestion_entries[body.suggestion_id], allow_equal_keyword=True)
                    and not _rule_suggestion_entry_covers(suggestion_entries[body.suggestion_id], old_entry, allow_equal_keyword=True)
                ):
                    synthetic_entries = _build_synthetic_rule_suggestion_entries(
                        conn,
                        review_state,
                        body.suggestion_id,
                        suggestion_entries[body.suggestion_id],
                        [dict(row) for row in rows],
                    )

        review_state["suggestions"] = suggestion_entries
        review_state["statuses"] = statuses
        if synthetic_entries:
            for entry in synthetic_entries:
                suggestion_id = entry.pop("id")
                review_state["suggestions"][suggestion_id] = entry
        _prune_phantom_rule_suggestion_entry(review_state, body.suggestion_id, status)
        review_summary = summarize_rule_suggestion_review(review_state)
        snapshot[RULE_SUGGESTION_REVIEW_KEY] = review_state
        save_batch_snapshot(conn, batch_id, snapshot)

    return {
        "ok": True,
        "review_summary": review_summary,
        "trash_sets": _public_rule_suggestion_trash_sets(review_state),
        "generated_at": review_state.get("generated_at"),
        "auto_discarded_suggestion_ids": auto_discarded_suggestion_ids,
    }


@router.post("/batches/{batch_id}/rule-suggestions/clear")
def clear_batch_rule_suggestions(batch_id: str, body: RuleSuggestionClearRequest):
    with get_db() as conn:
        batch = conn.execute(
            "SELECT id, config_snapshot FROM import_batch WHERE id = ?",
            (batch_id,),
        ).fetchone()
        if not batch:
            raise HTTPException(status_code=404, detail="Batch not found")
        snapshot = safe_json_dict(batch["config_snapshot"])
        review_state = get_rule_suggestion_review_state(snapshot)
        result = _clear_rule_suggestion_review_status(review_state, body.status, body.suggestion_ids)
        snapshot[RULE_SUGGESTION_REVIEW_KEY] = review_state
        save_batch_snapshot(conn, batch_id, snapshot)
    return result


@router.post("/batches/{batch_id}/rule-suggestions/trash/{trash_set_id}/restore")
def restore_batch_rule_suggestion_trash_set(batch_id: str, trash_set_id: str):
    with get_db() as conn:
        batch = conn.execute(
            "SELECT id, config_snapshot FROM import_batch WHERE id = ?",
            (batch_id,),
        ).fetchone()
        if not batch:
            raise HTTPException(status_code=404, detail="Batch not found")
        snapshot = safe_json_dict(batch["config_snapshot"])
        review_state = get_rule_suggestion_review_state(snapshot)
        result = _restore_rule_suggestion_trash_set(review_state, trash_set_id)
        snapshot[RULE_SUGGESTION_REVIEW_KEY] = review_state
        save_batch_snapshot(conn, batch_id, snapshot)
    return result


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
        auto_discarded_suggestion_ids: list[str] = []
        old_entry = dict(suggestion_entries.get(body.suggestion_id) or {})
        if status == "pending":
            _remove_pending_derived_rule_suggestions(review_state, body.suggestion_id)
        suggestion_entries = dict(review_state.get("suggestions") or {})
        suggestion_entries.setdefault(body.suggestion_id, {})

        if body.merchant_label:
            suggestion_entries[body.suggestion_id]["merchant_label"] = body.merchant_label
        if body.target_category_name:
            suggestion_entries[body.suggestion_id]["target_category_name"] = body.target_category_name
        if body.target_category_id is not None:
            suggestion_entries[body.suggestion_id]["target_category_id"] = body.target_category_id
        if body.keyword is not None:
            suggestion_entries[body.suggestion_id]["keyword"] = normalize_rule_keyword(body.keyword)
        # Use model_fields_set so an explicit null clears the field (generalizing a rule by removing its
        # owner/account). Without this an explicit "clear to none" was dropped and the suggestion kept
        # its old scope even though the created rule was generalized.
        if body.owner_id is not None or "owner_id" in body.model_fields_set:
            suggestion_entries[body.suggestion_id]["owner_id"] = body.owner_id or None
        if body.account_id is not None or "account_id" in body.model_fields_set:
            suggestion_entries[body.suggestion_id]["account_id"] = body.account_id or None
        if body.amount_min is not None or "amount_min" in body.model_fields_set:
            suggestion_entries[body.suggestion_id]["amount_min"] = body.amount_min
        if body.amount_max is not None or "amount_max" in body.model_fields_set:
            suggestion_entries[body.suggestion_id]["amount_max"] = body.amount_max
        if body.clean_name_suggestion is not None or "clean_name_suggestion" in body.model_fields_set:
            suggestion_entries[body.suggestion_id]["clean_name_suggestion"] = body.clean_name_suggestion
        if body.match_source_text is not None or "match_source_text" in body.model_fields_set:
            suggestion_entries[body.suggestion_id]["match_source_text"] = bool(body.match_source_text)
        if body.latest_txn_date is not None or "latest_txn_date" in body.model_fields_set:
            suggestion_entries[body.suggestion_id]["latest_txn_date"] = body.latest_txn_date
        if body.txn_count is not None or "txn_count" in body.model_fields_set:
            suggestion_entries[body.suggestion_id]["txn_count"] = body.txn_count
        if body.source_row_ids is not None or "source_row_ids" in body.model_fields_set:
            suggestion_entries[body.suggestion_id]["source_row_ids"] = sorted({
                str(value) for value in (body.source_row_ids or []) if str(value).strip()
            })
        if body.review_action is not None or "review_action" in body.model_fields_set:
            if isinstance(body.review_action, dict):
                suggestion_entries[body.suggestion_id]["review_action"] = body.review_action
            else:
                suggestion_entries[body.suggestion_id].pop("review_action", None)

        statuses = dict(review_state.get("statuses") or {})
        synthetic_entries: list[dict] = []
        if status == "pending":
            statuses.pop(body.suggestion_id, None)
        else:
            next_status = {
                "status": status,
                "updated_at": utcnow_iso(),
            }
            if body.rule_id:
                next_status["rule_id"] = body.rule_id
            if body.created_rule_id:
                next_status["created_rule_id"] = body.created_rule_id
            if body.accepted_prior_rows is not None or "accepted_prior_rows" in body.model_fields_set:
                next_status["accepted_prior_rows"] = list(body.accepted_prior_rows or [])
            if body.review_action is not None or "review_action" in body.model_fields_set:
                next_status["review_action"] = body.review_action if isinstance(body.review_action, dict) else None
            statuses[body.suggestion_id] = next_status
            review_state["statuses"] = statuses
            if status == "accepted":
                auto_discarded_suggestion_ids = _discard_covered_rule_suggestions(
                    review_state,
                    body.suggestion_id,
                    suggestion_entries[body.suggestion_id],
                )
                statuses = dict(review_state.get("statuses") or {})
                rows = _query_rule_suggestion_rows(conn, profile_id=profile_id)
                if (
                    old_entry
                    and old_entry.get("source_row_ids")
                    and _rule_suggestion_entry_covers(old_entry, suggestion_entries[body.suggestion_id], allow_equal_keyword=True)
                    and not _rule_suggestion_entry_covers(suggestion_entries[body.suggestion_id], old_entry, allow_equal_keyword=True)
                ):
                    synthetic_entries = _build_synthetic_rule_suggestion_entries(
                        conn,
                        review_state,
                        body.suggestion_id,
                        suggestion_entries[body.suggestion_id],
                        [dict(row) for row in rows],
                    )

        review_state["suggestions"] = suggestion_entries
        review_state["statuses"] = statuses
        if synthetic_entries:
            for entry in synthetic_entries:
                suggestion_id = entry.pop("id")
                review_state["suggestions"][suggestion_id] = entry
        _prune_phantom_rule_suggestion_entry(review_state, body.suggestion_id, status)
        review_summary = summarize_rule_suggestion_review(review_state)
        column_map[RULE_SUGGESTION_REVIEW_KEY] = review_state
        _save_profile_column_map(conn, profile_id, column_map)

    return {
        "ok": True,
        "review_summary": review_summary,
        "trash_sets": _public_rule_suggestion_trash_sets(review_state),
        "generated_at": review_state.get("generated_at"),
        "auto_discarded_suggestion_ids": auto_discarded_suggestion_ids,
    }


@router.post("/profiles/{profile_id}/rule-suggestions/clear")
def clear_profile_rule_suggestions(profile_id: str, body: RuleSuggestionClearRequest):
    with get_db() as conn:
        column_map = _load_profile_column_map(conn, profile_id)
        review_state = _get_profile_rule_suggestion_review_state(column_map)
        result = _clear_rule_suggestion_review_status(review_state, body.status, body.suggestion_ids)
        column_map[RULE_SUGGESTION_REVIEW_KEY] = review_state
        _save_profile_column_map(conn, profile_id, column_map)
    return result


@router.post("/profiles/{profile_id}/rule-suggestions/trash/{trash_set_id}/restore")
def restore_profile_rule_suggestion_trash_set(profile_id: str, trash_set_id: str):
    with get_db() as conn:
        column_map = _load_profile_column_map(conn, profile_id)
        review_state = _get_profile_rule_suggestion_review_state(column_map)
        result = _restore_rule_suggestion_trash_set(review_state, trash_set_id)
        column_map[RULE_SUGGESTION_REVIEW_KEY] = review_state
        _save_profile_column_map(conn, profile_id, column_map)
    return result


@router.get("/rule-suggestions")
def get_system_rule_suggestions(owner_ids: Optional[str] = Query(None)):
    with get_db() as conn:
        review_state = _get_system_rule_suggestion_review_state(conn)
        selected_owner_ids = [value.strip() for value in (owner_ids or "").split(",") if value.strip()]
        rows = _query_rule_suggestion_rows(conn, system_wide=True)
        result = _build_rule_suggestion_response(conn, rows, review_state, selected_owner_ids)
        if result.pop("should_persist", False):
            _save_system_rule_suggestion_review_state(conn, review_state)
    return result


@router.post("/rule-suggestions/debug-trace")
def write_rule_suggestion_debug_trace(body: RuleSuggestionDebugTraceRequest):
    with get_db() as conn:
        record = _build_rule_suggestion_trace_record(conn, body)
    path = _rule_suggestion_trace_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as trace_file:
        trace_file.write(json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n")
    return {"ok": True}


@router.post("/rule-suggestions/review")
def update_system_rule_suggestion_review(body: BatchRuleSuggestionReviewUpdateRequest):
    status = (body.status or "").strip().lower()
    if status not in ({"pending"} | RULE_SUGGESTION_REVIEW_STATUSES):
        raise HTTPException(status_code=400, detail="Invalid review status")

    with get_db() as conn:
        review_state = _get_system_rule_suggestion_review_state(conn)
        suggestion_entries = dict(review_state.get("suggestions") or {})
        suggestion_entries.setdefault(body.suggestion_id, {})
        auto_discarded_suggestion_ids: list[str] = []
        old_entry = dict(suggestion_entries.get(body.suggestion_id) or {})
        if status == "pending":
            _remove_pending_derived_rule_suggestions(review_state, body.suggestion_id)
        suggestion_entries = dict(review_state.get("suggestions") or {})
        suggestion_entries.setdefault(body.suggestion_id, {})

        if body.merchant_label:
            suggestion_entries[body.suggestion_id]["merchant_label"] = body.merchant_label
        if body.target_category_name:
            suggestion_entries[body.suggestion_id]["target_category_name"] = body.target_category_name
        if body.target_category_id is not None:
            suggestion_entries[body.suggestion_id]["target_category_id"] = body.target_category_id
        if body.keyword is not None:
            suggestion_entries[body.suggestion_id]["keyword"] = normalize_rule_keyword(body.keyword)
        # Use model_fields_set so an explicit null clears the field (generalizing a rule by removing its
        # owner/account). Without this an explicit "clear to none" was dropped and the suggestion kept
        # its old scope even though the created rule was generalized.
        if body.owner_id is not None or "owner_id" in body.model_fields_set:
            suggestion_entries[body.suggestion_id]["owner_id"] = body.owner_id or None
        if body.account_id is not None or "account_id" in body.model_fields_set:
            suggestion_entries[body.suggestion_id]["account_id"] = body.account_id or None
        if body.amount_min is not None or "amount_min" in body.model_fields_set:
            suggestion_entries[body.suggestion_id]["amount_min"] = body.amount_min
        if body.amount_max is not None or "amount_max" in body.model_fields_set:
            suggestion_entries[body.suggestion_id]["amount_max"] = body.amount_max
        if body.clean_name_suggestion is not None or "clean_name_suggestion" in body.model_fields_set:
            suggestion_entries[body.suggestion_id]["clean_name_suggestion"] = body.clean_name_suggestion
        if body.match_source_text is not None or "match_source_text" in body.model_fields_set:
            suggestion_entries[body.suggestion_id]["match_source_text"] = bool(body.match_source_text)
        if body.latest_txn_date is not None or "latest_txn_date" in body.model_fields_set:
            suggestion_entries[body.suggestion_id]["latest_txn_date"] = body.latest_txn_date
        if body.txn_count is not None or "txn_count" in body.model_fields_set:
            suggestion_entries[body.suggestion_id]["txn_count"] = body.txn_count
        if body.source_row_ids is not None or "source_row_ids" in body.model_fields_set:
            suggestion_entries[body.suggestion_id]["source_row_ids"] = sorted({
                str(value) for value in (body.source_row_ids or []) if str(value).strip()
            })
        if body.review_action is not None or "review_action" in body.model_fields_set:
            if isinstance(body.review_action, dict):
                suggestion_entries[body.suggestion_id]["review_action"] = body.review_action
            else:
                suggestion_entries[body.suggestion_id].pop("review_action", None)

        statuses = dict(review_state.get("statuses") or {})
        synthetic_entries: list[dict] = []
        if status == "pending":
            statuses.pop(body.suggestion_id, None)
        else:
            next_status = {
                "status": status,
                "updated_at": utcnow_iso(),
            }
            if body.rule_id:
                next_status["rule_id"] = body.rule_id
            if body.created_rule_id:
                next_status["created_rule_id"] = body.created_rule_id
            if body.accepted_prior_rows is not None or "accepted_prior_rows" in body.model_fields_set:
                next_status["accepted_prior_rows"] = list(body.accepted_prior_rows or [])
            if body.review_action is not None or "review_action" in body.model_fields_set:
                next_status["review_action"] = body.review_action if isinstance(body.review_action, dict) else None
            statuses[body.suggestion_id] = next_status
            review_state["statuses"] = statuses
            if status == "accepted":
                auto_discarded_suggestion_ids = _discard_covered_rule_suggestions(
                    review_state,
                    body.suggestion_id,
                    suggestion_entries[body.suggestion_id],
                )
                statuses = dict(review_state.get("statuses") or {})
                rows = _query_rule_suggestion_rows(conn, system_wide=True)
                if (
                    old_entry
                    and old_entry.get("source_row_ids")
                    and _rule_suggestion_entry_covers(old_entry, suggestion_entries[body.suggestion_id], allow_equal_keyword=True)
                    and not _rule_suggestion_entry_covers(suggestion_entries[body.suggestion_id], old_entry, allow_equal_keyword=True)
                ):
                    synthetic_entries = _build_synthetic_rule_suggestion_entries(
                        conn,
                        review_state,
                        body.suggestion_id,
                        suggestion_entries[body.suggestion_id],
                        [dict(row) for row in rows],
                    )

        review_state["suggestions"] = suggestion_entries
        review_state["statuses"] = statuses
        if synthetic_entries:
            for entry in synthetic_entries:
                suggestion_id = entry.pop("id")
                review_state["suggestions"][suggestion_id] = entry
        _prune_phantom_rule_suggestion_entry(review_state, body.suggestion_id, status)
        review_summary = summarize_rule_suggestion_review(review_state)
        _save_system_rule_suggestion_review_state(conn, review_state)

    return {
        "ok": True,
        "review_summary": review_summary,
        "trash_sets": _public_rule_suggestion_trash_sets(review_state),
        "generated_at": review_state.get("generated_at"),
        "auto_discarded_suggestion_ids": auto_discarded_suggestion_ids,
    }


@router.post("/rule-suggestions/clear")
def clear_system_rule_suggestions(body: RuleSuggestionClearRequest):
    with get_db() as conn:
        review_state = _get_system_rule_suggestion_review_state(conn)
        result = _clear_rule_suggestion_review_status(review_state, body.status, body.suggestion_ids)
        _save_system_rule_suggestion_review_state(conn, review_state)
    return result


@router.post("/rule-suggestions/trash/{trash_set_id}/restore")
def restore_system_rule_suggestion_trash_set(trash_set_id: str):
    with get_db() as conn:
        review_state = _get_system_rule_suggestion_review_state(conn)
        result = _restore_rule_suggestion_trash_set(review_state, trash_set_id)
        _save_system_rule_suggestion_review_state(conn, review_state)
    return result


@router.post("/batches/{batch_id}/rule-suggestions/refine-match")
def refine_batch_rule_suggestion_match(batch_id: str, body: BatchRuleSuggestionMatchRefineRequest):
    with get_db() as conn:
        batch = conn.execute(
            "SELECT id, config_snapshot FROM import_batch WHERE id = ?",
            (batch_id,),
        ).fetchone()
        if not batch:
            raise HTTPException(status_code=404, detail="Batch not found")

        snapshot = safe_json_dict(batch["config_snapshot"])
        review_state = get_rule_suggestion_review_state(snapshot)
        rows = [dict(row) for row in _query_rule_suggestion_rows(conn, batch_id=batch_id)]
        result = _refine_pending_conflict_group(conn, review_state, rows, body)
        snapshot[RULE_SUGGESTION_REVIEW_KEY] = review_state
        save_batch_snapshot(conn, batch_id, snapshot)
    return result


@router.post("/profiles/{profile_id}/rule-suggestions/refine-match")
def refine_profile_rule_suggestion_match(profile_id: str, body: BatchRuleSuggestionMatchRefineRequest):
    with get_db() as conn:
        column_map = _load_profile_column_map(conn, profile_id)
        review_state = _get_profile_rule_suggestion_review_state(column_map)
        rows = [dict(row) for row in _query_rule_suggestion_rows(conn, profile_id=profile_id)]
        result = _refine_pending_conflict_group(conn, review_state, rows, body)
        column_map[RULE_SUGGESTION_REVIEW_KEY] = review_state
        conn.execute(
            "UPDATE csv_import_profile SET column_map = ? WHERE id = ?",
            (json.dumps(column_map), profile_id),
        )
    return result


@router.post("/rule-suggestions/refine-match")
def refine_system_rule_suggestion_match(body: BatchRuleSuggestionMatchRefineRequest):
    with get_db() as conn:
        review_state = _get_system_rule_suggestion_review_state(conn)
        rows = [dict(row) for row in _query_rule_suggestion_rows(conn, system_wide=True)]
        result = _refine_pending_conflict_group(conn, review_state, rows, body)
        _save_system_rule_suggestion_review_state(conn, review_state)
    return result


@router.post("/rule-suggestions/matches")
def get_system_rule_suggestion_matches(body: BatchRuleSuggestionMatchRequest):
    keyword = normalize_rule_keyword(body.keyword or "")
    if not keyword:
        raise HTTPException(status_code=400, detail="keyword required")

    with get_db() as conn:
        categories_by_name, categories_by_id = _load_import_rule_target_maps(conn)
        row_ids, row_scope_clause, candidate_source_clause = _rule_suggestion_match_scope(body)
        rows = conn.execute(
            f"""
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
                t.category_source,
                t.import_evidence_json,
                COALESCE(a.parent_account_id, t.account_id) AS account_id,
                t.owner_id,
                COALESCE(a.display_name, a.name) AS account_name,
                COALESCE(p.mask, a.mask) AS account_mask,
                o.name AS owner_name
            FROM txn t
            JOIN import_batch b ON b.id = t.import_batch_id
            LEFT JOIN account a ON a.id = t.account_id
            LEFT JOIN account p ON p.id = a.parent_account_id
            LEFT JOIN owner o ON o.id = t.owner_id
            WHERE b.status = 'completed'
              AND b.use_imported_categories = 1
              {row_scope_clause}
              {candidate_source_clause}
            ORDER BY t.date DESC, t.id DESC
            """,
            row_ids,
        ).fetchall()

    row_ids_set = {str(value) for value in body.row_ids} if body.row_ids else None
    matching_rows = []
    for base_row in rows:
        row = dict(base_row)
        # When the caller passes the card's own source rows, the report is exactly those rows — so a
        # generic suggestion doesn't pull in same-keyword rows owned by other (e.g. discarded) suggestions.
        if row_ids_set is not None and str(row["id"]) not in row_ids_set:
            continue
        row["display_amount"] = get_import_display_amount(row["amount"], "single_signed")
        if not _row_matches_rule_suggestion_report_keyword(row, keyword, body.match_source_text):
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
            # A manual category is the user's settled decision, not an unresolved file conflict to flag.
            and row["category_source"] != "manual"
        )
        matching_rows.append(row)

    return {
        "keyword": keyword,
        "amount_convention": "single_signed",
        "count": len(matching_rows),
        "transactions": matching_rows,
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
        row_ids, row_scope_clause, candidate_source_clause = _rule_suggestion_match_scope(body)
        rows = conn.execute(
            f"""
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
                t.category_source,
                t.import_evidence_json,
                COALESCE(a.parent_account_id, t.account_id) AS account_id,
                t.owner_id,
                COALESCE(a.display_name, a.name) AS account_name,
                COALESCE(p.mask, a.mask) AS account_mask,
                o.name AS owner_name
            FROM txn t
            LEFT JOIN account a ON a.id = t.account_id
            LEFT JOIN account p ON p.id = a.parent_account_id
            LEFT JOIN owner o ON o.id = t.owner_id
            WHERE t.import_batch_id = ?
              {row_scope_clause}
              {candidate_source_clause}
            ORDER BY t.date DESC, t.id DESC
            """,
            [batch_id, *row_ids],
        ).fetchall()

    matching_rows = []
    for base_row in rows:
        row = dict(base_row)
        row["display_amount"] = get_import_display_amount(row["amount"], amount_convention)
        if not _row_matches_rule_suggestion_report_keyword(row, keyword, body.match_source_text):
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
            # A manual category is the user's settled decision, not an unresolved file conflict to flag.
            and row["category_source"] != "manual"
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
        row_ids, row_scope_clause, candidate_source_clause = _rule_suggestion_match_scope(body)
        rows = conn.execute(
            f"""
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
                t.category_source,
                t.import_evidence_json,
                COALESCE(a.parent_account_id, t.account_id) AS account_id,
                t.owner_id,
                COALESCE(a.display_name, a.name) AS account_name,
                COALESCE(p.mask, a.mask) AS account_mask,
                o.name AS owner_name
            FROM txn t
            JOIN import_batch b ON b.id = t.import_batch_id
            LEFT JOIN account a ON a.id = t.account_id
            LEFT JOIN account p ON p.id = a.parent_account_id
            LEFT JOIN owner o ON o.id = t.owner_id
            WHERE b.profile_id = ?
              AND b.status = 'completed'
              {row_scope_clause}
              {candidate_source_clause}
            ORDER BY t.date DESC, t.id DESC
            """,
            [profile_id, *row_ids],
        ).fetchall()

    matching_rows = []
    for base_row in rows:
        row = dict(base_row)
        row["display_amount"] = get_import_display_amount(row["amount"], amount_convention)
        if not _row_matches_rule_suggestion_report_keyword(row, keyword, body.match_source_text):
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
            # A manual category is the user's settled decision, not an unresolved file conflict to flag.
            and row["category_source"] != "manual"
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


@router.patch("/batches/{batch_id}/imported-category-usage")
def update_batch_imported_category_usage(batch_id: str, body: BatchImportedCategoryUsageUpdateRequest):
    with get_db() as conn:
        batch = conn.execute(
            "SELECT id, config_snapshot FROM import_batch WHERE id = ?",
            (batch_id,),
        ).fetchone()
        if not batch:
            raise HTTPException(status_code=404, detail="Batch not found")

        snapshot = safe_json_dict(batch["config_snapshot"])
        snapshot["use_imported_categories"] = bool(body.use_imported_categories)
        current_settings = _get_imported_category_settings(snapshot)
        next_settings = {
            "scope_mode": body.imported_category_scope_mode if body.imported_category_scope_mode is not None else current_settings["scope_mode"],
            "owner_ids": body.imported_category_owner_ids if body.imported_category_owner_ids is not None else current_settings["owner_ids"],
            "unassigned_account_tokens": (
                body.imported_category_unassigned_account_tokens
                if body.imported_category_unassigned_account_tokens is not None
                else current_settings["unassigned_account_tokens"]
            ),
        }
        snapshot[IMPORTED_CATEGORY_SETTINGS_KEY] = _normalize_imported_category_settings(next_settings)
        save_batch_snapshot(conn, batch_id, snapshot)
        _set_batch_imported_category_usage(conn, batch_id, body.use_imported_categories)
    return _annotate_imported_category_settings(
        {
            "ok": True,
            "use_imported_categories": bool(body.use_imported_categories),
        },
        snapshot[IMPORTED_CATEGORY_SETTINGS_KEY],
    )


def undo_batches(conn, batch_ids) -> dict:
    """Reverse the ledger effect of one or more import batches: delete the transactions they imported and
    the per-batch dedupe state they left behind, and undo everything those rows did to rows *outside* the
    batch. Shared by the per-file Undo, the re-import replace path, and the connection-level "Remove
    synced transactions", so the three cannot drift. What happens to the `import_batch` row itself is the
    caller's: a file keeps an 'undone' tombstone, a sync card is deleted outright.

    Three orderings are load-bearing:

      1. Enrichments and the wallet/marketplace links are reversed while the batch's rows still exist.
         Those records hold the delta needed to restore a *pre-existing* row the batch changed, which
         would otherwise be orphaned and unreversible.
      2. A row trashed as a confirmed duplicate of a row that is about to be deleted is restored
         *before* the dangling-pointer sweep, which is what would otherwise erase the very pointer
         naming its twin.
      3. The sweep runs once after all batches rather than per batch — it scans all of `txn`.

    Restoring the twin covers deliberate user Rejects as well as merge-time auto-promotions, unlike
    `restore_auto_merged_after_detach`: a detach leaves the canonical row in place, so the user's "yes,
    this is the duplicate" still has a referent, whereas here that row is being deleted and the
    decision's premise goes with it. The row comes back as an ordinary transaction rather than an active
    suspect — with the twin gone there is nothing left to re-judge it against.

    Deleting the batch's own dedupe records matters for two reasons beyond tidiness: its hard-reject
    records describe a decision about an import that no longer exists (they would surface as stale
    entries in the unified duplicate report), and its coverage records tell future imports "this date
    range was already covered", which would spuriously hard-reject rows on those dates.
    """
    ids = [str(b) for b in batch_ids if b]
    if not ids:
        return {"deleted": 0, "restored": 0}
    placeholders = ",".join("?" * len(ids))

    from .amazon import reverse_batch_amazon_links  # lazy: avoid the core↔amazon import cycle
    for batch_id in ids:
        reverse_batch_enrichments(conn, batch_id)
        reverse_batch_money_movement_links(conn, batch_id)
        reverse_batch_amazon_links(conn, batch_id)

    restored = conn.execute(
        f"""
        UPDATE txn
        SET    trashed_at           = NULL,
               rejection_reason     = NULL,
               dedupe_resolved_by   = NULL,
               suspect_duplicate_of = NULL
        WHERE  rejection_reason = 'duplicate_confirmed'
          AND  suspect_duplicate_of IN (
                   SELECT id FROM txn WHERE import_batch_id IN ({placeholders})
               )
        """,
        ids,
    ).rowcount or 0

    deleted = conn.execute(
        f"DELETE FROM txn WHERE import_batch_id IN ({placeholders})", ids
    ).rowcount or 0
    conn.execute(f"DELETE FROM import_batch_duplicate WHERE batch_id IN ({placeholders})", ids)
    conn.execute(f"DELETE FROM import_batch_account WHERE batch_id IN ({placeholders})", ids)

    # Soft-flags on OTHER batches may point at rows that just got deleted; clear those dangling
    # pointers so the unified report doesn't carry orphaned entries.
    conn.execute(
        """
        UPDATE txn
        SET    suspect_duplicate_of = NULL,
               suspect_duplicate_reason = NULL,
               suspect_resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE  suspect_duplicate_of IS NOT NULL
          AND  suspect_duplicate_of NOT IN (SELECT id FROM txn)
        """
    )
    return {"deleted": deleted, "restored": restored}


@router.delete("/batches/{batch_id}")
def undo_batch(batch_id: str, force: bool = Query(False)):
    """
    Undo an import batch. If any transactions were manually edited, returns 409
    with the list unless force=true.
    """
    with get_db() as conn:
        batch = conn.execute(
            "SELECT id, status, use_imported_categories FROM import_batch WHERE id = ?", (batch_id,)
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
                WHERE  t.import_batch_id = ?
                  AND  t.category_overridden = 1
                  AND  COALESCE(t.category_source, 'manual') = 'manual'
            """, (batch_id,)).fetchall()

            if edited:
                return JSONResponse(status_code=409, content={
                    "detail": "Some transactions were manually edited after import",
                    "edited_transactions": [dict(r) for r in edited],
                })

        undo_batches(conn, [batch_id])

        conn.execute(
            "UPDATE import_batch SET status = 'undone' WHERE id = ?", (batch_id,)
        )
        if batch["use_imported_categories"]:
            _remove_imported_batch_categories(conn, batch_id)

    return {"ok": True}
