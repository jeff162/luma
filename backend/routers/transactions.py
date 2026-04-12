# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: GPL-3.0-or-later

"""
Transaction list and summary endpoints.

Treat this file as two related contracts:
- `list_transactions` is the raw ledger view, so it keeps pending rows and accepts a broad mix of legacy and
  multi-select filters.
- the `/summary/*` endpoints normalize transactions into reporting semantics, which means pending rows drop out,
  amount sign is interpreted through category type, and group/category filters use subqueries so the reporting
  joins do not accidentally change which transactions qualify.
"""
from fastapi import APIRouter, Query, HTTPException
from pydantic import BaseModel
from typing import Optional
from backend.db.database import get_db, get_shared_owner_id

router = APIRouter()

EFFECTIVE_ACCOUNT_ID_SQL = "COALESCE((SELECT parent_account_id FROM account WHERE id = t.account_id), t.account_id)"


class CategoryOverride(BaseModel):
    # Category edits from the transaction UI can also persist the note field in the same save gesture.
    category_id: str
    notes: Optional[str] = None


def _append_effective_account_filter(clauses, params, *, account_id: Optional[str], account_ids: Optional[str]):
    if account_ids:
        ids = [i.strip() for i in account_ids.split(',') if i.strip()]
        placeholders = ','.join('?' * len(ids))
        clauses.append(f"{EFFECTIVE_ACCOUNT_ID_SQL} IN ({placeholders})")
        params.extend(ids)
    elif account_id:
        clauses.append(f"{EFFECTIVE_ACCOUNT_ID_SQL} = ?")
        params.append(account_id)


@router.get("")
def list_transactions(
    month:        Optional[str] = Query(None, description="YYYY-MM"),
    date_start:   Optional[str] = Query(None, description="YYYY-MM-DD"),
    date_end:     Optional[str] = Query(None, description="YYYY-MM-DD"),
    account_id:   Optional[str] = Query(None),
    account_ids:  Optional[str] = Query(None, description="comma-separated account IDs"),
    category_id:  Optional[str] = Query(None),
    group_ids:    Optional[str] = Query(None, description="comma-separated group IDs"),
    category_ids: Optional[str] = Query(None, description="comma-separated category IDs"),
    owner_ids:    Optional[str] = Query(None, description="comma-separated owner IDs"),
    payees:       Optional[str] = Query(None, description="pipe-separated payee names"),
    direction:    Optional[str] = Query(None, description="debit | credit"),
    search:       Optional[str] = Query(None),
    limit:        int           = Query(200, le=1000),
    offset:       int           = Query(0),
):
    # This endpoint is the UI's lossless transaction feed, so filters narrow the raw rows but do not apply the
    # reporting rules used by summaries such as excluding pending transactions or normalizing amount direction.
    clauses = []
    params  = []

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
    _append_effective_account_filter(clauses, params, account_id=account_id, account_ids=account_ids)
    if category_id == "__uncategorized__":
        clauses.append("t.category_id IS NULL")
    elif category_id and category_id.startswith("__group__"):
        # Group filters expand to leaf categories; the list endpoint never synthesizes group rows of its own.
        gid = category_id[len("__group__"):]
        clauses.append("t.category_id IN (SELECT id FROM category WHERE parent_id = ?)")
        params.append(gid)
    elif category_id:
        clauses.append("t.category_id = ?")
        params.append(category_id)
    if group_ids:
        ids = [i.strip() for i in group_ids.split(',') if i.strip()]
        placeholders = ','.join('?' * len(ids))
        clauses.append(f"t.category_id IN (SELECT id FROM category WHERE parent_id IN ({placeholders}))")
        params.extend(ids)
    if category_ids:
        ids = [i.strip() for i in category_ids.split(',') if i.strip()]
        placeholders = ','.join('?' * len(ids))
        clauses.append(f"t.category_id IN ({placeholders})")
        params.extend(ids)
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
    if search:
        clauses.append("(t.display_name LIKE ? OR t.merchant_name LIKE ? OR t.raw_name LIKE ?)")
        params.extend([f"%{search}%", f"%{search}%", f"%{search}%"])

    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""

    with get_db() as conn:
        total = conn.execute(
            f"SELECT COUNT(*) FROM txn t {where}", params
        ).fetchone()[0]

        rows = conn.execute(
            f"""
            SELECT
                t.id, t.date, t.amount, t.merchant_name, t.display_name, t.raw_name,
                t.is_pending, t.category_overridden, t.notes,
                COALESCE(a.parent_account_id, a.id) AS account_id,
                t.owner_id,
                COALESCE(a.display_name, a.name) AS account_name,
                COALESCE(p.mask, a.mask)         AS account_mask,
                t.category_id,
                c.name        AS category_name,
                NULL          AS category_color,
                o.name        AS owner_name,
                o.color       AS owner_color
            FROM   txn t
            JOIN   account  a ON a.id = t.account_id
            LEFT JOIN account  p ON p.id = a.parent_account_id
            LEFT JOIN category c ON c.id = t.category_id
            LEFT JOIN owner    o ON o.id = t.owner_id
            {where}
            ORDER BY t.date DESC, t.id DESC
            LIMIT ? OFFSET ?
            """,
            params + [limit, offset],
        ).fetchall()

    return {
        "total": total,
        "limit": limit,
        "offset": offset,
        "transactions": [dict(r) for r in rows],
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
            SET category_id = ?, category_overridden = 1, notes = ?
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


@router.patch("/{txn_id}/uncategorize")
def clear_override(txn_id: str):
    with get_db() as conn:
        # Clearing an override resets both the lock bit and the stored category so rule application can fully
        # re-derive the transaction instead of leaving a stale manual category behind.
        conn.execute(
            "UPDATE txn SET category_overridden = 0, category_id = NULL WHERE id = ?",
            (txn_id,),
        )
    return {"ok": True}


@router.get("/summary/by-category")
def spending_by_category(
    month: str = Query(..., description="YYYY-MM"),
    account_id:  Optional[str] = Query(None),
    account_ids: Optional[str] = Query(None),
):
    clauses = ["t.date LIKE ?", "t.amount > 0", "t.is_pending = 0"]
    params  = [f"{month}%"]

    _append_effective_account_filter(clauses, params, account_id=account_id, account_ids=account_ids)

    where = "WHERE " + " AND ".join(clauses)

    with get_db() as conn:
        rows = conn.execute(
            f"""
            SELECT
                COALESCE(c.id,    'uncategorized') AS category_id,
                COALESCE(c.name,  'Uncategorized') AS category_name,
                NULL                                AS category_color,
                SUM(t.amount)                       AS total,
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



@router.get("/summary/by-group")
def spending_by_group(
    month:              Optional[str] = Query(None, description="YYYY-MM"),
    date_start:         Optional[str] = Query(None),
    date_end:           Optional[str] = Query(None),
    account_id:         Optional[str] = Query(None),
    account_ids:        Optional[str] = Query(None),
    owner_ids:          Optional[str] = Query(None, description="filter by transaction owner (comma-separated)"),
    category_owner_ids: Optional[str] = Query(None, description="filter by category group owner (comma-separated)"),
):
    # Reporting treats amount sign through the category hierarchy: expense groups count positive debits, income
    # groups count negative credits, and excluded categories are removed before rollup.
    clauses = ["t.is_pending = 0",
               "COALESCE(p.exclude_from_totals, c.exclude_from_totals, 0) = 0",
               """(
                   CASE COALESCE(p.category_type, c.category_type)
                     WHEN 'income' THEN t.amount < 0
                     ELSE               t.amount > 0
                   END
               )"""]
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
        if category_owner_ids:
            ids = [i.strip() for i in category_owner_ids.split(',') if i.strip()]
            shared_owner_id = get_shared_owner_id(conn)
            filter_ids = list(ids)
            if shared_owner_id and shared_owner_id not in filter_ids:
                filter_ids.append(shared_owner_id)
            placeholders = ','.join('?' * len(filter_ids))
            # Ownership inherits downward only for unowned child categories. Once a leaf has its own owner, group
            # ownership stops applying so summaries and drill-downs stay aligned with what the category editor shows.
            clauses.append(
                f"(COALESCE(p.id, c.id) IS NULL OR "
                f"COALESCE(c.owner_id, p.owner_id) IN ({placeholders}))"
            )
            params.extend(filter_ids)

        where = "WHERE " + " AND ".join(clauses)
        rows = conn.execute(
            f"""
            SELECT
                COALESCE(p.id,              c.id,              'uncategorized') AS group_id,
                COALESCE(p.name,            c.name,            'Uncategorized') AS group_name,
                NULL                                                        AS group_color,
                COALESCE(c.owner_id,        p.owner_id)                          AS group_owner_id,
                COALESCE(p.category_type,   c.category_type)                     AS category_type,
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
    owner_ids:   Optional[str] = Query(None, description="comma-separated owner IDs"),
):
    clauses = ["t.amount > 0", "t.is_pending = 0"]
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
    clauses.append(
        "t.category_id IN (SELECT id FROM category WHERE parent_id = ? OR id = ?)"
    )
    params.extend([group_id, group_id])

    _append_effective_account_filter(clauses, params, account_id=account_id, account_ids=account_ids)

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
                COALESCE(c.id,    'uncategorized') AS category_id,
                COALESCE(c.name,  'Uncategorized') AS category_name,
                NULL                                AS category_color,
                SUM(t.amount)                       AS total,
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

@router.get("/summary/monthly-trend")
def monthly_trend(
    category_id: Optional[str] = Query(None),
    payee:       Optional[str] = Query(None),
    account_id:  Optional[str] = Query(None),
    account_ids: Optional[str] = Query(None),
    months:      int            = Query(18, le=120),
    date_start:  Optional[str] = Query(None),
    date_end:    Optional[str] = Query(None),
):
    if payee:
        # Payee detail drawers want the merchant's full visible history by default, so the rolling month window is
        # suppressed unless the caller supplied an explicit date filter.
        clauses = ["t.amount > 0", "t.is_pending = 0",
                   "(t.display_name = ? OR t.merchant_name = ? OR t.raw_name = ?)"]
        params  = [payee, payee, payee]
    else:
        clauses = ["t.amount > 0", "t.is_pending = 0",
                  ]
        params  = []
        if category_id == "__uncategorized__":
            clauses.append("t.category_id IS NULL")
        elif category_id and category_id.startswith("__group__"):
            gid = category_id[len("__group__"):]
            clauses.append("t.category_id IN (SELECT id FROM category WHERE parent_id = ?)")
            params.append(gid)
        elif category_id:
            clauses.append("t.category_id = ?")
            params.append(category_id)

    _append_effective_account_filter(clauses, params, account_id=account_id, account_ids=account_ids)

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

    where = "WHERE " + " AND ".join(clauses)

    with get_db() as conn:
        rows = conn.execute(
            f"""
            SELECT
                strftime('%Y-%m', t.date) AS month,
                SUM(t.amount)             AS total,
                COUNT(*)                  AS count
            FROM   txn t
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
    group_id:    Optional[str] = Query(None),
):
    clauses = [
        "t.is_pending = 0",
        "t.date >= date('now', ? || ' months')",
        "strftime('%Y-%m', t.date) IS NOT NULL",
        "COALESCE(p.exclude_from_totals, c.exclude_from_totals, 0) = 0",
        """(
            CASE COALESCE(p.category_type, c.category_type)
              WHEN 'income' THEN t.amount < 0
              ELSE               t.amount > 0
            END
        )""",
    ]
    params = [f"-{months}"]

    _append_effective_account_filter(clauses, params, account_id=account_id, account_ids=account_ids)

    if group_id:
        clauses.append("(c.parent_id = ? OR (c.parent_id IS NULL AND c.id = ?))")
        params.extend([group_id, group_id])

    where = "WHERE " + " AND ".join(clauses)

    if group_id:
        # Drill-down switches the series identity from top-level groups to the group's leaf categories without
        # changing the payload shape, so the trends UI can reuse one charting pipeline for both levels.
        select_id   = "COALESCE(c.id,    'uncategorized') AS series_id"
        select_name = "COALESCE(c.name,  'Uncategorized') AS series_name"
        select_col  = "NULL                                AS series_color"
        select_type = "NULL                                AS series_category_type"
        join        = "LEFT JOIN category c ON c.id = t.category_id"
    else:
        select_id   = "COALESCE(p.id,    c.id,    'uncategorized') AS series_id"
        select_name = "COALESCE(p.name,  c.name,  'Uncategorized') AS series_name"
        select_col  = "NULL                                          AS series_color"
        select_type = "COALESCE(p.category_type, c.category_type)  AS series_category_type"
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
