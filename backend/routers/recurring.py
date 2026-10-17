# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

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

import json
import sqlite3
import uuid
from datetime import date, timedelta
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.db.database import get_db, single_runner
from backend.routers.rules import _trash_rule
from backend.services.recurring_detection import (
    AMOUNT_MODE_FIXED,
    AMOUNT_MODE_VARIABLE,
    CADENCES,
    COUNTERPART_SCOPE_ACCOUNT_SQL,
    SERIES_SCOPE_ACCOUNT_SQL,
    link_series_members,
    relink_rule_series,
    auto_scan_due,
    maybe_auto_scan,
    owe_full_recurring_scan,
    scan_and_store,
    settle_owed_rescans,
    transfer_review,
)
from backend.services.recurring_signals import (
    UPCOMING_HORIZON_DAYS,
    compute_signals,
    dismissed_signals,
)
from backend.services.signal_dismissals import dismiss, restore

router = APIRouter()

_CADENCE_DAYS = {name: int(round(days)) for name, days in CADENCES}


def _member_ids(row: sqlite3.Row) -> list[str] | None:
    """The stored membership snapshot as a list, or None where there is none to read. Unparseable JSON
    reads as absent rather than raising: the drill-down's fallback is a worse answer, not a broken one."""
    if "suppressed_member_ids" not in row.keys() or not row["suppressed_member_ids"]:
        return None
    try:
        ids = json.loads(row["suppressed_member_ids"])
    except (TypeError, ValueError):
        return None
    return [str(i) for i in ids] if isinstance(ids, list) else None


def _serialize(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "payee_key": row["payee_key"],
        "display_name": row["display_name"],
        "category_id": row["category_id"],
        "category_name": row["category_name"] if "category_name" in row.keys() else None,
        # The series' account *scope*, resolved to the group it belongs to now — so the account picker
        # (which lists top-level accounts) preselects the right one after a merge, and the UI agrees
        # with what the matcher actually scopes by. See `recurring_detection.SERIES_SCOPE_ACCOUNT_SQL`.
        "account_id": row["scope_account_id"] if "scope_account_id" in row.keys() else row["account_id"],
        "account_name": row["account_name"] if "account_name" in row.keys() else None,
        # A two-legged money movement: `account_id` is the paying side, this is the receiving side, and
        # the series owns BOTH legs of every occurrence. NULL on an ordinary payee series, which is what
        # tells the two apart wherever it matters. See `services/transfer_pairs.py`.
        "counterpart_account_id": (row["counterpart_scope_account_id"]
                                   if "counterpart_scope_account_id" in row.keys()
                                   else row["counterpart_account_id"]),
        "counterpart_account_name": (row["counterpart_account_name"]
                                     if "counterpart_account_name" in row.keys() else None),
        # How many times the money actually moved. Exact rather than an estimate: a movement contributes
        # its two legs and nothing else, so the rows are always twice the occurrences. `occurrence_count`
        # stays rows, because the number beside a link has to be what the link opens.
        "transfer_count": (row["occurrence_count"] // 2) if row["counterpart_account_id"] else None,
        "cadence": row["cadence"],
        "period_days": row["period_days"],
        "expected_amount": row["expected_amount"],
        "amount_min": row["amount_min"],
        "amount_max": row["amount_max"],
        # Whether amount is part of this series' identity, and the band the user pinned for it (null =
        # derived from amount_min/amount_max). See recurring_detection.py.
        "amount_mode": row["amount_mode"] if "amount_mode" in row.keys() else "variable",
        "expected_min": row["expected_min"] if "expected_min" in row.keys() else None,
        "expected_max": row["expected_max"] if "expected_max" in row.keys() else None,
        "last_txn_date": row["last_txn_date"],
        "next_due_date": row["next_due_date"],
        "occurrence_count": row["occurrence_count"],
        "confidence": row["confidence"],
        "status": row["status"],
        "source": row["source"],
        "rule_id": row["rule_id"] if "rule_id" in row.keys() else None,
        # The rows this series held at the moment it was suppressed. A suppressed series owns no
        # transactions — suppress nulls their `recurring_series_id`, because that column is the
        # app-wide "is recurring" flag and a rejected series must not light up the `↻` marker or the
        # recurring filter — so without this list nothing can say which rows it *was* about, and the
        # drill-down was left re-deriving them from the visible payee label. That could not agree with
        # the count beside it: membership is the detector's judgement (a rhythm fit, one charge per
        # date), not a predicate any query can restate. Null for an unsuppressed series and for one
        # suppressed before this was recorded, both of which fall back to matching.
        "suppressed_member_ids": _member_ids(row),
        "confirmed": bool(row["confirmed"]),
        # A series whose category (or its parent group) is exclude_from_totals is "money movement" — a
        # transfer or a credit-card payment, not spending/income. Surfaced with a marker and clustered
        # together rather than mixed in with bills.
        "money_movement": bool(row["excluded_from_totals"]) if "excluded_from_totals" in row.keys() else False,
    }


def _fetch(conn: sqlite3.Connection, series_id: str) -> sqlite3.Row:
    row = conn.execute(
        f"""
        SELECT s.*, {SERIES_SCOPE_ACCOUNT_SQL}, {COUNTERPART_SCOPE_ACCOUNT_SQL},
               c.name AS category_name, a.display_name AS account_name,
               cp.display_name AS counterpart_account_name,
               COALESCE(pc.exclude_from_totals, c.exclude_from_totals, 0) AS excluded_from_totals
        FROM   recurring_series s
        LEFT   JOIN category c  ON c.id = s.category_id
        LEFT   JOIN category pc ON pc.id = c.parent_id
        LEFT   JOIN account  a  ON a.id = s.account_id
        LEFT   JOIN account  cp ON cp.id = s.counterpart_account_id
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
            SELECT s.*, {SERIES_SCOPE_ACCOUNT_SQL}, {COUNTERPART_SCOPE_ACCOUNT_SQL},
                   c.name AS category_name, a.display_name AS account_name,
                   cp.display_name AS counterpart_account_name,
                   COALESCE(pc.exclude_from_totals, c.exclude_from_totals, 0) AS excluded_from_totals
            FROM   recurring_series s
            LEFT   JOIN category c  ON c.id = s.category_id
            LEFT   JOIN category pc ON pc.id = c.parent_id
            LEFT   JOIN account  a  ON a.id = s.account_id
            LEFT   JOIN account  cp ON cp.id = s.counterpart_account_id
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
    # App load in two tabs, or a reload while the first load's scan runs, would otherwise both find the
    # scan due and both run it.
    with get_db() as conn:
        if not auto_scan_due(conn):
            return {"skipped": True}
    with single_runner("recurring_auto_scan") as claimed:
        if not claimed:
            return {"skipped": True, "reason": "scan_in_progress"}
        with get_db() as conn:
            return maybe_auto_scan(conn, window_months=window_months)


@router.get("/transfer-review")
def transfer_review_route():
    """The pairings the detector refused to make — see `recurring_detection.transfer_review`. Only ties
    reach here: a movement itself needs no permission, it claims its rows outright. A tie is a genuine
    question, which is why it is a report rather than something the scan settles on its own."""
    with get_db() as conn:
        return transfer_review(conn)


class PairDecision(BaseModel):
    paying_txn_id: str
    receiving_txn_id: Optional[str] = None   # null = "no counterpart, stop asking"


@router.post("/transfer-review/pair")
def decide_pair(body: PairDecision):
    """Answer an ambiguous pairing: name the counterpart, or dismiss the question.

    The answer is taken as given from then on — the pairing pass applies it before it infers anything,
    because inference is precisely what was found wanting in the case that raised the question. A rescan
    follows so a named pair can join its movement immediately; where the payment does not recur, nothing
    visible changes and the recorded answer is the whole result.
    """
    with get_db() as conn:
        for txn_id in (body.paying_txn_id, body.receiving_txn_id):
            if txn_id and conn.execute("SELECT 1 FROM txn WHERE id = ?", (txn_id,)).fetchone() is None:
                raise HTTPException(status_code=404, detail="Transaction not found")
        conn.execute(
            "INSERT OR REPLACE INTO transfer_pair_decision (paying_txn_id, receiving_txn_id) VALUES (?, ?)",
            (body.paying_txn_id, body.receiving_txn_id or None),
        )
        owe_full_recurring_scan(conn)
    return {"ok": True, "scan": settle_owed_rescans()}


class RestoreDecision(BaseModel):
    paying_txn_id: str


@router.post("/transfer-review/restore")
def restore_decision(body: RestoreDecision):
    """Take back an answer to a tie, putting the question back in the report. The counterpart to every
    hiding action on this page — a decision made once should not be permanent just because it was
    made."""
    with get_db() as conn:
        conn.execute("DELETE FROM transfer_pair_decision WHERE paying_txn_id = ?", (body.paying_txn_id,))
        owe_full_recurring_scan(conn)
    return {"ok": True, "scan": settle_owed_rescans()}


# Signal routes are declared ahead of the `/{series_id}` ones so "signals" is never read as a series id.

@router.get("/signals")
def list_signals(horizon_days: int = UPCOMING_HORIZON_DAYS, include_dismissed: bool = False):
    """The open anomaly/forecast signals over the current series (see `services/recurring_signals.py`).
    Derived on read, so this is always consistent with the ledger as it stands rather than with whatever
    was true at the last import."""
    if horizon_days < 1 or horizon_days > 365:
        raise HTTPException(status_code=400, detail="horizon_days must be between 1 and 365")
    with get_db() as conn:
        return compute_signals(conn, horizon_days=horizon_days, include_dismissed=include_dismissed)


@router.get("/signals/dismissed")
def list_dismissed_signals(horizon_days: int = UPCOMING_HORIZON_DAYS):
    """The signals a dismissal is currently hiding — what the review surface offers to bring back."""
    with get_db() as conn:
        return {"signals": dismissed_signals(conn, horizon_days=horizon_days)}


class SignalDismissal(BaseModel):
    key: str
    kind: str = ""
    # "Fine this time": only an Amount changed finding has a usual amount to keep expecting.
    one_off: bool = False


@router.post("/signals/dismiss")
def dismiss_signal_route(body: SignalDismissal):
    """"Seen it, it's fine." Keyed by the signal's fingerprint, so the same finding stays dismissed
    across scans while a genuinely new one (a later missed date, a different charge) still surfaces."""
    if not (body.key or "").strip():
        raise HTTPException(status_code=400, detail="key is required")
    kind = (body.kind or "").strip()
    if body.one_off and kind != "price_change":
        raise HTTPException(status_code=400, detail="only an amount change can be dismissed as a one-off")
    with get_db() as conn:
        dismiss(conn, body.key.strip(), kind, one_off=body.one_off)
        return {"ok": True}


@router.post("/signals/restore")
def restore_signal_route(body: SignalDismissal):
    """Undo a dismissal — both the immediate toast and the dismissed list route here."""
    with get_db() as conn:
        restore(conn, (body.key or "").strip())
        return {"ok": True}


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


@router.post("/{series_id}/unconfirm")
def unconfirm_series(series_id: str):
    """Hand an accepted series back to the detector, so it returns to Suggested.

    The counterpart to `confirm`, and the answer to accepting one by mistake. Suppress and End were the
    only ways back, and both record a judgement the user may not want to make — "not recurring" and
    "this has stopped" are claims, where the wanted state is *no claim yet*.

    Only an **auto** series can go back: the pile it returns to is the detector's, so there has to be a
    detector candidate behind it. A `manual` series was created by hand and nothing would re-propose it
    (deleting it is the way out), and a `rule` series is declared by its rule's flag, which is where it
    is undeclared. Both are refused rather than silently doing nothing.

    No scan is needed for it to move: the Recurring page derives a card's bucket from `confirmed`/`status`,
    so clearing the flag returns it to Suggested at once. The next scan then re-derives it like any other
    candidate — which is also why a hand-pinned amount band does not survive this (the scan rewrites auto
    series wholesale); accepting again and re-pinning is the way back to it.
    """
    with get_db() as conn:
        series = _fetch(conn, series_id)
        if series["source"] != "auto":
            raise HTTPException(status_code=409, detail={
                "code": "not_auto_detected",
                "message": ("Only a detected series can go back to Suggested. Delete a manually created "
                            "one, or uncheck 'Recurring series' on the rule behind a rule-backed one."),
            })
        conn.execute(
            "UPDATE recurring_series SET confirmed = 0, status = 'active', updated_at = datetime('now') "
            "WHERE id = ?",
            (series_id,),
        )
        return _serialize(_fetch(conn, series_id))


def _clear_backing_rule_flag(conn: sqlite3.Connection, series: sqlite3.Row) -> None:
    """A rule-backed series' 'recurring' checkbox lives on its rule. Suppress and delete both mean 'this
    isn't a series', so they clear that flag — otherwise the rule would keep re-declaring the series on the
    next scan. (End deliberately does NOT clear it, so a resubscribe can resume the series.)

    A recurring-only rule would be left with no action at all — dead weight, against the 'a rule must do
    something' invariant the rule create/update guards enforce — so it goes to the **rules trash** instead,
    like any deleted rule, rather than being destroyed: its matcher, amount range and tags are the user's
    configuration. Its flag is left set, so restoring it from Settings → Trash re-creates the series."""
    if not (series["source"] == "rule" and series["rule_id"]):
        return
    rid = series["rule_id"]
    r = conn.execute("SELECT category_id, clean_name FROM category_rule WHERE id = ?", (rid,)).fetchone()
    has_tag = conn.execute("SELECT 1 FROM rule_tag WHERE rule_id = ? LIMIT 1", (rid,)).fetchone()
    if r and r["category_id"] is None and not (r["clean_name"] or "").strip() and not has_tag:
        _trash_rule(conn, rid)
    else:
        conn.execute("UPDATE category_rule SET is_recurring = 0 WHERE id = ?", (rid,))


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
            # Its rows go to another recurring rule that matches them, if any.
            relink_rule_series(conn)
            return {"ok": True, "deleted": True}
        # Record which rows it held *before* dropping the links, because after this they are
        # unrecoverable: membership is the detector's judgement — a periodicity fit over one charge per
        # date — and no later query can restate it. Without the snapshot the drill-down had to guess from
        # the visible payee label, which disagreed with the count in both directions at once: a series
        # whose members were spelled inconsistently matched almost none of them, while one whose payee
        # also had unrelated charges matched far too many. A transfer series is the case that most needs
        # it: its members are spread over two accounts and two descriptors, so nothing about the label
        # could recover them at all.
        members = [r["id"] for r in conn.execute(
            "SELECT id FROM txn WHERE recurring_series_id = ? ORDER BY date, id", (series_id,)
        ).fetchall()]
        conn.execute(
            "UPDATE recurring_series SET status = 'suppressed', suppressed_member_ids = ?, "
            "updated_at = datetime('now') WHERE id = ?",
            (json.dumps(members), series_id),
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
        # The snapshot goes with the suppression that took it. A restored series owns rows again from the
        # next scan, so a stale list would send the drill-down to a frozen set while the card counted the
        # live one — the same disagreement this exists to remove, pointing the other way.
        conn.execute(
            "UPDATE recurring_series SET status = 'active', confirmed = 1, suppressed_member_ids = NULL, "
            "updated_at = datetime('now') WHERE id = ?",
            (series_id,),
        )
        return _serialize(_fetch(conn, series_id))


class SeriesUpdate(BaseModel):
    display_name: Optional[str] = None
    cadence: Optional[str] = None
    category_id: Optional[str] = None
    expected_amount: Optional[float] = None
    # Amount matching. `amount_mode` turns the gate on or off; the band is what it matches within, and
    # `clear_expected_band` is how a pinned band is retracted back to the derived one — a null bound
    # cannot say that on its own, since null is also "leave this field alone" for every other edit here.
    amount_mode: Optional[str] = None
    expected_min: Optional[float] = None
    expected_max: Optional[float] = None
    clear_expected_band: bool = False


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

        amount_mode = existing["amount_mode"]
        if body.amount_mode is not None:
            if body.amount_mode not in (AMOUNT_MODE_FIXED, AMOUNT_MODE_VARIABLE):
                raise HTTPException(status_code=400, detail=f"Unknown amount mode '{body.amount_mode}'")
            amount_mode = body.amount_mode

        # A pinned band is retracted explicitly, not by sending nulls: every other field here reads null
        # as "unchanged", so the clear needs its own flag to mean something different.
        if body.clear_expected_band:
            expected_min = expected_max = None
        else:
            expected_min = body.expected_min if body.expected_min is not None else existing["expected_min"]
            expected_max = body.expected_max if body.expected_max is not None else existing["expected_max"]
        if expected_min is not None and expected_max is not None and expected_min > expected_max:
            expected_min, expected_max = expected_max, expected_min
        if (expected_min is None) != (expected_max is None):
            raise HTTPException(status_code=400, detail="A pinned amount band needs both bounds, or neither")

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
                amount_mode = ?, expected_min = ?, expected_max = ?,
                next_due_date = ?, confirmed = 1, status = 'active', updated_at = datetime('now')
            WHERE id = ?
            """,
            (display_name, cadence, period_days, category_id, expected_amount,
             amount_mode, expected_min, expected_max, next_due, series_id),
        )
        # Amount matching decides which rows the series owns, so a change to it has to re-run membership
        # rather than wait for the next scan — otherwise the card keeps reporting the old members and the
        # edit reads as having done nothing.
        link_series_members(conn, series_id)
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
                 expected_amount, amount_min, amount_max, amount_mode, last_txn_date, next_due_date,
                 occurrence_count, confidence, status, source, confirmed, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'variable', ?, ?, 1, 1.0, 'active', 'manual', 1, datetime('now'))
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
    state: str  # 'excluded' | 'clear'


@router.post("/{series_id}/membership")
def set_membership(series_id: str, body: MembershipOverride):
    """Surgically correct one transaction's membership in a series and make it stick across scans:
    - **excluded** — keep this row out even though it matches (the detector grabbed one it shouldn't).
    - **clear**   — drop any override for this (transaction, series) pair.
    The override lives in its own table, so `reconcile_series` re-applies it on every scan. Membership is
    refreshed immediately via `link_series_members` so the change shows without waiting for a scan.

    There is deliberately no way to force a row *in*. A series is defined by what recurs, so a charge
    that merely shares a payee and category with one — a late fee on a tax payment, say — is not part of
    it, and pinning it in would misrepresent the series and every total read from it. A row that ought to
    belong and does not is a matching problem: correct the name, or widen the rule."""
    if body.state not in ("excluded", "clear"):
        raise HTTPException(status_code=400, detail="state must be 'excluded' or 'clear'")
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
        if series["source"] == "rule":
            # Its rows go to another recurring rule that matches them, if any.
            relink_rule_series(conn)
        return {"ok": True}
