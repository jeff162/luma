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
from fastapi import APIRouter, Query, HTTPException
from pydantic import BaseModel
from typing import Optional
from datetime import datetime
from decimal import Decimal, InvalidOperation
import re
from backend.db.database import get_db
from backend.services.transaction_tags import (
    tag_filter_membership_sql,
    effective_selected_tag_signature_sql,
    effective_tag_match_all_sql,
    get_blocked_transaction_tag_map,
    get_visible_transaction_tag_map,
    list_visible_transaction_tags,
    set_manual_transaction_tag,
)

router = APIRouter()

EFFECTIVE_ACCOUNT_ID_SQL = "COALESCE((SELECT parent_account_id FROM account WHERE id = t.account_id), t.account_id)"
QUICK_FILTER_ACCOUNT_LABEL_SQL = """
TRIM(
    REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
        LOWER(COALESCE(p.display_name, p.name, a.display_name, a.name, '')),
        '(', ' '
    ), ')', ' '), '.', ' '), '/', ' '), '-', ' '), '_', ' '), '  ', ' '), '  ', ' ')
)
"""
QUICK_FILTER_ACCOUNT_EXCLUDED_TERMS = {"check", "checking", "saving", "savings", "credit", "debit"}
QUICK_FILTER_FIELD_PREFIXES = {"merchant", "category", "account", "date", "amount"}
TRANSACTION_SORT_SQL = {
    "date": "t.date",
    "merchant": "LOWER(COALESCE(NULLIF(t.display_name, ''), NULLIF(t.merchant_name, ''), NULLIF(t.raw_name, ''), ''))",
    "category": "LOWER(COALESCE(c.name, ''))",
    "account": "LOWER(COALESCE(a.display_name, a.name, ''))",
    "amount": "t.amount",
}
UNASSIGNED_CATEGORY_SYSTEM_KEY = "unassigned"
UNCATEGORIZED_CATEGORY_ID = "__uncategorized__"
UNCATEGORIZED_EXPENSE_CATEGORY_ID = "__uncategorized_expense__"
UNCATEGORIZED_INCOME_CATEGORY_ID = "__uncategorized_income__"
UNCATEGORIZED_EXPENSE_CATEGORY_NAME = "Uncategorized"
UNCATEGORIZED_INCOME_CATEGORY_NAME = "Other Income"


class CategoryOverride(BaseModel):
    # Category edits from the transaction UI can also persist the note field in the same save gesture.
    category_id: str
    notes: Optional[str] = None


class TransactionTagUpdate(BaseModel):
    tag_id: str
    present: bool


class RejectedSuggestionDisposition(BaseModel):
    # When a rule suggestion is rejected, the rows it covered still need a disposition. `mode` chooses
    # between keeping their imported category as a settled manual decision, or clearing it. See
    # set_rejected_suggestion_disposition. `category_id` is only meaningful in 'keep' mode: when given
    # the rows are *re-pointed* to that category as the manual decision (the conflict screen's "keep
    # these, but as a different category" case); when omitted 'keep' leaves the existing category.
    transaction_ids: list[str] = []
    mode: str  # 'keep' | 'clear'
    category_id: Optional[str] = None


class CategorizationSnapshot(BaseModel):
    # One row's category state captured before a change, for Undo (see restore_categorization).
    id: str
    category_id: Optional[str] = None
    category_source: Optional[str] = None
    category_overridden: int = 0


class CategorizationRestore(BaseModel):
    rows: list[CategorizationSnapshot] = []


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


def _build_uncategorized_multi_filter(column_sql: str, raw_ids: list[str]):
    ids = [value.strip() for value in raw_ids if value and value.strip()]
    if not ids:
        return None
    normal_ids = []
    include_any_uncategorized = False
    include_uncategorized_expense = False
    include_uncategorized_income = False
    for value in ids:
        if value == UNCATEGORIZED_CATEGORY_ID:
            include_any_uncategorized = True
        elif value == UNCATEGORIZED_EXPENSE_CATEGORY_ID:
            include_uncategorized_expense = True
        elif value == UNCATEGORIZED_INCOME_CATEGORY_ID:
            include_uncategorized_income = True
        else:
            normal_ids.append(value)

    clauses = []
    params = []
    if normal_ids:
        placeholders = ",".join("?" * len(normal_ids))
        clauses.append(f"{column_sql} IN ({placeholders})")
        params.extend(normal_ids)
    if include_any_uncategorized:
        clauses.append("t.category_id IS NULL")
    else:
        if include_uncategorized_expense:
            clauses.append("(t.category_id IS NULL AND t.amount > 0)")
        if include_uncategorized_income:
            clauses.append("(t.category_id IS NULL AND t.amount < 0)")
    if not clauses:
        return None
    return f"({' OR '.join(clauses)})", params


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


def _summary_uncategorized_type_sql(level: str) -> str:
    base_column = "c.category_type" if level == "category" else "COALESCE(p.category_type, c.category_type)"
    return (
        "CASE "
        "WHEN t.category_id IS NULL AND t.amount < 0 THEN 'income' "
        "WHEN t.category_id IS NULL THEN 'expense' "
        f"ELSE {base_column} "
        "END"
    )


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


# --- Exclusion ("is not") ---------------------------------------------------------------------
# Every facet the shared FilterBar exposes can be selected as *include* (the historical default) or
# *exclude*. Exclusion is expressed as the NULL-safe negation of the same membership expression the
# include path builds, so there is one definition of "is a member of this facet set" per facet and
# the two modes can never drift. The NULL-safety matters: `t.category_id NOT IN (...)` is *unknown*
# (not true) for a NULL category, which would silently drop uncategorized rows from a "not Groceries"
# result even though an uncategorized row plainly is not Groceries. `_negate_membership` collapses
# unknown membership to non-member first, so a row the include set doesn't match always survives its
# exclusion. See docs/data-model.md (filter exclusion semantics).
def _negate_membership(expr: str) -> str:
    return f"COALESCE(({expr}), 0) = 0"


def _effective_account_membership(ids: list[str]) -> tuple[str, list]:
    placeholders = ','.join('?' * len(ids))
    return f"{EFFECTIVE_ACCOUNT_ID_SQL} IN ({placeholders})", list(ids)


def _append_effective_account_filter(
    clauses, params, *, account_id: Optional[str], account_ids: Optional[str],
    exclude_account_ids: Optional[str] = None,
):
    if account_ids and isinstance(account_ids, str):
        ids = [i.strip() for i in account_ids.split(',') if i.strip()]
        if ids:
            expr, expr_params = _effective_account_membership(ids)
            clauses.append(expr)
            params.extend(expr_params)
    elif account_id and isinstance(account_id, str):
        clauses.append(f"{EFFECTIVE_ACCOUNT_ID_SQL} = ?")
        params.append(account_id)
    if exclude_account_ids and isinstance(exclude_account_ids, str):
        ids = [i.strip() for i in exclude_account_ids.split(',') if i.strip()]
        if ids:
            expr, expr_params = _effective_account_membership(ids)
            clauses.append(_negate_membership(expr))
            params.extend(expr_params)


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


def _append_tag_filter(
    clauses, params, *, tag_ids: Optional[str], exclude_tag_ids: Optional[str] = None,
    require_all_tag_ids: Optional[str] = None,
):
    # Membership ("has this tag", effective + block-aware, plus the synthetic Untagged bucket) is defined
    # once in tag_filter_membership_sql so list/summaries/export all agree. Exclusion negates the same
    # expression: EXISTS is null-free, so plain NOT(...) is the exact negation (no COALESCE guard).
    # `require_all_tag_ids` is a *separate* AND constraint (has all of these), independent of the OR
    # `tag_ids`, so a caller can apply both at once — see effective_tag_match_all_sql.
    if tag_ids and isinstance(tag_ids, str):
        membership = tag_filter_membership_sql([i.strip() for i in tag_ids.split(",") if i.strip()])
        if membership:
            clauses.append(membership[0])
            params.extend(membership[1])
    if exclude_tag_ids and isinstance(exclude_tag_ids, str):
        membership = tag_filter_membership_sql([i.strip() for i in exclude_tag_ids.split(",") if i.strip()])
        if membership:
            clauses.append(f"NOT ({membership[0]})")
            params.extend(membership[1])
    if require_all_tag_ids and isinstance(require_all_tag_ids, str):
        ids = [i.strip() for i in require_all_tag_ids.split(",") if i.strip()]
        if ids:
            clauses.append(effective_tag_match_all_sql(len(ids)))
            params.extend(ids)


def _owner_membership(ids: list[str]) -> tuple[str, list]:
    # 'unassigned' expresses the first-class unowned bucket as `owner_id IS NULL`. Returns the
    # inclusion expression so include and exclude share one definition (exclude negates it NULL-safely,
    # which is why a NULL owner_id survives "not owned by X" but is removed by "not unassigned").
    if 'unassigned' in ids:
        other_ids = [i for i in ids if i != 'unassigned']
        if other_ids:
            placeholders = ','.join('?' * len(other_ids))
            return f"(t.owner_id IS NULL OR t.owner_id IN ({placeholders}))", other_ids
        return "t.owner_id IS NULL", []
    placeholders = ','.join('?' * len(ids))
    return f"t.owner_id IN ({placeholders})", list(ids)


def _append_owner_filter(clauses, params, *, owner_ids: Optional[str], exclude_owner_ids: Optional[str] = None):
    # Mirrors the inline owner filter used by the transaction list and the totals summaries: a comma list
    # of owner ids, with 'unassigned' expressing the first-class unowned bucket as `owner_id IS NULL`.
    if owner_ids and isinstance(owner_ids, str):
        ids = [i.strip() for i in owner_ids.split(',') if i.strip()]
        if ids:
            expr, expr_params = _owner_membership(ids)
            clauses.append(expr)
            params.extend(expr_params)
    if exclude_owner_ids and isinstance(exclude_owner_ids, str):
        ids = [i.strip() for i in exclude_owner_ids.split(',') if i.strip()]
        if ids:
            expr, expr_params = _owner_membership(ids)
            clauses.append(_negate_membership(expr))
            params.extend(expr_params)


def _group_membership(ids: list[str]) -> Optional[tuple[str, list]]:
    # Membership = leaf category sits under one of the selected top-level groups (plus any synthetic
    # uncategorized buckets). Shared by include and exclude so both read the same set definition.
    group_filter = _build_uncategorized_multi_filter("t.category_id", ids)
    normal_group_ids = [
        value for value in ids
        if value not in {UNCATEGORIZED_CATEGORY_ID, UNCATEGORIZED_EXPENSE_CATEGORY_ID, UNCATEGORIZED_INCOME_CATEGORY_ID}
    ]
    group_clauses, group_params = [], []
    if normal_group_ids:
        placeholders = ','.join('?' * len(normal_group_ids))
        group_clauses.append(f"t.category_id IN (SELECT id FROM category WHERE parent_id IN ({placeholders}))")
        group_params.extend(normal_group_ids)
    if group_filter:
        group_clauses.append(group_filter[0])
        group_params.extend(group_filter[1])
    if not group_clauses:
        return None
    return f"({' OR '.join(group_clauses)})", group_params


def _append_group_filter(clauses, params, *, group_ids: Optional[str], exclude_group_ids: Optional[str] = None):
    # Restrict to transactions whose leaf category sits under one of the selected top-level groups
    # (plus any synthetic uncategorized buckets). Mirrors the transaction list's group_ids handling.
    if group_ids and isinstance(group_ids, str):
        ids = [i.strip() for i in group_ids.split(',') if i.strip()]
        membership = _group_membership(ids) if ids else None
        if membership:
            clauses.append(membership[0])
            params.extend(membership[1])
    if exclude_group_ids and isinstance(exclude_group_ids, str):
        ids = [i.strip() for i in exclude_group_ids.split(',') if i.strip()]
        membership = _group_membership(ids) if ids else None
        if membership:
            clauses.append(_negate_membership(membership[0]))
            params.extend(membership[1])


def _append_category_ids_filter(clauses, params, *, category_ids: Optional[str], exclude_category_ids: Optional[str] = None):
    # Restrict to the selected leaf categories (plus synthetic uncategorized buckets). Mirrors the list.
    if category_ids and isinstance(category_ids, str):
        membership = _build_uncategorized_multi_filter(
            "t.category_id", [i.strip() for i in category_ids.split(',') if i.strip()]
        )
        if membership:
            clauses.append(membership[0])
            params.extend(membership[1])
    if exclude_category_ids and isinstance(exclude_category_ids, str):
        membership = _build_uncategorized_multi_filter(
            "t.category_id", [i.strip() for i in exclude_category_ids.split(',') if i.strip()]
        )
        if membership:
            clauses.append(_negate_membership(membership[0]))
            params.extend(membership[1])


def _payee_membership(names: list[str]) -> tuple[str, list]:
    or_clauses = ' OR '.join(['(t.display_name = ? OR t.merchant_name = ? OR t.raw_name = ?)'] * len(names))
    payee_params: list = []
    for n in names:
        payee_params.extend([n, n, n])
    return f"({or_clauses})", payee_params


def _append_payee_filter(clauses, params, *, payees: Optional[str], exclude_payees: Optional[str] = None):
    # Pipe-separated payee names; matches whichever merchant field carries the visible name. Mirrors the list.
    if payees and isinstance(payees, str):
        names = [n.strip() for n in payees.split('|') if n.strip()]
        if names:
            expr, expr_params = _payee_membership(names)
            clauses.append(expr)
            params.extend(expr_params)
    if exclude_payees and isinstance(exclude_payees, str):
        names = [n.strip() for n in exclude_payees.split('|') if n.strip()]
        if names:
            expr, expr_params = _payee_membership(names)
            clauses.append(_negate_membership(expr))
            params.extend(expr_params)


# Quick filter parsing keeps the Transactions page's one-box workflow lightweight:
# - merchant and category stay broad substring matches so partial labels still work naturally
# - account labels match normalized whole words/phrases so generic fragments like `check` do not expand to every
#   `Checking` account and drown out rows whose merchant is actually `CHECK`
# - date and amount parsing add more precise matches when the input looks like those domains; a full
#   date / year / month jumps to that exact slot, while a year-less partial (a bare month, or month/day)
#   matches that calendar slot across every year
# - a `<field>:<value>` prefix (merchant/category/account/date/amount) restricts the search to that one field;
#   when the prefix is explicit we also drop the account-term exclusion list because the user has asked specifically
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

    if want("merchant"):
        or_clauses.append(
            "LOWER(COALESCE(NULLIF(t.display_name, ''), NULLIF(t.merchant_name, ''), NULLIF(t.raw_name, ''), '')) LIKE ?"
        )
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

    if want("amount"):
        amount_value = _parse_quick_filter_amount(search_text)
        if amount_value is not None:
            if amount_value < 0:
                or_clauses.append("ROUND(t.amount, 2) = ?")
                params.append(float(amount_value))
            else:
                or_clauses.append("ROUND(ABS(t.amount), 2) = ?")
                params.append(float(amount_value))

    if not or_clauses:
        # The user explicitly asked for `field:value` but the value did not produce any constraint
        # (e.g. `date:not-a-date`). Match nothing so the empty result reflects the typed intent rather
        # than silently falling back to a broad OR search.
        return "(1 = 0)", []

    return f"({' OR '.join(or_clauses)})", params


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
    # ORs with the amount match, so "2023" also finds $2023.00; the date-year clause is additive.
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
    # match, so "9" also finds $9.00; the date-month clause is additive.
    text = (value or "").strip()
    if re.fullmatch(r"\d{1,2}", text) and 1 <= int(text) <= 12:
        return f"{int(text):02d}"
    return None


def _parse_quick_filter_amount(value: str) -> Optional[Decimal]:
    raw = (value or "").strip()
    if not raw:
        return None
    normalized = raw.replace(",", "").replace("$", "")
    if normalized.startswith("(") and normalized.endswith(")"):
        normalized = f"-{normalized[1:-1]}"
    try:
        amount = Decimal(normalized)
    except InvalidOperation:
        return None
    return amount.copy_abs().quantize(Decimal("0.01")) if amount >= 0 else amount.quantize(Decimal("0.01"))


def _build_transaction_filter(
    *,
    month=None, date_start=None, date_end=None, import_batch_id=None,
    account_id=None, account_ids=None, source_account_ids=None, category_id=None, group_ids=None,
    category_ids=None, tag_ids=None, owner_ids=None, payees=None,
    exclude_account_ids=None, exclude_group_ids=None, exclude_category_ids=None,
    exclude_owner_ids=None, exclude_payees=None, exclude_tag_ids=None, require_all_tag_ids=None,
    direction=None, view=None, search=None, quick_filter=None, ids=None,
    needs_review=None, include_trashed=False, recurring_series_id=None,
    recurring_excluded_series_id=None, account_type=None, import_evidence_type=None,
    amount_min=None, amount_max=None, amount_min_op=None, amount_max_op=None,
    recurring_only=None,
):
    # Single source of truth for the transaction-list WHERE clause, shared by the list feed and the
    # bulk endpoint so "select all matching the current filter" resolves the exact set the user sees.
    # Returns (clauses, params) against the alias set t(xn)/a(ccount)/p(arent account)/c(ategory)/
    # pc(parent category); any caller must JOIN those aliases identically.
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
    _append_effective_account_filter(
        clauses, params, account_id=account_id, account_ids=account_ids,
        exclude_account_ids=exclude_account_ids,
    )
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
    _append_group_filter(clauses, params, group_ids=group_ids, exclude_group_ids=exclude_group_ids)
    _append_category_ids_filter(
        clauses, params, category_ids=category_ids, exclude_category_ids=exclude_category_ids,
    )
    _append_tag_filter(clauses, params, tag_ids=tag_ids, exclude_tag_ids=exclude_tag_ids,
                       require_all_tag_ids=require_all_tag_ids)
    _append_payee_filter(clauses, params, payees=payees, exclude_payees=exclude_payees)
    _append_owner_filter(clauses, params, owner_ids=owner_ids, exclude_owner_ids=exclude_owner_ids)
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
    if view in ("spending", "income"):
        # Cross-cutting dashboard scopes (spending/income) skip categories marked
        # exclude_from_totals so transfers and other bookkeeping moves don't pollute
        # the listing of transactions backing a Dashboard total bar.
        clauses.append(
            "COALESCE(pc.exclude_from_totals, c.exclude_from_totals, 0) = 0"
        )
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


@router.get("")
def list_transactions(
    month:        Optional[str] = Query(None, description="YYYY-MM"),
    date_start:   Optional[str] = Query(None, description="YYYY-MM-DD"),
    date_end:     Optional[str] = Query(None, description="YYYY-MM-DD"),
    import_batch_id: Optional[str] = Query(None),
    sort_by:      Optional[str] = Query("date", description="date | merchant | category | account | amount"),
    sort_dir:     Optional[str] = Query("desc", description="asc | desc"),
    account_id:   Optional[str] = Query(None),
    account_ids:  Optional[str] = Query(None, description="comma-separated account IDs (effective/top-level account)"),
    source_account_ids: Optional[str] = Query(None, description="comma-separated source (original) account IDs — narrows a merged-account view to specific underlying accounts"),
    category_id:  Optional[str] = Query(None),
    group_ids:    Optional[str] = Query(None, description="comma-separated group IDs"),
    category_ids: Optional[str] = Query(None, description="comma-separated category IDs"),
    tag_ids:      Optional[str] = Query(None, description="comma-separated tag IDs"),
    owner_ids:    Optional[str] = Query(None, description="comma-separated owner IDs"),
    payees:       Optional[str] = Query(None, description="pipe-separated payee names"),
    exclude_account_ids:  Optional[str] = Query(None, description="comma-separated account IDs to exclude ('is not')"),
    exclude_group_ids:    Optional[str] = Query(None, description="comma-separated group IDs to exclude ('is not')"),
    exclude_category_ids: Optional[str] = Query(None, description="comma-separated category IDs to exclude ('is not')"),
    exclude_owner_ids:    Optional[str] = Query(None, description="comma-separated owner IDs to exclude ('is not')"),
    exclude_payees:       Optional[str] = Query(None, description="pipe-separated payee names to exclude ('is not')"),
    exclude_tag_ids:      Optional[str] = Query(None, description="comma-separated tag IDs to exclude ('is not')"),
    require_all_tag_ids:  Optional[str] = Query(None, description="comma-separated tag IDs the row must ALL have (AND), independent of tag_ids"),
    direction:    Optional[str] = Query(None, description="debit | credit"),
    view:         Optional[str] = Query(None, description="spending | income — mirrors monthly-trend's category-type scope filter"),
    search:       Optional[str] = Query(None),
    quick_filter: Optional[str] = Query(None),
    ids:          Optional[str] = Query(None, description="comma-separated transaction IDs — re-fetch a specific set of rows"),
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
    # This endpoint is the UI's lossless transaction feed, so filters narrow the raw rows but do not apply the
    # reporting rules used by summaries such as excluding pending transactions or normalizing amount direction.
    sort_key = sort_by if sort_by in TRANSACTION_SORT_SQL else "date"
    sort_direction = "ASC" if str(sort_dir).lower() == "asc" else "DESC"

    clauses, params = _build_transaction_filter(
        month=month, date_start=date_start, date_end=date_end, import_batch_id=import_batch_id,
        account_id=account_id, account_ids=account_ids, source_account_ids=source_account_ids,
        category_id=category_id, group_ids=group_ids,
        category_ids=category_ids, tag_ids=tag_ids, owner_ids=owner_ids, payees=payees,
        exclude_account_ids=exclude_account_ids, exclude_group_ids=exclude_group_ids,
        exclude_category_ids=exclude_category_ids, exclude_owner_ids=exclude_owner_ids,
        exclude_payees=exclude_payees, exclude_tag_ids=exclude_tag_ids,
        require_all_tag_ids=require_all_tag_ids,
        direction=direction, view=view, search=search, quick_filter=quick_filter, ids=ids,
        needs_review=needs_review, include_trashed=include_trashed, recurring_series_id=recurring_series_id,
        recurring_only=recurring_only,
        recurring_excluded_series_id=recurring_excluded_series_id,
        account_type=account_type, import_evidence_type=import_evidence_type,
        amount_min=amount_min, amount_max=amount_max,
        amount_min_op=amount_min_op, amount_max_op=amount_max_op,
    )

    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    order_by_parts = []
    # Sorting stays server-backed so filtered transaction views remain stable even when the page incrementally loads
    # additional rows. Text columns use explicit expressions here because the visible labels come from derived fields.
    if sort_key == "category":
        order_by_parts.append("CASE WHEN t.category_id IS NULL THEN 1 ELSE 0 END ASC")
    order_by_parts.append(f"{TRANSACTION_SORT_SQL[sort_key]} {sort_direction}")
    if sort_key != "date":
        order_by_parts.append("t.date DESC")
    order_by_parts.append("t.id DESC")
    order_by = ", ".join(order_by_parts)

    with get_db() as conn:
        # Count *and* signed net sum over the whole filtered set, not just the returned page — so a
        # caller can show a correct total/count for a scope larger than the page limit instead of
        # summing the capped `transactions` client-side (which silently undercounts past the limit).
        agg = conn.execute(
            f"""
            SELECT COUNT(*) AS count, COALESCE(SUM(t.amount), 0) AS sum_amount
            FROM txn t
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
                -- labeled e.g. "Chase") are still tellable apart. NULL for CSV/manual batches.
                bconn.provider AS import_batch_provider,
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
                rxs.display_name AS recurring_excluded_series_name
            FROM   txn t
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
            params + [sql_limit, offset],
        ).fetchall()
        transactions = [dict(r) for r in rows]
        txn_ids = [txn["id"] for txn in transactions]
        tag_map = get_visible_transaction_tag_map(conn, txn_ids) if rows else {}
        blocked_map = get_blocked_transaction_tag_map(conn, txn_ids) if rows else {}
        for txn in transactions:
            txn["tags"] = tag_map.get(txn["id"], [])
            # Tags the user hid on this row (inherited/rule opt-out); the picker offers them for restore.
            txn["blocked_tags"] = blocked_map.get(txn["id"], [])

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


@router.patch("/{txn_id}/category")
def override_category(txn_id: str, body: CategoryOverride):
    with get_db() as conn:
        txn = conn.execute(
            "SELECT id FROM txn WHERE id = ?", (txn_id,)
        ).fetchone()
        if not txn:
            raise HTTPException(status_code=404, detail="Transaction not found")
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
    return {"ok": True}


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
            SET category_id = ?, imported_category = ?, category_overridden = 1, category_source = 'import'
            WHERE id = ?
            """,
            (body.category_id, cat["name"], txn_id),
        )
    return {"ok": True}


@router.post("/rejected-suggestion-disposition")
def set_rejected_suggestion_disposition(body: RejectedSuggestionDisposition):
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
    ids = [str(i) for i in body.transaction_ids if str(i).strip()]
    mode = (body.mode or "").strip().lower()
    if mode not in ("keep", "clear"):
        raise HTTPException(status_code=400, detail="mode must be 'keep' or 'clear'")
    keep_category_id = (body.category_id or "").strip() or None
    if keep_category_id and mode != "keep":
        raise HTTPException(status_code=400, detail="category_id is only valid with mode 'keep'")
    if not ids:
        return {"updated": 0, "rows": []}
    if keep_category_id:
        # Re-pointing requires an assignable leaf (the shared group guard) that is also active — a stale
        # decision can't park rows on an inactive branch, the same invariant rules/imports honor.
        with get_db() as conn:
            _reject_group_category_assignment(conn, keep_category_id)
            target = conn.execute(
                "SELECT COALESCE(is_active, 1) AS is_active FROM category WHERE id = ?",
                (keep_category_id,),
            ).fetchone()
        if not target["is_active"]:
            raise HTTPException(status_code=400, detail="Cannot assign transactions to an inactive category")
    # Snapshot the prior state of exactly the rows we are about to change (the same `IS NOT 'manual'`
    # filter the UPDATE uses) so the caller can stash it for Undo and later POST it to
    # /restore-categorization. Only the affected rows are returned, so restore touches nothing else.
    prior: list[dict] = []
    with get_db() as conn:
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
    return {"updated": len(prior), "rows": prior}


@router.post("/restore-categorization")
def restore_categorization(body: CategorizationRestore):
    # Undo support: set each row back to a previously captured (category_id, category_source,
    # category_overridden) snapshot. Used to reverse a rejected-suggestion disposition; the rows come
    # from set_rejected_suggestion_disposition's `rows`, so only the deliberately-changed rows are
    # restored and exactly to their pre-change state.
    restored = 0
    with get_db() as conn:
        for row in body.rows:
            if not str(row.id or "").strip():
                continue
            conn.execute(
                "UPDATE txn SET category_id = ?, category_source = ?, category_overridden = ? WHERE id = ?",
                (row.category_id, row.category_source, int(row.category_overridden or 0), row.id),
            )
            restored += 1
    return {"restored": restored}


@router.patch("/{txn_id}/merchant")
def update_merchant(txn_id: str, body: dict):
    name = body.get("merchant_name", "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="merchant_name required")
    with get_db() as conn:
        conn.execute(
            "UPDATE txn SET display_name = ?, display_name_source = 'manual' WHERE id = ?",
            (name, txn_id),
        )
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
        # Clearing an override resets both the lock bit and the stored category so rule application can fully
        # re-derive the transaction instead of leaving a stale manual category behind.
        conn.execute(
            "UPDATE txn SET category_overridden = 0, category_id = NULL, category_source = NULL WHERE id = ?",
            (txn_id,),
        )
    return {"ok": True}


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


_BULK_FILTER_KEYS = {
    "month", "date_start", "date_end", "import_batch_id", "account_id", "account_ids",
    "source_account_ids", "category_id", "group_ids", "category_ids", "tag_ids", "owner_ids",
    "payees", "exclude_account_ids", "exclude_group_ids", "exclude_category_ids",
    "exclude_owner_ids", "exclude_payees", "exclude_tag_ids", "require_all_tag_ids",
    "direction", "view", "search", "quick_filter",
    "amount_min", "amount_max", "amount_min_op", "amount_max_op", "recurring_only",
}


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
        flt = {k: v for k, v in (selection.filter or {}).items() if k in _BULK_FILTER_KEYS}
        clauses, params = _build_transaction_filter(**flt)  # include_trashed defaults False
        where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
        rows = conn.execute(
            f"""
            SELECT t.id
            FROM   txn t
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


def _apply_bulk_action(conn, ids: list[str], action: BulkAction):
    kind = action.type
    if kind == "set_category":
        # None clears the category (a deliberate manual uncategorize); a real id must be a leaf.
        _reject_group_category_assignment(conn, action.category_id)
        for chunk in _chunk(ids):
            placeholders = ",".join("?" * len(chunk))
            conn.execute(
                # A manual category edit counts as reviewing the row, so it clears needs_review.
                f"UPDATE txn SET category_id = ?, category_overridden = 1, category_source = 'manual', "
                f"needs_review = 0 "
                f"WHERE id IN ({placeholders})",
                [action.category_id, *chunk],
            )
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
        date = (action.date or "").strip()
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
            raise HTTPException(status_code=400, detail="date must be YYYY-MM-DD")
        for chunk in _chunk(ids):
            placeholders = ",".join("?" * len(chunk))
            conn.execute(f"UPDATE txn SET date = ? WHERE id IN ({placeholders})", [date, *chunk])
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


@router.post("/bulk")
def bulk_update_transactions(body: BulkUpdateRequest):
    # One transaction so a multi-field apply (e.g. set category + add tag) is all-or-nothing.
    with get_db() as conn:
        target_ids = _resolve_bulk_target_ids(conn, body.selection)
        if not target_ids:
            return {"updated_count": 0}
        for action in body.actions:
            _apply_bulk_action(conn, target_ids, action)
    return {"updated_count": len(target_ids)}


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
        cursor = conn.execute(
            f"DELETE FROM txn WHERE trashed_at IS NOT NULL AND {visible}{cutoff}", params
        )
        removed = cursor.rowcount or 0
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
    account_ids:        Optional[str] = Query(None),
    tag_ids:            Optional[str] = Query(None),
    owner_ids:          Optional[str] = Query(None, description="filter by transaction owner (comma-separated)"),
    category_ids:       Optional[str] = Query(None, description="comma-separated leaf category IDs"),
    group_ids:          Optional[str] = Query(None, description="comma-separated top-level group IDs"),
    payees:             Optional[str] = Query(None, description="pipe-separated payee names"),
    exclude_account_ids:  Optional[str] = Query(None, description="account IDs to exclude ('is not')"),
    exclude_group_ids:    Optional[str] = Query(None, description="group IDs to exclude ('is not')"),
    exclude_category_ids: Optional[str] = Query(None, description="category IDs to exclude ('is not')"),
    exclude_owner_ids:    Optional[str] = Query(None, description="owner IDs to exclude ('is not')"),
    exclude_payees:       Optional[str] = Query(None, description="payee names to exclude ('is not')"),
    exclude_tag_ids:      Optional[str] = Query(None, description="tag IDs to exclude ('is not')"),
    exclude_income:     bool          = Query(False, description="omit income categories from results"),
    exclude_expense:    bool          = Query(False, description="omit expense categories from results"),
):
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

    _append_effective_account_filter(
        clauses, params, account_id=account_id, account_ids=account_ids,
        exclude_account_ids=exclude_account_ids,
    )
    _append_tag_filter(clauses, params, tag_ids=tag_ids, exclude_tag_ids=exclude_tag_ids)

    _append_owner_filter(clauses, params, owner_ids=owner_ids, exclude_owner_ids=exclude_owner_ids)
    _append_group_filter(clauses, params, group_ids=group_ids, exclude_group_ids=exclude_group_ids)
    _append_category_ids_filter(clauses, params, category_ids=category_ids, exclude_category_ids=exclude_category_ids)
    _append_payee_filter(clauses, params, payees=payees, exclude_payees=exclude_payees)

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
                COUNT(*)                                      AS count
            FROM   txn t
            LEFT JOIN category c ON c.id = t.category_id
            LEFT JOIN category p ON p.id = c.parent_id
            {where}
            GROUP BY category_id
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
    account_ids:        Optional[str] = Query(None),
    tag_ids:            Optional[str] = Query(None),
    owner_ids:          Optional[str] = Query(None, description="comma-separated owner IDs"),
    category_ids:       Optional[str] = Query(None, description="comma-separated leaf category IDs"),
    group_ids:          Optional[str] = Query(None, description="comma-separated top-level group IDs"),
    payees:             Optional[str] = Query(None, description="pipe-separated payee names"),
    exclude_account_ids:  Optional[str] = Query(None, description="account IDs to exclude ('is not')"),
    exclude_group_ids:    Optional[str] = Query(None, description="group IDs to exclude ('is not')"),
    exclude_category_ids: Optional[str] = Query(None, description="category IDs to exclude ('is not')"),
    exclude_owner_ids:    Optional[str] = Query(None, description="owner IDs to exclude ('is not')"),
    exclude_payees:       Optional[str] = Query(None, description="payee names to exclude ('is not')"),
    exclude_tag_ids:      Optional[str] = Query(None, description="tag IDs to exclude ('is not')"),
    exclude_income:     bool          = Query(False, description="omit income categories from results"),
    exclude_expense:    bool          = Query(False, description="omit expense categories from results"),
):
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

    _append_effective_account_filter(
        clauses, params, account_id=account_id, account_ids=account_ids,
        exclude_account_ids=exclude_account_ids,
    )
    _append_tag_filter(clauses, params, tag_ids=tag_ids, exclude_tag_ids=exclude_tag_ids)
    _append_owner_filter(clauses, params, owner_ids=owner_ids, exclude_owner_ids=exclude_owner_ids)
    _append_group_filter(clauses, params, group_ids=group_ids, exclude_group_ids=exclude_group_ids)
    _append_category_ids_filter(clauses, params, category_ids=category_ids, exclude_category_ids=exclude_category_ids)
    _append_payee_filter(clauses, params, payees=payees, exclude_payees=exclude_payees)
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
        rows = conn.execute(
            f"""
            SELECT sig, SUM(net) AS net, COUNT(*) AS count FROM (
                SELECT {sig_sql} AS sig, {signed_amount} AS net
                FROM   txn t
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
    account_ids:        Optional[str] = Query(None),
    tag_ids:            Optional[str] = Query(None),
    owner_ids:          Optional[str] = Query(None, description="filter by transaction owner (comma-separated)"),
    category_ids:       Optional[str] = Query(None, description="comma-separated leaf category IDs"),
    group_ids:          Optional[str] = Query(None, description="comma-separated top-level group IDs"),
    payees:             Optional[str] = Query(None, description="pipe-separated payee names"),
    exclude_account_ids:  Optional[str] = Query(None, description="account IDs to exclude ('is not')"),
    exclude_group_ids:    Optional[str] = Query(None, description="group IDs to exclude ('is not')"),
    exclude_category_ids: Optional[str] = Query(None, description="category IDs to exclude ('is not')"),
    exclude_owner_ids:    Optional[str] = Query(None, description="owner IDs to exclude ('is not')"),
    exclude_payees:       Optional[str] = Query(None, description="payee names to exclude ('is not')"),
    exclude_tag_ids:      Optional[str] = Query(None, description="tag IDs to exclude ('is not')"),
    category_owner_ids: Optional[str] = Query(None, description="reserved for summary filter parity"),
):
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

    _append_effective_account_filter(
        clauses, params, account_id=account_id, account_ids=account_ids,
        exclude_account_ids=exclude_account_ids,
    )
    _append_tag_filter(clauses, params, tag_ids=tag_ids, exclude_tag_ids=exclude_tag_ids)
    _append_owner_filter(clauses, params, owner_ids=owner_ids, exclude_owner_ids=exclude_owner_ids)
    _append_group_filter(clauses, params, group_ids=group_ids, exclude_group_ids=exclude_group_ids)
    _append_category_ids_filter(clauses, params, category_ids=category_ids, exclude_category_ids=exclude_category_ids)
    _append_payee_filter(clauses, params, payees=payees, exclude_payees=exclude_payees)

    with get_db() as conn:
        where = "WHERE " + " AND ".join(clauses)
        rows = conn.execute(
            f"""
            SELECT
                {_summary_uncategorized_id_sql('group')}      AS group_id,
                {_summary_uncategorized_name_sql('group')}    AS group_name,
                NULL                                                        AS group_color,
                {_summary_uncategorized_type_sql('group')}                       AS category_type,
                {_summary_signed_total_sql(_summary_uncategorized_type_sql('group'))} AS total,
                COUNT(*)                                                         AS count
            FROM   txn t
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
    account_ids: Optional[str] = Query(None),
    tag_ids:     Optional[str] = Query(None),
    owner_ids:   Optional[str] = Query(None, description="comma-separated owner IDs"),
    category_ids: Optional[str] = Query(None, description="comma-separated leaf category IDs"),
    group_ids:   Optional[str] = Query(None, description="comma-separated top-level group IDs"),
    payees:      Optional[str] = Query(None, description="pipe-separated payee names"),
    exclude_account_ids:  Optional[str] = Query(None, description="account IDs to exclude ('is not')"),
    exclude_group_ids:    Optional[str] = Query(None, description="group IDs to exclude ('is not')"),
    exclude_category_ids: Optional[str] = Query(None, description="category IDs to exclude ('is not')"),
    exclude_owner_ids:    Optional[str] = Query(None, description="owner IDs to exclude ('is not')"),
    exclude_payees:       Optional[str] = Query(None, description="payee names to exclude ('is not')"),
    exclude_tag_ids:      Optional[str] = Query(None, description="tag IDs to exclude ('is not')"),
):
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

    _append_effective_account_filter(
        clauses, params, account_id=account_id, account_ids=account_ids,
        exclude_account_ids=exclude_account_ids,
    )
    _append_tag_filter(clauses, params, tag_ids=tag_ids, exclude_tag_ids=exclude_tag_ids)

    _append_owner_filter(clauses, params, owner_ids=owner_ids, exclude_owner_ids=exclude_owner_ids)
    _append_group_filter(clauses, params, group_ids=group_ids, exclude_group_ids=exclude_group_ids)
    _append_category_ids_filter(clauses, params, category_ids=category_ids, exclude_category_ids=exclude_category_ids)
    _append_payee_filter(clauses, params, payees=payees, exclude_payees=exclude_payees)

    where = "WHERE " + " AND ".join(clauses)

    with get_db() as conn:
        rows = conn.execute(
            f"""
            SELECT
                {_summary_uncategorized_id_sql('category')}   AS category_id,
                {_summary_uncategorized_name_sql('category')} AS category_name,
                NULL                                AS category_color,
                {_summary_signed_total_sql(_summary_uncategorized_type_sql('category'))} AS total,
                COUNT(*)                            AS count
            FROM   txn t
            LEFT JOIN category c ON c.id = t.category_id
            {where}
            GROUP BY category_id
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
    account_ids: Optional[str] = Query(None),
    source_account_ids: Optional[str] = Query(None, description="comma-separated source (original) account IDs — narrows a merged-account view to specific underlying accounts"),
    tag_ids:     Optional[str] = Query(None),
    owner_ids:   Optional[str] = Query(None),
    category_ids: Optional[str] = Query(None, description="comma-separated leaf category IDs"),
    group_ids:   Optional[str] = Query(None, description="comma-separated top-level group IDs"),
    payees:      Optional[str] = Query(None, description="pipe-separated payee names"),
    exclude_account_ids:  Optional[str] = Query(None, description="account IDs to exclude ('is not')"),
    exclude_group_ids:    Optional[str] = Query(None, description="group IDs to exclude ('is not')"),
    exclude_category_ids: Optional[str] = Query(None, description="category IDs to exclude ('is not')"),
    exclude_owner_ids:    Optional[str] = Query(None, description="owner IDs to exclude ('is not')"),
    exclude_payees:       Optional[str] = Query(None, description="payee names to exclude ('is not')"),
    exclude_tag_ids:      Optional[str] = Query(None, description="tag IDs to exclude ('is not')"),
    months:      int            = Query(18, le=120),
    date_start:  Optional[str] = Query(None),
    date_end:    Optional[str] = Query(None),
    anchor:      Optional[str] = Query(None, description="'latest' slides the rolling window to end at the scope's most recent transaction instead of today"),
    view:        str            = Query("cash_flow", description="spending | income | cash_flow (used only when no category/payee scope)"),
):
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

    _append_effective_account_filter(
        clauses, params, account_id=account_id, account_ids=account_ids,
        exclude_account_ids=exclude_account_ids,
    )
    _append_source_account_filter(clauses, params, source_account_ids=source_account_ids)
    _append_tag_filter(clauses, params, tag_ids=tag_ids, exclude_tag_ids=exclude_tag_ids)
    _append_owner_filter(clauses, params, owner_ids=owner_ids, exclude_owner_ids=exclude_owner_ids)
    _append_group_filter(clauses, params, group_ids=group_ids, exclude_group_ids=exclude_group_ids)
    _append_category_ids_filter(clauses, params, category_ids=category_ids, exclude_category_ids=exclude_category_ids)
    _append_payee_filter(clauses, params, payees=payees, exclude_payees=exclude_payees)

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

    if (not date_start and not date_end and not payee and not account_id and not account_ids
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
                COUNT(*)                  AS count
            FROM   txn t
            {join_sql}
            {where}
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
    account_ids: Optional[str] = Query(None),
    tag_ids:     Optional[str] = Query(None),
    owner_ids:   Optional[str] = Query(None),
    category_ids: Optional[str] = Query(None, description="comma-separated leaf category IDs"),
    group_ids:   Optional[str] = Query(None, description="comma-separated top-level group IDs"),
    payees:      Optional[str] = Query(None, description="pipe-separated payee names"),
    exclude_account_ids:  Optional[str] = Query(None, description="account IDs to exclude ('is not')"),
    exclude_group_ids:    Optional[str] = Query(None, description="group IDs to exclude ('is not')"),
    exclude_category_ids: Optional[str] = Query(None, description="category IDs to exclude ('is not')"),
    exclude_owner_ids:    Optional[str] = Query(None, description="owner IDs to exclude ('is not')"),
    exclude_payees:       Optional[str] = Query(None, description="payee names to exclude ('is not')"),
    exclude_tag_ids:      Optional[str] = Query(None, description="tag IDs to exclude ('is not')"),
    group_id:    Optional[str] = Query(None),
):
    clauses = [
        "t.is_pending = 0",
        "t.trashed_at IS NULL",
        "t.date >= date('now', ? || ' months')",
        "strftime('%Y-%m', t.date) IS NOT NULL",
        "COALESCE(p.exclude_from_totals, c.exclude_from_totals, 0) = 0",
    ]
    params = [f"-{months}"]

    _append_effective_account_filter(
        clauses, params, account_id=account_id, account_ids=account_ids,
        exclude_account_ids=exclude_account_ids,
    )
    _append_tag_filter(clauses, params, tag_ids=tag_ids, exclude_tag_ids=exclude_tag_ids)
    _append_owner_filter(clauses, params, owner_ids=owner_ids, exclude_owner_ids=exclude_owner_ids)
    _append_group_filter(clauses, params, group_ids=group_ids, exclude_group_ids=exclude_group_ids)
    _append_category_ids_filter(clauses, params, category_ids=category_ids, exclude_category_ids=exclude_category_ids)
    _append_payee_filter(clauses, params, payees=payees, exclude_payees=exclude_payees)

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
        rows = conn.execute(
            f"""
            SELECT
                strftime('%Y-%m', t.date) AS month,
                {select_id},
                {select_name},
                {select_col},
                {select_type},
                {select_total}
            FROM   txn t
            {join}
            {where}
            GROUP BY month, series_id
            ORDER BY month, total DESC
            """,
            params,
        ).fetchall()

    return [dict(r) for r in rows]
