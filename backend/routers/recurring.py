# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: GPL-3.0-or-later

"""
Recurring transaction series — detection, listing, and curation.

Detection lives in `services/recurring_detection.py`; this router is the API surface over the
`recurring_series` table. A scan is on-demand and idempotent (see the service): it rewrites
auto+unconfirmed series while preserving the user's manual, confirmed, and suppressed ones. Curation
actions here are what make a series "user-owned" so the next scan won't overwrite or re-propose it:
confirm (accept an auto series), suppress ("this is not recurring"), edit (adjust cadence/category/
amount), and manual create (from a transaction the detector missed).
"""

from __future__ import annotations

import sqlite3
import uuid
from datetime import date, timedelta
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.db.database import get_db
from backend.services.recurring_detection import (
    CADENCES,
    link_series_members,
    maybe_auto_scan,
    scan_and_store,
)

router = APIRouter()

_CADENCE_DAYS = {name: int(round(days)) for name, days in CADENCES}


def _serialize(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "payee_key": row["payee_key"],
        "display_name": row["display_name"],
        "category_id": row["category_id"],
        "category_name": row["category_name"] if "category_name" in row.keys() else None,
        "account_id": row["account_id"],
        "account_name": row["account_name"] if "account_name" in row.keys() else None,
        "cadence": row["cadence"],
        "period_days": row["period_days"],
        "expected_amount": row["expected_amount"],
        "amount_min": row["amount_min"],
        "amount_max": row["amount_max"],
        "last_txn_date": row["last_txn_date"],
        "next_due_date": row["next_due_date"],
        "occurrence_count": row["occurrence_count"],
        "confidence": row["confidence"],
        "status": row["status"],
        "source": row["source"],
        "rule_id": row["rule_id"] if "rule_id" in row.keys() else None,
        "confirmed": bool(row["confirmed"]),
        # A series whose category (or its parent group) is exclude_from_totals is "money movement" — a
        # transfer or a credit-card payment, not spending/income. Surfaced with a marker and clustered
        # together rather than mixed in with bills.
        "money_movement": bool(row["excluded_from_totals"]) if "excluded_from_totals" in row.keys() else False,
    }


def _fetch(conn: sqlite3.Connection, series_id: str) -> sqlite3.Row:
    row = conn.execute(
        """
        SELECT s.*, c.name AS category_name, a.display_name AS account_name,
               COALESCE(pc.exclude_from_totals, c.exclude_from_totals, 0) AS excluded_from_totals
        FROM   recurring_series s
        LEFT   JOIN category c  ON c.id = s.category_id
        LEFT   JOIN category pc ON pc.id = c.parent_id
        LEFT   JOIN account  a  ON a.id = s.account_id
        WHERE  s.id = ?
        """,
        (series_id,),
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Recurring series not found")
    return row


@router.get("")
def list_series(include_suppressed: bool = False):
    """All recurring series, most-active first. Suppressed series are hidden unless asked for (they are
    the 'not recurring' rejections, kept only so detection won't re-propose them)."""
    with get_db() as conn:
        where = "" if include_suppressed else "WHERE s.status != 'suppressed'"
        rows = conn.execute(
            f"""
            SELECT s.*, c.name AS category_name, a.display_name AS account_name,
                   COALESCE(pc.exclude_from_totals, c.exclude_from_totals, 0) AS excluded_from_totals
            FROM   recurring_series s
            LEFT   JOIN category c  ON c.id = s.category_id
            LEFT   JOIN category pc ON pc.id = c.parent_id
            LEFT   JOIN account  a  ON a.id = s.account_id
            {where}
            ORDER BY s.next_due_date IS NULL, s.next_due_date, s.confidence DESC
            """
        ).fetchall()
        return {"series": [_serialize(r) for r in rows]}


@router.post("/scan")
def scan(window_months: int = 25):
    """Re-run detection over the recent window and rebuild auto series (idempotent)."""
    if window_months < 1 or window_months > 120:
        raise HTTPException(status_code=400, detail="window_months must be between 1 and 120")
    with get_db() as conn:
        summary = scan_and_store(conn, window_months=window_months)
    return summary


@router.post("/auto-scan")
def auto_scan(window_months: int = 25):
    """App-load catch-up: scan only if one is due — never scanned (e.g. a database migrated from a
    pre-recurring schema, or a fresh restore) or the last scan is stale. A cheap no-op when a recent
    import/sync already scanned, so it's safe to call unconditionally on every app load."""
    if window_months < 1 or window_months > 120:
        raise HTTPException(status_code=400, detail="window_months must be between 1 and 120")
    with get_db() as conn:
        return maybe_auto_scan(conn, window_months=window_months)


@router.post("/{series_id}/confirm")
def confirm_series(series_id: str):
    """Accept an auto-detected series. Marks it user-owned so future scans leave it alone."""
    with get_db() as conn:
        _fetch(conn, series_id)
        conn.execute(
            "UPDATE recurring_series SET confirmed = 1, status = 'active', updated_at = datetime('now') WHERE id = ?",
            (series_id,),
        )
        return _serialize(_fetch(conn, series_id))


def _clear_backing_rule_flag(conn: sqlite3.Connection, series: sqlite3.Row) -> None:
    """A rule-backed series' 'recurring' checkbox lives on its rule. Suppress and delete both mean 'this
    isn't a series', so they clear that flag — otherwise the rule would keep re-declaring the series on the
    next scan. (End deliberately does NOT clear it, so a resubscribe can resume the series.) If clearing the
    flag leaves the rule with no action at all (a recurring-only rule), the rule is dead weight, so it is
    removed — matching the 'a rule must do something' invariant the rule create/update guards enforce."""
    if not (series["source"] == "rule" and series["rule_id"]):
        return
    rid = series["rule_id"]
    conn.execute("UPDATE category_rule SET is_recurring = 0 WHERE id = ?", (rid,))
    r = conn.execute("SELECT category_id, clean_name FROM category_rule WHERE id = ?", (rid,)).fetchone()
    has_tag = conn.execute("SELECT 1 FROM rule_tag WHERE rule_id = ? LIMIT 1", (rid,)).fetchone()
    if r and r["category_id"] is None and not (r["clean_name"] or "").strip() and not has_tag:
        conn.execute("DELETE FROM rule_tag WHERE rule_id = ?", (rid,))
        conn.execute("DELETE FROM category_rule WHERE id = ?", (rid,))


@router.post("/{series_id}/suppress")
def suppress_series(series_id: str):
    """Mark a series 'not recurring'. It stays recorded (so detection won't re-propose it) but owns no
    transactions and drops out of the default list. For a rule-backed series this also unchecks the rule's
    recurring flag and removes the series outright — there is nothing for detection to re-propose, so the
    'kept as a rejection' rationale doesn't apply."""
    with get_db() as conn:
        series = _fetch(conn, series_id)
        if series["source"] == "rule":
            _clear_backing_rule_flag(conn, series)
            conn.execute("UPDATE txn SET recurring_series_id = NULL WHERE recurring_series_id = ?", (series_id,))
            conn.execute("DELETE FROM recurring_series WHERE id = ?", (series_id,))
            return {"ok": True, "deleted": True}
        conn.execute(
            "UPDATE recurring_series SET status = 'suppressed', updated_at = datetime('now') WHERE id = ?",
            (series_id,),
        )
        conn.execute("UPDATE txn SET recurring_series_id = NULL WHERE recurring_series_id = ?", (series_id,))
        return _serialize(_fetch(conn, series_id))


@router.post("/{series_id}/end")
def end_series(series_id: str):
    """Mark a series ended/canceled: it stops going forward (drops out of forecasts) but is kept as
    history with its transactions still linked, and — unlike suppress — is NOT blocked from re-detection.
    Resubscribing (a charge on/after the projected next date) reactivates it on the next scan."""
    with get_db() as conn:
        _fetch(conn, series_id)
        conn.execute(
            "UPDATE recurring_series SET status = 'ended', confirmed = 1, updated_at = datetime('now') WHERE id = ?",
            (series_id,),
        )
        return _serialize(_fetch(conn, series_id))


@router.post("/{series_id}/restore")
def restore_series(series_id: str):
    """Reactivate a suppressed or ended series (back to active, user-owned). Membership is repopulated
    on the next scan."""
    with get_db() as conn:
        _fetch(conn, series_id)
        conn.execute(
            "UPDATE recurring_series SET status = 'active', confirmed = 1, updated_at = datetime('now') WHERE id = ?",
            (series_id,),
        )
        return _serialize(_fetch(conn, series_id))


class SeriesUpdate(BaseModel):
    display_name: Optional[str] = None
    cadence: Optional[str] = None
    category_id: Optional[str] = None
    expected_amount: Optional[float] = None


@router.patch("/{series_id}")
def update_series(series_id: str, body: SeriesUpdate):
    """Edit a series. Any edit marks it user-owned (confirmed) so the scan preserves the user's intent."""
    with get_db() as conn:
        existing = _fetch(conn, series_id)
        cadence = existing["cadence"]
        period_days = existing["period_days"]
        if body.cadence is not None:
            if body.cadence not in _CADENCE_DAYS:
                raise HTTPException(status_code=400, detail=f"Unknown cadence '{body.cadence}'")
            cadence = body.cadence
            period_days = _CADENCE_DAYS[cadence]

        category_id = body.category_id if body.category_id is not None else existing["category_id"]
        if category_id is not None:
            cat = conn.execute("SELECT parent_id FROM category WHERE id = ?", (category_id,)).fetchone()
            if cat is None:
                raise HTTPException(status_code=400, detail="Category not found")
            if cat["parent_id"] is None:
                raise HTTPException(status_code=400, detail="A recurring series must target a leaf category, not a group")

        display_name = body.display_name if body.display_name is not None else existing["display_name"]
        expected_amount = body.expected_amount if body.expected_amount is not None else existing["expected_amount"]

        # Recompute the projected next date off the (possibly new) cadence and the last observed charge.
        next_due = existing["next_due_date"]
        last = existing["last_txn_date"]
        if last:
            try:
                next_due = (date.fromisoformat(str(last)[:10]) + timedelta(days=period_days)).isoformat()
            except ValueError:
                pass

        conn.execute(
            """
            UPDATE recurring_series
            SET display_name = ?, cadence = ?, period_days = ?, category_id = ?, expected_amount = ?,
                next_due_date = ?, confirmed = 1, status = 'active', updated_at = datetime('now')
            WHERE id = ?
            """,
            (display_name, cadence, period_days, category_id, expected_amount, next_due, series_id),
        )
        return _serialize(_fetch(conn, series_id))


class SeriesCreate(BaseModel):
    transaction_id: str
    cadence: str


@router.post("")
def create_series(body: SeriesCreate):
    """Manually declare a transaction's payee a recurring series (for series the detector missed).
    Seeds cadence/category/account/amount from the anchor transaction; membership fills on next scan."""
    if body.cadence not in _CADENCE_DAYS:
        raise HTTPException(status_code=400, detail=f"Unknown cadence '{body.cadence}'")
    period_days = _CADENCE_DAYS[body.cadence]
    with get_db() as conn:
        txn = conn.execute(
            """
            SELECT t.id, COALESCE(a.parent_account_id, t.account_id) AS effective_account_id,
                   t.category_id, t.amount, t.date, t.merchant_name, t.display_name, t.raw_name
            FROM   txn t JOIN account a ON a.id = t.account_id
            WHERE  t.id = ?
            """,
            (body.transaction_id,),
        ).fetchone()
        if txn is None:
            raise HTTPException(status_code=404, detail="Transaction not found")

        # Reuse the detector's name resolution + normalization so a manual series groups/matches (and is
        # labeled) like a detected one.
        from backend.services.recurring_detection import _normalize_payee, resolve_txn_name
        resolved = resolve_txn_name(txn["merchant_name"], txn["display_name"], txn["raw_name"])
        payee_key = _normalize_payee(resolved)
        if not payee_key:
            raise HTTPException(status_code=400, detail="Transaction has no usable payee name")

        display_name = resolved or payee_key
        amount = round(float(txn["amount"] or 0.0), 2)
        last = str(txn["date"])[:10]
        try:
            next_due = (date.fromisoformat(last) + timedelta(days=period_days)).isoformat()
        except ValueError:
            next_due = None

        series_id = str(uuid.uuid4())
        conn.execute(
            """
            INSERT INTO recurring_series
                (id, payee_key, display_name, category_id, account_id, cadence, period_days,
                 expected_amount, amount_min, amount_max, last_txn_date, next_due_date,
                 occurrence_count, confidence, status, source, confirmed, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1.0, 'active', 'manual', 1, datetime('now'))
            """,
            (
                series_id, payee_key, display_name, txn["category_id"], txn["effective_account_id"],
                body.cadence, period_days, amount, amount, amount, last, next_due,
            ),
        )
        # Link matching transactions and refresh stats now, so the new series shows its members
        # immediately rather than only after the next scan. This also folds in the anchor transaction.
        link_series_members(conn, series_id)
        return _serialize(_fetch(conn, series_id))


class MembershipOverride(BaseModel):
    transaction_id: str
    state: str  # 'pinned' | 'excluded' | 'clear'


@router.post("/{series_id}/membership")
def set_membership(series_id: str, body: MembershipOverride):
    """Surgically correct one transaction's membership in a series and make it stick across scans:
    - **pinned**  — force this row into the series even if it wouldn't match (a member the detector/rule
      missed). A transaction can be pinned to only one series, so any prior pin is replaced and the row is
      unlinked from wherever it currently sits before this series reclaims it.
    - **excluded** — keep this row out even though it matches (the detector grabbed one it shouldn't).
    - **clear**   — drop any override for this (transaction, series) pair.
    The override lives in its own table, so `reconcile_series` re-applies it on every scan. Membership is
    refreshed immediately via `link_series_members` so the change shows without waiting for a scan."""
    if body.state not in ("pinned", "excluded", "clear"):
        raise HTTPException(status_code=400, detail="state must be 'pinned', 'excluded', or 'clear'")
    with get_db() as conn:
        _fetch(conn, series_id)
        txn = conn.execute("SELECT id FROM txn WHERE id = ?", (body.transaction_id,)).fetchone()
        if txn is None:
            raise HTTPException(status_code=404, detail="Transaction not found")
        # Curating membership makes the series user-owned, like confirm/edit — otherwise an auto series is
        # deleted and re-minted with a new id on the next scan and the override (keyed by series id) dangles.
        conn.execute("UPDATE recurring_series SET confirmed = 1, updated_at = datetime('now') WHERE id = ?", (series_id,))
        if body.state == "clear":
            conn.execute(
                "DELETE FROM recurring_membership_override WHERE txn_id = ? AND series_id = ?",
                (body.transaction_id, series_id),
            )
        elif body.state == "pinned":
            # A pin is exclusive: drop any other pin for this row and detach it from its current series so
            # the target series can reclaim it (reconcile treats already-owned rows as off-limits).
            conn.execute("DELETE FROM recurring_membership_override WHERE txn_id = ? AND state = 'pinned'", (body.transaction_id,))
            conn.execute("UPDATE txn SET recurring_series_id = NULL WHERE id = ?", (body.transaction_id,))
            conn.execute(
                "INSERT OR REPLACE INTO recurring_membership_override (txn_id, series_id, state) VALUES (?, ?, 'pinned')",
                (body.transaction_id, series_id),
            )
        else:  # excluded
            conn.execute(
                "INSERT OR REPLACE INTO recurring_membership_override (txn_id, series_id, state) VALUES (?, ?, 'excluded')",
                (body.transaction_id, series_id),
            )
        link_series_members(conn, series_id)
        return _serialize(_fetch(conn, series_id))


@router.delete("/{series_id}")
def delete_series(series_id: str):
    """Delete a series outright. A detected series will simply reappear on the next scan; use suppress
    to make a rejection stick."""
    with get_db() as conn:
        series = _fetch(conn, series_id)
        # A rule-backed series' checkbox lives on the rule; deleting the series unchecks it so the rule
        # doesn't just re-mint the series on the next scan.
        _clear_backing_rule_flag(conn, series)
        # Unlink members first, then delete. Don't rely on the FK's ON DELETE action: on databases
        # created fresh the column has ON DELETE SET NULL, but on databases migrated to v4 the ALTER
        # added it as NO ACTION, so deleting a series that still has linked rows would raise a foreign-
        # key error there. Clearing membership up front makes delete work regardless of the FK action.
        conn.execute("UPDATE txn SET recurring_series_id = NULL WHERE recurring_series_id = ?", (series_id,))
        conn.execute("DELETE FROM recurring_series WHERE id = ?", (series_id,))
        return {"ok": True}
