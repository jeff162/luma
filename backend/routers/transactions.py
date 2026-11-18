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
from typing import NamedTuple, Optional
from datetime import datetime
from decimal import Decimal
import re
import uuid
from backend.db.database import compact_if_worthwhile, get_db
from backend.services.connection_names import card_title_sql
from backend.services.amount_text import DECIMAL_POINT, amount_text_parts
from backend.services.input_format import (
    DATE_ORDER_DMY, DATE_ORDER_MDY, DATE_ORDER_YMD, DEFAULT_INPUT_FORMAT, InputFormat,
    caller_input_format, coerce_input_format,
)
from backend.services.recurring_detection import owe_recurring_rescan, payee_keys_for_ids, settle_owed_rescans
from backend.services.import_batch_totals import delete_transactions
from backend.services.storage_summary import TRASH_DELETED_SQL, TRASH_DUPLICATES_SQL
from backend.services.txn_trash import restore_txns, trash_txns
from backend.services.account_groups import effective_account_id_sql
from backend.services.transaction_attributes import attribute_require_all_sql, attribute_vocabulary
from backend.services.transaction_facets import (
    AMOUNT_PARAM_NAMES,
    AmountFilter,
    FACET_PARAM_NAMES,
    PAYEE_LABEL_SQL,
    TransactionFacets,
    UNCATEGORIZED_CATEGORY_ID,
    UNCATEGORIZED_EXPENSE_CATEGORY_ID,
    UNCATEGORIZED_INCOME_CATEGORY_ID,
    account_membership,
    append_amount_filter,
    append_facets,
    append_totals_exclusion,
    coerce_facets,
    facets_from,
    group_membership,
    like_contains_pattern,
)
from backend.services.transaction_tags import (
    effective_selected_tag_signature_sql,
    effective_tag_match_all_sql,
    get_blocked_transaction_tag_map,
    get_visible_transaction_tag_map,
    list_visible_transaction_tags,
    set_manual_transaction_tag,
)
from backend.services.categorizer import (
    category_lock_for,
    recategorize_all,
)
from backend.services.documents import (
    INGEST_GRACE_SECONDS,
    document_match_excerpts,
    documents_map_for,
    sweep_unreferenced_files,
)
from backend.services.purchase_links import purchase_for_txn, purchase_map_for
from backend.services.refund_links import following_refund_ids, refund_map_for
from backend.services.txn_links import partners_map
from backend.services.reimbursements import (
    claimed_txn_ids,
    receivable_amounts,
    receivable_change_refusal,
    receivable_of_allocations,
    receivable_of_category,
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
    save_split,
    split_txn_ids,
    suggest_split,
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


def _resolve_group_is_income(conn, group_id: str) -> bool:
    if group_id == UNCATEGORIZED_INCOME_CATEGORY_ID:
        return True
    if group_id in (UNCATEGORIZED_EXPENSE_CATEGORY_ID, UNCATEGORIZED_CATEGORY_ID):
        return False
    row = conn.execute("SELECT category_type FROM category WHERE id = ?", [group_id]).fetchone()
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
#   combine two — a precise combination belongs to a page-local control like the amount filter
# - the result stays additive with the normal ledger filters instead of replacing them
def _split_quick_filter_field(value: str):
    match = re.match(r"^([A-Za-z]+)\s*:\s*(.*)$", value)
    if not match:
        return None, value
    field = match.group(1).lower()
    if field not in QUICK_FILTER_FIELD_PREFIXES:
        return None, value
    return field, match.group(2).strip()


def _build_quick_filter_clause(value: str, *, expanded: bool = False, input_format: InputFormat = DEFAULT_INPUT_FORMAT):
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

    if field is None:
        # What a split's parts cover, in the user's words. Neither a name nor imported text, so only the
        # unprefixed search reads it.
        or_clauses.append(split_label_match_sql(expanded=expanded))
        params.append(f"%{lowered}%")

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
        date_order = input_format.date_order
        iso_date = _parse_quick_filter_date(search_text, date_order)
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
        month_day = _parse_quick_filter_month_day(search_text, date_order)
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
        match_query = _fts_match_query(search_text, input_format.date_order)
        if match_query:
            or_clauses.append(DOCUMENT_MATCH_SQL)
            params.append(match_query)

    if want("amount"):
        amount = _parse_quick_filter_amount(search_text, input_format.decimal_separator)
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
VISIBLE_NAME_SQL = f"LOWER({PAYEE_LABEL_SQL})"

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


def split_label_match_sql(*, expanded: bool) -> str:
    """Whether a split part's label matches one LIKE pattern, against a row source that is or is not expanded.

    Expanded, a row is one part, and only *its* label counts — a search for one item inside a category
    scope must not bring back another category's part of the same purchase. Unexpanded, a row is the whole
    purchase, so any part's label does.
    """
    part = "s.id = t.split_part_id" if expanded else "s.txn_id = t.id"
    return f"EXISTS (SELECT 1 FROM txn_split s WHERE {part} AND LOWER(COALESCE(s.label, '')) LIKE ?)"


def split_label_match_query(quick_filter: Optional[str]) -> Optional[str]:
    """The LIKE pattern a quick filter implies for split part labels, or None if it searches none.

    Used by the list feed to mark a whole split found through a part's label, which the row itself does not
    show (an expanded part row shows its own label, so it needs no mark).
    """
    text = (quick_filter or "").strip()
    if not text:
        return None
    field, _ = _split_quick_filter_field(text)
    return None if field is not None else f"%{text.lower()}%"


def hidden_text_search_value(quick_filter: Optional[str]) -> Optional[str]:
    """The text a quick filter looks for in names and captured text, or None if it searches neither.

    It is the whole filter when unprefixed and the value after `merchant:` or `raw:`; an unprefixed filter
    is also what split part labels are searched for. The list feed returns it on the rows it marks as
    matched on text the row does not show, so the hover that shows that text can highlight the match.
    """
    text = (quick_filter or "").strip()
    if not text:
        return None
    field, remainder = _split_quick_filter_field(text)
    if field not in (None, "merchant", "raw"):
        return None
    return (remainder if field is not None else text) or None


def hidden_text_match_sql(quick_filter: Optional[str]):
    """`(sql, params)` for whether a row matched a quick filter on text its visible name does not show, or
    None when the filter searches no names.

    The sibling of `document_match_query`, for the same reason: a row found through its raw bank text or a
    memo column has no visible cause on screen, so the list feed marks it rather than leaving it to read as
    a wrong result. A row whose visible name also matches is not marked — the name already explains it.
    """
    value = hidden_text_search_value(quick_filter)
    if not value:
        return None
    field, _ = _split_quick_filter_field(quick_filter.strip())
    pattern = f"%{value.lower()}%"
    hidden_sql, hidden_params = _hidden_text_sql(pattern, field)
    return f"({hidden_sql} AND {VISIBLE_NAME_SQL} NOT LIKE ?)", [*hidden_params, pattern]


def document_match_query(quick_filter: Optional[str], input_format: InputFormat = DEFAULT_INPUT_FORMAT) -> Optional[str]:
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
    return _fts_match_query(remainder if field is not None else text, input_format.date_order)


def _fts_match_query(value: str, date_order: str = DATE_ORDER_MDY) -> Optional[str]:
    """Turn what someone typed into an FTS5 MATCH expression, or None if nothing usable is left.

    **Every token is quoted rather than passed through.** FTS5 MATCH is a query language — `AND`, `*`,
    `:`, `^`, parentheses and quotes all mean something — so raw input is both a syntax error waiting to
    happen (an unbalanced quote raises, which would surface as a 500 from a typo) and a way to write a
    query nobody asked for. Quoting each token makes it a literal phrase, so a receipt can be searched
    for `AND` or `store (west)` and get what it says.

    **Terms match by prefix.** Every other quick-filter facet is a substring match, so an exact-word
    search here would behave differently from the box it shares — `doc:brak` finding nothing while
    `merchant:brak` finds Brake Co. Prefix is the closest FTS equivalent to typing-as-you-go.

    **Text typed without a space is one phrase**, its pieces adjacent and in order; only spaces separate
    the terms that are ANDed. FTS5 splits `13.80` or `8/25/2026` into several tokens, and ANDing those
    loose found any receipt holding a word starting with each somewhere — `8oz`, a `6.25%` tax line and
    the year were enough to "match" a date that appeared nowhere.

    **A date is searched as the date, not as its spelling**, with or without its year — see
    `_fts_date_phrases`.
    """
    date_phrases = _fts_date_phrases(value, date_order)
    if date_phrases:
        return " OR ".join(f'"{phrase}"' for phrase in date_phrases)
    terms = []
    for chunk in (value or "").split():
        tokens = [token for token in re.split(r"[^0-9A-Za-z\']+", chunk) if token]
        if tokens:
            terms.append(f'"{" ".join(tokens)}"*')
    return " ".join(terms) or None


def _fts_date_phrases(value: str, date_order: str = DATE_ORDER_MDY) -> list[str]:
    """The ways a receipt may print the date `value` names, as FTS5 phrases, or [] if it names no date.

    A receipt's date is free text in whatever form its issuer chose, so the form typed is rarely the form
    printed: `8/25/2026` has to find `08/25/2026`, `8/25/26`, `2026-08-25` and `Aug 25, 2026`. Punctuation
    is not listed because the tokenizer drops it, which also covers `Aug. 25, 2026` and `08-25-2026`. The
    numeric forms are written in the searcher's date order, on the assumption that a receipt they hold
    prints dates the way they write them; a named month is listed both ways round, since it cannot be
    misread.

    A month and day with no year (`8/25`, `Aug 25`) gets the same forms without one, and a phrase matches
    wherever it sits, so those find the date in any year.
    """
    iso_date = _parse_quick_filter_date(value, date_order)
    month_day = None if iso_date else _parse_fts_month_day(value, date_order)
    if not iso_date and not month_day:
        return []
    year, month, day = iso_date.split("-") if iso_date else (None, *month_day.split("-"))
    months = sorted({month, str(int(month))})
    days = sorted({day, str(int(day))})
    # Named from a fixed leap year: only the month is read, and Feb 29 has to be constructible.
    named = datetime(2000, int(month), 1)
    names = sorted({named.strftime("%b").lower(), named.strftime("%B").lower()})
    day_first = date_order == DATE_ORDER_DMY
    if not year:
        phrases = [f"{d} {m}" if day_first else f"{m} {d}" for m in months for d in days]
        phrases += [f"{name} {d}" for name in names for d in days]
        phrases += [f"{d} {name}" for name in names for d in days]
        return phrases
    years = (year, year[2:])
    phrases = [f"{year} {month} {day}"]
    if date_order == DATE_ORDER_YMD:
        phrases += [f"{year} {m} {d}" for m in months for d in days if (m, d) != (month, day)]
    else:
        phrases += [f"{d} {m} {y}" if day_first else f"{m} {d} {y}" for m in months for d in days for y in years]
    phrases += [f"{name} {d} {year}" for name in names for d in days]
    phrases += [f"{d} {name} {year}" for name in names for d in days]
    return phrases


# A named month is unambiguous, so it is read either way round in every date order.
_NAMED_MONTH_DAY_FORMATS = ("%b %d", "%B %d", "%d %b", "%d %B")


def _parse_fts_month_day(value: str, date_order: str = DATE_ORDER_MDY) -> Optional[str]:
    """A month and day with no year as "MM-DD" — `_parse_quick_filter_month_day`, plus a named month."""
    numeric = _parse_quick_filter_month_day(value, date_order)
    if numeric:
        return numeric
    text = (value or "").strip()
    for fmt in _NAMED_MONTH_DAY_FORMATS:
        try:
            # Parsed against a leap year so Feb 29 is not refused.
            return datetime.strptime(f"{text} 2000", f"{fmt} %Y").strftime("%m-%d")
        except ValueError:
            continue
    return None


def _normalize_quick_filter_text(value: str) -> str:
    return " ".join(re.sub(r"[()./_-]+", " ", str(value or "").strip().lower()).split())


# **The parse order follows the searcher's date order**, because `02/01/2026` is Feb 1 to one person and
# 1 Feb to another and nothing in the text says which. ISO `2026-02-01` is read first in every order: it
# cannot be misread, and it is what the help names as the form that always works. A named month is read
# either way round, for the same reason.
_NUMERIC_DATE_FORMATS = {
    DATE_ORDER_MDY: ("%m/%d/%Y", "%m/%d/%y", "%m-%d-%Y", "%m-%d-%y", "%m.%d.%Y", "%m.%d.%y"),
    DATE_ORDER_DMY: ("%d/%m/%Y", "%d/%m/%y", "%d-%m-%Y", "%d-%m-%y", "%d.%m.%Y", "%d.%m.%y"),
    DATE_ORDER_YMD: ("%Y/%m/%d", "%Y.%m.%d"),
}
_NAMED_DATE_FORMATS = (
    "%b %d %Y", "%b %d, %Y", "%B %d %Y", "%B %d, %Y", "%d %b %Y", "%d %B %Y",
)


def _parse_quick_filter_date(value: str, date_order: str = DATE_ORDER_MDY) -> Optional[str]:
    text = (value or "").strip()
    if not text:
        return None
    formats = ("%Y-%m-%d", *_NUMERIC_DATE_FORMATS.get(date_order, _NUMERIC_DATE_FORMATS[DATE_ORDER_MDY]), *_NAMED_DATE_FORMATS)
    for fmt in formats:
        try:
            return datetime.strptime(text, fmt).date().isoformat()
        except ValueError:
            continue
    return None


def _parse_quick_filter_year_month(value: str) -> Optional[str]:
    # A four-digit year cannot be mistaken for a month, so these read the same in every date order.
    text = (value or "").strip()
    if not text:
        return None
    formats = ["%Y-%m", "%Y/%m", "%m/%Y", "%m-%Y"]
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


def _parse_quick_filter_month_day(value: str, date_order: str = DATE_ORDER_MDY) -> Optional[str]:
    # A month/day with no year (mm/dd or mm-dd, dd/mm in a day-first order) returns "MM-DD" for an any-year
    # match. Validated by range rather than strptime so leap days like 2/29 are not rejected against an
    # arbitrary year.
    match = re.fullmatch(r"\s*(\d{1,2})[/-](\d{1,2})\s*", value or "")
    if not match:
        return None
    first, second = int(match.group(1)), int(match.group(2))
    month, day = (second, first) if date_order == DATE_ORDER_DMY else (first, second)
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


def _parse_quick_filter_amount(
    value: str, decimal_separator: str = DECIMAL_POINT,
) -> Optional[tuple[int, int, Optional[str]]]:
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

    **Read in the searcher's number format** by the import's strict parser (`services/amount_text.py`):
    `1.234` is twelve hundred with a decimal comma and one and a quarter with a decimal point, so the
    same text means a different number in each, and a form that is well-formed in neither (`12,50` with a
    decimal point) is not an amount at all rather than a guess. Strict also keeps out what `Decimal` would
    accept — `inf`, `nan` and `1e3` — the first two of which raised out of the list query on the way to
    typing a name like "Nantucket".
    """
    try:
        sign, digits = amount_text_parts(value or "", decimal_separator)
    except ValueError:
        return None
    direction = {"-": "out", "+": "in"}.get(sign)
    dollars, _, cents = digits.partition(".")
    if len(cents) >= 2:
        exact = int((Decimal(digits) * 100).quantize(Decimal("1")))
        return exact, exact, direction
    low = int(dollars or 0) * 100 + (int(cents) * 10 if cents else 0)
    return low, low + (9 if cents else 99), direction


def _build_transaction_filter(
    *,
    month=None, date_start=None, date_end=None, import_batch_id=None,
    account_id=None, source_account_ids=None, category_id=None, group_id=None, require_all_tag_ids=None,
    require_all_attribute_ids=None,
    direction=None, view=None, search=None, quick_filter=None, ids=None,
    sync_connection_id=None, expanded=False,
    needs_review=None, include_trashed=False, recurring_series_id=None,
    recurring_excluded_series_id=None, import_evidence_type=None,
    amount_min=None, amount_max=None, amount_min_op=None, amount_max_op=None,
    recurring_only=None, input_format=None,
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
    # One group of a breakdown, as a drill opens it: unlike `group_ids`, which ORs with `category_ids`
    # as the filter bar's selection, this ANDs with every facet, so the list is the rows behind the
    # slice's figure under the page's filter. It means what `group_id` means on the summary endpoints:
    # the group's leaves, or the bucket a synthetic uncategorized id names.
    group_scope = group_membership([group_id]) if group_id and isinstance(group_id, str) else None
    if group_scope:
        clauses.append(group_scope[0])
        params.extend(group_scope[1])
    # group/category/tag/payee/owner include+exclude all route through the shared facet helpers so the
    # list feed and the summary/trend endpoints build one identical set definition per facet (and its
    # NULL-safe negation). Payee chips come from canonicalized labels in the UI, so matching honors
    # whichever merchant field currently carries the visible name; owner exposes the unowned bucket as a
    # first-class 'unassigned' value.
    _append_require_all_tags_filter(clauses, params, require_all_tag_ids=require_all_tag_ids)
    _append_require_all_attributes_filter(
        clauses, params, require_all_attribute_ids=require_all_attribute_ids,
    )
    append_amount_filter(clauses, params, {
        "direction": direction, "amount_min": amount_min, "amount_max": amount_max,
        "amount_min_op": amount_min_op, "amount_max_op": amount_max_op,
    })
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
        append_totals_exclusion(clauses, params, facets_from(facet_kwargs), group_alias="pc")
        clauses.append("t.is_pending = 0")
    if search:
        clauses.append("(t.display_name LIKE ? OR t.merchant_name LIKE ? OR t.raw_name LIKE ?)")
        params.extend([f"%{search}%", f"%{search}%", f"%{search}%"])
    if quick_filter:
        quick_filter_clause = _build_quick_filter_clause(
            quick_filter, expanded=expanded, input_format=coerce_input_format(input_format),
        )
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


@router.get("/payee-names")
def list_payee_names(
    q: str = Query(..., description="fragment of a payee name"),
    limit: int = Query(20, ge=1, le=100),
):
    """The distinct payee names containing `q`, most used first — what the FilterBar's Payee tab offers.

    A query of its own rather than names read off a page of the list feed: that page is a number of
    *transactions*, so one frequent payee filled it and the others never appeared, and it was found by
    the ledger search, which also matches categories, amounts and attachment text and so offered names
    that do not contain what was typed. Spellings differing only in case are one entry, as they are to
    the payee facet.
    """
    fragment = q.strip()
    if not fragment:
        return []
    with get_db() as conn:
        rows = conn.execute(
            f"""
            SELECT name FROM (
                SELECT {PAYEE_LABEL_SQL} AS name FROM txn t WHERE t.trashed_at IS NULL
            )
            WHERE name LIKE ? ESCAPE '\\'
            GROUP BY name COLLATE NOCASE
            ORDER BY COUNT(*) DESC, name COLLATE NOCASE
            LIMIT ?
            """,
            (like_contains_pattern(fragment), limit),
        ).fetchall()
    return [row["name"] for row in rows]


def transaction_list_filters(
    month:        Optional[str] = Query(None, description="YYYY-MM"),
    date_start:   Optional[str] = Query(None, description="YYYY-MM-DD"),
    date_end:     Optional[str] = Query(None, description="YYYY-MM-DD"),
    import_batch_id: Optional[str] = Query(None),
    account_id:   Optional[str] = Query(None),
    source_account_ids: Optional[str] = Query(None),
    category_id:  Optional[str] = Query(None),
    group_id:     Optional[str] = Query(None),
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
    import_evidence_type: Optional[str] = Query(None),
    needs_review: bool          = Query(False),
    include_trashed: bool       = Query(False),
    input_format: InputFormat   = Depends(caller_input_format),
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

    # A category-shaped facet is what makes split expansion correct *here*. Scoped to a category, a
    # split transaction belongs in the result as the part that matched, carrying the part's amount — so
    # a drill-down's visible rows sum to the total its summary endpoint reported. Unscoped, the ledger
    # must stay one row per purchase, so the plain table is the row source and a split renders once at
    # its full amount (`is_split` / `split_part_count` drive the "Split (N)" affordance). `view` counts
    # because every cross-cutting scope resolves through the category: spending/income through its type,
    # and cash_flow through its exclude_from_totals guard, which a split's parts can straddle. See
    # services/txn_splits.py.
    expand_splits = bool(
        filters.get("category_id") or filters.get("group_id") or facets.category_ids or facets.group_ids
        or facets.exclude_category_ids or facets.exclude_group_ids
        or filters.get("view") in ("spending", "income", "cash_flow")
    )
    clauses, params = _build_transaction_filter(**filters, **facets.as_params(), expanded=expand_splits)
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


def transaction_ids_matching(conn, txn_ids, *, facets, filters: dict) -> set[str]:
    """Which of `txn_ids` the list feed would show under these filters.

    For a surface that lists something other than transactions but is narrowed by the FilterBar, so it
    reads the filters exactly as the ledger does — split parts under a category scope included — rather
    than restating them. A trashed row never matches.
    """
    txn_ids = list(dict.fromkeys(txn_ids))
    if not txn_ids:
        return set()
    where, params, expand_splits, _ = transaction_list_scope(
        facets=facets, sort_by=None, sort_dir=None, filters={**filters, "ids": ",".join(txn_ids)},
    )
    rows = conn.execute(
        f"""
        SELECT DISTINCT t.id
        FROM {txn_effective_sql(conn, expand=expand_splits)} t
        JOIN account a ON a.id = t.account_id
        LEFT JOIN account p ON p.id = a.parent_account_id
        LEFT JOIN category c ON c.id = t.category_id
        LEFT JOIN category pc ON pc.id = c.parent_id
        {where}
        """,
        params,
    ).fetchall()
    return {row["id"] for row in rows}


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
    group_id:     Optional[str] = Query(None, description="one breakdown group (or synthetic uncategorized bucket) a drill lists; ANDs with every facet, unlike group_ids"),
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
    import_evidence_type: Optional[str] = Query(None, description="Only rows whose captured import evidence carries this `Type` value (PayPal money-movement report)."),
    needs_review: bool          = Query(False, description="Only rows still flagged as needing review (freshly imported/synced, not yet looked over)."),
    include_trashed: bool       = Query(False, description="Include rows in the trash. Off by default — the trash view sets this explicitly."),
    limit:        int           = Query(200, ge=0, le=1000, description="rows per page (max 1000); 0 = no limit — returns all matching rows, for known-bounded scopes only"),
    offset:       int           = Query(0),
    input_format: InputFormat   = Depends(caller_input_format),
):
    # Direct (non-HTTP) callers may omit the dependencies; over HTTP FastAPI always supplies them.
    facets = coerce_facets(facets) or TransactionFacets()
    input_format = coerce_input_format(input_format)
    # This endpoint is the UI's lossless transaction feed, so filters narrow the raw rows but do not apply the
    # reporting rules used by summaries such as excluding pending transactions or normalizing amount direction.
    # The exception is `view`, which asks for exactly the rows behind a Dashboard figure and so takes the
    # summaries' exclusions (see _build_transaction_filter); the sign is still left to the caller.
    where, params, expand_splits, order_by = transaction_list_scope(
        facets=facets, sort_by=sort_by, sort_dir=sort_dir,
        filters=dict(
            month=month, date_start=date_start, date_end=date_end, import_batch_id=import_batch_id,
            account_id=account_id, source_account_ids=source_account_ids,
            category_id=category_id, group_id=group_id, require_all_tag_ids=require_all_tag_ids,
            require_all_attribute_ids=require_all_attribute_ids,
            direction=direction, view=view, search=search, quick_filter=quick_filter, ids=ids,
            sync_connection_id=sync_connection_id,
            needs_review=needs_review, include_trashed=include_trashed, recurring_series_id=recurring_series_id,
            recurring_only=recurring_only,
            recurring_excluded_series_id=recurring_excluded_series_id,
            import_evidence_type=import_evidence_type,
            amount_min=amount_min, amount_max=amount_max,
            amount_min_op=amount_min_op, amount_max_op=amount_max_op,
            input_format=input_format,
        ),
    )

    # Why a row came back, for the rows whose reason is invisible. Each is projected only when the filter
    # actually has that component, so the ordinary listing pays nothing for it.
    doc_query = document_match_query(quick_filter, input_format)
    document_match_column = f"{DOCUMENT_MATCH_SQL} AS matched_document," if doc_query else ""
    document_match_params = [doc_query] if doc_query else []
    hidden_text_match = hidden_text_match_sql(quick_filter)
    if hidden_text_match:
        document_match_column += f" {hidden_text_match[0]} AS matched_hidden_text,"
        document_match_params += hidden_text_match[1]
    label_query = None if expand_splits else split_label_match_query(quick_filter)
    if label_query:
        document_match_column += f" {split_label_match_sql(expanded=False)} AS matched_split_label,"
        document_match_params.append(label_query)

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
                {card_title_sql("b", "bconn")} AS import_batch_filename,
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
            LEFT JOIN connection bconn ON bconn.id = b.connection_id
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
        # Where the search matched inside a document, the passage, so the marker can show it — the
        # viewer cannot point at it, since it hands the file to the browser untouched.
        excerpts_by_document = (
            document_match_excerpts(conn, doc_query, [t["id"] for t in transactions if t.get("matched_document")])
            if doc_query else {}
        )
        # The text the search looked for, on the rows matched through text the row itself does not show,
        # so the hover that shows that text can highlight it.
        hidden_search_value = hidden_text_search_value(quick_filter)
        # The purchase each row is a payment of, for the row's link marker. A *summary* per row (label,
        # ordinal, totals) rather than the sibling payments: this marker explains the row rather than
        # acting on it, so the panel is where the payments are listed. See services/purchase_links.py.
        purchases_by_txn = purchase_map_for(conn, txn_ids) if rows else {}
        # The reimbursements each row has a share in, for the row's marker. A **list**, because a split
        # row can be part of several — two friends' shares of one charge, a deposit repaying both — so a
        # singular field would name one and hide the rest. See services/reimbursements.py.
        reimbursements_by_txn = reimbursement_map_for(conn, txn_ids) if rows else {}
        # The refund pairing each row is on either side of, for the same link marker the purchase uses:
        # who the other side is, so the marker can name it and open it. See services/refund_links.py.
        refunds_by_txn = refund_map_for(conn, txn_ids) if rows else {}
        # The Amazon order each row is the card charge of, or the charges an order row was paid by — the
        # same marker again, so a charge the importer excluded reads as paired wherever it is seen rather
        # than only in the Amazon card's reconciliation report. Lazy: the Amazon importer imports routers
        # that import this one.
        from backend.routers.import_export.amazon import LINK_KIND as AMAZON_ORDER_LINK_KIND
        amazon_by_txn = partners_map(conn, AMAZON_ORDER_LINK_KIND, txn_ids) if rows else {}
        for txn in transactions:
            txn["tags"] = tag_map.get(txn["id"], [])
            # Tags the user hid on this row (inherited/rule opt-out); the picker offers them for restore.
            txn["blocked_tags"] = blocked_map.get(txn["id"], [])
            parts = split_parts.get(txn["id"], [])
            txn["split_parts"] = parts
            txn["split_part_count"] = len(parts)
            docs = documents_by_txn.get(txn["id"], [])
            for doc in docs:
                if doc["id"] in excerpts_by_document:
                    doc["match_excerpt"] = excerpts_by_document[doc["id"]]
            if txn.get("matched_hidden_text") or txn.get("matched_split_label"):
                txn["matched_search_text"] = hidden_search_value
            txn["documents"] = docs
            txn["document_count"] = len(docs)
            txn["purchase"] = purchases_by_txn.get(txn["id"])
            txn["reimbursements"] = reimbursements_by_txn.get(txn["id"], [])
            txn["refund_link"] = refunds_by_txn.get(txn["id"])
            txn["amazon_order"] = amazon_by_txn.get(txn["id"])

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
        owe_recurring_rescan(conn, [txn_id])
        row = conn.execute(
            """SELECT t.id, t.date, t.amount, t.display_name, t.category_id, t.notes,
                      COALESCE(c.name, '') AS category_name
               FROM   txn t LEFT JOIN category c ON c.id = t.category_id
               WHERE  t.id = ?""",
            (txn_id,),
        ).fetchone()
    settle_owed_rescans()
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
    a row can fail more than one of these, and the first is the one worth saying.

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
        owe_recurring_rescan(conn, [txn_id])
        updated = conn.execute(
            """SELECT t.id, t.date, t.amount, t.display_name, t.category_id, t.notes,
                      COALESCE(c.name, '') AS category_name
               FROM   txn t LEFT JOIN category c ON c.id = t.category_id
               WHERE  t.id = ?""",
            (txn_id,),
        ).fetchone()
    settle_owed_rescans()
    return dict(updated)


@router.patch("/{txn_id}/category")
def override_category(txn_id: str, body: CategoryOverride):
    with get_db() as conn:
        txn = conn.execute(
            "SELECT id, is_split, category_id, amount FROM txn WHERE id = ?", (txn_id,)
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
        # Moving the row out of the Reimbursable group takes the money a reimbursement has claimed with
        # it; see `receivable_change_refusal` for why that fails silently rather than loudly.
        refusal = receivable_change_refusal(
            conn, txn_id, receivable_of_category(conn, body.category_id, txn["amount"])
        )
        if refusal:
            raise HTTPException(status_code=400, detail=refusal)

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
        # owe_recurring_rescan), and nothing else re-runs after a hand edit. Gated on the category
        # actually changing: a re-save of the same category is a common no-op (the picker fires on every
        # confirm) and a scan costs a pass over the whole detection window.
        if body.category_id != txn["category_id"]:
            owe_recurring_rescan(conn, [txn_id])
        resolved = _resolved_tags_response(conn, txn_id)
        followed_ids = following_refund_ids(conn, [txn_id])
    settle_owed_rescans()
    # `followed_ids`: the refunds that moved with this row's category (services/refund_links.py), which
    # the client refetches — its patch covers only the row it edited.
    return {"ok": True, **resolved, "followed_ids": followed_ids}


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
        allocations = [p.model_dump() for p in body.parts]
        # Reallocating may shrink what sits in the Reimbursable group. Raising the receivable, or
        # lowering it to a figure that still covers every claim, is an ordinary correction and passes.
        refusal = receivable_change_refusal(
            conn, txn_id, receivable_of_allocations(conn, allocations)
        )
        if refusal:
            raise HTTPException(status_code=400, detail=refusal)
        try:
            parts = save_split(conn, txn_id, allocations)
        except SplitValidationError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
    return {"txn_id": txn_id, "is_split": True, "parts": parts}


@router.delete("/{txn_id}/split")
def delete_transaction_split(txn_id: str):
    """Un-split a transaction, restoring the category it carried before the split."""
    with get_db() as conn:
        row = conn.execute(
            "SELECT id, amount, category_id FROM txn WHERE id = ?", (txn_id,)
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Transaction not found")
        # Un-splitting returns the row to its stashed prior category, so its receivable becomes whatever
        # that single category holds — nothing at all, unless the prior was itself a receivable leaf.
        refusal = receivable_change_refusal(
            conn, txn_id, receivable_of_category(conn, row["category_id"], row["amount"])
        )
        if refusal:
            raise HTTPException(status_code=400, detail=refusal)
        clear_split(conn, txn_id)
    return {"ok": True}


@router.get("/{txn_id}/split/suggestion")
def suggest_transaction_split(txn_id: str):
    """A proposed allocation from the per-item detail an import captured; see `suggest_split`."""
    with get_db() as conn:
        suggestion = suggest_split(conn, txn_id)
    if suggestion is None:
        raise HTTPException(status_code=404, detail="Transaction not found")
    return suggestion


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
            owe_recurring_rescan(conn, [txn_id], prior_payee_keys=prior)
    settle_owed_rescans()
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
        prior = conn.execute(
            "SELECT category_id, is_split FROM txn WHERE id = ?", (txn_id,)
        ).fetchone()
        had_category = prior is not None and prior["category_id"] is not None
        # A split row's categorization is its allocations, and its `category_id` is the stashed prior —
        # so there is no single category here to clear. Refused for the same reason
        # `override_category` refuses it, and the clearing below is why it matters: it would reset
        # `category_source` and the lock bit on a row that is still split, taking it out of
        # FEATURE_OWNED_CATEGORY_SOURCES and handing the prior slot to the next automatic pass.
        if prior is not None and prior["is_split"]:
            raise HTTPException(
                status_code=400,
                detail="This transaction is split across categories. Remove the split before clearing "
                       "its category.",
            )
        # Clearing the category takes the row out of the Reimbursable group with it, so a standing claim
        # is refused here exactly as the category edit refuses it.
        refusal = receivable_change_refusal(conn, txn_id, 0.0)
        if refusal:
            raise HTTPException(status_code=400, detail=refusal)
        # Clearing an override resets both the lock bit and the stored category so rule application can fully
        # re-derive the transaction instead of leaving a stale manual category behind.
        conn.execute(
            "UPDATE txn SET category_overridden = 0, category_id = NULL, category_source = NULL WHERE id = ?",
            (txn_id,),
        )
        if had_category:
            owe_recurring_rescan(conn, [txn_id])
        resolved = _resolved_tags_response(conn, txn_id)
        followed_ids = following_refund_ids(conn, [txn_id])
    settle_owed_rescans()
    return {"ok": True, **resolved, "followed_ids": followed_ids}


# Soft-delete (trash): stamp `trashed_at` so every read filters the row out, while the underlying
# record is preserved until the user empties the trash from Settings. Restoration just clears the
# timestamp.
@router.delete("/{txn_id}")
def trash_transaction(txn_id: str):
    with get_db() as conn:
        row = conn.execute("SELECT id FROM txn WHERE id = ?", (txn_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Transaction not found")
        trash_txns(conn, [txn_id])
    settle_owed_rescans()
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
# bulk automatically, as does the FilterBar's amount filter; only the page-local filters below still have
# to be named by hand.
_BULK_FILTER_KEYS = FACET_PARAM_NAMES | AMOUNT_PARAM_NAMES | {
    "month", "date_start", "date_end", "import_batch_id", "sync_connection_id", "account_id",
    "source_account_ids", "category_id", "group_id", "require_all_tag_ids", "require_all_attribute_ids",
    "view", "search", "quick_filter", "needs_review", "recurring_only",
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


def _resolve_bulk_target_ids(conn, selection: BulkSelection, input_format: InputFormat = DEFAULT_INPUT_FORMAT) -> list[str]:
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
        # Read in the caller's format, so "everything matching" is the set their list showed.
        clauses, params = _build_transaction_filter(**flt, expanded=True, input_format=input_format)  # include_trashed defaults False
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


# What a bulk action declined, by reason. Two buckets rather than one total because they mean different
# things to the person reading the result — allocation work kept, versus an edit that would have broken
# a reimbursement — and a single "N skipped" is a number they would act on wrongly.
#
# Ids rather than counts, because a batch may carry several actions and the same row can be declined by
# more than one of them. Counting per action would subtract it twice from the total; a union cannot.
class BulkDeclines(NamedTuple):
    splits: frozenset = frozenset()
    claimed: frozenset = frozenset()

    def __add__(self, other):
        return BulkDeclines(self.splits | other.splits, self.claimed | other.claimed)

    @property
    def ids(self) -> frozenset:
        return self.splits | self.claimed


def _txn_amount(conn, txn_id: str):
    row = conn.execute("SELECT amount FROM txn WHERE id = ?", (txn_id,)).fetchone()
    return row["amount"] if row else 0.0


def _apply_bulk_action(conn, ids: list[str], action: BulkAction) -> BulkDeclines:
    """Apply one bulk action to a set of rows. Returns the rows it declined and why — always nothing
    except for `set_category`, whose whole effect is the thing a split and a claim own."""
    kind = action.type
    if kind == "set_category":
        # None clears the category (a deliberate manual uncategorize); a real id must be a leaf.
        _reject_group_category_assignment(conn, action.category_id)
        # Split rows keep their allocations. A bulk recategorize would replace hand-built allocation
        # work with a single category and leave nothing to restore it from, so those rows are declined
        # and counted for the caller to report — the same contract a full-force rule apply follows.
        skipped = split_txn_ids(conn, ids)
        ids = [i for i in ids if i not in skipped]
        # And the same refusal the single-row edit makes, for the same reason: moving a row out of the
        # Reimbursable group takes money a reimbursement has claimed with it, and nothing says so. The
        # bulk path declines rather than refusing the batch, since the user selected a set and the rows
        # it can act on are still correct to act on.
        # Narrowed to the claimed rows first, in one query: the receivable question is per row, and a
        # bulk selection can be thousands of them while the claimed ones are a handful.
        claimed = {
            txn_id for txn_id in claimed_txn_ids(conn, ids)
            if receivable_change_refusal(
                conn, txn_id, receivable_of_category(conn, action.category_id, _txn_amount(conn, txn_id))
            )
        }
        ids = [i for i in ids if i not in claimed]
        if not ids:
            return BulkDeclines(frozenset(skipped), frozenset(claimed))
        for chunk in _chunk(ids):
            placeholders = ",".join("?" * len(chunk))
            conn.execute(
                # A manual category edit counts as reviewing the row, so it clears needs_review.
                f"UPDATE txn SET category_id = ?, category_overridden = 1, category_source = 'manual', "
                f"needs_review = 0 "
                f"WHERE id IN ({placeholders})",
                [action.category_id, *chunk],
            )
        return BulkDeclines(frozenset(skipped), frozenset(claimed))
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
        trash_txns(conn, ids)
    else:
        raise HTTPException(status_code=400, detail=f"unknown bulk action: {kind}")
    return BulkDeclines()


# Bulk actions that can move a row between recurring series, or out of one: category is part of a
# derived series' identity, the merchant name *is* its key, the date decides which occurrence a charge
# is and whether one was missed, and a trashed row stops being an occurrence at all. Tags, notes and
# the review flag are read by nothing the detector does.
_RECURRING_RELEVANT_BULK_ACTIONS = {"set_category", "set_merchant", "set_date", "trash"}


@router.post("/bulk")
def bulk_update_transactions(body: BulkUpdateRequest, input_format: InputFormat = Depends(caller_input_format)):
    # One transaction so a multi-field apply (e.g. set category + add tag) is all-or-nothing.
    with get_db() as conn:
        target_ids = _resolve_bulk_target_ids(conn, body.selection, coerce_input_format(input_format))
        if not target_ids:
            return {"updated_count": 0}
        kinds = {a.type for a in body.actions}
        touches_recurring = bool(kinds & _RECURRING_RELEVANT_BULK_ACTIONS)
        # Captured before the writes, since a rename moves rows out of the payee group they are in now.
        prior_keys = payee_keys_for_ids(conn, target_ids) if "set_merchant" in kinds else frozenset()
        declines = BulkDeclines()
        for action in body.actions:
            declines += _apply_bulk_action(conn, target_ids, action)
        # Once for the whole batch, never per row: a scan loads the entire detection window before it
        # filters by payee, so a per-row call would repeat that load for every row selected.
        if touches_recurring:
            owe_recurring_rescan(conn, target_ids, prior_payee_keys=prior_keys)
        followed_ids = following_refund_ids(conn, target_ids) if "set_category" in kinds else []
    settle_owed_rescans()
    # `skipped_splits` counts rows a set_category action left alone because they are split, and
    # `skipped_claimed` those it left alone because a reimbursement claims money in them. Both are
    # reported *and* kept out of the total: "updated 40" when 3 of them kept their old categorization is
    # a number the user would act on wrongly, and the client shows this count verbatim.
    # `followed_ids` are the refunds that moved with a recategorized payment
    # (services/refund_links.py) — not counted as updated, since the user did not select them, but named
    # so the client can refresh them.
    return {
        "updated_count": len([i for i in target_ids if i not in declines.ids]),
        "skipped_splits": len(declines.splits),
        "skipped_claimed": len(declines.claimed),
        "followed_ids": followed_ids,
    }


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
               SET suspect_duplicate_of = NULL, dedupe_resolved_by = NULL, rejection_reason = NULL
               WHERE id = ? AND rejection_reason = 'duplicate_confirmed'""",
            (txn_id,),
        )
        # A row the provider dropped comes back as an ordinary one; left tagged, it would stay out of the
        # live-row reads that require `rejection_reason IS NULL` (duplicate detection's candidates).
        conn.execute(
            "UPDATE txn SET rejection_reason = NULL WHERE id = ? AND rejection_reason = 'provider_removed'",
            (txn_id,),
        )
        restore_txns(conn, [txn_id])
    settle_owed_rescans()
    return {"ok": True}


@router.get("/trash")
def list_trashed_transactions(limit: int = Query(200, le=1000), scope: str = "all"):
    """The most recently trashed transactions. ``scope`` narrows to one Trash section, as it does for
    emptying, so each section's page is drawn from its own rows — one page shared between the two let a
    run of removed duplicates crowd every direct delete off it."""
    if scope == "deleted":
        section = f" AND NOT ({TRASH_DUPLICATES_SQL})"
    elif scope == "duplicates":
        section = f" AND {TRASH_DUPLICATES_SQL}"
    elif scope == "all":
        section = ""
    else:
        raise HTTPException(status_code=400, detail="Unknown trash scope")
    with get_db() as conn:
        rows = conn.execute(
            f"""
            SELECT t.id, t.date, t.amount, t.merchant_name, t.display_name, t.raw_name,
                   t.account_id, t.category_id, t.trashed_at, t.notes, t.is_pending,
                   t.dedupe_resolved_by, t.rejection_reason,
                   a.name AS account_name, a.display_name AS account_display_name, a.mask AS account_mask,
                   c.name AS category_name,
                   p.name AS group_name, p.id AS group_id,
                   {card_title_sql("ib", "ibconn")} AS source_filename
            FROM   txn t
            LEFT JOIN account  a ON a.id = t.account_id
            LEFT JOIN category c ON c.id = t.category_id
            LEFT JOIN category p ON p.id = c.parent_id
            LEFT JOIN import_batch ib ON ib.id = t.import_batch_id
            LEFT JOIN connection ibconn ON ibconn.id = ib.connection_id
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
            """ + section + """
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
    amazon = TRASH_DUPLICATES_SQL
    direct = TRASH_DELETED_SQL
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
    settle_owed_rescans()
    if removed:
        # Attached documents are what makes the purge the *irreversible* half of the trash: trashing a
        # transaction hides its documents with it and a restore brings them back, while this deletes
        # them. The rows go with their transaction (ON DELETE CASCADE), but files sit outside that
        # transaction, so the stored bytes are reclaimed here — after the commit, against the ledger as
        # it now stands, sparing anything an in-flight ingest has written but not yet committed.
        with get_db() as conn:
            sweep_unreferenced_files(conn, min_age_seconds=INGEST_GRACE_SECONDS)
        compact_if_worthwhile(reason="emptied the transaction trash")
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
    settle_owed_rescans()
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
    settle_owed_rescans()
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
    amount:      AmountFilter = Depends(),
    exclude_income:     bool          = Query(False, description="omit income categories from results"),
    exclude_expense:    bool          = Query(False, description="omit expense categories from results"),
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

    _append_single_account_filter(clauses, params, account_id=account_id, account_ids=facets.account_ids)
    append_facets(clauses, params, facets)
    append_amount_filter(clauses, params, amount)
    append_totals_exclusion(clauses, params, facets, group_alias="p")

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
    amount:      AmountFilter = Depends(),
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
    clauses = ["t.is_pending = 0", "t.trashed_at IS NULL"]
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
    append_amount_filter(clauses, params, amount)
    append_totals_exclusion(clauses, params, facets, group_alias="p")
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
    amount:      AmountFilter = Depends(),
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

    _append_single_account_filter(clauses, params, account_id=account_id, account_ids=facets.account_ids)
    append_facets(clauses, params, facets)
    append_amount_filter(clauses, params, amount)
    append_totals_exclusion(clauses, params, facets, group_alias="p")

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
    amount:      AmountFilter = Depends(),
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
    append_amount_filter(clauses, params, amount)

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

# The population and sign shared by the trend endpoints (`monthly-trend`, `range-trend`), which differ
# only in how they cut time. Signed totals (no ABS), so reverses against the natural direction of the
# queried scope appear as negative bars instead of being folded into a magnitude. Sign and
# transaction-filter selection:
#   - category_id or group_id given: ignore `view`; sign follows the category's or group's type so
#     income-type scopes flip to positive-on-receipt; the existing
#     category-membership filter limits which transactions count. `group_id` is the drill scope the
#     list feed and the group breakdowns take, so a drilled group's bars count the rows its figure did.
#   - payee given: ignore `view`; signed SUM, positive = paid them.
#   - neither: `view` selects the cross-cutting frame the caller wants:
#       * spending  -> filter to expense-side transactions, SUM
#       * income    -> filter to income-side transactions, -SUM
#       * cash_flow -> all transactions, -SUM (positive = net inflow)
def _trend_scope(category_id, payee, account_id, facets, amount, source_account_ids, view, group_id=None):
    if payee:
        clauses = ["t.is_pending = 0", "t.trashed_at IS NULL",
                   "(t.display_name = ? OR t.merchant_name = ? OR t.raw_name = ?)"]
        params  = [payee, payee, payee]
    else:
        clauses = ["t.is_pending = 0", "t.trashed_at IS NULL"]
        params  = []
        if _append_uncategorized_filter(clauses, params, category_id=category_id):
            pass
        elif group_id:
            group_scope = group_membership([group_id])
            clauses.append(group_scope[0])
            params.extend(group_scope[1])
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

        if not category_id and not group_id:
            # In cross-cutting dashboard frames the bars represent total
            # spending/income/cash flow, so categories marked exclude_from_totals
            # (transfers etc.) are removed. Detail-panel scopes (category_id) keep
            # showing their own activity unfiltered so the user can still see what
            # is in an excluded category when they ask for it explicitly.
            append_totals_exclusion(clauses, params, facets, group_alias="p")

    _append_single_account_filter(clauses, params, account_id=account_id, account_ids=facets.account_ids)
    _append_source_account_filter(clauses, params, source_account_ids=source_account_ids)
    append_facets(clauses, params, facets)
    append_amount_filter(clauses, params, amount)

    needs_category_join = bool(category_id or group_id) or (not payee)
    join_sql = (
        "LEFT JOIN category c ON c.id = t.category_id "
        "LEFT JOIN category p ON p.id = c.parent_id"
        if needs_category_join else ""
    )
    return clauses, params, join_sql


def _trend_sign_factor(conn, category_id, payee, view, group_id=None) -> int:
    if category_id:
        return -1 if _resolve_category_is_income(conn, category_id) else 1
    if group_id:
        return -1 if _resolve_group_is_income(conn, group_id) else 1
    if payee:
        return 1
    return -1 if view in ("income", "cash_flow") else 1


@router.get("/summary/monthly-trend")
def monthly_trend(
    category_id: Optional[str] = Query(None),
    group_id:    Optional[str] = Query(None, description="one breakdown group (or synthetic uncategorized bucket), as a drill opens it; ANDs with every facet"),
    payee:       Optional[str] = Query(None),
    account_id:  Optional[str] = Query(None),
    facets:      TransactionFacets = Depends(),
    amount:      AmountFilter = Depends(),
    source_account_ids: Optional[str] = Query(None, description="comma-separated source (original) account IDs — narrows a merged-account view to specific underlying accounts"),
    months:      int            = Query(18, le=120),
    date_start:  Optional[str] = Query(None),
    date_end:    Optional[str] = Query(None),
    anchor:      Optional[str] = Query(None, description="'latest' slides the rolling window to end at the scope's most recent transaction instead of today"),
    view:        str            = Query("cash_flow", description="spending | income | cash_flow (used only when no category/payee scope)"),
):
    # Direct (non-HTTP) callers may omit the dependency; over HTTP FastAPI always supplies it.
    facets = coerce_facets(facets) or TransactionFacets()
    # A direct (non-HTTP) call leaves an unset Query default as a truthy FieldInfo.
    group_id = group_id if isinstance(group_id, str) else None
    # Payee detail drawers want the merchant's full visible history by default, so the rolling month
    # window is suppressed for a payee scope unless the caller supplied an explicit date filter.
    clauses, params, join_sql = _trend_scope(category_id, payee, account_id, facets, amount, source_account_ids, view, group_id)

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

        sign_factor = _trend_sign_factor(conn, category_id, payee, view, group_id)

        rows = conn.execute(
            f"""
            SELECT
                strftime('%Y-%m', t.date) AS month,
                ({sign_factor} * SUM(t.amount)) AS total,
                COUNT(DISTINCT t.id)      AS count,
                MIN(t.date)               AS first_date,
                MAX(t.date)               AS last_date
            FROM   {_expanded} t
            {join_sql}
            {where}
            GROUP BY month
            ORDER BY month
            """,
            params,
        ).fetchall()

    return [dict(r) for r in rows]


# The most ranges one `range-trend` call may ask for — the single-period chart's same-span window
# needs a fraction of this.
RANGE_TREND_MAX_RANGES = 64


# The `monthly-trend` population and sign, totalled over caller-supplied day-precise date ranges
# instead of calendar months. It exists because a bar has to equal the total its own range would give
# when selected, and a month-grained series cannot honour that for a range that does not start and end
# on month boundaries (Jan 1 – Oct 7 in each prior year; the 8th to the 7th of each month).
#
# `ranges` is `start:end` pairs (inclusive ISO dates), comma-separated. One row comes back per range,
# in the order asked, including a zero row for a range nothing fell in — the caller asked about that
# range, so "nothing" is its answer. Ranges may overlap; a transaction counts in every range holding it.
@router.get("/summary/range-trend")
def range_trend(
    ranges:      str           = Query(..., description="comma-separated start:end inclusive ISO date pairs"),
    category_id: Optional[str] = Query(None),
    group_id:    Optional[str] = Query(None, description="one breakdown group (or synthetic uncategorized bucket), as a drill opens it; ANDs with every facet"),
    payee:       Optional[str] = Query(None),
    account_id:  Optional[str] = Query(None),
    facets:      TransactionFacets = Depends(),
    amount:      AmountFilter = Depends(),
    source_account_ids: Optional[str] = Query(None, description="comma-separated source (original) account IDs — narrows a merged-account view to specific underlying accounts"),
    view:        str           = Query("cash_flow", description="spending | income | cash_flow (used only when no category/payee scope)"),
):
    facets = coerce_facets(facets) or TransactionFacets()
    # A direct (non-HTTP) call leaves an unset Query default as a truthy FieldInfo.
    group_id = group_id if isinstance(group_id, str) else None
    spans = []
    for part in (ranges or "").split(","):
        if not part.strip():
            continue
        start_text, sep, end_text = part.partition(":")
        if not sep:
            raise HTTPException(status_code=400, detail="each range must be start:end")
        start, end = _require_calendar_date(start_text), _require_calendar_date(end_text)
        if start > end:
            raise HTTPException(status_code=400, detail=f"range {start}:{end} ends before it starts")
        spans.append((start, end))
    if not spans:
        raise HTTPException(status_code=400, detail="at least one range is required")
    if len(spans) > RANGE_TREND_MAX_RANGES:
        raise HTTPException(status_code=400, detail=f"at most {RANGE_TREND_MAX_RANGES} ranges")

    clauses, params, join_sql = _trend_scope(category_id, payee, account_id, facets, amount, source_account_ids, view, group_id)
    # The overall bounds let the date index prune before the per-range join does its work.
    clauses.append("t.date >= ?")
    params.append(min(s for s, _ in spans))
    clauses.append("t.date <= ?")
    params.append(max(e for _, e in spans))
    where = "WHERE " + " AND ".join(clauses)

    values_sql = ", ".join("(?, ?, ?)" for _ in spans)
    range_params = [v for i, (s, e) in enumerate(spans) for v in (i, s, e)]

    with get_db() as conn:
        # The same split-expansion seam monthly-trend reads, so a split counts per allocation here too.
        _expanded = txn_effective_sql(conn, expand=True)
        sign_factor = _trend_sign_factor(conn, category_id, payee, view, group_id)
        rows = conn.execute(
            f"""
            WITH r(idx, lo, hi) AS (VALUES {values_sql})
            SELECT
                r.idx                           AS idx,
                ({sign_factor} * SUM(t.amount)) AS total,
                COUNT(DISTINCT t.id)            AS count
            FROM   {_expanded} t
            JOIN   r ON t.date >= r.lo AND t.date <= r.hi
            {join_sql}
            {where}
            GROUP BY r.idx
            """,
            range_params + params,
        ).fetchall()

    found = {r["idx"]: r for r in rows}
    return [
        {
            "start": start,
            "end": end,
            "total": found[i]["total"] if i in found else 0,
            "count": found[i]["count"] if i in found else 0,
        }
        for i, (start, end) in enumerate(spans)
    ]


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
# `granularity=year` applies the same atom to a calendar year — a category's net for the *year* — and
# returns `year` in place of `month`. It cannot be had by summing a year's monthly rows: a category that
# nets money in one month and out the next sits on both sides there and on neither here, so the summed
# sides would overstate the year's diagram while the net still agreed.
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
    amount:      AmountFilter = Depends(),
    source_account_ids: Optional[str] = Query(None, description="comma-separated source (original) account IDs — narrows a merged-account view to specific underlying accounts"),
    date_start:  Optional[str] = Query(None),
    date_end:    Optional[str] = Query(None),
    granularity: str           = Query("month", description="month | year — the period each row covers"),
):
    # Direct (non-HTTP) callers may omit the dependency; over HTTP FastAPI always supplies it.
    facets = coerce_facets(facets) or TransactionFacets()
    if granularity not in ("month", "year"):
        raise HTTPException(status_code=400, detail="granularity must be month or year")
    clauses = [
        "t.is_pending = 0",
        "t.trashed_at IS NULL",
    ]
    params: list = []

    _append_single_account_filter(clauses, params, account_id=account_id, account_ids=facets.account_ids)
    _append_source_account_filter(clauses, params, source_account_ids=source_account_ids)
    append_facets(clauses, params, facets)
    append_amount_filter(clauses, params, amount)
    # Cash flow is a cross-cutting dashboard frame, so the transfer exclusion that governs every
    # other such frame governs it too — and it is the *only* exclusion axis the design allows.
    # See docs/data-model.md -> "Reporting assumptions" -> "Cash flow".
    append_totals_exclusion(clauses, params, facets, group_alias="p")

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
    # The literal SQL for each choice, so nothing caller-supplied reaches the query text.
    period_sql = "strftime('%Y', t.date)" if granularity == "year" else "strftime('%Y-%m', t.date)"

    with get_db() as conn:
        # Category rollups read the split-expansion seam: a split transaction contributes one row
        # per allocation, so every facet, sentinel and exclusion guard below applies per part
        # without being restated. See services/txn_splits.py.
        _expanded = txn_effective_sql(conn, expand=True)
        rows = conn.execute(
            f"""
            SELECT
                period,
                SUM(CASE WHEN bucket_net < 0 THEN -bucket_net ELSE 0 END) AS inflow,
                SUM(CASE WHEN bucket_net > 0 THEN  bucket_net ELSE 0 END) AS outflow,
                -SUM(bucket_net)                                          AS net,
                MIN(bucket_first) AS first_date,
                MAX(bucket_last)  AS last_date
            FROM (
                SELECT
                    {period_sql}  AS period,
                    {bucket_sql}  AS bucket,
                    SUM(t.amount) AS bucket_net,
                    MIN(t.date)   AS bucket_first,
                    MAX(t.date)   AS bucket_last
                FROM   {_expanded} t
                LEFT JOIN category c ON c.id = t.category_id
                LEFT JOIN category p ON p.id = c.parent_id
                {where}
                GROUP BY period, bucket
            )
            GROUP BY period
            ORDER BY period
            """,
            params,
        ).fetchall()

    return [
        {granularity: r["period"], "inflow": r["inflow"], "outflow": r["outflow"], "net": r["net"],
         "first_date": r["first_date"], "last_date": r["last_date"]}
        for r in rows
    ]

@router.get("/summary/monthly-by-group")
def monthly_by_group(
    # The Trends view fetches its full visible history through this one window. The bound stays generous
    # rather than unbounded (20 years) so the multi-year trend/annual charts can reach every year in the
    # data without turning into an open-ended all-history scan.
    months:      int           = Query(24, le=240),
    account_id:  Optional[str] = Query(None),
    facets:      TransactionFacets = Depends(),
    amount:      AmountFilter = Depends(),
    group_id:    Optional[str] = Query(None),
):
    # Direct (non-HTTP) callers may omit the dependency; over HTTP FastAPI always supplies it.
    facets = coerce_facets(facets) or TransactionFacets()
    clauses = [
        "t.is_pending = 0",
        "t.trashed_at IS NULL",
        "t.date >= date('now', ? || ' months')",
        "strftime('%Y-%m', t.date) IS NOT NULL",
    ]
    params = [f"-{months}"]

    _append_single_account_filter(clauses, params, account_id=account_id, account_ids=facets.account_ids)
    append_facets(clauses, params, facets)
    append_amount_filter(clauses, params, amount)
    append_totals_exclusion(clauses, params, facets, group_alias="p")

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
                {select_total},
                MIN(t.date) AS first_date,
                MAX(t.date) AS last_date
            FROM   {_expanded} t
            {join}
            {where}
            GROUP BY month, series_id
            ORDER BY month, total DESC
            """,
            params,
        ).fetchall()

    return [dict(r) for r in rows]
