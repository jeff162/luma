# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: GPL-3.0-or-later

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
    VISIBLE_TXN_TAG_SQL,
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


def _append_effective_account_filter(clauses, params, *, account_id: Optional[str], account_ids: Optional[str]):
    if account_ids and isinstance(account_ids, str):
        ids = [i.strip() for i in account_ids.split(',') if i.strip()]
        placeholders = ','.join('?' * len(ids))
        clauses.append(f"{EFFECTIVE_ACCOUNT_ID_SQL} IN ({placeholders})")
        params.extend(ids)
    elif account_id and isinstance(account_id, str):
        clauses.append(f"{EFFECTIVE_ACCOUNT_ID_SQL} = ?")
        params.append(account_id)


def _append_tag_filter(clauses, params, *, tag_ids: Optional[str]):
    if not tag_ids or not isinstance(tag_ids, str):
        return
    ids = [i.strip() for i in tag_ids.split(",") if i.strip()]
    if not ids:
        return
    placeholders = ",".join("?" * len(ids))
    # A transaction "has" a tag through any of three paths: direct (txn_tag with
    # rule/manual visibility), inherited from its leaf category, or inherited from
    # the leaf category's parent group. The filter accepts a match through any
    # path so tag-based reporting picks up tags applied at the most natural level.
    clauses.append(
        f"""
        (
            EXISTS (
                SELECT 1
                FROM txn_tag tt
                WHERE tt.txn_id = t.id
                  AND tt.tag_id IN ({placeholders})
                  AND {VISIBLE_TXN_TAG_SQL}
            )
            OR EXISTS (
                SELECT 1
                FROM category_tag ct
                JOIN category cc ON cc.id = t.category_id
                WHERE ct.tag_id IN ({placeholders})
                  AND (ct.category_id = cc.id OR ct.category_id = cc.parent_id)
            )
        )
        """
    )
    params.extend(ids)
    params.extend(ids)


# Quick filter parsing keeps the Transactions page's one-box workflow lightweight:
# - merchant and category stay broad substring matches so partial labels still work naturally
# - account labels match normalized whole words/phrases so generic fragments like `check` do not expand to every
#   `Checking` account and drown out rows whose merchant is actually `CHECK`
# - date and amount parsing add more precise matches when the input looks like those domains
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


@router.get("")
def list_transactions(
    month:        Optional[str] = Query(None, description="YYYY-MM"),
    date_start:   Optional[str] = Query(None, description="YYYY-MM-DD"),
    date_end:     Optional[str] = Query(None, description="YYYY-MM-DD"),
    import_batch_id: Optional[str] = Query(None),
    sort_by:      Optional[str] = Query("date", description="date | merchant | category | account | amount"),
    sort_dir:     Optional[str] = Query("desc", description="asc | desc"),
    account_id:   Optional[str] = Query(None),
    account_ids:  Optional[str] = Query(None, description="comma-separated account IDs"),
    category_id:  Optional[str] = Query(None),
    group_ids:    Optional[str] = Query(None, description="comma-separated group IDs"),
    category_ids: Optional[str] = Query(None, description="comma-separated category IDs"),
    tag_ids:      Optional[str] = Query(None, description="comma-separated tag IDs"),
    owner_ids:    Optional[str] = Query(None, description="comma-separated owner IDs"),
    payees:       Optional[str] = Query(None, description="pipe-separated payee names"),
    direction:    Optional[str] = Query(None, description="debit | credit"),
    view:         Optional[str] = Query(None, description="spending | income — mirrors monthly-trend's category-type scope filter"),
    search:       Optional[str] = Query(None),
    quick_filter: Optional[str] = Query(None),
    include_trashed: bool       = Query(False, description="Include rows in the trash. Off by default — the trash view sets this explicitly."),
    limit:        int           = Query(200, le=1000),
    offset:       int           = Query(0),
):
    # This endpoint is the UI's lossless transaction feed, so filters narrow the raw rows but do not apply the
    # reporting rules used by summaries such as excluding pending transactions or normalizing amount direction.
    clauses = []
    params  = []
    if not include_trashed:
        clauses.append("t.trashed_at IS NULL")
    sort_key = sort_by if sort_by in TRANSACTION_SORT_SQL else "date"
    sort_direction = "ASC" if str(sort_dir).lower() == "asc" else "DESC"

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
    _append_effective_account_filter(clauses, params, account_id=account_id, account_ids=account_ids)
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
    if group_ids:
        ids = [i.strip() for i in group_ids.split(',') if i.strip()]
        group_filter = _build_uncategorized_multi_filter(
            "t.category_id",
            ids,
        )
        normal_group_ids = [
            value for value in ids
            if value not in {
                UNCATEGORIZED_CATEGORY_ID,
                UNCATEGORIZED_EXPENSE_CATEGORY_ID,
                UNCATEGORIZED_INCOME_CATEGORY_ID,
            }
        ]
        group_clauses = []
        group_params = []
        if normal_group_ids:
            placeholders = ','.join('?' * len(normal_group_ids))
            group_clauses.append(f"t.category_id IN (SELECT id FROM category WHERE parent_id IN ({placeholders}))")
            group_params.extend(normal_group_ids)
        if group_filter:
            group_clauses.append(group_filter[0])
            group_params.extend(group_filter[1])
        if group_clauses:
            clauses.append(f"({' OR '.join(group_clauses)})")
            params.extend(group_params)
    if category_ids:
        category_filter = _build_uncategorized_multi_filter(
            "t.category_id",
            [i.strip() for i in category_ids.split(',') if i.strip()],
        )
        if category_filter:
            clauses.append(category_filter[0])
            params.extend(category_filter[1])
    _append_tag_filter(clauses, params, tag_ids=tag_ids)
    if payees:
        names = [n.strip() for n in payees.split('|') if n.strip()]
        # Payee chips come from canonicalized labels in the UI, so matching has to honor whichever merchant field
        # currently carries the visible name instead of forcing one column to be authoritative.
        or_clauses = ' OR '.join(
            ['(t.display_name = ? OR t.merchant_name = ? OR t.raw_name = ?)'] * len(names)
        )
        clauses.append(f"({or_clauses})")
        for n in names:
            params.extend([n, n, n])
    if owner_ids:
        ids = [i.strip() for i in owner_ids.split(',') if i.strip()]
        # Owner filters need to express "real owner(s) plus unassigned" because the UI exposes unowned transactions
        # as a first-class bucket rather than forcing the client to issue separate queries.
        if 'unassigned' in ids:
            other_ids = [i for i in ids if i != 'unassigned']
            if other_ids:
                placeholders = ','.join('?' * len(other_ids))
                clauses.append(f"(t.owner_id IS NULL OR t.owner_id IN ({placeholders}))")
                params.extend(other_ids)
            else:
                clauses.append("t.owner_id IS NULL")
        else:
            placeholders = ','.join('?' * len(ids))
            clauses.append(f"t.owner_id IN ({placeholders})")
            params.extend(ids)
    if direction == "debit":
        clauses.append("t.amount > 0")
    elif direction == "credit":
        clauses.append("t.amount < 0")
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
        total = conn.execute(
            f"""
            SELECT COUNT(*)
            FROM txn t
            JOIN account a ON a.id = t.account_id
            LEFT JOIN account p ON p.id = a.parent_account_id
            LEFT JOIN category c ON c.id = t.category_id
            LEFT JOIN category pc ON pc.id = c.parent_id
            {where}
            """,
            params
        ).fetchone()[0]

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
                t.category_id,
                c.name        AS category_name,
                NULL          AS category_color,
                b.filename    AS import_batch_filename,
                b.imported_at AS import_batch_imported_at,
                o.name        AS owner_name,
                o.color       AS owner_color,
                t.suspect_duplicate_of,
                t.suspect_duplicate_reason
            FROM   txn t
            JOIN   account  a ON a.id = t.account_id
            LEFT JOIN account  p ON p.id = a.parent_account_id
            LEFT JOIN category c ON c.id = t.category_id
            LEFT JOIN category pc ON pc.id = c.parent_id
            LEFT JOIN import_batch b ON b.id = t.import_batch_id
            LEFT JOIN owner    o ON o.id = t.owner_id
            {where}
            ORDER BY {order_by}
            LIMIT ? OFFSET ?
            """,
            params + [limit, offset],
        ).fetchall()
        transactions = [dict(r) for r in rows]
        tag_map = get_visible_transaction_tag_map(conn, [txn["id"] for txn in transactions]) if rows else {}
        for txn in transactions:
            txn["tags"] = tag_map.get(txn["id"], [])

    return {
        "total": total,
        "limit": limit,
        "offset": offset,
        "transactions": transactions,
    }


@router.patch("/{txn_id}/category")
def override_category(txn_id: str, body: CategoryOverride):
    with get_db() as conn:
        txn = conn.execute(
            "SELECT id FROM txn WHERE id = ?", (txn_id,)
        ).fetchone()
        if not txn:
            raise HTTPException(status_code=404, detail="Transaction not found")

        conn.execute(
            """
            UPDATE txn
            SET category_id = ?, category_overridden = 1, category_source = 'manual', notes = ?
            WHERE id = ?
            """,
            (body.category_id, body.notes, txn_id),
        )
    return {"ok": True}



@router.patch("/{txn_id}/merchant")
def update_merchant(txn_id: str, body: dict):
    name = body.get("merchant_name", "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="merchant_name required")
    with get_db() as conn:
        conn.execute(
            "UPDATE txn SET display_name = ? WHERE id = ?",
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
    return {"tags": tags}


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


@router.post("/{txn_id}/restore")
def restore_transaction(txn_id: str):
    with get_db() as conn:
        row = conn.execute("SELECT id FROM txn WHERE id = ?", (txn_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Transaction not found")
        conn.execute("UPDATE txn SET trashed_at = NULL WHERE id = ?", (txn_id,))
    return {"ok": True}


@router.get("/trash")
def list_trashed_transactions(limit: int = Query(200, le=1000)):
    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT t.id, t.date, t.amount, t.merchant_name, t.display_name, t.raw_name,
                   t.account_id, t.category_id, t.trashed_at, t.notes,
                   a.name AS account_name, a.display_name AS account_display_name, a.mask AS account_mask,
                   c.name AS category_name,
                   p.name AS group_name, p.id AS group_id
            FROM   txn t
            LEFT JOIN account  a ON a.id = t.account_id
            LEFT JOIN category c ON c.id = t.category_id
            LEFT JOIN category p ON p.id = c.parent_id
            WHERE  t.trashed_at IS NOT NULL
            ORDER  BY t.trashed_at DESC, t.date DESC
            LIMIT  ?
            """,
            (limit,),
        ).fetchall()
    return [dict(row) for row in rows]


@router.post("/trash/empty")
def empty_transaction_trash():
    with get_db() as conn:
        cursor = conn.execute("DELETE FROM txn WHERE trashed_at IS NOT NULL")
        removed = cursor.rowcount or 0
    return {"removed": removed}


# Suspect-duplicate review. The flag itself is set by services/duplicate_detection.py during the
# import and account-merge flows; these endpoints just expose listing and per-row resolution.
@router.get("/suspect-duplicates")
def list_suspect_duplicates(
    batch_id: Optional[str] = Query(None, description="Filter to a specific import batch."),
    limit:    int           = Query(500, le=2000),
):
    from backend.services.duplicate_detection import list_suspects
    with get_db() as conn:
        return {"pairs": list_suspects(conn, batch_id=batch_id, limit=limit)}


@router.get("/suspect-duplicates/count")
def count_suspect_duplicates():
    from backend.services.duplicate_detection import count_active_suspects
    with get_db() as conn:
        return {"count": count_active_suspects(conn)}


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
        if reason == "invalid_action":
            raise HTTPException(status_code=400, detail="action must be 'keep' or 'trash'")
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

    _append_effective_account_filter(clauses, params, account_id=account_id, account_ids=account_ids)
    _append_tag_filter(clauses, params, tag_ids=tag_ids)

    if owner_ids:
        ids = [i.strip() for i in owner_ids.split(',') if i.strip()]
        if 'unassigned' in ids:
            other_ids = [i for i in ids if i != 'unassigned']
            if other_ids:
                placeholders = ','.join('?' * len(other_ids))
                clauses.append(f"(t.owner_id IS NULL OR t.owner_id IN ({placeholders}))")
                params.extend(other_ids)
            else:
                clauses.append("t.owner_id IS NULL")
        else:
            placeholders = ','.join('?' * len(ids))
            clauses.append(f"t.owner_id IN ({placeholders})")
            params.extend(ids)

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
                ABS(SUM(t.amount))                            AS total,
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



@router.get("/summary/by-group")
def spending_by_group(
    month:              Optional[str] = Query(None, description="YYYY-MM"),
    date_start:         Optional[str] = Query(None),
    date_end:           Optional[str] = Query(None),
    account_id:         Optional[str] = Query(None),
    account_ids:        Optional[str] = Query(None),
    tag_ids:            Optional[str] = Query(None),
    owner_ids:          Optional[str] = Query(None, description="filter by transaction owner (comma-separated)"),
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

    _append_effective_account_filter(clauses, params, account_id=account_id, account_ids=account_ids)
    _append_tag_filter(clauses, params, tag_ids=tag_ids)
    if owner_ids:
        ids = [i.strip() for i in owner_ids.split(',') if i.strip()]
        if 'unassigned' in ids:
            other_ids = [i for i in ids if i != 'unassigned']
            if other_ids:
                placeholders = ','.join('?' * len(other_ids))
                clauses.append(f"(t.owner_id IS NULL OR t.owner_id IN ({placeholders}))")
                params.extend(other_ids)
            else:
                clauses.append("t.owner_id IS NULL")
        else:
            placeholders = ','.join('?' * len(ids))
            clauses.append(f"t.owner_id IN ({placeholders})")
            params.extend(ids)

    with get_db() as conn:
        where = "WHERE " + " AND ".join(clauses)
        rows = conn.execute(
            f"""
            SELECT
                {_summary_uncategorized_id_sql('group')}      AS group_id,
                {_summary_uncategorized_name_sql('group')}    AS group_name,
                NULL                                                        AS group_color,
                {_summary_uncategorized_type_sql('group')}                       AS category_type,
                ABS(SUM(t.amount))                                               AS total,
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

    _append_effective_account_filter(clauses, params, account_id=account_id, account_ids=account_ids)
    _append_tag_filter(clauses, params, tag_ids=tag_ids)

    if owner_ids:
        ids = [i.strip() for i in owner_ids.split(',') if i.strip()]
        if 'unassigned' in ids:
            other_ids = [i for i in ids if i != 'unassigned']
            if other_ids:
                placeholders = ','.join('?' * len(other_ids))
                clauses.append(f"(t.owner_id IS NULL OR t.owner_id IN ({placeholders}))")
                params.extend(other_ids)
            else:
                clauses.append("t.owner_id IS NULL")
        else:
            placeholders = ','.join('?' * len(ids))
            clauses.append(f"t.owner_id IN ({placeholders})")
            params.extend(ids)

    where = "WHERE " + " AND ".join(clauses)

    with get_db() as conn:
        rows = conn.execute(
            f"""
            SELECT
                {_summary_uncategorized_id_sql('category')}   AS category_id,
                {_summary_uncategorized_name_sql('category')} AS category_name,
                NULL                                AS category_color,
                ABS(SUM(t.amount))                  AS total,
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
    tag_ids:     Optional[str] = Query(None),
    months:      int            = Query(18, le=120),
    date_start:  Optional[str] = Query(None),
    date_end:    Optional[str] = Query(None),
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

    _append_effective_account_filter(clauses, params, account_id=account_id, account_ids=account_ids)
    _append_tag_filter(clauses, params, tag_ids=tag_ids)

    if date_start:
        clauses.append("t.date >= ?")
        params.append(date_start)
    if date_end:
        clauses.append("t.date <= ?")
        params.append(date_end)

    if not date_start and not date_end and not payee and not account_id and not account_ids:
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
    months:      int           = Query(24, le=60),
    account_id:  Optional[str] = Query(None),
    account_ids: Optional[str] = Query(None),
    tag_ids:     Optional[str] = Query(None),
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

    _append_effective_account_filter(clauses, params, account_id=account_id, account_ids=account_ids)
    _append_tag_filter(clauses, params, tag_ids=tag_ids)

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
        select_type = "'expense' AS series_category_type"
        join        = "LEFT JOIN category c ON c.id = t.category_id LEFT JOIN category p ON p.id = c.parent_id"
    elif group_id == UNCATEGORIZED_INCOME_CATEGORY_ID:
        select_id   = f"'{UNCATEGORIZED_INCOME_CATEGORY_ID}' AS series_id"
        select_name = f"'{UNCATEGORIZED_INCOME_CATEGORY_NAME}' AS series_name"
        select_col  = "NULL AS series_color"
        select_type = "'income' AS series_category_type"
        join        = "LEFT JOIN category c ON c.id = t.category_id LEFT JOIN category p ON p.id = c.parent_id"
    elif group_id:
        # Drill-down switches the series identity from top-level groups to the group's leaf categories without
        # changing the payload shape, so the trends UI can reuse one charting pipeline for both levels.
        select_id   = f"{_summary_uncategorized_id_sql('category')}   AS series_id"
        select_name = f"{_summary_uncategorized_name_sql('category')} AS series_name"
        select_col  = "NULL                                AS series_color"
        select_type = f"{_summary_uncategorized_type_sql('category')} AS series_category_type"
        # Keep the parent join available because the shared reporting filters above still
        # read parent-group metadata such as exclude-from-totals and system category type.
        join        = "LEFT JOIN category c ON c.id = t.category_id LEFT JOIN category p ON p.id = c.parent_id"
    else:
        select_id   = f"{_summary_uncategorized_id_sql('group')}   AS series_id"
        select_name = f"{_summary_uncategorized_name_sql('group')} AS series_name"
        select_col  = "NULL                                          AS series_color"
        select_type = f"{_summary_uncategorized_type_sql('group')} AS series_category_type"
        join        = "LEFT JOIN category c ON c.id = t.category_id LEFT JOIN category p ON p.id = c.parent_id"

    with get_db() as conn:
        rows = conn.execute(
            f"""
            SELECT
                strftime('%Y-%m', t.date) AS month,
                {select_id},
                {select_name},
                {select_col},
                {select_type},
                ABS(SUM(t.amount)) AS total
            FROM   txn t
            {join}
            {where}
            GROUP BY month, series_id
            ORDER BY month, total DESC
            """,
            params,
        ).fetchall()

    return [dict(r) for r in rows]
