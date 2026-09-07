# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Charges an amount-gated rule nearly claimed, or only just claimed.

**An amount range on a rule is a matching gate**, which is what makes drift expensive. The user's actual
use of a range is disambiguation — separating several bills from one biller by size — so when a bill
grows past the bound the row simply stops matching: it loses the rule's category, and with it the place
in that rule's series the category was what earned. Nothing else in the app notices, because nothing is
broken. The row is categorized, just not the way it was meant to be. So the finding worth reporting is
the charge that missed a bound by a little, with the still-inside-but-near-the-edge case as the same
warning one occurrence earlier.

**These are findings about the rule set, not about a series**, which is why they live here and are
surfaced on the Rules page rather than with the recurring signals they were first written beside. Both
actions they offer — widen the bound, or open the rule editor — edit a rule, and `_load_ranged_rules`
never required the rule to have a series at all. What happens to the series follows on its own: widening
re-applies the rule, the row takes the rule's category back, and the detector claims it into the series
on its next pass, since membership gates on payee and category (`recurring_detection`).

**Derived on read, never stored.** A finding written down at import time goes stale the moment the user
edits the rule, recategorizes the row, or trashes it; recomputing costs one pass over a bounded window
of recent rows and is self-healing. The only durable state is a dismissal, kept in the store shared with
the recurring signals (`signal_dismissals.py`) and keyed by rule and transaction, so acknowledging one
charge says nothing about the next.

**A dismissal does not consume the per-rule cap.** The cap exists so a broad keyword with a tight range
cannot say "this range is wrong" thirty times, but it counts findings actually shown: dismissing the
three on screen would otherwise silence the rule entirely while further drifted charges sat behind them.
"""

from __future__ import annotations

import sqlite3
from datetime import date, timedelta

from backend.services import signal_dismissals
from backend.services.categorizer import rule_matches_row

# A charge that misses a bound by less than this was probably meant to match — the range has drifted,
# not the charge. A charge *inside* the range but this close to a bound is the same warning one
# occurrence earlier.
NEAR_FRACTION = 0.25
EDGE_FRACTION = 0.10
# Only recent rows are actionable: a range that drifted two years ago is history, not a task.
WINDOW_DAYS = 90
# At most this many open findings per rule (most recent first). A broad keyword with a tight range could
# otherwise produce a wall of near-misses that says one thing — "this range is wrong" — a hundred times.
PER_RULE_CAP = 3

SEVERITY_WARNING = "warning"
SEVERITY_INFO = "info"

KIND_OUTSIDE = "rule_range"
KIND_EDGE = "rule_range_edge"
KINDS = (KIND_OUTSIDE, KIND_EDGE)


def _load_ranged_rules(conn: sqlite3.Connection) -> list[dict]:
    """User-authored rules that gate on amount. App-managed rules are excluded: their bounds are the
    app's, not the user's, so there is nothing here for the user to maintain."""
    rows = conn.execute(
        """
        SELECT cr.id, cr.category_id, cr.keyword, cr.match_expr, cr.amount_min, cr.amount_max,
               cr.debit_credit, cr.clean_name, cr.owner_id, cr.account_id, cr.account_type,
               cr.match_source_text, c.name AS category_name,
               s.id AS series_id, s.display_name AS series_name
        FROM   category_rule cr
        LEFT   JOIN category c ON c.id = cr.category_id
        LEFT   JOIN recurring_series s ON s.rule_id = cr.id
        WHERE  cr.deleted_at IS NULL
          AND  cr.is_managed = 0
          AND  (cr.amount_min IS NOT NULL OR cr.amount_max IS NOT NULL)
        """
    ).fetchall()
    return [dict(r) for r in rows]


def _load_recent_rows(conn: sqlite3.Connection, window_days: int) -> list[sqlite3.Row]:
    """Recent live rows carrying exactly the columns the shared rule matcher reads, so a near-miss is
    decided by the same predicate that decides a match."""
    cutoff = (date.today() - timedelta(days=window_days)).isoformat()
    return conn.execute(
        """
        SELECT t.id, t.date, t.amount, t.category_id, t.owner_id, t.recurring_series_id,
               t.merchant_name, t.display_name, t.raw_name, t.import_evidence_json,
               COALESCE(a.parent_account_id, t.account_id) AS effective_account_id,
               COALESCE(p.type, a.type) AS effective_account_type,
               c.name AS current_category_name
        FROM   txn t
        JOIN   account a ON a.id = t.account_id
        LEFT   JOIN account  p ON p.id = a.parent_account_id
        LEFT   JOIN category c ON c.id = t.category_id
        WHERE  t.trashed_at IS NULL AND t.is_pending = 0 AND t.date >= ?
        ORDER  BY t.date DESC
        """,
        (cutoff,),
    ).fetchall()


def _range_proximity(amount: float, amount_min, amount_max):
    """Where an amount sits relative to a rule's bounds: which bound is in play, whether the amount is
    inside the range, and how far off it is as a fraction of that bound. Bounds are compared against the
    absolute amount, matching `categorizer._amount_rule_matches`."""
    if amount_min is not None and amount < amount_min:
        return "min", False, (amount_min - amount) / amount_min if amount_min else None
    if amount_max is not None and amount > amount_max:
        return "max", False, (amount - amount_max) / amount_max if amount_max else None
    # Inside: report the nearer bound, as a fraction of that bound's own size.
    best = None
    if amount_min is not None and amount_min > 0:
        best = ("min", True, (amount - amount_min) / amount_min)
    if amount_max is not None and amount_max > 0:
        slack = (amount_max - amount) / amount_max
        if best is None or slack < best[2]:
            best = ("max", True, slack)
    return best if best is not None else (None, True, None)


def _finding(rule: dict, row: sqlite3.Row, kind: str, severity: str, bound: str, distance: float) -> dict:
    return {
        "kind": kind,
        "key": f"{kind}:{rule['id']}:{row['id']}",
        "severity": severity,
        "dismissible": True,
        "dismissed": False,
        # The rule is named by id alone, as the overlap findings are: the endpoint returns each
        # referenced rule once, in the shape the rules list uses, so the panel renders it the way the
        # list does rather than from a second, thinner copy of the same facts.
        "rule_id": rule["id"],
        "amount_min": rule["amount_min"],
        "amount_max": rule["amount_max"],
        "bound": bound,
        "percent": round(distance * 100, 1),
        "txn_id": row["id"],
        "txn_date": row["date"],
        "txn_name": row["display_name"] or row["merchant_name"] or row["raw_name"],
        "amount": round(float(row["amount"] or 0.0), 2),
        "current_category_name": row["current_category_name"],
        # Display only, and the reason the finding matters beyond one category: a rule that feeds a
        # series takes the charge out of that series too. There is nothing to navigate to from here —
        # the fix is the rule either way — so the name is carried and the id is not.
        "series_name": rule["series_name"],
    }


def find_range_drift(conn: sqlite3.Connection, *, include_dismissed: bool = False) -> dict:
    """Every charge a ranged rule nearly claimed, as `{count, counts, dismissed_count, findings}` — the
    same shape `rule_overlaps.find_rule_overlaps` returns, since one panel presents both.

    Dismissed findings are excluded and counted in `dismissed_count`; `include_dismissed` brings them
    back carrying `dismissed: True`, which is what the panel's "show dismissed" toggle asks for.
    """
    rules = _load_ranged_rules(conn)
    if not rules:
        return {"count": 0, "counts": {}, "dismissed_count": 0, "findings": []}

    rows = _load_recent_rows(conn, WINDOW_DAYS)
    dismissed_keys = signal_dismissals.dismissed_keys(conn)
    findings: list[dict] = []
    dismissed_count = 0

    for rule in rules:
        relaxed = {**rule, "amount_min": None, "amount_max": None}
        open_emitted = 0
        for row in rows:
            if open_emitted >= PER_RULE_CAP:
                break
            # Distance to the bound is arithmetic and rules out almost every row; the merchant match is
            # string work over three name fields. Cheapest discriminating test first.
            amount = abs(float(row["amount"] or 0.0))
            bound, inside, distance = _range_proximity(amount, rule["amount_min"], rule["amount_max"])
            if bound is None or distance is None:
                continue
            if inside:
                if distance > EDGE_FRACTION:
                    continue
                kind, severity = KIND_EDGE, SEVERITY_INFO
            else:
                if distance > NEAR_FRACTION:
                    continue
                kind, severity = KIND_OUTSIDE, SEVERITY_WARNING
            # A row that already carries the rule's own category is not reported: whatever the range
            # says, nothing about that row went wrong.
            if rule["category_id"] is not None and row["category_id"] == rule["category_id"]:
                continue
            if rule["series_id"] and row["recurring_series_id"] == rule["series_id"]:
                continue
            if not rule_matches_row(relaxed, row):
                continue

            finding = _finding(rule, row, kind, severity, bound, distance)
            if finding["key"] in dismissed_keys:
                dismissed_count += 1
                if not include_dismissed:
                    continue
                finding["dismissed"] = True
            else:
                open_emitted += 1
            findings.append(finding)

    # Warnings first, then the most recent charge — the order that puts the bill which just failed to
    # match above one from two months ago. Two stable passes rather than one key, since the date sorts
    # descending while the severity sorts ascending.
    findings.sort(key=lambda f: str(f["txn_date"]), reverse=True)
    findings.sort(key=lambda f: 0 if f["severity"] == SEVERITY_WARNING else 1)

    counts: dict[str, int] = {}
    for finding in findings:
        if not finding["dismissed"]:
            counts[finding["kind"]] = counts.get(finding["kind"], 0) + 1
    return {
        "count": sum(counts.values()),
        "counts": counts,
        "dismissed_count": dismissed_count,
        "findings": findings,
    }


def open_count(conn: sqlite3.Connection) -> int:
    """How many findings are open — the Rules page's badge and the Tasks entry, neither of which needs
    the findings themselves."""
    return find_range_drift(conn)["count"]
