"""
transactions.py — Transaction list and summary endpoints

FILTERING DESIGN:
  Most endpoints accept both a legacy `month` param (YYYY-MM) and newer
  `date_start`/`date_end` params (YYYY-MM-DD). The date range params take
  precedence. When neither is supplied, no date constraint is applied (all time).
  This lets the dashboard show all-time totals by default while the global
  filter bar can pass an explicit range.

MULTI-FILTER PARAMS:
  The list endpoint accepts several comma/pipe-separated multi-value params:
    account_ids   — comma-separated account IDs (OR'd)
    group_ids     — comma-separated group IDs; matches all child categories
    category_ids  — comma-separated leaf category IDs
    payees        — pipe-separated payee names (exact match on merchant_name OR raw_name)
  These are AND'd together (must match all supplied filters).
  The singular account_id/category_id params remain for backwards compatibility.

SENTINEL VALUES for category_id:
  '__uncategorized__'  — matches transactions with no category assigned
  '__group__{id}'      — matches all transactions in any child category of group {id}
  A plain UUID         — matches that specific leaf category

CATEGORY-IN-GROUP QUERY NOTE:
  The by-category-in-group endpoint uses a subquery rather than a JOIN filter
  to restrict to the group's categories:
    t.category_id IN (SELECT id FROM category WHERE parent_id = ? OR id = ?)
  Using a JOIN filter instead would silently exclude NULL category_id rows
  (uncategorized transactions) because NULL comparisons always evaluate false.

SUMMARY ENDPOINTS:
  /summary/by-group              — totals per top-level group
  /summary/by-category-in-group  — totals per leaf category within one group
  /summary/by-category           — totals per leaf category (flat)
  /summary/monthly-trend         — per-month totals, optionally filtered by category/payee
  /summary/monthly-by-group      — per-month totals broken down by group (for Trends view)
"""

"""
transactions.py — Transaction list and summary endpoints.

DESIGN PRINCIPLES:
- All summary endpoints (by-group, by-category-in-group, etc.) accept both
  a `month` param (YYYY-MM) and `date_start`/`date_end` params (YYYY-MM-DD).
  When a global date filter is active in the UI, date_start/date_end are used.
  When no filter is set, all params are omitted and the query returns all-time data.
- Multi-select filters (account_ids, group_ids, category_ids, payees) are passed
  as comma-separated strings. The backend splits and builds IN() clauses.
  account_id (singular) is kept for backwards compatibility with direct API calls.
- The category hierarchy is two levels. Filtering by group uses a subquery:
    t.category_id IN (SELECT id FROM category WHERE parent_id = ?)
  rather than a JOIN filter, so that the LEFT JOIN used for display fields
  doesn't accidentally exclude transactions from the result set.
- SQLite reserved word: the table is named `txn`, not `transaction`.
- Pending transactions (is_pending=1) are excluded from all summary queries
  but included in the raw transaction list so users can see them.
"""
from fastapi import APIRouter, Query, HTTPException
from pydantic import BaseModel
from typing import Optional
from db.database import get_db

router = APIRouter()


class CategoryOverride(BaseModel):
    category_id: str
    notes: Optional[str] = None


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
    """
    Unified transaction list across all accounts.
    Filter by month (YYYY-MM), account, category, or free-text search.
    """
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
    if account_ids:
        ids = [i.strip() for i in account_ids.split(',') if i.strip()]
        placeholders = ','.join('?' * len(ids))
        clauses.append(f"t.account_id IN ({placeholders})")
        params.extend(ids)
    elif account_id:
        clauses.append("t.account_id = ?")
        params.append(account_id)
    if category_id == "__uncategorized__":
        clauses.append("t.category_id IS NULL")
    elif category_id and category_id.startswith("__group__"):
        # Filter by all categories whose parent = this group
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
        or_clauses = ' OR '.join(
            ['(t.display_name = ? OR t.merchant_name = ? OR t.raw_name = ?)'] * len(names)
        )
        clauses.append(f"({or_clauses})")
        for n in names:
            params.extend([n, n, n])
    if owner_ids:
        ids = [i.strip() for i in owner_ids.split(',') if i.strip()]
        # Support 'unassigned' sentinel for transactions with no owner
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
                t.account_id,
                t.owner_id,
                a.name        AS account_name,
                a.mask        AS account_mask,
                t.category_id,
                c.name        AS category_name,
                c.color       AS category_color,
                o.name        AS owner_name,
                o.color       AS owner_color
            FROM   txn t
            JOIN   account  a ON a.id = t.account_id
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
    """Manually set a category, marking it as overridden."""
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
    """Manually set the display merchant name on a transaction."""
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
    """Set or clear a note on a transaction."""
    notes = body.get("notes", "")
    notes = notes.strip() if notes else None
    with get_db() as conn:
        conn.execute("UPDATE txn SET notes = ? WHERE id = ?", (notes, txn_id))
    return {"ok": True}


@router.patch("/{txn_id}/uncategorize")
def clear_override(txn_id: str):
    """Remove manual override so auto-categorization can run again."""
    with get_db() as conn:
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
    """Monthly spending totals grouped by category."""
    clauses = ["t.date LIKE ?", "t.amount > 0", "t.is_pending = 0"]
    params  = [f"{month}%"]

    if account_ids:
        ids = [i.strip() for i in account_ids.split(',') if i.strip()]
        placeholders = ','.join('?' * len(ids))
        clauses.append(f"t.account_id IN ({placeholders})")
        params.extend(ids)
    elif account_id:
        clauses.append("t.account_id = ?")
        params.append(account_id)

    where = "WHERE " + " AND ".join(clauses)

    with get_db() as conn:
        rows = conn.execute(
            f"""
            SELECT
                COALESCE(c.id,    'uncategorized') AS category_id,
                COALESCE(c.name,  'Uncategorized') AS category_name,
                COALESCE(c.color, '#9E9E9E')       AS category_color,
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
    """Monthly spending rolled up to top-level category groups."""
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

    if account_ids:
        ids = [i.strip() for i in account_ids.split(',') if i.strip()]
        placeholders = ','.join('?' * len(ids))
        clauses.append(f"t.account_id IN ({placeholders})")
        params.extend(ids)
    elif account_id:
        clauses.append("t.account_id = ?")
        params.append(account_id)
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

    # Category-owner filter (used by Dashboard — filters on the group's owner_id)
    # NULL category owner is treated as Shared and always included when filtering
    if category_owner_ids:
        ids = [i.strip() for i in category_owner_ids.split(',') if i.strip()]
        placeholders = ','.join('?' * len(ids))
        clauses.append(
            f"(COALESCE(p.id, c.id) IS NULL OR "
            f"COALESCE(p.owner_id, c.owner_id) IS NULL OR "
            f"COALESCE(p.owner_id, c.owner_id) IN ({placeholders}))"
        )
        params.extend(ids)

    where = "WHERE " + " AND ".join(clauses)

    with get_db() as conn:
        rows = conn.execute(
            f"""
            SELECT
                COALESCE(p.id,              c.id,              'uncategorized') AS group_id,
                COALESCE(p.name,            c.name,            'Uncategorized') AS group_name,
                COALESCE(p.color,           c.color,           '#9E9E9E')       AS group_color,
                COALESCE(p.owner_id,        c.owner_id)                          AS group_owner_id,
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
    """Monthly spending by category within a specific group."""
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

    # Filter to categories that belong to this group (children or the group itself)
    # Use a subquery so uncategorized txns don't slip through the LEFT JOIN filter
    clauses.append(
        "t.category_id IN (SELECT id FROM category WHERE parent_id = ? OR id = ?)"
    )
    params.extend([group_id, group_id])

    if account_ids:
        ids = [i.strip() for i in account_ids.split(',') if i.strip()]
        placeholders = ','.join('?' * len(ids))
        clauses.append(f"t.account_id IN ({placeholders})")
        params.extend(ids)
    elif account_id:
        clauses.append("t.account_id = ?")
        params.append(account_id)

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
                COALESCE(c.color, '#9E9E9E')       AS category_color,
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
    """Spending per month, optionally filtered by category or payee.
    When filtering by payee, uses date_start/date_end from the active filter
    (or all history if no date filter is set). Otherwise uses the months window."""

    if payee:
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

    if account_ids:
        ids = [i.strip() for i in account_ids.split(',') if i.strip()]
        placeholders = ','.join('?' * len(ids))
        clauses.append(f"t.account_id IN ({placeholders})")
        params.extend(ids)
    elif account_id:
        clauses.append("t.account_id = ?")
        params.append(account_id)

    if date_start:
        clauses.append("t.date >= ?")
        params.append(date_start)
    if date_end:
        clauses.append("t.date <= ?")
        params.append(date_end)

    if not date_start and not date_end and not payee and not account_id and not account_ids:
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
    """
    Monthly spending totals for the last N months, broken down by group
    (or by category within a group if group_id supplied).
    Returns rows of { month, group_id/category_id, name, color, total }.
    """
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

    if account_ids:
        ids = [i.strip() for i in account_ids.split(',') if i.strip()]
        placeholders = ','.join('?' * len(ids))
        clauses.append(f"t.account_id IN ({placeholders})")
        params.extend(ids)
    elif account_id:
        clauses.append("t.account_id = ?")
        params.append(account_id)

    if group_id:
        clauses.append("(c.parent_id = ? OR (c.parent_id IS NULL AND c.id = ?))")
        params.extend([group_id, group_id])

    where = "WHERE " + " AND ".join(clauses)

    if group_id:
        select_id   = "COALESCE(c.id,    'uncategorized') AS series_id"
        select_name = "COALESCE(c.name,  'Uncategorized') AS series_name"
        select_col  = "COALESCE(c.color, '#9E9E9E')       AS series_color"
        select_type = "NULL                                AS series_category_type"
        join        = "LEFT JOIN category c ON c.id = t.category_id"
    else:
        select_id   = "COALESCE(p.id,    c.id,    'uncategorized') AS series_id"
        select_name = "COALESCE(p.name,  c.name,  'Uncategorized') AS series_name"
        select_col  = "COALESCE(p.color, c.color, '#9E9E9E')       AS series_color"
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
