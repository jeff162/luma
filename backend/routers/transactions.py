# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Transaction list and summary endpoints.

Treat this file as two related contracts:
- `list_transactions` is the raw ledger view, so it keeps pending rows and accepts a broad mix of legacy and
  multi-select filters.
- the `/summary/*` endpoints normalize transactions into reporting semantics, which means pending rows drop out,
  reports keep both debits and credits in the selected slice and roll them up as net totals, and group/category filters use subqueries so the reporting
  joins do not accidentally change which transactions qualify.
"""
from fastapi import APIRouter, Depends, Query, HTTPException
from pydantic import BaseModel
from typing import Optional
from datetime import datetime
from decimal import Decimal
import re
import uuid
from backend.db.database import get_db
from backend.services.recurring_detection import payee_keys_for_ids, rescan_edited_transactions
from backend.services.import_batch_totals import delete_transactions
from backend.services.account_groups import effective_account_id_sql
from backend.services.transaction_attributes import attribute_require_all_sql, attribute_vocabulary
from backend.services.transaction_facets import (
    FACET_PARAM_NAMES,
    TransactionFacets,
    UNCATEGORIZED_CATEGORY_ID,
    UNCATEGORIZED_EXPENSE_CATEGORY_ID,
    UNCATEGORIZED_INCOME_CATEGORY_ID,
    account_membership,
    append_facets,
    coerce_facets,
    facets_from,
)
from backend.services.transaction_tags import (
    effective_selected_tag_signature_sql,
    effective_tag_match_all_sql,
    get_blocked_transaction_tag_map,
    get_visible_transaction_tag_map,
    list_visible_transaction_tags,
    set_manual_transaction_tag,
)
from backend.json_utils import safe_json_dict
from backend.services.amazon_import import parse_item_evidence
from backend.services.categorizer import (
    categorize_transaction,
    category_lock_for,
    load_categorization_rules,
    recategorize_all,
)
from backend.services.documents import (
    INGEST_GRACE_SECONDS,
    documents_map_for,
    sweep_unreferenced_files,
)
from backend.services.purchase_links import purchase_for_txn, purchase_map_for
from backend.services.reimbursements import (
    receivable_amounts,
    receivable_parts,
    reimbursement_map_for,
    reimbursements_for_txn,
    unclaimed_amounts,
)
from backend.services.txn_splits import (
    SplitValidationError,
    clear_split,
    get_split_parts_map,
    get_split_parts,
    split_part_id_sql,
    proportional_allocation,
    save_split,
    split_txn_ids,
    txn_effective_sql,
)

router = APIRouter()

EFFECTIVE_ACCOUNT_ID_SQL = effective_account_id_sql("t.account_id")
QUICK_FILTER_ACCOUNT_LABEL_SQL = """
TRIM(
    REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
        LOWER(COALESCE(p.display_name, p.name, a.display_name, a.name, '')),
        '(', ' '
    ), ')', ' '), '.', ' '), '/', ' '), '-', ' '), '_', ' '), '  ', ' '), '  ', ' ')
)
"""
QUICK_FILTER_ACCOUNT_EXCLUDED_TERMS = {"check", "checking", "saving", "savings", "credit", "debit"}
QUICK_FILTER_FIELD_PREFIXES = {"merchant", "raw", "category", "account", "date", "amount", "doc"}
TRANSACTION_SORT_SQL = {
    "date": "t.date",
    "merchant": "LOWER(COALESCE(NULLIF(t.display_name, ''), NULLIF(t.merchant_name, ''), NULLIF(t.raw_name, ''), ''))",
    "category": "LOWER(COALESCE(c.name, ''))",
    "account": "LOWER(COALESCE(a.display_name, a.name, ''))",
    "amount": "t.amount",
}
UNASSIGNED_CATEGORY_SYSTEM_KEY = "unassigned"
UNCATEGORIZED_EXPENSE_CATEGORY_NAME = "Uncategorized"
UNCATEGORIZED_INCOME_CATEGORY_NAME = "Other Income"


class CategoryOverride(BaseModel):
    # Category edits from the transaction UI can also persist the note field in the same save gesture.
    category_id: str
    notes: Optional[str] = None


class SplitPartInput(BaseModel):
    category_id: Optional[str] = None
    amount: Optional[float] = None
    label: Optional[str] = None


class SplitSave(BaseModel):
    parts: list[SplitPartInput] = []


class TransactionTagUpdate(BaseModel):
    tag_id: str
    present: bool


class CategorizationSnapshot(BaseModel):
    # One row's category state captured before a change, for Undo (see restore_categorization_rows).
    id: str
    category_id: Optional[str] = None
    category_source: Optional[str] = None
    category_overridden: int = 0


# Bulk edit applies one or more field changes to a selection that is either an explicit id list or
# "everything matching the current filter" (minus a few unchecked ids). Filter mode lets the UI act on
# rows the user never scrolled into. See bulk_update_transactions.
class BulkSelection(BaseModel):
    mode: str                                   # 'ids' | 'filter'
    ids: Optional[list[str]] = None             # mode == 'ids'
    filter: Optional[dict] = None               # mode == 'filter': same params as the list endpoint
    exclude_ids: Optional[list[str]] = None     # mode == 'filter': rows unchecked after select-all


class BulkAction(BaseModel):
    type: str                                   # set_category | add_tags | remove_tags | set_notes | set_merchant | set_date | mark_reviewed | set_review_status | trash
    category_id: Optional[str] = None
    tag_ids: Optional[list[str]] = None
    notes: Optional[str] = None
    merchant: Optional[str] = None
    date: Optional[str] = None
    needs_review: Optional[bool] = None         # set_review_status: True = needs review, False = reviewed


class BulkUpdateRequest(BaseModel):
    selection: BulkSelection
    actions: list[BulkAction]


def _append_uncategorized_filter(clauses, params, *, category_id: Optional[str]) -> bool:
    if category_id == UNCATEGORIZED_CATEGORY_ID:
        clauses.append("t.category_id IS NULL")
        return True
    if category_id == UNCATEGORIZED_EXPENSE_CATEGORY_ID:
        clauses.append("t.category_id IS NULL")
        clauses.append("t.amount > 0")
        return True
    if category_id == UNCATEGORIZED_INCOME_CATEGORY_ID:
        clauses.append("t.category_id IS NULL")
        clauses.append("t.amount < 0")
        return True
    return False


# Sign convention for monthly-trend and related reports:
# the chart's positive y-axis should always represent the natural direction for
# the queried scope. The DB stores expense amounts as positive and income
# amounts as negative, so income-type scopes get a -1 multiplier to make
# received income read as a positive bar, while reverses (refunds in expense
# categories, returns in income categories) appear as negative bars and the
# chart's y-axis spans both sides naturally.
def _resolve_category_is_income(conn, category_id: str) -> bool:
    if category_id == UNCATEGORIZED_INCOME_CATEGORY_ID:
        return True
    if category_id in (UNCATEGORIZED_EXPENSE_CATEGORY_ID, UNCATEGORIZED_CATEGORY_ID):
        return False
    if category_id.startswith("__group__"):
        gid = category_id[len("__group__"):]
        row = conn.execute(
            "SELECT category_type FROM category WHERE id = ?",
            [gid],
        ).fetchone()
        return bool(row and row[0] == "income")
    row = conn.execute(
        """
        SELECT COALESCE(c.category_type, p.category_type)
        FROM   category c
        LEFT JOIN category p ON p.id = c.parent_id
        WHERE  c.id = ?
        """,
        [category_id],
    ).fetchone()
    return bool(row and row[0] == "income")




def _summary_uncategorized_id_sql(level: str) -> str:
    base_column = "c.id" if level == "category" else "COALESCE(p.id, c.id)"
    return (
        "CASE "
        f"WHEN t.category_id IS NULL AND t.amount < 0 THEN '{UNCATEGORIZED_INCOME_CATEGORY_ID}' "
        f"WHEN t.category_id IS NULL THEN '{UNCATEGORIZED_EXPENSE_CATEGORY_ID}' "
        f"ELSE {base_column} "
        "END"
    )


def _summary_uncategorized_name_sql(level: str) -> str:
    base_column = "c.name" if level == "category" else "COALESCE(p.name, c.name)"
    return (
        "CASE "
        f"WHEN t.category_id IS NULL AND t.amount < 0 THEN '{UNCATEGORIZED_INCOME_CATEGORY_NAME}' "
        f"WHEN t.category_id IS NULL THEN '{UNCATEGORIZED_EXPENSE_CATEGORY_NAME}' "
        f"ELSE {base_column} "
        "END"
    )


# **A leaf's type is inherited when it does not carry one of its own**, and every resolver of "is this
# income?" has to agree about that or a bucket gets selected by one rule and signed by another. A leaf
# with `category_type IS NULL` under an income group is the ordinary case, not an anomaly — the group
# skeleton carries the type and most leaves never set one — so reading the leaf's own column alone made
# the category level the sole dissenter among five resolvers (`_resolve_category_is_income`, the
# `view=income` scope clause, `by-tag-signature`'s per-row sign, and the group level here all
# COALESCE). The `view=income` drill therefore *listed* such a category's rows while the pie beside it
# signed them as expense, so received income read as a large negative, and a group's total stopped
# equalling the sum of its own slices.
#
# The precedence differs by level and both directions are deliberate: a category bucket prefers its own
# type and falls back to its group, while a group bucket is the group, so the group's type wins over any
# one child's. Callers must join `category p ON p.id = c.parent_id` for either.
def _summary_uncategorized_type_sql(level: str) -> str:
    base_column = ("COALESCE(c.category_type, p.category_type)" if level == "category"
                   else "COALESCE(p.category_type, c.category_type)")
    return (
        "CASE "
        "WHEN t.category_id IS NULL AND t.amount < 0 THEN 'income' "
        "WHEN t.category_id IS NULL THEN 'expense' "
        f"ELSE {base_column} "
        "END"
    )


# Every summary bucket counts DISTINCT transactions, not rows. The expansion seam fans a split
# transaction into one row per allocation, and a split may hold several allocations in the same
# category (two records bought in one order are two items, not one) — so a plain COUNT(*) would report
# a bucket's row count while its total reported money, and the two would disagree for the same
# transaction. The list endpoint deliberately keeps COUNT(*): its count drives pagination, so it has to
# count the rows it will actually return.
#
# Signed net for a summary bucket, following the sign convention documented at monthly_trend (see the
# "Sign convention" note): income-type buckets negate so received income reads positive, while reverses
# — refunds in an expense bucket, returns in an income bucket — stay negative. This deliberately replaces
# ABS(SUM(amount)): ABS hid a refund by flipping its sign, so a bucket that net-refunded a period read as
# positive "spending" and inflated the period total. `type_expr` must be constant within each GROUP BY
# bucket (true for the by-category/by-group buckets, whose type is a function of the bucket). Charts that
# can't render a negative magnitude (pie wedges, stacked bands) floor the geometry client-side while the
# displayed numbers keep this true sign.
def _summary_signed_total_sql(type_expr: str) -> str:
    return f"CASE WHEN ({type_expr}) = 'income' THEN -SUM(t.amount) ELSE SUM(t.amount) END"


# The singular `account_id` is a legacy convenience the registry deliberately does not carry: it means
# the same thing as a one-element `account_ids`, and `account_ids` wins when both arrive. Kept as its own
# helper so that precedence is stated once rather than re-derived per caller.
def _append_single_account_filter(clauses, params, *, account_id: Optional[str], account_ids: Optional[str]):
    if account_ids and isinstance(account_ids, str) and account_ids.strip():
        return
    if account_id and isinstance(account_id, str):
        membership = account_membership([account_id])
        if membership:
            clauses.append(membership[0])
            params.extend(membership[1])


def _append_source_account_filter(clauses, params, *, source_account_ids: Optional[str]):
    # Filters on the row's *original* (source) account — t.account_id directly — rather than the
    # effective/top-level account the `account_ids` filter resolves through COALESCE(parent, id).
    # This is what lets a merged-account report narrow to one underlying child account: every row in
    # the report already shares the same effective (parent) account, so only the source distinguishes them.
    if source_account_ids and isinstance(source_account_ids, str):
        ids = [i.strip() for i in source_account_ids.split(',') if i.strip()]
        if ids:
            placeholders = ','.join('?' * len(ids))
            clauses.append(f"t.account_id IN ({placeholders})")
            params.extend(ids)


# `require_all_tag_ids` is not a facet: it is an *AND* constraint ("has all of these") that applies
# alongside the OR tag facet rather than instead of it, and it is internal — the tag-report drill scopes
# rows to an exact signature with it, while the app-wide FilterBar stays OR. See docs/data-model.md →
# "Filter exclusion".
def _append_require_all_tags_filter(clauses, params, *, require_all_tag_ids: Optional[str]):
    if require_all_tag_ids and isinstance(require_all_tag_ids, str):
        ids = [i.strip() for i in require_all_tag_ids.split(",") if i.strip()]
        if ids:
            clauses.append(effective_tag_match_all_sql(len(ids)))
            params.extend(ids)


# The attribute counterpart, and for the same reason: the ledger's toolbar filter is a control of its own
# rather than another tick in the facet's picker, so it has to AND. Folding its key into `attribute_ids`
# would OR it with the FilterBar's chips, which means adding a second filter could *widen* the result.
def _append_require_all_attributes_filter(clauses, params, *, require_all_attribute_ids: Optional[str]):
    if require_all_attribute_ids and isinstance(require_all_attribute_ids, str):
        keys = [k.strip() for k in require_all_attribute_ids.split(",") if k.strip()]
        membership = attribute_require_all_sql(keys) if keys else None
        if membership:
            clauses.append(membership[0])
            params.extend(membership[1])


# `quick_filter` is the ledger *search box* (the Transactions page and import-card ledgers). The name predates
# the Transactions toolbar's quick-filter control (`AttributeFilterControl`), which is a different thing.
# Parsing keeps the one-box workflow lightweight:
# - merchant and category stay broad substring matches so partial labels still work naturally; merchant reads
#   every name the row carries, raw reads the imported text (the raw name and the import's captured free text),
#   and an unprefixed search reads both
# - account labels match normalized whole words/phrases so generic fragments like `check` do not expand to every
#   `Checking` account and drown out rows whose merchant is actually `CHECK`
# - date and amount parsing add more precise matches when the input looks like those domains; a full
#   date / year / month jumps to that exact slot, while a year-less partial (a bare month, or month/day)
#   matches that calendar slot across every year
# - a `<field>:<value>` prefix (merchant/raw/category/account/date/amount/doc) restricts the search to that one field;
#   when the prefix is explicit we also drop the account-term exclusion list because the user has asked specifically.
#   The prefix is recognized only at the start and its value is the whole rest of the box, so there is no way to
#   combine two — a precise combination belongs to a page-local control like the amount filter (ui-patterns.md)
# - the result stays additive with the normal ledger filters instead of replacing them
def _split_quick_filter_field(value: str):
    match = re.match(r"^([A-Za-z]+)\s*:\s*(.*)$", value)
    if not match:
        return None, value
    field = match.group(1).lower()
    if field not in QUICK_FILTER_FIELD_PREFIXES:
        return None, value
    return field, match.group(2).strip()


def _build_quick_filter_clause(value: str):
    text = (value or "").strip()
    if not text:
        return None

    field, remainder = _split_quick_filter_field(text)
    if field is not None:
        if not remainder:
            return None
        search_text = remainder
    else:
        search_text = text

    lowered = search_text.lower()
    normalized_account_text = _normalize_quick_filter_text(search_text)
    or_clauses = []
    params = []

    def want(name: str) -> bool:
        return field is None or field == name

    if field in (None, "merchant", "raw"):
        # Every name the row carries, not only the one on screen. A rule's clean name or a manual rename
        # replaces what the bank sent, and a search for words from the bank's own text has to keep finding
        # the row afterwards — the rule matcher reads all three names for the same reason. Split into the
        # visible name and the rest so `hidden_text_match_sql` can say which one matched. `raw:` is the
        # imported text alone, so it leaves the visible name out unless that name *is* the raw one.
        if field != "raw":
            or_clauses.append(f"{VISIBLE_NAME_SQL} LIKE ?")
            params.append(f"%{lowered}%")
        hidden_sql, hidden_params = _hidden_text_sql(f"%{lowered}%", field)
        or_clauses.append(hidden_sql)
        params.extend(hidden_params)

    if want("category"):
        or_clauses.append("LOWER(COALESCE(c.name, '')) LIKE ?")
        params.append(f"%{lowered}%")
        if lowered in {"uncategorized", "uncategorised"}:
            or_clauses.append("t.category_id IS NULL")

    if want("account") and normalized_account_text:
        if field is not None or normalized_account_text not in QUICK_FILTER_ACCOUNT_EXCLUDED_TERMS:
            if " " in normalized_account_text:
                or_clauses.append(f"{QUICK_FILTER_ACCOUNT_LABEL_SQL} LIKE ?")
                params.append(f"%{normalized_account_text}%")
            else:
                or_clauses.append(f"(' ' || {QUICK_FILTER_ACCOUNT_LABEL_SQL} || ' ') LIKE ?")
                params.append(f"% {normalized_account_text} %")

    if want("date"):
        iso_date = _parse_quick_filter_date(search_text)
        if iso_date:
            or_clauses.append("t.date = ?")
            params.append(iso_date)
        year_month = _parse_quick_filter_year_month(search_text)
        if year_month:
            or_clauses.append("t.date LIKE ?")
            params.append(f"{year_month}%")
        year = _parse_quick_filter_year(search_text)
        if year:
            or_clauses.append("t.date LIKE ?")
            params.append(f"{year}-%")
        # Partial dates with no year (a bare month, or month/day) match that calendar slot in every
        # year — e.g. "9/29" finds Sept 29 across all years, "9" finds every September. Stored dates
        # are ISO YYYY-MM-DD, so the leading "-" anchors the match to the month/day fields and keeps
        # a bare month like "09" from also matching a day or a year fragment.
        month_day = _parse_quick_filter_month_day(search_text)
        if month_day:
            or_clauses.append("t.date LIKE ?")
            params.append(f"%-{month_day}")
        month = _parse_quick_filter_month(search_text)
        if month:
            or_clauses.append("t.date LIKE ?")
            params.append(f"%-{month}-%")

    if want("doc"):
        # Text inside an attached receipt is searchable from the plain box, not only behind `doc:`.
        # The objection to folding it in was that a hit has no visible cause — every field shown on the
        # row lacks the term — and the answer is to *show* the cause rather than to hide the match: the
        # list feed carries `matched_document` for these rows and the ledger marks them. `doc:` remains
        # as the way to search documents *only*.
        match_query = _fts_match_query(search_text)
        if match_query:
            or_clauses.append(DOCUMENT_MATCH_SQL)
            params.append(match_query)

    if want("amount"):
        amount = _parse_quick_filter_amount(search_text)
        if amount is not None:
            low_cents, high_cents, direction = amount
            # Stored money out is positive (docs/data-model.md), the reverse of how it is typed, so a typed sign
            # picks the stored one and no sign compares the magnitude. Compared in whole cents, where a range's
            # edges are exact; a float edge like 77.5 is not.
            stored = {"out": "t.amount", "in": "-t.amount"}.get(direction, "ABS(t.amount)")
            or_clauses.append(f"CAST(ROUND({stored} * 100) AS INTEGER) BETWEEN ? AND ?")
            params.extend([low_cents, high_cents])

    if not or_clauses:
        # The user explicitly asked for `field:value` but the value did not produce any constraint
        # (e.g. `date:not-a-date`). Match nothing so the empty result reflects the typed intent rather
        # than silently falling back to a broad OR search.
        return "(1 = 0)", []

    return f"({' OR '.join(or_clauses)})", params


# Whether any document attached to `t` matches an FTS query. Stated once because it is used two ways —
# as a filter clause, and as a projected column telling the ledger *why* a row came back — and the two
# must ask exactly the same question or a row would match without being marked, or the reverse.
DOCUMENT_MATCH_SQL = (
    "EXISTS (SELECT 1 FROM document_fts "
    "        JOIN document d ON d.rowid = document_fts.rowid "
    "        WHERE document_fts MATCH ? AND d.txn_id = t.id)"
)


# The name the ledger shows for a row — the first non-empty of the rename, the cleaned name and the raw
# name, as `visibleMerchant` in lib/importSourceFields.js resolves it.
VISIBLE_NAME_SQL = "LOWER(COALESCE(NULLIF(t.display_name, ''), NULLIF(t.merchant_name, ''), NULLIF(t.raw_name, ''), ''))"

# The free text an import captured beyond the names: the file's description cell and its extra text columns
# (a memo, an "Original Statement"). The same set `match_source_text` rules read
# (`categorizer.extract_source_match_text`) and the merchant hover lists, so a row found through it can be
# explained by hovering its name. Both reads sit behind CASE guards because SQLite's JSON functions raise on
# malformed input — a single bad value would otherwise fail the whole list query rather than just not match
# — and CASE is the one construct whose branches SQLite guarantees not to evaluate.
IMPORTED_TEXT_MATCH_SQL = (
    "(CASE WHEN json_valid(t.import_evidence_json) THEN ("
    "LOWER(COALESCE(json_extract(t.import_evidence_json, '$.description.value'), '')) LIKE ? "
    "OR EXISTS (SELECT 1 FROM json_each(t.import_evidence_json, '$.extra_text_fields') je "
    "WHERE CASE WHEN je.type = 'object' "
    "THEN LOWER(COALESCE(json_extract(je.value, '$.value'), '')) LIKE ? ELSE 0 END)"
    ") ELSE 0 END)"
)


def _imported_text_match_sql(pattern: str):
    """`IMPORTED_TEXT_MATCH_SQL` for one LIKE pattern, behind a cheap substring test where that test is sound.

    Parsing every row's JSON is most of what an unprefixed search costs, and most rows cannot match. A plain
    LIKE over the stored string rules them out first — roughly eight times faster on a ledger-sized copy for
    a term few rows contain. It can only rule out, never admit, and it is sound only when the term appears
    verbatim in serialized JSON: printable ASCII with no quote or backslash, since JSON escapes those and a
    writer may escape all non-ASCII. Any other term goes straight to the parse.
    """
    if pattern.isascii() and pattern.isprintable() and '"' not in pattern and "\\" not in pattern:
        return f"(CASE WHEN t.import_evidence_json LIKE ? THEN {IMPORTED_TEXT_MATCH_SQL} ELSE 0 END)", [
            pattern, pattern, pattern,
        ]
    return IMPORTED_TEXT_MATCH_SQL, [pattern, pattern]


def _hidden_text_sql(pattern: str, field: Optional[str]):
    """The row's searchable text beyond its visible name, as `(sql, params)` for one LIKE pattern, for an
    unprefixed search (`field` None), `merchant:` or `raw:`.

    The raw name is in all three. The cleaned name is a *name*, so `raw:` leaves it out; the import's captured
    free text is not a name, so `merchant:` leaves that out. Used by the filter and by the match-reason
    projection, which have to ask the same question or a row could match without being marked.
    """
    clauses = ["LOWER(COALESCE(t.raw_name, '')) LIKE ?"]
    params = [pattern]
    if field != "raw":
        clauses.append("LOWER(COALESCE(t.merchant_name, '')) LIKE ?")
        params.append(pattern)
    if field != "merchant":
        imported_sql, imported_params = _imported_text_match_sql(pattern)
        clauses.append(imported_sql)
        params.extend(imported_params)
    return f"({' OR '.join(clauses)})", params


def hidden_text_match_sql(quick_filter: Optional[str]):
    """`(sql, params)` for whether a row matched a quick filter on text its visible name does not show, or
    None when the filter searches no names.

    The sibling of `document_match_query`, for the same reason: a row found through its raw bank text or a
    memo column has no visible cause on screen, so the list feed marks it rather than leaving it to read as
    a wrong result. A row whose visible name also matches is not marked — the name already explains it.
    """
    text = (quick_filter or "").strip()
    if not text:
        return None
    field, remainder = _split_quick_filter_field(text)
    if field not in (None, "merchant", "raw"):
        return None
    value = remainder if field is not None else text
    if not value:
        return None
    pattern = f"%{value.lower()}%"
    hidden_sql, hidden_params = _hidden_text_sql(pattern, field)
    return f"({hidden_sql} AND {VISIBLE_NAME_SQL} NOT LIKE ?)", [*hidden_params, pattern]


def document_match_query(quick_filter: Optional[str]) -> Optional[str]:
    """The FTS query a quick filter implies for document text, or None if it implies none.

    Used by the list feed to project the match reason. Returns None for a prefixed filter that is not
    `doc:` — a `merchant:` search has no document component, so its rows must not be marked as though
    they matched one.
    """
    text = (quick_filter or "").strip()
    if not text:
        return None
    field, remainder = _split_quick_filter_field(text)
    if field is not None and field != "doc":
        return None
    return _fts_match_query(remainder if field is not None else text)


def _fts_match_query(value: str) -> Optional[str]:
    """Turn what someone typed into an FTS5 MATCH expression, or None if nothing usable is left.

    **Every token is quoted rather than passed through.** FTS5 MATCH is a query language — `AND`, `*`,
    `:`, `^`, parentheses and quotes all mean something — so raw input is both a syntax error waiting to
    happen (an unbalanced quote raises, which would surface as a 500 from a typo) and a way to write a
    query nobody asked for. Quoting each token makes it a literal phrase, so a receipt can be searched
    for `AND` or `store (west)` and get what it says.

    **Tokens match by prefix.** Every other quick-filter facet is a substring match, so an exact-word
    search here would behave differently from the box it shares — `doc:brak` finding nothing while
    `merchant:brak` finds Brake Co. Prefix is the closest FTS equivalent to typing-as-you-go.
    """
    tokens = [token for token in re.split(r"[^0-9A-Za-z\']+", value or "") if token]
    if not tokens:
        return None
    return " ".join(f'"{token}"*' for token in tokens)


def _normalize_quick_filter_text(value: str) -> str:
    return " ".join(re.sub(r"[()./_-]+", " ", str(value or "").strip().lower()).split())


def _parse_quick_filter_date(value: str) -> Optional[str]:
    text = (value or "").strip()
    if not text:
        return None
    formats = [
        "%Y-%m-%d",
        "%m/%d/%Y",
        "%m/%d/%y",
        "%m-%d-%Y",
        "%m-%d-%y",
        "%b %d %Y",
        "%b %d, %Y",
        "%B %d %Y",
        "%B %d, %Y",
    ]
    for fmt in formats:
        try:
            return datetime.strptime(text, fmt).date().isoformat()
        except ValueError:
            continue
    return None


def _parse_quick_filter_year_month(value: str) -> Optional[str]:
    text = (value or "").strip()
    if not text:
        return None
    formats = ["%Y-%m", "%m/%Y", "%m-%Y"]
    for fmt in formats:
        try:
            return datetime.strptime(text, fmt).date().strftime("%Y-%m")
        except ValueError:
            continue
    return None


def _parse_quick_filter_year(value: str) -> Optional[str]:
    # A bare 4-digit year (1900–2099) jumps to that year — handy for scrolling far back. It still
    # ORs with the amount match, so "2023" also finds $2,023.00–$2,023.99; the date-year clause is additive.
    text = (value or "").strip()
    return text if re.fullmatch(r"(?:19|20)\d{2}", text) else None


def _parse_quick_filter_month_day(value: str) -> Optional[str]:
    # A month/day with no year (mm/dd or mm-dd) returns "MM-DD" for an any-year match. Validated by
    # range rather than strptime so leap days like 2/29 are not rejected against an arbitrary year.
    match = re.fullmatch(r"\s*(\d{1,2})[/-](\d{1,2})\s*", value or "")
    if not match:
        return None
    month, day = int(match.group(1)), int(match.group(2))
    if 1 <= month <= 12 and 1 <= day <= 31:
        return f"{month:02d}-{day:02d}"
    return None


def _parse_quick_filter_month(value: str) -> Optional[str]:
    # A bare 1-12 returns the zero-padded month for an any-year match. It still ORs with the amount
    # match, so "9" also finds $9.00–$9.99; the date-month clause is additive.
    text = (value or "").strip()
    if re.fullmatch(r"\d{1,2}", text) and 1 <= int(text) <= 12:
        return f"{int(text):02d}"
    return None


_QUICK_FILTER_AMOUNT_RE = re.compile(r"([+-]?)(\d+(?:\.\d*)?|\.\d+)")


def _parse_quick_filter_amount(value: str) -> Optional[tuple[int, int, Optional[str]]]:
    """`(low_cents, high_cents, direction)` for text that reads as an amount, else None: the inclusive range of
    magnitudes, in cents, the typed text could still become. Direction is "out", "in" or None.

    **The dollars are exact and only the cents narrow as they are typed.** `77` is $77.00–$77.99, `77.4` is
    $77.40–$77.49 and `77.45` is exactly $77.45. An exact match found nothing until the last cent was in, so a
    $77.35 charge stayed hidden at "77" while a $77.00 one showed. The dollars are *not* a prefix: `7` is
    $7.00–$7.99 and never $70 or $700, which would flood the list at every keystroke. Past two decimals the
    value rounds to the cent, as it always did.

    **The sign is read the way a person writes it**, not the way it is stored: `-42.10` is money paid out,
    `+42.10` money received, and a bare `42.10` either. Accounting parentheses mean a minus. Storage runs the
    other way round (`amount > 0` is money out), and the flip belongs to the clause that compares against it.

    **Matched against a strict pattern rather than handed to `Decimal`**, which also accepts `inf`, `nan` and
    `1e3`: the first two then raised out of the list query, so typing the start of a name like "Nantucket"
    returned a server error, and the third silently searched for $1,000.
    """
    text = (value or "").strip().replace(",", "").replace("$", "")
    parenthesized = len(text) > 2 and text.startswith("(") and text.endswith(")")
    if parenthesized:
        text = text[1:-1]
    match = _QUICK_FILTER_AMOUNT_RE.fullmatch(text)
    if not match or (parenthesized and match.group(1)):
        return None
    sign = "-" if parenthesized else match.group(1)
    direction = {"-": "out", "+": "in"}.get(sign)
    digits = match.group(2)
    dollars, _, cents = digits.partition(".")
    if len(cents) >= 2:
        exact = int((Decimal(digits) * 100).quantize(Decimal("1")))
        return exact, exact, direction
    low = int(dollars or 0) * 100 + (int(cents) * 10 if cents else 0)
    return low, low + (9 if cents else 99), direction


def _build_transaction_filter(
    *,
    month=None, date_start=None, date_end=None, import_batch_id=None,
    account_id=None, source_account_ids=None, category_id=None, require_all_tag_ids=None,
    require_all_attribute_ids=None,
    direction=None, view=None, search=None, quick_filter=None, ids=None,
    sync_connection_id=None,
    needs_review=None, include_trashed=False, recurring_series_id=None,
    recurring_excluded_series_id=None, account_type=None, import_evidence_type=None,
    amount_min=None, amount_max=None, amount_min_op=None, amount_max_op=None,
    recurring_only=None,
    **facet_kwargs,
):
    # Single source of truth for the transaction-list WHERE clause, shared by the list feed and the
    # bulk endpoint so "select all matching the current filter" resolves the exact set the user sees.
    # Returns (clauses, params) against the alias set t(xn)/a(ccount)/p(arent account)/c(ategory)/
    # pc(parent category); any caller must JOIN those aliases identically.
    #
    # The facets arrive as **kwargs rather than as named parameters so that adding one is a change to
    # the registry alone. They are still checked against it, so a misspelled facet is a TypeError here
    # exactly as it would have been in an explicit signature — the looseness is in *which* names are
    # accepted, never in whether an unrecognized one is noticed.
    unknown = sorted(set(facet_kwargs) - FACET_PARAM_NAMES)
    if unknown:
        raise TypeError(f"_build_transaction_filter() got unexpected keyword argument(s): {', '.join(unknown)}")
    clauses: list[str] = []
    params: list = []
    if not include_trashed:
        clauses.append("t.trashed_at IS NULL")

    if date_start and date_end:
        clauses.append("t.date BETWEEN ? AND ?")
        params.extend([date_start, date_end])
    elif date_start:
        clauses.append("t.date >= ?")
        params.append(date_start)
    elif date_end:
        clauses.append("t.date <= ?")
        params.append(date_end)
    elif month:
        clauses.append("t.date LIKE ?")
        params.append(f"{month}%")
    if import_batch_id:
        clauses.append("t.import_batch_id = ?")
        params.append(import_batch_id)
    # isinstance guard mirrors the other filters: a direct (non-HTTP) call leaves an unset Query default
    # as a truthy FieldInfo, which must not trip this clause.
    if recurring_series_id and isinstance(recurring_series_id, str):
        clauses.append("t.recurring_series_id = ?")
        params.append(recurring_series_id)
    # "Any recurring series" — backs the Recurring page's all-series report. `is True` mirrors the
    # needs_review guard so a direct (non-HTTP) call with an unset Query default doesn't trip it.
    if recurring_only is True:
        clauses.append("t.recurring_series_id IS NOT NULL")
    # Rows the user explicitly removed from a series (an 'excluded' override) — for the "N removed" list
    # in that series' drill-down, so a mistaken removal is recoverable there and not just via the toast.
    if recurring_excluded_series_id and isinstance(recurring_excluded_series_id, str):
        clauses.append(
            "t.id IN (SELECT txn_id FROM recurring_membership_override WHERE series_id = ? AND state = 'excluded')"
        )
        params.append(recurring_excluded_series_id)
    # Explicit id set, used to re-fetch a specific group of rows by id (e.g. reconciling exactly the rows a
    # rule just recategorized back into an in-place list). Comma-separated to match the other multi filters;
    # the isinstance check mirrors the other multi-filters so a direct (non-HTTP) call with an unset Query
    # default doesn't trip the clause.
    if ids and isinstance(ids, str):
        id_list = [i.strip() for i in ids.split(',') if i.strip()]
        if id_list:
            clauses.append(f"t.id IN ({','.join('?' * len(id_list))})")
            params.extend(id_list)
    # Rows a connection's most recent sync added or revised — the connection card's "review what just
    # arrived" report, which opens the import-card ledger scoped to the pull rather than to the whole
    # calendar month the card covers.
    #
    # The ids are expanded **here, in SQL**, from the list the sync stored on the connection, rather than
    # sent by the client. Three reasons, and each one on its own is decisive: a few hundred uuids is ~10KB
    # of query string, past the default request-line limit and re-sent on every page and every sort; the
    # list would otherwise have to ride `GET /api/providers`, which is polled throughout a sync; and doing
    # it in the shared filter builder means the list feed and the bulk endpoint resolve the identical set,
    # which is what makes "select all matching" safe from this surface.
    #
    # Every missing case collapses to zero rows on its own — no stored summary, a summary from before this
    # existed, or a pull whose list exceeded the cap and was dropped. That is the honest answer rather than
    # a silent widening to the whole card: a report that quietly changes its own scope is worse than an
    # empty one. The client only offers the arrow in scoped mode when `scoped_rows` is non-zero, so the
    # empty case is reachable only by re-syncing while the drawer is open — where the rows really have
    # been replaced by a newer pull's.
    if sync_connection_id and isinstance(sync_connection_id, str):
        clauses.append("""t.id IN (
            SELECT je.value
            FROM   connection cn, json_each(json_extract(cn.last_sync_summary, '$.row_ids')) je
            WHERE  cn.id = ?
        )""")
        params.append(sync_connection_id)
    _append_single_account_filter(
        clauses, params, account_id=account_id, account_ids=facet_kwargs.get('account_ids'),
    )
    append_facets(clauses, params, facets_from(facet_kwargs))
    _append_source_account_filter(clauses, params, source_account_ids=source_account_ids)
    # Scope by the *effective* account type ('paypal'/'amazon'/…) — the money-movement report uses this
    # with `import_evidence_type` to list every row the type-scoped rule reaches.
    if account_type and isinstance(account_type, str):
        clauses.append("COALESCE(p.type, a.type) = ?")
        params.append(account_type)
    # Rows whose captured import evidence carries a specific `Type` value (the PayPal money-movement Type).
    # Matched case-insensitively against the extra_text_fields entry whose header is "Type".
    if import_evidence_type and isinstance(import_evidence_type, str):
        clauses.append(
            "EXISTS (SELECT 1 FROM json_each(json_extract(t.import_evidence_json, '$.extra_text_fields')) je "
            "WHERE LOWER(json_extract(je.value, '$.header')) = 'type' "
            "AND LOWER(json_extract(je.value, '$.value')) = ?)"
        )
        params.append(import_evidence_type.strip().lower())
    if _append_uncategorized_filter(clauses, params, category_id=category_id):
        pass
    elif category_id and category_id.startswith("__group__"):
        # The protected Unassigned group owns the expense-side uncategorized fallback bucket even though those rows persist as NULL.
        gid = category_id[len("__group__"):]
        clauses.append(
            """
            (
                t.category_id IN (SELECT id FROM category WHERE parent_id = ?)
                OR (
                    t.category_id IS NULL
                    AND t.amount > 0
                    AND EXISTS (
                        SELECT 1
                        FROM category
                        WHERE id = ?
                          AND system_key = ?
                    )
                )
            )
            """
        )
        params.extend([gid, gid, UNASSIGNED_CATEGORY_SYSTEM_KEY])
    elif category_id:
        clauses.append("t.category_id = ?")
        params.append(category_id)
    # group/category/tag/payee/owner include+exclude all route through the shared facet helpers so the
    # list feed and the summary/trend endpoints build one identical set definition per facet (and its
    # NULL-safe negation). Payee chips come from canonicalized labels in the UI, so matching honors
    # whichever merchant field currently carries the visible name; owner exposes the unowned bucket as a
    # first-class 'unassigned' value.
    _append_require_all_tags_filter(clauses, params, require_all_tag_ids=require_all_tag_ids)
    _append_require_all_attributes_filter(
        clauses, params, require_all_attribute_ids=require_all_attribute_ids,
    )
    if direction == "debit":
        clauses.append("t.amount > 0")
    elif direction == "credit":
        clauses.append("t.amount < 0")
    # Amount-magnitude filter (the Transactions ledger's amount popover). Mirrors the category-rule
    # amount condition: bounds compare against ABS(amount) while the debit/credit *side* is applied
    # separately through `direction` above — so "credit, >= $50" resolves to amount <= -50. Comparators
    # are whitelisted to the two the UI offers per bound (>=/> and <=/<) so they can be interpolated safely.
    # isinstance numeric guard mirrors the other filters: a direct (non-HTTP) call leaves an unset Query
    # default as a truthy FieldInfo, which `is not None` wouldn't catch (bool excluded — it's not a bound).
    if isinstance(amount_min, (int, float)) and not isinstance(amount_min, bool):
        op = ">" if str(amount_min_op) == ">" else ">="
        clauses.append(f"ABS(t.amount) {op} ?")
        params.append(float(amount_min))
    if isinstance(amount_max, (int, float)) and not isinstance(amount_max, bool):
        op = "<" if str(amount_max_op) == "<" else "<="
        clauses.append(f"ABS(t.amount) {op} ?")
        params.append(float(amount_max))
    if view == "spending":
        clauses.append(
            "(COALESCE(c.category_type, pc.category_type) = 'expense' "
            "OR (t.category_id IS NULL AND t.amount > 0))"
        )
    elif view == "income":
        clauses.append(
            "(COALESCE(c.category_type, pc.category_type) = 'income' "
            "OR (t.category_id IS NULL AND t.amount < 0))"
        )
    if view in ("spending", "income", "cash_flow"):
        # Cross-cutting dashboard scopes skip categories marked exclude_from_totals so transfers and
        # other bookkeeping moves don't pollute the listing of transactions backing a Dashboard total.
        # `cash_flow` takes no category-type clause above — it counts both directions — but it takes
        # this one, because a drill from a cash-flow node has to list exactly the rows that node's
        # figure was computed from. Pending rows go for the same reason: every summary endpoint leaves
        # them out, so a drill that kept them would list rows its figure never counted.
        clauses.append(
            "COALESCE(pc.exclude_from_totals, c.exclude_from_totals, 0) = 0"
        )
        clauses.append("t.is_pending = 0")
    if search:
        clauses.append("(t.display_name LIKE ? OR t.merchant_name LIKE ? OR t.raw_name LIKE ?)")
        params.extend([f"%{search}%", f"%{search}%", f"%{search}%"])
    if quick_filter:
        quick_filter_clause = _build_quick_filter_clause(quick_filter)
        if quick_filter_clause:
            clause, clause_params = quick_filter_clause
            clauses.append(clause)
            params.extend(clause_params)
    # "Needs review" is its own axis, independent of categorization: a rule-categorized row can still
    # need a look, and a reviewed row can be deliberately uncategorized. The `is True` mirrors the
    # isinstance guards above so a direct (non-HTTP) call with an unset Query default (a truthy
    # FieldInfo) doesn't trip the clause.
    if needs_review is True:
        clauses.append("t.needs_review = 1")
    return clauses, params


@router.get("/filter-attributes")
def list_filter_attributes():
    """The attribute vocabulary, labels included, so no UI surface keeps its own copy.

    Both consumers read this: the FilterBar's Attributes tab (multi-select, with "is not") and the
    Transactions toolbar's single-select quick filter. Serving the labels rather than only the keys is
    what makes adding an attribute a one-place change — a parallel label table in the frontend would be
    a second list to keep in step, which is the duplication this whole seam exists to remove.
    """
    return attribute_vocabulary()


def transaction_list_filters(
    month:        Optional[str] = Query(None, description="YYYY-MM"),
    date_start:   Optional[str] = Query(None, description="YYYY-MM-DD"),
    date_end:     Optional[str] = Query(None, description="YYYY-MM-DD"),
    import_batch_id: Optional[str] = Query(None),
    account_id:   Optional[str] = Query(None),
    source_account_ids: Optional[str] = Query(None),
    category_id:  Optional[str] = Query(None),
    require_all_tag_ids: Optional[str] = Query(None),
    require_all_attribute_ids: Optional[str] = Query(None),
    direction:    Optional[str] = Query(None),
    view:         Optional[str] = Query(None),
    search:       Optional[str] = Query(None),
    quick_filter: Optional[str] = Query(None),
    ids:          Optional[str] = Query(None),
    sync_connection_id: Optional[str] = Query(None),
    recurring_series_id: Optional[str] = Query(None),
    recurring_only: bool          = Query(False),
    recurring_excluded_series_id: Optional[str] = Query(None),
    amount_min:   Optional[float] = Query(None),
    amount_max:   Optional[float] = Query(None),
    amount_min_op: Optional[str]  = Query(">="),
    amount_max_op: Optional[str]  = Query("<="),
    account_type: Optional[str] = Query(None),
    import_evidence_type: Optional[str] = Query(None),
    needs_review: bool          = Query(False),
    include_trashed: bool       = Query(False),
) -> dict:
    """The list feed's non-facet filters as a dependency, for an endpoint that must resolve the same rows.

    Each parameter means exactly what it does on `GET /transactions`. `list_transactions` keeps its own
    explicit signature, which its direct callers rely on, so this is a second declaration of that list —
    `tests/test_export_matches_ledger.py` asserts the two name the same filters, because a filter missing
    here does not error: the endpoint silently ignores it and answers with a wider set.
    """
    return dict(locals())


def transaction_list_scope(*, facets, sort_by, sort_dir, filters: dict) -> tuple[str, list, bool, str]:
    """The list feed's WHERE clause, row-source expansion and ORDER BY for one set of filters.

    Shared by the feed and the CSV export, so a download of what the ledger shows is the same rows in the
    same order — split parts under a category scope included — rather than a second reading of the
    filters. Returns `(where, params, expand_splits, order_by)`; the caller selects
    `FROM txn_effective_sql(conn, expand=expand_splits) t` with the builder's joins (a, p, c, pc).
    """
    facets = coerce_facets(facets) or TransactionFacets()
    clauses, params = _build_transaction_filter(**filters, **facets.as_params())

    # A category-shaped facet is what makes split expansion correct *here*. Scoped to a category, a
    # split transaction belongs in the result as the part that matched, carrying the part's amount — so
    # a drill-down's visible rows sum to the total its summary endpoint reported. Unscoped, the ledger
    # must stay one row per purchase, so the plain table is the row source and a split renders once at
    # its full amount (`is_split` / `split_part_count` drive the "Split (N)" affordance). `view` counts
    # because every cross-cutting scope resolves through the category: spending/income through its type,
    # and cash_flow through its exclude_from_totals guard, which a split's parts can straddle. See
    # services/txn_splits.py.
    expand_splits = bool(
        filters.get("category_id") or facets.category_ids or facets.group_ids
        or facets.exclude_category_ids or facets.exclude_group_ids
        or filters.get("view") in ("spending", "income", "cash_flow")
    )
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""

    sort_key = sort_by if sort_by in TRANSACTION_SORT_SQL else "date"
    sort_direction = "ASC" if str(sort_dir).lower() == "asc" else "DESC"
    order_by_parts = []
    # Sorting stays server-backed so filtered transaction views remain stable even when the page incrementally loads
    # additional rows. Text columns use explicit expressions here because the visible labels come from derived fields.
    if sort_key == "category":
        order_by_parts.append("CASE WHEN t.category_id IS NULL THEN 1 ELSE 0 END ASC")
    order_by_parts.append(f"{TRANSACTION_SORT_SQL[sort_key]} {sort_direction}")
    if sort_key != "date":
        order_by_parts.append("t.date DESC")
    order_by_parts.append("t.id DESC")
    return where, params, expand_splits, ", ".join(order_by_parts)


@router.get("")
def list_transactions(
    month:        Optional[str] = Query(None, description="YYYY-MM"),
    date_start:   Optional[str] = Query(None, description="YYYY-MM-DD"),
    date_end:     Optional[str] = Query(None, description="YYYY-MM-DD"),
    import_batch_id: Optional[str] = Query(None),
    sort_by:      Optional[str] = Query("date", description="date | merchant | category | account | amount"),
    sort_dir:     Optional[str] = Query("desc", description="asc | desc"),
    account_id:   Optional[str] = Query(None),
    facets:       TransactionFacets = Depends(),
    source_account_ids: Optional[str] = Query(None, description="comma-separated source (original) account IDs — narrows a merged-account view to specific underlying accounts"),
    category_id:  Optional[str] = Query(None),
    require_all_tag_ids:  Optional[str] = Query(None, description="comma-separated tag IDs the row must ALL have (AND), independent of tag_ids"),
    require_all_attribute_ids: Optional[str] = Query(None, description="comma-separated attribute keys the row must ALL carry (AND), independent of attribute_ids"),
    direction:    Optional[str] = Query(None, description="debit | credit"),
    view:         Optional[str] = Query(None, description="spending | income | cash_flow — mirrors monthly-trend's cross-cutting dashboard scope"),
    search:       Optional[str] = Query(None),
    quick_filter: Optional[str] = Query(None),
    ids:          Optional[str] = Query(None, description="comma-separated transaction IDs — re-fetch a specific set of rows"),
    sync_connection_id: Optional[str] = Query(None, description="Only rows this connection's most recent sync added or revised. The id list is expanded server-side from the stored sync summary; matches nothing once a newer sync has replaced it."),
    recurring_series_id: Optional[str] = Query(None, description="Only rows linked to this recurring series (its members)."),
    recurring_only: bool          = Query(False, description="Only rows linked to any recurring series (recurring_series_id IS NOT NULL)."),
    recurring_excluded_series_id: Optional[str] = Query(None, description="Only rows the user removed from this series (an 'excluded' override)."),
    amount_min:   Optional[float] = Query(None, description="Lower amount-magnitude bound; compares against ABS(amount). Pair with amount_min_op."),
    amount_max:   Optional[float] = Query(None, description="Upper amount-magnitude bound; compares against ABS(amount). Pair with amount_max_op."),
    amount_min_op: Optional[str]  = Query(">=", description="Lower-bound comparator: '>=' (default) or '>'."),
    amount_max_op: Optional[str]  = Query("<=", description="Upper-bound comparator: '<=' (default) or '<'."),
    account_type: Optional[str] = Query(None, description="Only rows whose effective account is of this type (e.g. 'paypal')."),
    import_evidence_type: Optional[str] = Query(None, description="Only rows whose captured import evidence carries this `Type` value (PayPal money-movement report)."),
    needs_review: bool          = Query(False, description="Only rows still flagged as needing review (freshly imported/synced, not yet looked over)."),
    include_trashed: bool       = Query(False, description="Include rows in the trash. Off by default — the trash view sets this explicitly."),
    limit:        int           = Query(200, ge=0, le=1000, description="rows per page (max 1000); 0 = no limit — returns all matching rows, for known-bounded scopes only"),
    offset:       int           = Query(0),
):
    # Direct (non-HTTP) callers may omit the dependency; over HTTP FastAPI always supplies it.
    facets = coerce_facets(facets) or TransactionFacets()
    # This endpoint is the UI's lossless transaction feed, so filters narrow the raw rows but do not apply the
    # reporting rules used by summaries such as excluding pending transactions or normalizing amount direction.
    # The exception is `view`, which asks for exactly the rows behind a Dashboard figure and so takes the
    # summaries' exclusions (see _build_transaction_filter); the sign is still left to the caller.
    where, params, expand_splits, order_by = transaction_list_scope(
        facets=facets, sort_by=sort_by, sort_dir=sort_dir,
        filters=dict(
            month=month, date_start=date_start, date_end=date_end, import_batch_id=import_batch_id,
            account_id=account_id, source_account_ids=source_account_ids,
            category_id=category_id, require_all_tag_ids=require_all_tag_ids,
            require_all_attribute_ids=require_all_attribute_ids,
            direction=direction, view=view, search=search, quick_filter=quick_filter, ids=ids,
            sync_connection_id=sync_connection_id,
            needs_review=needs_review, include_trashed=include_trashed, recurring_series_id=recurring_series_id,
            recurring_only=recurring_only,
            recurring_excluded_series_id=recurring_excluded_series_id,
            account_type=account_type, import_evidence_type=import_evidence_type,
            amount_min=amount_min, amount_max=amount_max,
            amount_min_op=amount_min_op, amount_max_op=amount_max_op,
        ),
    )

    # Why a row came back, for the rows whose reason is invisible. Each is projected only when the filter
    # actually has that component, so the ordinary listing pays nothing for it.
    doc_query = document_match_query(quick_filter)
    document_match_column = f"{DOCUMENT_MATCH_SQL} AS matched_document," if doc_query else ""
    document_match_params = [doc_query] if doc_query else []
    hidden_text_match = hidden_text_match_sql(quick_filter)
    if hidden_text_match:
        document_match_column += f" {hidden_text_match[0]} AS matched_hidden_text,"
        document_match_params += hidden_text_match[1]

    with get_db() as conn:
        _src = txn_effective_sql(conn, expand=expand_splits)
        # Count *and* signed net sum over the whole filtered set, not just the returned page — so a
        # caller can show a correct total/count for a scope larger than the page limit instead of
        # summing the capped `transactions` client-side (which silently undercounts past the limit).
        agg = conn.execute(
            f"""
            SELECT COUNT(*) AS count, COALESCE(SUM(t.amount), 0) AS sum_amount
            FROM {_src} t
            JOIN account a ON a.id = t.account_id
            LEFT JOIN account p ON p.id = a.parent_account_id
            LEFT JOIN category c ON c.id = t.category_id
            LEFT JOIN category pc ON pc.id = c.parent_id
            {where}
            """,
            params
        ).fetchone()
        total = agg["count"]
        sum_amount = agg["sum_amount"]

        # limit=0 is the explicit "no limit / all matching rows" opt-in; SQLite treats LIMIT -1 as unbounded.
        sql_limit = limit if limit > 0 else -1
        rows = conn.execute(
            f"""
            SELECT
                t.id, t.date, t.amount, t.merchant_name, t.display_name, t.raw_name,
                t.is_pending, t.category_overridden, t.category_source, t.notes,
                COALESCE(a.parent_account_id, a.id) AS account_id,
                t.account_id  AS source_account_id,
                t.owner_id,
                COALESCE(a.display_name, a.name) AS account_name,
                COALESCE(p.mask, a.mask)         AS account_mask,
                a.name                            AS source_account_raw_name,
                t.import_batch_id,
                -- Whether the row came from a provider, which with `import_batch_id` is how a
                -- hand-entered row is told apart (see `data-model.md` → *Transactions*). The detail
                -- panel's amount editor is offered on those rows only.
                t.external_transaction_id,
                t.import_evidence_json,
                t.imported_category,
                t.category_id,
                c.name        AS category_name,
                NULL          AS category_color,
                COALESCE(pc.exclude_from_totals, c.exclude_from_totals, 0) AS excluded_from_totals,
                b.filename    AS import_batch_filename,
                b.imported_at AS import_batch_imported_at,
                -- Data-source (sync) provenance for the origin hover: the provider names which
                -- connection a synced row came from, so two same-institution connections (both
                -- labeled e.g. "Northgate") are still tellable apart. Read from the card, not the
                -- connection, so it outlives a removed connection. NULL for CSV/manual batches.
                b.provider    AS import_batch_provider,
                (b.provider IS NOT NULL AND b.connection_id IS NULL) AS import_batch_connection_removed,
                o.name        AS owner_name,
                o.color       AS owner_color,
                t.suspect_duplicate_of,
                t.suspect_duplicate_reason,
                t.needs_review,
                t.recurring_series_id,
                rs.display_name AS recurring_series_name,
                rs.rule_id      AS recurring_rule_id,
                -- The series (if any) this row was manually removed from, so the row menu can offer a
                -- targeted "Restore to recurring series". Grouped subquery → one row per txn (no fan-out);
                -- MIN picks a stable one in the rare multi-exclude case.
                rex.series_id    AS recurring_excluded_series_id,
                rxs.display_name AS recurring_excluded_series_name,
                {document_match_column}
                t.is_split,
                -- Which allocation this row is, when the row source is expanded (NULL otherwise). It
                -- is what makes an expanded row identifiable and what tells the ledger it is holding
                -- one part rather than a whole split. See services/txn_splits.py.
                {split_part_id_sql(expand=expand_splits)} AS split_part_id
            FROM   {_src} t
            JOIN   account  a ON a.id = t.account_id
            LEFT JOIN account  p ON p.id = a.parent_account_id
            LEFT JOIN category c ON c.id = t.category_id
            LEFT JOIN category pc ON pc.id = c.parent_id
            LEFT JOIN import_batch b ON b.id = t.import_batch_id
            LEFT JOIN recurring_series rs ON rs.id = t.recurring_series_id
            LEFT JOIN (
                SELECT txn_id, MIN(series_id) AS series_id
                FROM   recurring_membership_override WHERE state = 'excluded' GROUP BY txn_id
            ) rex ON rex.txn_id = t.id
            LEFT JOIN recurring_series rxs ON rxs.id = rex.series_id
            LEFT JOIN owner    o ON o.id = t.owner_id
            {where}
            ORDER BY {order_by}
            LIMIT ? OFFSET ?
            """,
            document_match_params + params + [sql_limit, offset],
        ).fetchall()
        transactions = [dict(r) for r in rows]
        txn_ids = [txn["id"] for txn in transactions]
        tag_map = get_visible_transaction_tag_map(conn, txn_ids) if rows else {}
        blocked_map = get_blocked_transaction_tag_map(conn, txn_ids) if rows else {}
        # A split row's allocations, for its "Split (N)" label and the hover that lists the parts. One
        # query for the page rather than one per row, and only for the rows that are actually split.
        split_parts = get_split_parts_map(conn, [t["id"] for t in transactions if t.get("is_split")])
        # The documents on each row, for the ledger's paperclip — which names them and opens them, so it
        # needs more than a count. Slim rows only (no extracted text, which can run to hundreds of
        # kilobytes no list surface renders), carried inline for the same reason `split_parts` is: the
        # marker opens straight from the row, and a fetch there would be a loading state inside a click.
        documents_by_txn = documents_map_for(conn, txn_ids) if rows else {}
        # The purchase each row is a payment of, for the row's link marker. A *summary* per row (label,
        # ordinal, totals) rather than the sibling payments: this marker explains the row rather than
        # acting on it, so the panel is where the payments are listed. See services/purchase_links.py.
        purchases_by_txn = purchase_map_for(conn, txn_ids) if rows else {}
        # The reimbursements each row has a share in, for the row's marker. A **list**, because a split
        # row can be part of several — two friends' shares of one charge, a deposit repaying both — so a
        # singular field would name one and hide the rest. See services/reimbursements.py.
        reimbursements_by_txn = reimbursement_map_for(conn, txn_ids) if rows else {}
        for txn in transactions:
            txn["tags"] = tag_map.get(txn["id"], [])
            # Tags the user hid on this row (inherited/rule opt-out); the picker offers them for restore.
            txn["blocked_tags"] = blocked_map.get(txn["id"], [])
            parts = split_parts.get(txn["id"], [])
            txn["split_parts"] = parts
            txn["split_part_count"] = len(parts)
            docs = documents_by_txn.get(txn["id"], [])
            txn["documents"] = docs
            txn["document_count"] = len(docs)
            txn["purchase"] = purchases_by_txn.get(txn["id"])
            txn["reimbursements"] = reimbursements_by_txn.get(txn["id"], [])

    return {
        "total": total,
        "sum_amount": sum_amount,
        "limit": limit,
        "offset": offset,
        "transactions": transactions,
    }


def _reject_group_category_assignment(conn, category_id: Optional[str]) -> None:
    # Transactions are only ever assigned to leaf categories; a top-level group is a reporting rollup,
    # not an assignable bucket. This single guard holds across every assignment entry point (manual
    # override, import re-pin), so a group that shares a leaf's name can never become a txn's category.
    if not category_id:
        return
    row = conn.execute(
        "SELECT parent_id FROM category WHERE id = ?", (category_id,)
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Category not found")
    if row["parent_id"] is None:
        raise HTTPException(
            status_code=400,
            detail="Transactions can only be assigned to a category, not a group.",
        )


def _require_calendar_date(value: Optional[str]) -> str:
    # A hand-entered date has to name a real day, not merely look like one: `2026-02-31` passes the shape
    # check and then sorts and buckets as a date that does not exist. `strptime` is the same calendar check
    # the import path parses every file date with.
    text = (value or "").strip()
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
        raise HTTPException(status_code=400, detail="date must be YYYY-MM-DD")
    try:
        datetime.strptime(text, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(status_code=400, detail=f"{text} is not a real date")
    return text


def _resolved_tags_response(conn, txn_id: str) -> dict:
    """A transaction's effective tags, for an endpoint that just changed what they resolve from.

    Tag inheritance is resolved per transaction from the leaf category, its group and the effective
    account, so *changing the category changes the tags* — but only the server can say to what. An
    endpoint that answers `{"ok": True}` leaves the client's row holding the previous category's
    inherited tags with no way to know it, and nothing else on the page refetches the row. Returning
    the resolved set is what lets the caller's in-place patch stay honest; it mirrors what the tag
    PATCH already returns, so the client has one shape to reconcile from either write.
    """
    return {
        "tags": list_visible_transaction_tags(conn, txn_id),
        "blocked_tags": get_blocked_transaction_tag_map(conn, [txn_id]).get(txn_id, []),
    }


# A row's `content_hash` is `make_hash(date, amount, description)`, so any edit to its date or amount
# stales it unless it is recomputed — and it is the exact-match rung of duplicate detection
# (`services/duplicate_detection.py`), the mechanism by which a later import or sync of the same charge
# recognizes a row already held. The description it was hashed with is the row's own `raw_name`, falling
# back to `merchant_name`: CSV import hashes the file's raw description and stores it verbatim as
# `raw_name`, a hand entry hashes the payee it writes to all three name fields, and sync hashes this
# exact expression. `display_name` is deliberately not in it, which is what lets a rename leave a hash
# alone.
#
# **A marketplace row is the exception, and its hash must be left as it is.** That importer digests the
# *order id* rather than a description (`import_export/amazon.py`), so recomputing one from a name would
# write a digest matching nothing — strictly worse than a stale one, since a stale hash at least still
# matches the source that produced it.
_MARKETPLACE_SOURCE_KIND_PREFIX = "marketplace:"


def _hashed_description(row) -> str:
    return row["raw_name"] or row["merchant_name"] or ""


# --- Manual entry ------------------------------------------------------------------------------
# Cash, a cheque, a charge on an account nothing syncs. The data model has always allowed for it —
# `external_transaction_id` and `needs_review` both name hand-entered rows in their own definitions, and
# duplicate detection already treats a row with no import batch as a legitimate candidate rather than
# withholding it. What was missing was only the way in.


class TransactionCreate(BaseModel):
    account_id: str
    # YYYY-MM-DD, matching the bulk date setter and what the ledger stores.
    date: str
    # **Signed, in the ledger's convention** (`amount > 0` is money out), like every other amount the API
    # carries. A person types a magnitude, so the direction is chosen in the UI and applied there before
    # the request is made — the same boundary `signedExpectedTotal` draws for a purchase total, and the
    # reason it is drawn there is that the derived figure can be shown back before it is saved.
    amount: float
    payee: str
    category_id: Optional[str] = None
    notes: Optional[str] = None


@router.post("")
def create_transaction(body: TransactionCreate):
    """Record a transaction by hand.

    Two decisions are worth stating because neither is visible in the row afterwards:

    **The content hash is the *same* function the importers use.** That is what lets a later import or
    sync of the same charge recognize the hand-entered row as its duplicate — the behavior duplicate
    detection already documents. A second hash implementation here would compute a different digest for
    identical data and the match would silently never happen.

    **An uncategorized entry is run through the rules**, exactly as an imported row is. Skipping it would
    drop every hand-entered transaction into the uncategorized pile the app then nags about, for no
    reason other than which door it came through.
    """
    # Local import: the hash belongs to the import pipeline and is shared rather than reimplemented (see
    # the docstring). Imported inside the function to keep this router free of a load-order dependency
    # on the import package.
    from backend.routers.import_export.core import make_hash

    payee = (body.payee or "").strip()
    if not payee:
        raise HTTPException(status_code=400, detail="A payee or description is required")
    date = _require_calendar_date(body.date)
    amount = round(float(body.amount), 2)
    if amount == 0:
        raise HTTPException(status_code=400, detail="A transaction needs an amount")

    with get_db() as conn:
        account = conn.execute(
            "SELECT id, owner_id, trashed_at FROM account WHERE id = ?", (body.account_id,)
        ).fetchone()
        if not account:
            raise HTTPException(status_code=404, detail="Account not found")
        if account["trashed_at"]:
            raise HTTPException(status_code=400, detail="That account is in the trash")

        category_id = (body.category_id or "").strip() or None
        if category_id:
            category = conn.execute(
                "SELECT id, parent_id, is_active FROM category WHERE id = ?", (category_id,)
            ).fetchone()
            if not category:
                raise HTTPException(status_code=404, detail="Category not found")
            if category["parent_id"] is None:
                raise HTTPException(status_code=400, detail="Choose a category, not a group")
            if "is_active" in category.keys() and not category["is_active"]:
                raise HTTPException(status_code=400, detail="That category has been deleted")

        txn_id = str(uuid.uuid4())
        conn.execute(
            """
            INSERT INTO txn
              (id, account_id, owner_id, category_id, amount, merchant_name, display_name, raw_name,
               date, is_pending, content_hash, category_overridden, category_source,
               display_name_source, needs_review)
            VALUES (?,?,?,?,?,?,?,?,?,0,?,?,?,'manual',0)
            """,
            (
                txn_id,
                account["id"],
                # The owner follows the account, the same rule the importers apply.
                account["owner_id"],
                category_id,
                amount,
                payee,
                payee,
                payee,
                date,
                make_hash(date, amount, payee),
                1 if category_id else 0,
                "manual" if category_id else None,
            ),
        )
        if body.notes and body.notes.strip():
            conn.execute("UPDATE txn SET notes = ? WHERE id = ?", (body.notes.strip(), txn_id))
        if not category_id:
            recategorize_all(conn, txn_ids=[txn_id])
        # The recurring detector's membership cache is only rewritten by a scan, and none of its
        # triggers cover a row appearing outside an import — so a hand-entered charge would never join
        # the series it belongs to without this.
        rescan_edited_transactions(conn, [txn_id])
        row = conn.execute(
            """SELECT t.id, t.date, t.amount, t.display_name, t.category_id, t.notes,
                      COALESCE(c.name, '') AS category_name
               FROM   txn t LEFT JOIN category c ON c.id = t.category_id
               WHERE  t.id = ?""",
            (txn_id,),
        ).fetchone()
    return dict(row)


# --- Correcting a hand-entered amount -------------------------------------------------------------
# The figure typed wrongly and noticed a moment later. Offered on hand-entered rows only and refused on
# two of those; `frontend/src/lib/amountEdit.js` carries the reasoning in full, and the client derives
# its own affordance from the same three conditions while this refuses independently — which is what
# holds for every caller rather than only for the shipped client.


class AmountUpdate(BaseModel):
    # Signed, in the ledger's convention (`amount > 0` is money out), like every other amount the API
    # carries. A magnitude and its direction are separate controls on screen and are combined before the
    # request is made, the same boundary the manual-entry form draws (`lib/manualTransaction.js`).
    amount: float


def _amount_edit_refusal(conn, row) -> Optional[str]:
    """Why this row's amount may not be changed in place, or None where it may.

    Phrased as sentences for the user because they are what the panel shows: the invariants live on this
    side, and a second phrasing of them in the client is the thing that drifts. The order is deliberate —
    a row can fail more than one of these, and the first is the one worth saying (`ui-patterns.md` → the
    disabled-control rule).

    The two refusals are the expensive cases, and both fail *silently*: a split's parts are checked
    against the transaction's amount only when the split is saved, and a reimbursement's claims against
    what the row has receivable only when the claim is made. Nothing re-checks either afterwards, so an
    amount moved out from under one leaves a split that no longer sums and an outstanding report whose
    headline has quietly stopped being true.
    """
    if row["import_batch_id"] or row["external_transaction_id"]:
        return "The amount can only be edited for a manually entered transaction."
    if row["is_split"]:
        return ("Cannot edit the amount of a split transaction.")
    if reimbursements_for_txn(conn, row["id"]):
        return "Cannot edit the amount of a transaction that is part of a reimbursement."
    return None


@router.patch("/{txn_id}/amount")
def update_amount(txn_id: str, body: AmountUpdate):
    """Correct the amount of a hand-entered transaction.

    **The content hash is restamped with it**, for the reason `_hashed_description` above gives: it
    digests the amount, and left alone it would go on describing a figure the row no longer has. For a
    hand-entered row the restamp is strictly an improvement — the corrected figure is the one a future
    source describing the same charge will carry.

    **The rules are re-run.** An amount is a rule condition (a range scoped to debits or credits), so a
    corrected figure can genuinely belong to a different rule than the typo did. `recategorize_all`
    leaves a category set by hand alone, so this re-derives only what a rule owned in the first place —
    and the answer carries the category back because it may have moved.
    """
    from backend.routers.import_export.core import make_hash

    amount = round(float(body.amount), 2)
    if amount == 0:
        raise HTTPException(status_code=400, detail="A transaction needs an amount")

    with get_db() as conn:
        row = conn.execute(
            """SELECT id, date, amount, raw_name, merchant_name, is_split,
                      import_batch_id, external_transaction_id
               FROM   txn WHERE id = ?""",
            (txn_id,),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Transaction not found")
        refusal = _amount_edit_refusal(conn, row)
        if refusal:
            raise HTTPException(status_code=400, detail=refusal)

        conn.execute(
            "UPDATE txn SET amount = ?, content_hash = ? WHERE id = ?",
            (amount, make_hash(row["date"], amount, _hashed_description(row)), txn_id),
        )
        recategorize_all(conn, txn_ids=[txn_id])
        # Membership, the expected-amount band, and which charge on a crowded date represents a series
        # are all read off the amount, and only a scan rewrites them — the same reason the manual insert
        # calls this.
        rescan_edited_transactions(conn, [txn_id])
        updated = conn.execute(
            """SELECT t.id, t.date, t.amount, t.display_name, t.category_id, t.notes,
                      COALESCE(c.name, '') AS category_name
               FROM   txn t LEFT JOIN category c ON c.id = t.category_id
               WHERE  t.id = ?""",
            (txn_id,),
        ).fetchone()
    return dict(updated)


@router.patch("/{txn_id}/category")
def override_category(txn_id: str, body: CategoryOverride):
    with get_db() as conn:
        txn = conn.execute(
            "SELECT id, is_split, category_id FROM txn WHERE id = ?", (txn_id,)
        ).fetchone()
        if not txn:
            raise HTTPException(status_code=404, detail="Transaction not found")
        # A split transaction has no single category to set — its allocations are the categorization.
        # Refusing here rather than silently discarding them keeps un-splitting an explicit act; the UI
        # opens the split editor from this row instead of the category picker.
        if txn["is_split"]:
            raise HTTPException(
                status_code=400,
                detail="This transaction is split across categories. Remove the split before setting a single category.",
            )
        _reject_group_category_assignment(conn, body.category_id)

        conn.execute(
            """
            UPDATE txn
            SET category_id = ?, category_overridden = 1, category_source = 'manual', notes = ?,
                needs_review = 0
            WHERE id = ?
            """,
            (body.category_id, body.notes, txn_id),
        )
        # Category is part of a derived series' identity, so a manual recategorization can move a row
        # between series — or out of one. Membership is a cache only a scan rewrites (see
        # rescan_edited_transactions), and nothing else re-runs after a hand edit. Gated on the category
        # actually changing: a re-save of the same category is a common no-op (the picker fires on every
        # confirm) and a scan costs a pass over the whole detection window.
        if body.category_id != txn["category_id"]:
            rescan_edited_transactions(conn, [txn_id])
        resolved = _resolved_tags_response(conn, txn_id)
    return {"ok": True, **resolved}


# --- Splits -----------------------------------------------------------------------------------
# Allocating one transaction's amount across several categories. The invariants (parts sum to the
# amount, share its sign) and the reporting expansion they feed live in
# services/txn_splits.py; these endpoints are the editor's surface onto them.


@router.get("/{txn_id}/split")
def get_transaction_split(txn_id: str):
    with get_db() as conn:
        txn = conn.execute(
            "SELECT id, amount, is_split FROM txn WHERE id = ?", (txn_id,)
        ).fetchone()
        if not txn:
            raise HTTPException(status_code=404, detail="Transaction not found")
        return {
            "txn_id": txn_id,
            "amount": txn["amount"],
            "is_split": bool(txn["is_split"]),
            "parts": get_split_parts(conn, txn_id),
        }


@router.put("/{txn_id}/split")
def save_transaction_split(txn_id: str, body: SplitSave):
    """Replace a transaction's allocations. Validation failures come back as 400s carrying the reason in
    the user's terms — a remainder that has not reached zero, a repeated category, a part pointing the
    wrong direction — because every one of them is something the editor can show and the user can fix."""
    with get_db() as conn:
        try:
            parts = save_split(conn, txn_id, [p.model_dump() for p in body.parts])
        except SplitValidationError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
    return {"txn_id": txn_id, "is_split": True, "parts": parts}


@router.delete("/{txn_id}/split")
def delete_transaction_split(txn_id: str):
    """Un-split a transaction, restoring the category it carried before the split."""
    with get_db() as conn:
        row = conn.execute("SELECT id FROM txn WHERE id = ?", (txn_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Transaction not found")
        clear_split(conn, txn_id)
    return {"ok": True}


@router.get("/{txn_id}/split/suggestion")
def suggest_transaction_split(txn_id: str):
    """A proposed allocation for a transaction whose import captured per-item detail.

    The items carry **list prices** while the transaction carries what was actually paid (net of refunds,
    inclusive of tax, shipping and any promo), so the two do not agree. The suggestion therefore
    distributes the real amount across the items by list-price share rather than using the list figures
    as amounts — which spreads tax and shipping proportionally instead of parking them on one item.

    It is a starting point, never applied on its own: parts arrive without categories for the user to
    fill in, and an item the export priced at nothing arrives with a null amount rather than a guess.
    `available` is false when there is nothing to propose — no captured item detail, no cash to
    distribute (a points- or gift-card-funded order), or no priced items to weight by.
    """
    with get_db() as conn:
        txn = conn.execute(
            "SELECT id, amount, owner_id, account_id, import_evidence_json FROM txn WHERE id = ?",
            (txn_id,),
        ).fetchone()
        if not txn:
            raise HTTPException(status_code=404, detail="Transaction not found")
        evidence = safe_json_dict(txn["import_evidence_json"])
        items = parse_item_evidence(evidence)
        # Weighted by the *extended* list price (unit price × quantity), not the unit price: the export
        # prices one of a thing, so weighting by it alone gives a line the user bought six of the same
        # share as a line they bought one of, and pushes the tax/shipping spread onto the single items.
        amounts = proportional_allocation(float(txn["amount"]), [i["extended_price"] for i in items])
        if not amounts:
            return {"available": False, "parts": []}
        # The list figures ride along with each proposed amount so the editor can *show its working*:
        # a share is otherwise an unexplained number, and the arithmetic behind it (this item's list
        # price against the sum of them, applied to what was actually paid) is exactly what makes it
        # trustworthy or obviously wrong at a glance.
        # Each item's own description is run through the user's ordinary categorization rules, so an
        # order of a dozen things arrives mostly classified instead of as a dozen empty pickers. The
        # rules are the right source precisely because they are the user's — the marketplace's own
        # taxonomy stays unused, as everywhere else in this importer.
        #
        # It stays a *proposal*: a line no rule claims comes back with no category rather than a guess,
        # and nothing is written until the user saves. The item's own share is what the matcher sees,
        # since a rule may be scoped by amount or by debit/credit and the line — not the whole order —
        # is what it would be classifying. An item the export never priced has no share to offer, so it
        # is left for the user rather than matched against a number that does not exist.
        rules = load_categorization_rules(conn)
        proposed = []
        for item, amount in zip(items, amounts):
            category_id = None
            if amount is not None:
                match = categorize_transaction(
                    item["description"], item["description"], item["description"],
                    amount, conn,
                    owner_id=txn["owner_id"], account_id=txn["account_id"], rules=rules,
                )
                category_id = (match or {}).get("category_id")
            proposed.append({
                "label": item["description"],
                "amount": amount,
                "category_id": category_id,
                "unit_price": item["price"],
                "quantity": item["quantity"],
                "list_price": item["extended_price"],
            })
        return {
            "available": True,
            "list_total": round(sum(i["extended_price"] or 0 for i in items), 2),
            "categorized": sum(1 for p in proposed if p["category_id"]),
            "parts": proposed,
        }


# --- Multi-payment purchases -------------------------------------------------------------------
# The one transaction-scoped read of a purchase link: what purchase, if any, this row is a payment of.
# Everything that acts on a purchase is addressed by the purchase's own id — see routers/purchases.py.


@router.get("/{txn_id}/purchase")
def get_transaction_purchase(txn_id: str):
    with get_db() as conn:
        if not conn.execute("SELECT 1 FROM txn WHERE id = ?", (txn_id,)).fetchone():
            raise HTTPException(status_code=404, detail="Transaction not found")
        return {"purchase": purchase_for_txn(conn, txn_id)}


# --- Reimbursable expenses ----------------------------------------------------------------------
# The transaction-scoped read, and the reason it carries `receivable` alongside the link: a row holding
# money in the Reimbursable group is a receivable whether or not anything has been linked to it yet, so
# the panel has something true to say about an unlinked row — which is the state every reimbursement
# starts in. Everything that acts on a reimbursement is addressed by its own id, in
# routers/reimbursements.py.


@router.get("/{txn_id}/reimbursement")
def get_transaction_reimbursement(txn_id: str):
    with get_db() as conn:
        if not conn.execute("SELECT 1 FROM txn WHERE id = ?", (txn_id,)).fetchone():
            raise HTTPException(status_code=404, detail="Transaction not found")
        return {
            # A list: one row may be split between several reimbursements — two friends' shares of a
            # charge, or an ATM deposit repaying two debts — so a singular field here would pick one and
            # hide the rest.
            "reimbursements": reimbursements_for_txn(conn, txn_id),
            "receivable": receivable_amounts(conn, [txn_id]).get(txn_id, 0.0),
            "unclaimed": unclaimed_amounts(conn, [txn_id]).get(txn_id, 0.0),
            "parts": receivable_parts(conn, txn_id),
        }


@router.patch("/{txn_id}/imported-category")
def set_imported_category(txn_id: str, body: CategoryOverride):
    # Used by the import rule-suggestions review to re-pin an imported transaction's category as a
    # *corrected file categorization*: keep category_source='import' (so it still drives the suggestions)
    # and rewrite imported_category to match, so the rule-suggestion engine re-targets to it and a later
    # trust-flag re-toggle (which re-derives 'import' rows from their file label) can't revert it.
    # Contrast override_category, which marks the row 'manual' — an exception the rules leave alone.
    with get_db() as conn:
        txn = conn.execute("SELECT id FROM txn WHERE id = ?", (txn_id,)).fetchone()
        if not txn:
            raise HTTPException(status_code=404, detail="Transaction not found")
        _reject_group_category_assignment(conn, body.category_id)
        cat = conn.execute("SELECT name FROM category WHERE id = ?", (body.category_id,)).fetchone()
        if not cat:
            raise HTTPException(status_code=404, detail="Category not found")
        conn.execute(
            """
            UPDATE txn
            SET category_id = ?, imported_category = ?, category_overridden = 0, category_source = 'import'
            WHERE id = ?
            """,
            (body.category_id, cat["name"], txn_id),
        )
        resolved = _resolved_tags_response(conn, txn_id)
    return {"ok": True, **resolved}


def settle_rejected_suggestion_rows(conn, transaction_ids: list[str], mode: str, category_id: Optional[str] = None) -> list[dict]:
    # Settle the imported rows behind a rejected rule suggestion. Three outcomes by intent:
    #
    #   'keep' (no category_id, or category_id == the row's current category) -> KEEP AS IMPORTED: leave
    #             the row untouched at `category_source = 'import'`. Keeping the file's own category is not
    #             an override, so the row stays re-derivable and — crucially — still reclaimable by an
    #             explicit rule apply / "apply to existing" toast later (a `manual` row would be spared by
    #             that, defeating the toast). The caller marks the suggestion discarded; the row is fine.
    #   'keep' with a *different* category_id -> RE-POINT AS MANUAL (`category_source = 'manual'`, locked):
    #             a genuine override (the conflict screen's "keep these, but as a different category").
    #             Survives Run categorization and is spared even by an explicit apply.
    #   'clear' -> discard the category to the `cleared` source (`category_id = NULL`, override = 0).
    #             Rule-eligible again, but the raw `imported_category` text is retained for audit and the
    #             `cleared` marker keeps the trust-flag re-derivation from re-applying that label (see
    #             _set_batch_imported_category_usage). `cleared` is distinct from a plain NULL source
    #             precisely so the re-derivation can tell "user discarded this" from "ordinary uncategorized".
    #
    # All spare a row the user already settled by hand (`category_source = 'manual'`): a deliberate
    # per-transaction edit is the final say and is never undone here.
    ids = [str(i) for i in transaction_ids if str(i).strip()]
    mode = (mode or "").strip().lower()
    if mode not in ("keep", "clear"):
        raise HTTPException(status_code=400, detail="mode must be 'keep' or 'clear'")
    keep_category_id = (category_id or "").strip() or None
    if keep_category_id and mode != "keep":
        raise HTTPException(status_code=400, detail="category_id is only valid with mode 'keep'")
    if not ids:
        return []
    if keep_category_id:
        # Re-pointing requires an assignable leaf (the shared group guard) that is also active — a stale
        # decision can't park rows on an inactive branch, the same invariant rules/imports honor.
        _reject_group_category_assignment(conn, keep_category_id)
        target = conn.execute(
            "SELECT COALESCE(is_active, 1) AS is_active FROM category WHERE id = ?",
            (keep_category_id,),
        ).fetchone()
        if not target["is_active"]:
            raise HTTPException(status_code=400, detail="Cannot assign transactions to an inactive category")
    # Snapshot the prior state of exactly the rows we are about to change (the same `IS NOT 'manual'`
    # filter the UPDATE uses) so the caller can stash it for Undo and later hand it to
    # `restore_categorization_rows`. Only the affected rows are returned, so restore touches nothing else.
    prior: list[dict] = []
    for chunk in _chunk(ids):
        placeholders = ",".join("?" * len(chunk))
        rows = conn.execute(
            f"SELECT id, category_id, category_source, category_overridden FROM txn "
            f"WHERE id IN ({placeholders}) AND category_source IS NOT 'manual'",
            list(chunk),
        ).fetchall()
        if mode == "keep" and keep_category_id:
            # Re-point only the rows whose category actually changes. Keeping a row at the category it
            # already has is not an override, so it stays `import` (re-derivable, toast-claimable) —
            # only a genuine move to a different category becomes `manual`.
            changing = [row for row in rows if str(row["category_id"] or "") != str(keep_category_id)]
            prior.extend(dict(row) for row in changing)
            for change_chunk in _chunk([row["id"] for row in changing]):
                change_placeholders = ",".join("?" * len(change_chunk))
                conn.execute(
                    # Re-pointing to a different category is a manual edit, so it also reviews the row.
                    f"UPDATE txn SET category_id = ?, category_overridden = 1, category_source = 'manual', "
                    f"needs_review = 0 "
                    f"WHERE id IN ({change_placeholders})",
                    [keep_category_id, *change_chunk],
                )
        elif mode == "keep":
            # Keep exactly as imported: leave the rows untouched at `import` (nothing changes, so
            # nothing to snapshot for undo). The caller marks the suggestion discarded.
            pass
        else:
            prior.extend(dict(row) for row in rows)
            conn.execute(
                f"UPDATE txn SET category_id = NULL, category_overridden = 0, category_source = 'cleared' "
                f"WHERE id IN ({placeholders}) AND category_source IS NOT 'manual'",
                list(chunk),
            )
    return prior


def restore_categorization_rows(conn, rows: list[dict]) -> list[str]:
    # Undo support: set each row back to a previously captured (category_id, category_source,
    # category_overridden) snapshot — the shape `settle_rejected_suggestion_rows` and a capturing rule
    # apply return, so only the deliberately-changed rows are restored and exactly to their pre-change
    # state. Returns the restored ids; the caller owns the recurring rescan they need.
    restored: list[str] = []
    for row in rows:
        row_id = str(row.get("id") or "").strip()
        if not row_id:
            continue
        conn.execute(
            "UPDATE txn SET category_id = ?, category_source = ?, category_overridden = ? WHERE id = ?",
            (row.get("category_id"), row.get("category_source"),
             category_lock_for(row.get("category_source"), row.get("category_overridden")), row_id),
        )
        restored.append(row_id)
    return restored


@router.patch("/{txn_id}/merchant")
def update_merchant(txn_id: str, body: dict):
    name = body.get("merchant_name", "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="merchant_name required")
    with get_db() as conn:
        # The payee key is derived from the name, so a rename moves the row between payee groups. The
        # group it is leaving has to be reconsidered too, and only a read before the write can name it.
        current = conn.execute("SELECT display_name FROM txn WHERE id = ?", (txn_id,)).fetchone()
        changed = current is not None and (current["display_name"] or "") != name
        prior = payee_keys_for_ids(conn, [txn_id]) if changed else frozenset()
        conn.execute(
            "UPDATE txn SET display_name = ?, display_name_source = 'manual' WHERE id = ?",
            (name, txn_id),
        )
        if changed:
            rescan_edited_transactions(conn, [txn_id], prior_payee_keys=prior)
    return {"ok": True}

@router.patch("/{txn_id}/notes")
def update_notes(txn_id: str, body: dict):
    notes = body.get("notes", "")
    notes = notes.strip() if notes else None
    with get_db() as conn:
        conn.execute("UPDATE txn SET notes = ? WHERE id = ?", (notes, txn_id))
    return {"ok": True}


@router.patch("/{txn_id}/tags")
def update_transaction_tag(txn_id: str, body: TransactionTagUpdate):
    with get_db() as conn:
        txn = conn.execute("SELECT id FROM txn WHERE id = ?", (txn_id,)).fetchone()
        if not txn:
            raise HTTPException(status_code=404, detail="Transaction not found")
        tag = conn.execute("SELECT id FROM tag WHERE id = ?", (body.tag_id,)).fetchone()
        if not tag:
            raise HTTPException(status_code=404, detail="Tag not found")
        set_manual_transaction_tag(conn, txn_id, body.tag_id, present=body.present)
        tags = list_visible_transaction_tags(conn, txn_id)
        blocked_tags = get_blocked_transaction_tag_map(conn, [txn_id]).get(txn_id, [])
    return {"tags": tags, "blocked_tags": blocked_tags}


@router.patch("/{txn_id}/uncategorize")
def clear_override(txn_id: str):
    with get_db() as conn:
        prior = conn.execute("SELECT category_id FROM txn WHERE id = ?", (txn_id,)).fetchone()
        had_category = prior is not None and prior["category_id"] is not None
        # Clearing an override resets both the lock bit and the stored category so rule application can fully
        # re-derive the transaction instead of leaving a stale manual category behind.
        conn.execute(
            "UPDATE txn SET category_overridden = 0, category_id = NULL, category_source = NULL WHERE id = ?",
            (txn_id,),
        )
        if had_category:
            rescan_edited_transactions(conn, [txn_id])
        resolved = _resolved_tags_response(conn, txn_id)
    return {"ok": True, **resolved}


# Soft-delete (trash) mirrors the account-trash pattern in routers/accounts.py: stamp `trashed_at`
# so every read filters the row out, but the underlying record is preserved until the user empties
# the trash from Settings. Restoration just clears the timestamp.
@router.delete("/{txn_id}")
def trash_transaction(txn_id: str):
    with get_db() as conn:
        row = conn.execute("SELECT id FROM txn WHERE id = ?", (txn_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Transaction not found")
        conn.execute(
            "UPDATE txn SET trashed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
            (txn_id,),
        )
    return {"ok": True}


# Which of the list feed's filters a "select all matching" payload may carry. Every key here must
# narrow the same way it does on the list endpoint, because the count the user was shown came from
# that endpoint and the rows changed come from this one.
#
# **A key this set does not name is rejected, never dropped.** Dropping is silent and it is never
# conservative: every filter here narrows, so losing one *widens* the set the actions run against —
# which is how a "mark the 28 rows needing review" once resolved to the whole ledger. An unsupported
# key is a client and a server that disagree about the selection, and the only safe reading of that
# disagreement is to refuse it.
# The facet half is *derived* from the registry rather than restated, because restating it is exactly
# how this list goes wrong: every filter here narrows, so a key missing from the allowlist does not fail
# closed — it is rejected as unknown if sent, and if the client stops sending it the selection silently
# *widens* past the count the user is looking at. That is not hypothetical; `needs_review` was once
# missing and "mark the 28 rows needing review" resolved to the whole ledger. Adding a facet now reaches
# bulk automatically; only the non-facet filters below still have to be named by hand.
_BULK_FILTER_KEYS = FACET_PARAM_NAMES | {
    "month", "date_start", "date_end", "import_batch_id", "sync_connection_id", "account_id",
    "source_account_ids", "category_id", "require_all_tag_ids", "require_all_attribute_ids",
    "direction", "view", "search", "quick_filter", "needs_review",
    "amount_min", "amount_max", "amount_min_op", "amount_max_op", "recurring_only",
}

# Filters the builder understands but bulk refuses on purpose, named separately so the error can say
# why rather than calling them unknown: bulk never acts on trashed rows, and a filter payload naming
# ids outright would bypass the resolve-and-exclude path that mode='ids' exists for.
_BULK_FILTER_REFUSED_KEYS = {"include_trashed", "ids"}


def _bulk_filter_params(raw: dict | None) -> dict:
    flt = dict(raw or {})
    refused = sorted(k for k in flt if k in _BULK_FILTER_REFUSED_KEYS)
    if refused:
        raise HTTPException(
            status_code=400,
            detail=f"selection.filter may not carry: {', '.join(refused)}",
        )
    unknown = sorted(k for k in flt if k not in _BULK_FILTER_KEYS)
    if unknown:
        raise HTTPException(
            status_code=400,
            detail=f"selection.filter has unsupported key(s): {', '.join(unknown)}",
        )
    return flt


def _chunk(seq, size=400):
    for start in range(0, len(seq), size):
        yield seq[start:start + size]


def _resolve_bulk_target_ids(conn, selection: BulkSelection) -> list[str]:
    # Always resolves to existing, non-trashed rows so the returned count is the real number changed
    # and a stale client id can't act on something already gone.
    if selection.mode == "ids":
        ids = [str(i) for i in (selection.ids or []) if i]
        if not ids:
            return []
        resolved: list[str] = []
        for chunk in _chunk(ids):
            placeholders = ",".join("?" * len(chunk))
            rows = conn.execute(
                f"SELECT id FROM txn WHERE id IN ({placeholders}) AND trashed_at IS NULL",
                chunk,
            ).fetchall()
            resolved.extend(row["id"] for row in rows)
        return resolved

    if selection.mode == "filter":
        flt = _bulk_filter_params(selection.filter)
        clauses, params = _build_transaction_filter(**flt)  # include_trashed defaults False
        where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
        # Expanded, so a "select all matching" under a category filter resolves the same rows the
        # ledger showed — including split transactions that matched on one part. DISTINCT because a
        # split whose parts both match would otherwise arrive twice. The bulk actions that cannot act
        # on a split refuse it by name and report the count; silently dropping it here instead would
        # make the selection quietly mean less than the screen said it did.
        rows = conn.execute(
            f"""
            SELECT DISTINCT t.id
            FROM   {txn_effective_sql(conn, expand=True)} t
            JOIN   account  a ON a.id = t.account_id
            LEFT JOIN account  p ON p.id = a.parent_account_id
            LEFT JOIN category c ON c.id = t.category_id
            LEFT JOIN category pc ON pc.id = c.parent_id
            {where}
            """,
            params,
        ).fetchall()
        exclude = {str(i) for i in (selection.exclude_ids or [])}
        return [row["id"] for row in rows if row["id"] not in exclude]

    raise HTTPException(status_code=400, detail="selection.mode must be 'ids' or 'filter'")


def _apply_set_date(conn, ids: list[str], date: str) -> None:
    """Move rows to `date`, keeping each one's `content_hash` true to it.

    The hash digests the date, so moving a row without restamping leaves it describing a date it no
    longer has — and because that hash is what duplicate detection matches an incoming row against
    exactly, the row quietly stops being recognizable to a later import of the same charge. The rows
    whose hash cannot be recomputed from their own fields are left with the one they have; see
    `_MARKETPLACE_SOURCE_KIND_PREFIX` for which those are and why a wrong digest is worse than a stale
    one. A row carrying no hash at all keeps not having one.
    """
    from backend.routers.import_export.core import make_hash

    for chunk in _chunk(ids):
        placeholders = ",".join("?" * len(chunk))
        rows = conn.execute(
            f"""SELECT t.id, t.amount, t.raw_name, t.merchant_name, t.content_hash,
                       COALESCE(b.source_kind, '') AS source_kind
                FROM   txn t
                LEFT   JOIN import_batch b ON b.id = t.import_batch_id
                WHERE  t.id IN ({placeholders})""",
            chunk,
        ).fetchall()
        restamped, left_alone = [], []
        for row in rows:
            if row["content_hash"] and not row["source_kind"].startswith(_MARKETPLACE_SOURCE_KIND_PREFIX):
                restamped.append(
                    (date, make_hash(date, row["amount"], _hashed_description(row)), row["id"])
                )
            else:
                left_alone.append(row["id"])
        if left_alone:
            ph = ",".join("?" * len(left_alone))
            conn.execute(f"UPDATE txn SET date = ? WHERE id IN ({ph})", [date, *left_alone])
        if restamped:
            conn.executemany("UPDATE txn SET date = ?, content_hash = ? WHERE id = ?", restamped)


def _apply_bulk_action(conn, ids: list[str], action: BulkAction) -> int:
    """Apply one bulk action to a set of rows. Returns how many rows it declined because they are
    split — always 0 except for `set_category`, whose whole effect is the thing a split owns."""
    kind = action.type
    if kind == "set_category":
        # None clears the category (a deliberate manual uncategorize); a real id must be a leaf.
        _reject_group_category_assignment(conn, action.category_id)
        # Split rows keep their allocations. A bulk recategorize would replace hand-built allocation
        # work with a single category and leave nothing to restore it from, so those rows are declined
        # and counted for the caller to report — the same contract a full-force rule apply follows.
        skipped = split_txn_ids(conn, ids)
        ids = [i for i in ids if i not in skipped]
        if not ids:
            return len(skipped)
        for chunk in _chunk(ids):
            placeholders = ",".join("?" * len(chunk))
            conn.execute(
                # A manual category edit counts as reviewing the row, so it clears needs_review.
                f"UPDATE txn SET category_id = ?, category_overridden = 1, category_source = 'manual', "
                f"needs_review = 0 "
                f"WHERE id IN ({placeholders})",
                [action.category_id, *chunk],
            )
        return len(skipped)
    elif kind in ("add_tags", "remove_tags"):
        present = kind == "add_tags"
        for tag_id in (action.tag_ids or []):
            for txn_id in ids:
                set_manual_transaction_tag(conn, txn_id, tag_id, present=present)
    elif kind == "set_notes":
        notes = action.notes.strip() if action.notes else None
        notes = notes or None
        for chunk in _chunk(ids):
            placeholders = ",".join("?" * len(chunk))
            conn.execute(f"UPDATE txn SET notes = ? WHERE id IN ({placeholders})", [notes, *chunk])
    elif kind == "set_merchant":
        name = (action.merchant or "").strip()
        if not name:
            raise HTTPException(status_code=400, detail="merchant is required for set_merchant")
        for chunk in _chunk(ids):
            placeholders = ",".join("?" * len(chunk))
            conn.execute(
                f"UPDATE txn SET display_name = ?, display_name_source = 'manual' WHERE id IN ({placeholders})",
                [name, *chunk],
            )
    elif kind == "set_date":
        _apply_set_date(conn, ids, _require_calendar_date(action.date))
    elif kind == "mark_reviewed":
        # Explicit "looked, it's fine as-is" — the catch-all clear for rows a manual category edit
        # didn't already clear. Powers both the single-row action and "clear the whole filtered pool".
        for chunk in _chunk(ids):
            placeholders = ",".join("?" * len(chunk))
            conn.execute(
                f"UPDATE txn SET needs_review = 0 WHERE id IN ({placeholders})",
                chunk,
            )
    elif kind == "set_review_status":
        # Two-way review toggle (the bulk panel's "Review status" field). Unlike mark_reviewed, which
        # only clears the flag, this can also set it back on so a batch can be deliberately flagged for
        # another look. A missing value is a client bug, not a silent no-op.
        if action.needs_review is None:
            raise HTTPException(status_code=400, detail="needs_review is required for set_review_status")
        flag = 1 if action.needs_review else 0
        for chunk in _chunk(ids):
            placeholders = ",".join("?" * len(chunk))
            conn.execute(
                f"UPDATE txn SET needs_review = ? WHERE id IN ({placeholders})",
                [flag, *chunk],
            )
    elif kind == "trash":
        for chunk in _chunk(ids):
            placeholders = ",".join("?" * len(chunk))
            conn.execute(
                f"UPDATE txn SET trashed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id IN ({placeholders})",
                chunk,
            )
    else:
        raise HTTPException(status_code=400, detail=f"unknown bulk action: {kind}")
    return 0


# Bulk actions that can move a row between recurring series, or out of one: category is part of a
# derived series' identity, the merchant name *is* its key, the date decides which occurrence a charge
# is and whether one was missed, and a trashed row stops being an occurrence at all. Tags, notes and
# the review flag are read by nothing the detector does.
_RECURRING_RELEVANT_BULK_ACTIONS = {"set_category", "set_merchant", "set_date", "trash"}


@router.post("/bulk")
def bulk_update_transactions(body: BulkUpdateRequest):
    # One transaction so a multi-field apply (e.g. set category + add tag) is all-or-nothing.
    with get_db() as conn:
        target_ids = _resolve_bulk_target_ids(conn, body.selection)
        if not target_ids:
            return {"updated_count": 0}
        kinds = {a.type for a in body.actions}
        touches_recurring = bool(kinds & _RECURRING_RELEVANT_BULK_ACTIONS)
        # Captured before the writes, since a rename moves rows out of the payee group they are in now.
        prior_keys = payee_keys_for_ids(conn, target_ids) if "set_merchant" in kinds else frozenset()
        skipped_splits = 0
        for action in body.actions:
            skipped_splits += _apply_bulk_action(conn, target_ids, action)
        # Once for the whole batch, never per row: a scan loads the entire detection window before it
        # filters by payee, so a per-row call would repeat that load for every row selected.
        if touches_recurring:
            rescan_edited_transactions(conn, target_ids, prior_payee_keys=prior_keys)
    # `skipped_splits` counts rows a set_category action left alone because they are split. Reported
    # rather than folded into the total: "updated 40" when 3 of them kept their old categorization is
    # a number the user would act on wrongly.
    return {"updated_count": len(target_ids), "skipped_splits": skipped_splits}


@router.post("/{txn_id}/restore")
def restore_transaction(txn_id: str):
    with get_db() as conn:
        row = conn.execute("SELECT id FROM txn WHERE id = ?", (txn_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Transaction not found")
        # A restore asserts "this is a real transaction after all" — so a confirmed-duplicate's dedupe
        # tags clear with the untrash (mirroring restore_rejected_duplicate). Left in place, the row
        # would return to the ledger still filtered out as a removed duplicate.
        conn.execute(
            """UPDATE txn
               SET trashed_at = NULL,
                   suspect_duplicate_of = CASE WHEN rejection_reason = 'duplicate_confirmed' THEN NULL ELSE suspect_duplicate_of END,
                   dedupe_resolved_by   = CASE WHEN rejection_reason = 'duplicate_confirmed' THEN NULL ELSE dedupe_resolved_by END,
                   rejection_reason     = CASE WHEN rejection_reason = 'duplicate_confirmed' THEN NULL ELSE rejection_reason END
               WHERE id = ?""",
            (txn_id,),
        )
    return {"ok": True}


@router.get("/trash")
def list_trashed_transactions(limit: int = Query(200, le=1000)):
    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT t.id, t.date, t.amount, t.merchant_name, t.display_name, t.raw_name,
                   t.account_id, t.category_id, t.trashed_at, t.notes,
                   t.dedupe_resolved_by,
                   a.name AS account_name, a.display_name AS account_display_name, a.mask AS account_mask,
                   c.name AS category_name,
                   p.name AS group_name, p.id AS group_id,
                   ib.filename AS source_filename
            FROM   txn t
            LEFT JOIN account  a ON a.id = t.account_id
            LEFT JOIN category c ON c.id = t.category_id
            LEFT JOIN category p ON p.id = c.parent_id
            LEFT JOIN import_batch ib ON ib.id = t.import_batch_id
            WHERE  t.trashed_at IS NOT NULL
              -- Confirmed-duplicate rows soft-deleted by the *unified dedupe flow* — account merges
              -- (dedupe_resolved_by='auto_merge') and explicit Rejects in the duplicate report
              -- (dedupe_resolved_by='user') — belong to the originating file's duplicate report and
              -- are restorable from there (detach the accounts, or "undo reject"), so they're kept
              -- out of the manual Trash view to avoid implying the user deleted them or should empty
              -- them here. Amazon reconciliation removals ('amazon_merge' / 'amazon_discard') ARE
              -- shown: the user removed those copies deliberately, and the Trash page (grouped by
              -- origin) is their undo path.
              AND NOT (COALESCE(t.rejection_reason, '') = 'duplicate_confirmed'
                       AND COALESCE(t.dedupe_resolved_by, '') NOT IN ('amazon_merge', 'amazon_discard'))
            ORDER  BY t.trashed_at DESC, t.date DESC
            LIMIT  ?
            """,
            (limit,),
        ).fetchall()
    return [dict(row) for row in rows]


# Timeframe cutoffs for the Empty-trash chooser, keyed by the frontend's option value. Each maps to a
# SQLite datetime modifier applied to `trashed_at` (age in the trash, not the transaction's own date):
# a row is purged only if it was trashed at or before now minus this interval. "all" has no cutoff and
# empties the whole section — the original behavior.
_TRASH_OLDER_THAN = {"1m": "-1 month", "3m": "-3 months", "6m": "-6 months", "1y": "-1 year"}


@router.post("/trash/empty")
def empty_transaction_trash(scope: str = "all", older_than: str = "all"):
    """Empty the visible transaction trash. ``scope`` narrows to one Trash section — ``deleted``
    (rows the user trashed directly) or ``duplicates`` (Amazon reconciliation removals) — so each
    section's Empty button touches only its own rows; ``all`` empties both. ``older_than`` narrows by
    age in the trash (``trashed_at``): ``all`` purges the whole section, or ``1m``/``3m``/``6m``/``1y``
    purge only rows trashed at least that long ago. The unified dedupe flow's confirmed-duplicate rows
    are protected regardless: they aren't shown in the Trash view, so emptying it must not permanently
    delete them either — doing so would silently destroy the rows that account-detach (auto_merge) and
    "undo reject" (user) rely on to restore them."""
    # The two visible slices. Amazon removals are exactly the duplicate_confirmed rows tagged
    # amazon_*; direct deletes are the untagged remainder (the dedupe flow's rows match neither).
    amazon = "COALESCE(dedupe_resolved_by, '') IN ('amazon_merge', 'amazon_discard')"
    direct = "COALESCE(rejection_reason, '') <> 'duplicate_confirmed'"
    if scope == "deleted":
        visible = direct
    elif scope == "duplicates":
        visible = amazon
    elif scope == "all":
        visible = f"({direct} OR {amazon})"
    else:
        raise HTTPException(status_code=400, detail="Unknown trash scope")
    if older_than != "all" and older_than not in _TRASH_OLDER_THAN:
        raise HTTPException(status_code=400, detail="Unknown trash timeframe")
    params: tuple = ()
    cutoff = ""
    if older_than != "all":
        # Compare through julianday() so the stored ISO trashed_at (…T…Z) and the computed cutoff land on
        # the same numeric scale regardless of separator/zone formatting (both are UTC) — a raw string
        # compare would misjudge same-date boundaries where the 'T'/space separators diverge.
        cutoff = " AND julianday(trashed_at) <= julianday('now', ?)"
        params = (_TRASH_OLDER_THAN[older_than],)
    with get_db() as conn:
        # The shared delete, so each import card a purged row came from stops counting it — its account
        # chip, row count and summary all move together (`services/import_batch_totals.py`).
        removed = delete_transactions(conn, f"trashed_at IS NOT NULL AND {visible}{cutoff}", params)
    if removed:
        # Attached documents are what makes the purge the *irreversible* half of the trash: trashing a
        # transaction hides its documents with it and a restore brings them back, while this deletes
        # them. The rows go with their transaction (ON DELETE CASCADE), but files sit outside that
        # transaction, so the stored bytes are reclaimed here — after the commit, against the ledger as
        # it now stands, sparing anything an in-flight ingest has written but not yet committed.
        with get_db() as conn:
            sweep_unreferenced_files(conn, min_age_seconds=INGEST_GRACE_SECONDS)
    return {"removed": removed}


# Soft-flag duplicate review. The flag is set by services/duplicate_detection.py during import
# and account-merge flows; the per-row resolve endpoint below is the live entry point. The
# old cross-batch listing endpoints have been retired in favor of the per-batch unified report
# served by /import-export/batches/{id}/duplicates-unified (see import_export.py).
class SuspectResolveBody(BaseModel):
    action: str  # 'keep' | 'trash'


@router.post("/{txn_id}/restore-rejected")
def restore_rejected_duplicate_endpoint(txn_id: str):
    """Reverse a confirmed-duplicate rejection. The transaction returns to the active ledger
    with the rejection flag cleared. Used from the unified duplicate-detection report when the
    user undoes a previous 'reject' decision on a soft-flag suspect."""
    from backend.services.duplicate_detection import restore_rejected_duplicate
    with get_db() as conn:
        result = restore_rejected_duplicate(conn, txn_id)
    if not result.get("restored"):
        reason = result.get("reason")
        if reason == "not_found":
            raise HTTPException(status_code=404, detail="Transaction not found")
        if reason == "not_rejected":
            raise HTTPException(status_code=400, detail="Transaction is not a confirmed-duplicate rejection")
        raise HTTPException(status_code=400, detail="Unable to restore transaction")
    return result


@router.post("/{txn_id}/resolve-suspect")
def resolve_suspect_duplicate(txn_id: str, body: SuspectResolveBody):
    from backend.services.duplicate_detection import resolve_suspect
    with get_db() as conn:
        result = resolve_suspect(conn, txn_id, action=body.action)
    if not result.get("resolved"):
        reason = result.get("reason")
        if reason == "not_found":
            raise HTTPException(status_code=404, detail="Transaction not found")
        if reason == "not_suspect":
            raise HTTPException(status_code=400, detail="Transaction is not flagged as a suspect duplicate")
        if reason == "matched_missing":
            raise HTTPException(status_code=400, detail="The matched existing transaction no longer exists")
        if reason == "invalid_action":
            raise HTTPException(status_code=400, detail="action must be 'keep', 'reject', or 'replace'")
        raise HTTPException(status_code=400, detail="Unable to resolve suspect")
    return result


# Filter surface is kept symmetric with /summary/by-group (date range, owner filters, exclude_from_totals)
# so dashboard views that toggle between group and category aggregation see the same slice of data.
# Unlike by-group, this endpoint has no natural category_type column to filter on post-grouping, so
# income exclusion is a query-time flag rather than a frontend filter on the result list.
@router.get("/summary/by-category")
def spending_by_category(
    month:              Optional[str] = Query(None, description="YYYY-MM"),
    date_start:         Optional[str] = Query(None),
    date_end:           Optional[str] = Query(None),
    account_id:         Optional[str] = Query(None),
    facets:      TransactionFacets = Depends(),
    exclude_income:     bool          = Query(False, description="omit income categories from results"),
    exclude_expense:    bool          = Query(False, description="omit expense categories from results"),
):
    # Direct (non-HTTP) callers may omit the dependency; over HTTP FastAPI always supplies it.
    facets = coerce_facets(facets) or TransactionFacets()
    clauses = ["t.is_pending = 0", "t.trashed_at IS NULL",
               "COALESCE(p.exclude_from_totals, c.exclude_from_totals, 0) = 0"]
    params  = []
    if date_start and date_end:
        clauses.append("t.date BETWEEN ? AND ?"); params.extend([date_start, date_end])
    elif date_start:
        clauses.append("t.date >= ?"); params.append(date_start)
    elif date_end:
        clauses.append("t.date <= ?"); params.append(date_end)
    elif month:
        clauses.append("t.date LIKE ?"); params.append(f"{month}%")

    _append_single_account_filter(clauses, params, account_id=account_id, account_ids=facets.account_ids)
    append_facets(clauses, params, facets)

    if exclude_income:
        clauses.append(
            "((t.category_id IS NULL AND t.amount > 0) OR "
            "COALESCE(c.category_type, p.category_type) != 'income')"
        )
    if exclude_expense:
        clauses.append(
            "((t.category_id IS NULL AND t.amount < 0) OR "
            "COALESCE(c.category_type, p.category_type) != 'expense')"
        )

    with get_db() as conn:
        # Category rollups read the split-expansion seam: a split transaction contributes one row
        # per allocation, so every facet, sentinel and exclusion guard below applies per part
        # without being restated. See services/txn_splits.py.
        _expanded = txn_effective_sql(conn, expand=True)
        where = "WHERE " + " AND ".join(clauses)
        rows = conn.execute(
            f"""
            SELECT
                {_summary_uncategorized_id_sql('category')}   AS category_id,
                {_summary_uncategorized_name_sql('category')} AS category_name,
                NULL                                          AS category_color,
                COALESCE(p.id, c.id)                          AS group_id,
                COALESCE(p.name, c.name)                      AS group_name,
                {_summary_uncategorized_type_sql('category')} AS category_type,
                {_summary_signed_total_sql(_summary_uncategorized_type_sql('category'))} AS total,
                COUNT(DISTINCT t.id)                          AS count
            FROM   {_expanded} t
            LEFT JOIN category c ON c.id = t.category_id
            LEFT JOIN category p ON p.id = c.parent_id
            {where}
            -- GROUP BY the sentinel *expression*, not the `category_id` alias: the row source carries a
            -- real `category_id` column, and SQLite binds a bare name in GROUP BY to that column rather
            -- than to the output alias. Grouping on it merges the synthetic uncategorized income and
            -- expense buckets back into one (both have `t.category_id IS NULL`), which also breaks
            -- _summary_signed_total_sql's precondition that the type expression be constant within a
            -- bucket — leaving the merged row labelled and signed by whichever member SQLite picked.
            GROUP BY {_summary_uncategorized_id_sql('category')}
            ORDER BY total DESC
            """,
            params,
        ).fetchall()

    return [dict(r) for r in rows]


@router.get("/summary/by-tag-signature")
def spending_by_tag_signature(
    selected_tag_ids:   str           = Query("", description="comma-separated tag IDs the report is built from"),
    month:              Optional[str] = Query(None, description="YYYY-MM"),
    date_start:         Optional[str] = Query(None),
    date_end:           Optional[str] = Query(None),
    account_id:         Optional[str] = Query(None),
    facets:      TransactionFacets = Depends(),
    exclude_income:     bool          = Query(False, description="omit income categories from results"),
    exclude_expense:    bool          = Query(False, description="omit expense categories from results"),
):
    # Direct (non-HTTP) callers may omit the dependency; over HTTP FastAPI always supplies it.
    facets = coerce_facets(facets) or TransactionFacets()
    # The tag report's pie: buckets the scoped spending by *tag signature* — which of the report's
    # selected tags each transaction effectively carries — entirely in SQL. This replaces a client-side
    # aggregation over a /transactions fetch capped at 1000 rows, which silently truncated (and thus
    # undercounted every slice) on any period with more transactions than the cap. Scope mirrors
    # spending_by_category exactly (is_pending / trashed / exclude_from_totals + exclude_income/expense +
    # the shared facet filters incl. exclusions) so all three "Spending by" modes reconcile to one total.
    sel_ids = [i.strip() for i in selected_tag_ids.split(",") if i.strip()]
    clauses = ["t.is_pending = 0", "t.trashed_at IS NULL",
               "COALESCE(p.exclude_from_totals, c.exclude_from_totals, 0) = 0"]
    params: list = []
    if date_start and date_end:
        clauses.append("t.date BETWEEN ? AND ?"); params.extend([date_start, date_end])
    elif date_start:
        clauses.append("t.date >= ?"); params.append(date_start)
    elif date_end:
        clauses.append("t.date <= ?"); params.append(date_end)
    elif month:
        clauses.append("t.date LIKE ?"); params.append(f"{month}%")

    _append_single_account_filter(clauses, params, account_id=account_id, account_ids=facets.account_ids)
    append_facets(clauses, params, facets)
    if exclude_income:
        clauses.append("((t.category_id IS NULL AND t.amount > 0) OR "
                       "COALESCE(c.category_type, p.category_type) != 'income')")
    if exclude_expense:
        clauses.append("((t.category_id IS NULL AND t.amount < 0) OR "
                       "COALESCE(c.category_type, p.category_type) != 'expense')")

    # The signature subquery sits in the inner SELECT, so its placeholders (the selected tag ids) precede
    # the WHERE-clause params. When nothing is selected, every row's signature is the Other bucket.
    sig_sql = effective_selected_tag_signature_sql(len(sel_ids)) if sel_ids else "NULL"
    where = "WHERE " + " AND ".join(clauses)
    query_params = sel_ids + params

    # Sign each row by the convention in _summary_signed_total_sql before summing, so a signature that
    # mixes expense and income rows nets them along their natural direction (income negated to positive,
    # refunds/returns negative) rather than by raw stored sign. A whole signature can span both types, so
    # the sign is applied per row here, not per bucket.
    signed_amount = (
        "CASE WHEN (COALESCE(c.category_type, p.category_type) = 'income' "
        "OR (t.category_id IS NULL AND t.amount < 0)) THEN -t.amount ELSE t.amount END"
    )
    with get_db() as conn:
        # Category rollups read the split-expansion seam: a split transaction contributes one row
        # per allocation, so every facet, sentinel and exclusion guard below applies per part
        # without being restated. See services/txn_splits.py.
        _expanded = txn_effective_sql(conn, expand=True)
        rows = conn.execute(
            f"""
            SELECT sig, SUM(net) AS net, COUNT(DISTINCT txn_id) AS count FROM (
                SELECT {sig_sql} AS sig, {signed_amount} AS net, t.id AS txn_id
                FROM   {_expanded} t
                LEFT JOIN category c ON c.id = t.category_id
                LEFT JOIN category p ON p.id = c.parent_id
                {where}
            ) q
            GROUP BY sig
            """,
            query_params,
        ).fetchall()

    # Re-key by the canonical (sorted) signature — defensive against any GROUP_CONCAT ordering variance.
    # The bucket total is the signed net (no ABS): a signature whose refunds outweigh its spend reads
    # negative, exactly as it does in spending_by_category. An empty signature is the Other / Untagged
    # bucket. Naming, coloring, and sort order stay on the client.
    merged: dict[tuple, dict] = {}
    for r in rows:
        ids = tuple(sorted(r["sig"].split(","))) if r["sig"] else ()
        bucket = merged.get(ids)
        if bucket is None:
            bucket = {"signature_tag_ids": list(ids), "net": 0.0, "count": 0}
            merged[ids] = bucket
        bucket["net"] += float(r["net"] or 0)
        bucket["count"] += int(r["count"] or 0)
    return [
        {"signature_tag_ids": b["signature_tag_ids"], "total": b["net"], "count": b["count"]}
        for b in merged.values()
    ]


@router.get("/summary/by-group")
def spending_by_group(
    month:              Optional[str] = Query(None, description="YYYY-MM"),
    date_start:         Optional[str] = Query(None),
    date_end:           Optional[str] = Query(None),
    account_id:         Optional[str] = Query(None),
    facets:      TransactionFacets = Depends(),
):
    # Direct (non-HTTP) callers may omit the dependency; over HTTP FastAPI always supplies it.
    facets = coerce_facets(facets) or TransactionFacets()
    clauses = ["t.is_pending = 0", "t.trashed_at IS NULL",
               "COALESCE(p.exclude_from_totals, c.exclude_from_totals, 0) = 0"]
    params  = []
    if date_start and date_end:
        clauses.append("t.date BETWEEN ? AND ?"); params.extend([date_start, date_end])
    elif date_start:
        clauses.append("t.date >= ?"); params.append(date_start)
    elif date_end:
        clauses.append("t.date <= ?"); params.append(date_end)
    elif month:
        clauses.append("t.date LIKE ?"); params.append(f"{month}%")

    _append_single_account_filter(clauses, params, account_id=account_id, account_ids=facets.account_ids)
    append_facets(clauses, params, facets)

    with get_db() as conn:
        # Category rollups read the split-expansion seam: a split transaction contributes one row
        # per allocation, so every facet, sentinel and exclusion guard below applies per part
        # without being restated. See services/txn_splits.py.
        _expanded = txn_effective_sql(conn, expand=True)
        where = "WHERE " + " AND ".join(clauses)
        rows = conn.execute(
            f"""
            SELECT
                {_summary_uncategorized_id_sql('group')}      AS group_id,
                {_summary_uncategorized_name_sql('group')}    AS group_name,
                NULL                                                        AS group_color,
                {_summary_uncategorized_type_sql('group')}                       AS category_type,
                {_summary_signed_total_sql(_summary_uncategorized_type_sql('group'))} AS total,
                COUNT(DISTINCT t.id)                                             AS count
            FROM   {_expanded} t
            LEFT JOIN category c  ON c.id  = t.category_id
            LEFT JOIN category p  ON p.id  = c.parent_id
            {where}
            GROUP BY group_id
            ORDER BY total DESC
            """,
            params,
        ).fetchall()

    return [dict(r) for r in rows]


@router.get("/summary/by-category-in-group")
def spending_by_category_in_group(
    month:       Optional[str] = Query(None, description="YYYY-MM"),
    date_start:  Optional[str] = Query(None),
    date_end:    Optional[str] = Query(None),
    group_id:    str           = Query(...),
    account_id:  Optional[str] = Query(None),
    facets:      TransactionFacets = Depends(),
):
    # Direct (non-HTTP) callers may omit the dependency; over HTTP FastAPI always supplies it.
    facets = coerce_facets(facets) or TransactionFacets()
    clauses = ["t.is_pending = 0", "t.trashed_at IS NULL"]
    params  = []
    if date_start and date_end:
        clauses.append("t.date BETWEEN ? AND ?"); params.extend([date_start, date_end])
    elif date_start:
        clauses.append("t.date >= ?"); params.append(date_start)
    elif date_end:
        clauses.append("t.date <= ?"); params.append(date_end)
    elif month:
        clauses.append("t.date LIKE ?"); params.append(f"{month}%")

    # Keep the membership test separate from the display join so grouping rules do not accidentally mutate which
    # rows qualify once category metadata is LEFT JOINed in for names/colors.
    if group_id == UNCATEGORIZED_EXPENSE_CATEGORY_ID:
        clauses.append("t.category_id IS NULL")
        clauses.append("t.amount > 0")
    elif group_id == UNCATEGORIZED_INCOME_CATEGORY_ID:
        clauses.append("t.category_id IS NULL")
        clauses.append("t.amount < 0")
    else:
        clauses.append(
            "t.category_id IN (SELECT id FROM category WHERE parent_id = ? OR id = ?)"
        )
        params.extend([group_id, group_id])

    _append_single_account_filter(clauses, params, account_id=account_id, account_ids=facets.account_ids)
    append_facets(clauses, params, facets)

    where = "WHERE " + " AND ".join(clauses)

    with get_db() as conn:
        # Category rollups read the split-expansion seam: a split transaction contributes one row
        # per allocation, so every facet, sentinel and exclusion guard below applies per part
        # without being restated. See services/txn_splits.py.
        _expanded = txn_effective_sql(conn, expand=True)
        rows = conn.execute(
            f"""
            SELECT
                {_summary_uncategorized_id_sql('category')}   AS category_id,
                {_summary_uncategorized_name_sql('category')} AS category_name,
                NULL                                AS category_color,
                {_summary_signed_total_sql(_summary_uncategorized_type_sql('category'))} AS total,
                COUNT(DISTINCT t.id)                AS count
            FROM   {_expanded} t
            LEFT JOIN category c ON c.id = t.category_id
            LEFT JOIN category p ON p.id = c.parent_id
            {where}
            -- GROUP BY the sentinel *expression*, not the `category_id` alias: the row source carries a
            -- real `category_id` column, and SQLite binds a bare name in GROUP BY to that column rather
            -- than to the output alias. Grouping on it merges the synthetic uncategorized income and
            -- expense buckets back into one (both have `t.category_id IS NULL`), which also breaks
            -- _summary_signed_total_sql's precondition that the type expression be constant within a
            -- bucket — leaving the merged row labelled and signed by whichever member SQLite picked.
            GROUP BY {_summary_uncategorized_id_sql('category')}
            ORDER BY total DESC
            """,
            params,
        ).fetchall()

    return [dict(r) for r in rows]

# Returns signed monthly totals (no ABS), so reverses against the natural
# direction of the queried scope appear as negative bars instead of being
# folded into a magnitude. Sign and transaction-filter selection:
#   - category_id given: ignore `view`; sign follows category type so
#     income-type scopes flip to positive-on-receipt; the existing
#     category-membership filter limits which transactions count.
#   - payee given: ignore `view`; signed SUM, positive = paid them.
#   - neither: `view` selects the cross-cutting frame the caller wants:
#       * spending  -> filter to expense-side transactions, SUM
#       * income    -> filter to income-side transactions, -SUM
#       * cash_flow -> all transactions, -SUM (positive = net inflow)
@router.get("/summary/monthly-trend")
def monthly_trend(
    category_id: Optional[str] = Query(None),
    payee:       Optional[str] = Query(None),
    account_id:  Optional[str] = Query(None),
    facets:      TransactionFacets = Depends(),
    source_account_ids: Optional[str] = Query(None, description="comma-separated source (original) account IDs — narrows a merged-account view to specific underlying accounts"),
    months:      int            = Query(18, le=120),
    date_start:  Optional[str] = Query(None),
    date_end:    Optional[str] = Query(None),
    anchor:      Optional[str] = Query(None, description="'latest' slides the rolling window to end at the scope's most recent transaction instead of today"),
    view:        str            = Query("cash_flow", description="spending | income | cash_flow (used only when no category/payee scope)"),
):
    # Direct (non-HTTP) callers may omit the dependency; over HTTP FastAPI always supplies it.
    facets = coerce_facets(facets) or TransactionFacets()
    if payee:
        # Payee detail drawers want the merchant's full visible history by default, so the rolling month window is
        # suppressed unless the caller supplied an explicit date filter.
        clauses = ["t.is_pending = 0", "t.trashed_at IS NULL",
                   "(t.display_name = ? OR t.merchant_name = ? OR t.raw_name = ?)"]
        params  = [payee, payee, payee]
    else:
        clauses = ["t.is_pending = 0", "t.trashed_at IS NULL"]
        params  = []
        if _append_uncategorized_filter(clauses, params, category_id=category_id):
            pass
        elif category_id and category_id.startswith("__group__"):
            gid = category_id[len("__group__"):]
            clauses.append(
                """
                (
                    t.category_id IN (SELECT id FROM category WHERE parent_id = ?)
                    OR (
                        t.category_id IS NULL
                        AND t.amount > 0
                        AND EXISTS (
                            SELECT 1
                            FROM category
                            WHERE id = ?
                              AND system_key = ?
                        )
                    )
                )
                """
            )
            params.extend([gid, gid, UNASSIGNED_CATEGORY_SYSTEM_KEY])
        elif category_id:
            clauses.append("t.category_id = ?")
            params.append(category_id)
        # Spending/income trends classify by category_type, so transactions in a *type-less* category
        # (imported labels parked under `Unassigned`, not yet organized) do NOT appear in these trends —
        # only uncategorized rows get a sign-based fallback. This is why such a trend can read lower than
        # the headline total, which counts the Unassigned group via by-group's NET. Do NOT "fix" this by
        # extending the sign fallback to type-less categorized rows: Unassigned is dominated by offsetting
        # transfers (e.g. card payments) that net small per-group but gross up enormously per-transaction
        # (measured ~12x). The real resolution is organizing/ typing the imported categories.
        elif view == "spending":
            clauses.append(
                "(COALESCE(c.category_type, p.category_type) = 'expense' "
                "OR (t.category_id IS NULL AND t.amount > 0))"
            )
        elif view == "income":
            clauses.append(
                "(COALESCE(c.category_type, p.category_type) = 'income' "
                "OR (t.category_id IS NULL AND t.amount < 0))"
            )
        # cash_flow: no category-type filter

        if not category_id:
            # In cross-cutting dashboard frames the bars represent total
            # spending/income/cash flow, so categories marked exclude_from_totals
            # (transfers etc.) are removed. Detail-panel scopes (category_id) keep
            # showing their own activity unfiltered so the user can still see what
            # is in an excluded category when they ask for it explicitly.
            clauses.append(
                "COALESCE(p.exclude_from_totals, c.exclude_from_totals, 0) = 0"
            )

    _append_single_account_filter(clauses, params, account_id=account_id, account_ids=facets.account_ids)
    _append_source_account_filter(clauses, params, source_account_ids=source_account_ids)
    append_facets(clauses, params, facets)

    if date_start:
        clauses.append("t.date >= ?")
        params.append(date_start)
    if date_end:
        clauses.append("t.date <= ?")
        params.append(date_end)

    # `anchor='latest'` slides the rolling window to end at the scope's most recent transaction
    # (resolved below, inside the db session) instead of today, so a category whose activity is all
    # older than `months` still shows its most recent N months of history rather than nothing.
    anchor_latest = anchor == "latest" and not date_start and not date_end and not payee

    if (not date_start and not date_end and not payee and not account_id and not facets.account_ids
            and not source_account_ids and not anchor_latest):
        # The generic trends view stays bounded by a rolling window so dashboards do not turn into unbounded
        # all-history scans unless the caller explicitly asked for that.
        clauses.append("t.date >= date('now', ? || ' months')")
        params.append(f"-{months}")

    needs_category_join = bool(category_id) or (not payee)
    join_sql = (
        "LEFT JOIN category c ON c.id = t.category_id "
        "LEFT JOIN category p ON p.id = c.parent_id"
        if needs_category_join else ""
    )

    where = "WHERE " + " AND ".join(clauses)

    with get_db() as conn:
        # Category rollups read the split-expansion seam: a split transaction contributes one row
        # per allocation, so every facet, sentinel and exclusion guard below applies per part
        # without being restated. See services/txn_splits.py.
        _expanded = txn_effective_sql(conn, expand=True)
        if anchor_latest:
            anchor_row = conn.execute(
                f"SELECT MAX(t.date) AS m FROM txn t {join_sql} {where}",
                params,
            ).fetchone()
            anchor_date = anchor_row["m"] if anchor_row else None
            if anchor_date:
                clauses.append("t.date >= date(?, ? || ' months')")
                params.extend([anchor_date, f"-{months}"])
                clauses.append("t.date <= ?")
                params.append(anchor_date)
                where = "WHERE " + " AND ".join(clauses)

        if category_id:
            sign_factor = -1 if _resolve_category_is_income(conn, category_id) else 1
        elif payee:
            sign_factor = 1
        elif view == "income" or view == "cash_flow":
            sign_factor = -1
        else:
            sign_factor = 1

        rows = conn.execute(
            f"""
            SELECT
                strftime('%Y-%m', t.date) AS month,
                ({sign_factor} * SUM(t.amount)) AS total,
                COUNT(DISTINCT t.id)      AS count
            FROM   {_expanded} t
            {join_sql}
            {where}
            GROUP BY month
            ORDER BY month
            """,
            params,
        ).fetchall()

    return [dict(r) for r in rows]


# Monthly cash flow, split into the two sides the trend chart draws as diverging bars.
#
# **The atom is a category's net for the month, not a transaction's sign.** A month's `inflow` is the
# sum of the categories that net money *in* that month and `outflow` the sum of those that net money
# *out*, so a refund inside an expense category reduces that month's outflow instead of appearing as
# income. That is the same rule the single-period Sankey applies to decide which side a node sits on
# (a link cannot have a negative width), which is what makes a month's bars equal the sides of that
# month's diagram. The alternative — bucketing raw transaction signs — reports a larger gross both
# ways for the same net and would not reconcile against the diagram.
#
# `net` is `inflow - outflow` (positive = net inflow), and equals `/summary/monthly-trend`'s
# `view=cash_flow` total for the same filters: netting per bucket and then re-summing is the same
# arithmetic as summing the whole month. That equality is the contract between the two frames.
#
# No `count`: an accurate one is `COUNT(DISTINCT t.id)` per month, which cannot be recovered by summing
# per-bucket counts (the expansion seam puts a split transaction in several buckets), and reading the
# source a second time to get it is the cost the seam itself was shaped to avoid. Callers that need a
# count have `/summary/monthly-trend` over the same population.
@router.get("/summary/monthly-cash-flow")
def monthly_cash_flow(
    months:      int           = Query(24, le=240),
    account_id:  Optional[str] = Query(None),
    facets:      TransactionFacets = Depends(),
    source_account_ids: Optional[str] = Query(None, description="comma-separated source (original) account IDs — narrows a merged-account view to specific underlying accounts"),
    date_start:  Optional[str] = Query(None),
    date_end:    Optional[str] = Query(None),
):
    # Direct (non-HTTP) callers may omit the dependency; over HTTP FastAPI always supplies it.
    facets = coerce_facets(facets) or TransactionFacets()
    clauses = [
        "t.is_pending = 0",
        "t.trashed_at IS NULL",
        # Cash flow is a cross-cutting dashboard frame, so the transfer exclusion that governs every
        # other such frame governs it too — and it is the *only* exclusion axis the design allows.
        # See docs/data-model.md -> "Reporting assumptions" -> "Cash flow".
        "COALESCE(p.exclude_from_totals, c.exclude_from_totals, 0) = 0",
    ]
    params: list = []

    _append_single_account_filter(clauses, params, account_id=account_id, account_ids=facets.account_ids)
    _append_source_account_filter(clauses, params, source_account_ids=source_account_ids)
    append_facets(clauses, params, facets)

    if date_start:
        clauses.append("t.date >= ?")
        params.append(date_start)
    if date_end:
        clauses.append("t.date <= ?")
        params.append(date_end)
    if not date_start and not date_end:
        clauses.append("t.date >= date('now', ? || ' months')")
        params.append(f"-{months}")

    where = "WHERE " + " AND ".join(clauses)
    bucket_sql = _summary_uncategorized_id_sql('category')

    with get_db() as conn:
        # Category rollups read the split-expansion seam: a split transaction contributes one row
        # per allocation, so every facet, sentinel and exclusion guard below applies per part
        # without being restated. See services/txn_splits.py.
        _expanded = txn_effective_sql(conn, expand=True)
        rows = conn.execute(
            f"""
            SELECT
                month,
                SUM(CASE WHEN bucket_net < 0 THEN -bucket_net ELSE 0 END) AS inflow,
                SUM(CASE WHEN bucket_net > 0 THEN  bucket_net ELSE 0 END) AS outflow,
                -SUM(bucket_net)                                          AS net
            FROM (
                SELECT
                    strftime('%Y-%m', t.date) AS month,
                    {bucket_sql}              AS bucket,
                    SUM(t.amount)             AS bucket_net
                FROM   {_expanded} t
                LEFT JOIN category c ON c.id = t.category_id
                LEFT JOIN category p ON p.id = c.parent_id
                {where}
                GROUP BY month, bucket
            )
            GROUP BY month
            ORDER BY month
            """,
            params,
        ).fetchall()

    return [dict(r) for r in rows]

@router.get("/summary/monthly-by-group")
def monthly_by_group(
    # The Trends view fetches its full visible history through this one window. The bound stays generous
    # rather than unbounded (20 years) so the multi-year trend/annual charts can reach every year in the
    # data without turning into an open-ended all-history scan.
    months:      int           = Query(24, le=240),
    account_id:  Optional[str] = Query(None),
    facets:      TransactionFacets = Depends(),
    group_id:    Optional[str] = Query(None),
):
    # Direct (non-HTTP) callers may omit the dependency; over HTTP FastAPI always supplies it.
    facets = coerce_facets(facets) or TransactionFacets()
    clauses = [
        "t.is_pending = 0",
        "t.trashed_at IS NULL",
        "t.date >= date('now', ? || ' months')",
        "strftime('%Y-%m', t.date) IS NOT NULL",
        "COALESCE(p.exclude_from_totals, c.exclude_from_totals, 0) = 0",
    ]
    params = [f"-{months}"]

    _append_single_account_filter(clauses, params, account_id=account_id, account_ids=facets.account_ids)
    append_facets(clauses, params, facets)

    if group_id == UNCATEGORIZED_EXPENSE_CATEGORY_ID:
        clauses.extend(["t.category_id IS NULL", "t.amount > 0"])
    elif group_id == UNCATEGORIZED_INCOME_CATEGORY_ID:
        clauses.extend(["t.category_id IS NULL", "t.amount < 0"])
    elif group_id:
        clauses.append("(c.parent_id = ? OR (c.parent_id IS NULL AND c.id = ?))")
        params.extend([group_id, group_id])

    where = "WHERE " + " AND ".join(clauses)

    if group_id == UNCATEGORIZED_EXPENSE_CATEGORY_ID:
        select_id   = f"'{UNCATEGORIZED_EXPENSE_CATEGORY_ID}' AS series_id"
        select_name = f"'{UNCATEGORIZED_EXPENSE_CATEGORY_NAME}' AS series_name"
        select_col  = "NULL AS series_color"
        type_expr   = "'expense'"
        join        = "LEFT JOIN category c ON c.id = t.category_id LEFT JOIN category p ON p.id = c.parent_id"
    elif group_id == UNCATEGORIZED_INCOME_CATEGORY_ID:
        select_id   = f"'{UNCATEGORIZED_INCOME_CATEGORY_ID}' AS series_id"
        select_name = f"'{UNCATEGORIZED_INCOME_CATEGORY_NAME}' AS series_name"
        select_col  = "NULL AS series_color"
        type_expr   = "'income'"
        join        = "LEFT JOIN category c ON c.id = t.category_id LEFT JOIN category p ON p.id = c.parent_id"
    elif group_id:
        # Drill-down switches the series identity from top-level groups to the group's leaf categories without
        # changing the payload shape, so the trends UI can reuse one charting pipeline for both levels.
        select_id   = f"{_summary_uncategorized_id_sql('category')}   AS series_id"
        select_name = f"{_summary_uncategorized_name_sql('category')} AS series_name"
        select_col  = "NULL                                AS series_color"
        type_expr   = _summary_uncategorized_type_sql('category')
        # Keep the parent join available because the shared reporting filters above still
        # read parent-group metadata such as exclude-from-totals and system category type.
        join        = "LEFT JOIN category c ON c.id = t.category_id LEFT JOIN category p ON p.id = c.parent_id"
    else:
        select_id   = f"{_summary_uncategorized_id_sql('group')}   AS series_id"
        select_name = f"{_summary_uncategorized_name_sql('group')} AS series_name"
        select_col  = "NULL                                          AS series_color"
        type_expr   = _summary_uncategorized_type_sql('group')
        join        = "LEFT JOIN category c ON c.id = t.category_id LEFT JOIN category p ON p.id = c.parent_id"

    select_type = f"{type_expr} AS series_category_type"
    # Signed net per series (see _summary_signed_total_sql): a group that *net-refunded* a month reduces
    # that month's total instead of inflating it, so the Trends "Total per month" bar agrees with the
    # single-period spending total. The stacked by-group area chart floors each band at zero client-side
    # for readable stacking; every numeric total keeps this true sign.
    select_total = f"{_summary_signed_total_sql(type_expr)} AS total"

    with get_db() as conn:
        # Category rollups read the split-expansion seam: a split transaction contributes one row
        # per allocation, so every facet, sentinel and exclusion guard below applies per part
        # without being restated. See services/txn_splits.py.
        _expanded = txn_effective_sql(conn, expand=True)
        rows = conn.execute(
            f"""
            SELECT
                strftime('%Y-%m', t.date) AS month,
                {select_id},
                {select_name},
                {select_col},
                {select_type},
                {select_total}
            FROM   {_expanded} t
            {join}
            {where}
            GROUP BY month, series_id
            ORDER BY month, total DESC
            """,
            params,
        ).fetchall()

    return [dict(r) for r in rows]
