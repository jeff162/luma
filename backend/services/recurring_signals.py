# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Anomaly and forecast signals over the recurring-series records.

The series subsystem (`recurring_detection.py`) answers "what recurs"; this module answers "and what
about it needs attention". Five signals: an **upcoming** charge (a forward view, deliberately not a
nag), a **missed** one, a **newly detected** series, a **price change**, and a rule whose **amount
range** a charge has drifted out of.

**Signals are derived on read, never stored.** The obvious home would have been the import/sync scan
(`scan_imported_payees`), which knows exactly which payees changed — but stored findings would be
wrong twice over here. Auto-detected series are deleted and re-minted with fresh ids on every scan,
so anything keyed to a series id would be orphaned within a day; and a finding written at import time
goes stale the moment the user recategorizes, trashes, or re-scopes a row. Deriving from the ledger
each time is self-healing and idempotent, and costs one pass over the (small) set of rows that are
series members.

Two consequences shape everything below:

- **The stored `amount_min`/`amount_max` band cannot detect a price change.** `_write_series_stats`
  rewrites it from exactly the rows the series owns, so a hiked charge is inside the band by the time
  anything could look. Price change is therefore computed against the occurrences *preceding* the
  latest one, which only a read-time derivation has access to.
- **"Missed" is judged against how current the data is, not against the calendar.** A ledger that
  has not been imported into for three weeks has no opinion about whether a charge arrived; comparing
  `next_due_date` to today would turn every active series into a false alarm. The reference "now" is
  the newest live transaction on the series' account (or in the ledger, for an account-agnostic
  series), which is also how the detector picks its own reference date.

The only persisted state is the user's dismissal of a signal, keyed by a fingerprint that is stable
across scans (a transaction id, or the series' derived identity plus the date it concerns) rather
than by a series id. A dismissal whose subject later disappears simply never matches again.
"""

from __future__ import annotations

import sqlite3
import statistics
from datetime import date, timedelta

from backend.services.categorizer import rule_matches_row
from backend.services.recurring_detection import SERIES_SCOPE_ACCOUNT_SQL

# How far ahead the forward view looks. Upcoming is a budgeting aid rather than an anomaly, so it is
# surfaced as its own view and never as a task — a badge that counts ordinary life stops meaning
# anything.
UPCOMING_HORIZON_DAYS = 30

# How late a charge may be before it counts as missed. Proportional to the cadence (a weekly charge is
# late in days, an annual one in weeks) with a floor that keeps a weekly series from alarming over a
# weekend, and a ceiling so an annual series still reports inside the same season.
_MISSED_TOLERANCE_FRACTION = 0.25
_MISSED_TOLERANCE_FLOOR_DAYS = 3
_MISSED_TOLERANCE_CEILING_DAYS = 45

# Whole periods missed before a series is *presumed* ended. This only changes what the signal says and
# which action it offers — `status` is never written without the user, because silently freezing a
# confirmed series' next_due is invisible until it is wrong.
_PRESUMED_ENDED_PERIODS = 2

# A series whose past amounts are this tight (coefficient of variation) is treated as fixed-price, and
# judged by a step away from its trailing median. Anything looser is a variable bill, judged only when
# a charge lands outside the range it has ever occupied — a water bill that swings with the season must
# not report a price change every summer. Mirrors the detector's `_FALLBACK_AMOUNT_CV_MAX`.
_FIXED_AMOUNT_CV_MAX = 0.15
_FIXED_STEP_FRACTION = 0.15
_VARIABLE_STEP_FRACTION = 0.25
# Below this, a step is rounding rather than a price change, whatever the percentage says.
_STEP_MIN_ABSOLUTE = 1.00
# Occurrences before the latest that establish the baseline it is judged against.
_BASELINE_OCCURRENCES = 4
# Two consecutive charges at the same amount mean the step has settled — the change was real but it is
# no longer news, so it stops being reported rather than nagging until the median catches up.
_SETTLED_FRACTION = 0.02
# A series needs this many occurrences before its amounts say anything at all.
_MIN_OCCURRENCES_FOR_PRICE = 3

# How recently a series must have first been detected to count as new. Rests on `created_at` being
# carried across the auto-series re-mint (see `recurring_detection._insert_series`); without that it
# would mean "last rebuilt" and every daily catch-up would re-announce the whole list.
_NEW_SERIES_MAX_AGE_DAYS = 30

# Amount-range drift on a rule. A charge that misses a bound by less than this was probably meant to
# match — the range has drifted, not the charge. A charge *inside* the range but this close to a bound
# is the same warning one occurrence earlier.
_RULE_RANGE_NEAR_FRACTION = 0.25
_RULE_RANGE_EDGE_FRACTION = 0.10
# Only recent rows are actionable: a range that drifted two years ago is history, not a task.
_RULE_RANGE_WINDOW_DAYS = 90
# At most this many per rule (most recent first). A broad keyword with a tight range could otherwise
# produce a wall of near-misses that says one thing — "this range is wrong" — a hundred times.
_RULE_RANGE_PER_RULE_CAP = 3

SEVERITY_WARNING = "warning"
SEVERITY_INFO = "info"

# Kinds that are anomalies (they reach the Tasks page). `upcoming` is deliberately absent.
ANOMALY_KINDS = ("missed", "price_change", "new_series", "rule_range", "rule_range_edge")


def _parse_date(value):
    try:
        return date.fromisoformat(str(value)[:10])
    except (TypeError, ValueError):
        return None


def _identity_key(series) -> str:
    """The stable identity of a series across scans: the tuple the detector itself dedupes candidates
    by. A series id cannot be used — auto series are re-minted on every scan — so any dismissal that
    must outlive a rebuild is fingerprinted with this instead."""
    account_id = series["scope_account_id"] if "scope_account_id" in series.keys() else series["account_id"]
    return "|".join([
        str(series["payee_key"] or ""),
        str(series["category_id"] or ""),
        str(account_id or ""),
    ])


def _missed_tolerance_days(period_days: float) -> int:
    raw = _MISSED_TOLERANCE_FRACTION * float(period_days or 0)
    return int(round(max(_MISSED_TOLERANCE_FLOOR_DAYS, min(raw, _MISSED_TOLERANCE_CEILING_DAYS))))


def _load_series(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    """Every non-suppressed series, with the display fields the signal payloads carry. Suppressed series
    own no rows and mean "this is not recurring", so nothing about them can be a signal."""
    return conn.execute(
        f"""
        SELECT s.*, {SERIES_SCOPE_ACCOUNT_SQL}, c.name AS category_name, a.display_name AS account_name
        FROM   recurring_series s
        LEFT   JOIN category c ON c.id = s.category_id
        LEFT   JOIN account  a ON a.id = s.account_id
        WHERE  s.status != 'suppressed'
        """
    ).fetchall()


def _load_members(conn: sqlite3.Connection) -> dict[str, list[dict]]:
    """Each series' own occurrences, oldest first. Scoped by the membership link rather than re-derived,
    so a signal describes exactly the rows the series' card and drill-down show."""
    members: dict[str, list[dict]] = {}
    for row in conn.execute(
        """
        SELECT t.recurring_series_id AS series_id, t.id, t.date, t.amount
        FROM   txn t
        WHERE  t.recurring_series_id IS NOT NULL
          AND  t.trashed_at IS NULL
          AND  t.is_pending = 0
        ORDER  BY t.recurring_series_id, t.date
        """
    ).fetchall():
        d = _parse_date(row["date"])
        if d is None:
            continue
        members.setdefault(row["series_id"], []).append(
            {"id": row["id"], "date": d, "amount": float(row["amount"] or 0.0)}
        )
    return members


def _load_freshness(conn: sqlite3.Connection) -> tuple[dict[str, date], date | None]:
    """How current the data is, per effective account and overall — the reference "now" for lateness.
    Accounts are folded to their group root so a merged child's rows still date its parent."""
    per_account: dict[str, date] = {}
    newest: date | None = None
    for row in conn.execute(
        """
        SELECT COALESCE(a.parent_account_id, t.account_id) AS acct, MAX(t.date) AS newest
        FROM   txn t
        JOIN   account a ON a.id = t.account_id
        WHERE  t.trashed_at IS NULL AND t.is_pending = 0
        GROUP  BY acct
        """
    ).fetchall():
        d = _parse_date(row["newest"])
        if d is None:
            continue
        per_account[row["acct"]] = d
        if newest is None or d > newest:
            newest = d
    return per_account, newest


def _reference_now(series, per_account: dict[str, date], ledger_newest: date | None) -> date | None:
    """The date a series' lateness is measured from. An account-scoped series is judged by its own
    account's newest row — an account that stopped syncing has no opinion about a missing charge — and
    an account-agnostic one by the ledger as a whole. Never later than today: imported future-dated rows
    must not make a series look overdue."""
    account_id = series["scope_account_id"]
    ref = per_account.get(account_id) if account_id else ledger_newest
    if ref is None:
        return None
    today = date.today()
    return ref if ref < today else today


def _load_accepted_amounts(conn: sqlite3.Connection) -> dict[str, list[float]]:
    """Per series, the amounts of charges whose price-change warning the user has already dismissed.

    A dismissal is "seen it, that is fine", and for a **variable** series that is a statement about the
    amount, not just about that one charge: a gas bill that reaches $900 every January should say so
    once, not every January. Folding the dismissed amounts into the range a later charge is compared
    against makes the series' envelope converge on the truth — the seasonal shape is *learned* from what
    the user accepts rather than modelled from dates, which needs no calendar reasoning and no new state
    beyond the dismissals already stored.

    Deliberately not applied to a **fixed** series: there, a dismissal means "yes, the price went up",
    and the next charge at the new price is already silent under the settled rule. Widening a fixed
    series' band would mask the *next* hike, which is the one thing that signal exists to catch.

    The join reconstructs the fingerprint rather than storing the amount, so restoring a dismissal
    narrows the band again with no extra bookkeeping, and a charge that leaves the series takes its
    acceptance with it. Grouped by the transaction's *current* series, so the auto-series rebuild — which
    hands out new ids every scan — cannot strand these either.
    """
    accepted: dict[str, list[float]] = {}
    for row in conn.execute(
        """
        SELECT t.recurring_series_id AS series_id, t.amount
        FROM   recurring_signal_dismissal d
        JOIN   txn t ON d.signal_key = 'price_change:' || t.id
        WHERE  d.kind = 'price_change'
          AND  t.recurring_series_id IS NOT NULL
          AND  t.trashed_at IS NULL
          AND  t.is_pending = 0
        """
    ).fetchall():
        accepted.setdefault(row["series_id"], []).append(abs(float(row["amount"] or 0.0)))
    return accepted


def _series_payload(series) -> dict:
    """The series identification every signal carries, so a card can be rendered without a second
    lookup and a signal survives being read out of context."""
    return {
        "series_id": series["id"],
        "series_name": series["display_name"],
        "category_name": series["category_name"],
        "account_name": series["account_name"],
        "cadence": series["cadence"],
        "confirmed": bool(series["confirmed"]),
        "source": series["source"],
        "rule_id": series["rule_id"] if "rule_id" in series.keys() else None,
    }


def _upcoming(series, today: date, horizon_days: int) -> dict | None:
    if series["status"] != "active" or not series["occurrence_count"]:
        return None
    due = _parse_date(series["next_due_date"])
    if due is None or due < today or due > today + timedelta(days=horizon_days):
        return None
    return {
        "kind": "upcoming",
        "key": f"upcoming:{_identity_key(series)}:{due.isoformat()}",
        "severity": SEVERITY_INFO,
        "due_date": due.isoformat(),
        "days_until": (due - today).days,
        "expected_amount": series["expected_amount"],
        **_series_payload(series),
    }


def _missed(series, ref_now: date | None) -> dict | None:
    """An expected occurrence that never arrived. Measured from the data's own newest date (see the
    module docstring), and reported with how many whole periods have now gone by — two of them is what
    `presumed_ended` means, which is a statement the card makes and an action it offers, not a status
    the scan writes."""
    if series["status"] != "active" or not series["occurrence_count"] or ref_now is None:
        return None
    due = _parse_date(series["next_due_date"])
    period = float(series["period_days"] or 0)
    if due is None or period <= 0:
        return None
    tolerance = _missed_tolerance_days(period)
    late_days = (ref_now - due).days
    if late_days <= tolerance:
        return None
    periods_missed = int(late_days // period) + 1
    return {
        "kind": "missed",
        "key": f"missed:{_identity_key(series)}:{due.isoformat()}",
        "severity": SEVERITY_WARNING,
        "expected_date": due.isoformat(),
        "days_late": late_days,
        "periods_missed": periods_missed,
        "presumed_ended": periods_missed >= _PRESUMED_ENDED_PERIODS,
        "expected_amount": series["expected_amount"],
        **_series_payload(series),
    }


def _new_series(series, today: date) -> dict | None:
    """A series the detector has only just started proposing — the forgotten free trial that began
    billing. Distinct from the /recurring page's full Suggested list, which never empties on its own:
    this is the subset that was not there the last time the user looked."""
    if series["source"] != "auto" or series["confirmed"] or series["status"] != "active":
        return None
    first_seen = _parse_date(series["created_at"])
    if first_seen is None or (today - first_seen).days > _NEW_SERIES_MAX_AGE_DAYS:
        return None
    return {
        "kind": "new_series",
        "key": f"new_series:{_identity_key(series)}",
        "severity": SEVERITY_INFO,
        "first_seen": first_seen.isoformat(),
        "occurrence_count": series["occurrence_count"],
        "confidence": series["confidence"],
        "expected_amount": series["expected_amount"],
        "next_due_date": series["next_due_date"],
        **_series_payload(series),
    }


def _price_change(series, occurrences: list[dict], accepted: list[float] | None = None) -> dict | None:
    """The latest charge judged against the ones before it — the comparison the stored band cannot make.

    Which threshold applies depends on how tight the series' own history is, and **both the tightness
    test and the range are taken over the whole prior history, not a trailing window**. A seasonal bill
    is the case that forces it: four consecutive winter gas bills look tight in isolation, so a trailing
    window would classify the series as fixed-price and then report the following summer as a collapse.
    Only the *median* the step is measured from comes from the recent window, because that is what a
    fixed series' current price means.

    - **Fixed** (tight history): a modest step from the recent median.
    - **Variable**: only a charge beyond the recent range *widened by `accepted`* — the amounts whose
      warnings the user has already dismissed. Deliberately not the whole history: an outlier the user
      never triaged would otherwise teach the band all by itself, and the point is that the band records
      what someone has actually accepted.

    Either way a step the *previous* charge already made is not reported again: the hike was news once.
    """
    if series["status"] != "active" or len(occurrences) < _MIN_OCCURRENCES_FOR_PRICE:
        return None
    latest = occurrences[-1]
    prior = occurrences[:-1]
    history = [abs(o["amount"]) for o in prior]
    baseline_amounts = history[-_BASELINE_OCCURRENCES:]
    baseline = statistics.median(baseline_amounts)
    current = abs(latest["amount"])
    if baseline <= 0:
        return None

    previous = abs(prior[-1]["amount"])
    if previous > 0 and abs(current - previous) / previous <= _SETTLED_FRACTION:
        return None  # the step, if any, settled at the previous occurrence

    mean_amt = statistics.mean(history) if history else 0.0
    tight = mean_amt > 0 and len(history) >= 2 and (
        statistics.pstdev(history) / mean_amt) <= _FIXED_AMOUNT_CV_MAX
    delta = current - baseline
    if abs(delta) < _STEP_MIN_ABSOLUTE:
        return None

    if tight:
        if abs(delta) / baseline < _FIXED_STEP_FRACTION:
            return None
    else:
        # The recent range, widened by everything the user has said is fine. A seasonal bill's envelope
        # is therefore *learned* rather than modelled from dates: the first winter reports its peaks, and
        # once those are dismissed the following winter is silent. What a trailing window alone cannot do
        # is remember across a full cycle — by the next January the last one has long left the window.
        seen = baseline_amounts + list(accepted or [])
        low, high = min(seen), max(seen)
        if low - current < _VARIABLE_STEP_FRACTION * baseline and current - high < _VARIABLE_STEP_FRACTION * baseline:
            return None

    return {
        "kind": "price_change",
        "key": f"price_change:{latest['id']}",
        "severity": SEVERITY_WARNING if delta > 0 else SEVERITY_INFO,
        "txn_id": latest["id"],
        "txn_date": latest["date"].isoformat(),
        "amount": round(latest["amount"], 2),
        "baseline_amount": round(baseline, 2),
        "delta": round(abs(delta), 2),
        "percent": round(abs(delta) / baseline * 100, 1),
        "direction": "increase" if delta > 0 else "decrease",
        "amount_kind": "fixed" if tight else "variable",
        **_series_payload(series),
    }


def _load_ranged_rules(conn: sqlite3.Connection) -> list[dict]:
    """User-authored rules that gate on amount. App-managed rules are excluded: their bounds are the
    app's, not the user's, so there is nothing here for the user to maintain."""
    rows = conn.execute(
        """
        SELECT cr.id, cr.category_id, cr.keyword, cr.match_expr, cr.amount_min, cr.amount_max,
               cr.debit_credit, cr.clean_name, cr.owner_id, cr.account_id, cr.account_type,
               cr.match_source_text, cr.is_recurring, c.name AS category_name,
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


def _rule_range_signals(conn: sqlite3.Connection) -> list[dict]:
    """Charges an amount-gated rule nearly claimed, or only just claimed.

    A range on a rule is a *matching gate*, which is what makes drift expensive: when a bill grows past
    the bound the row stops matching, so it silently loses the rule's category as well as its place in
    the rule's recurring series. Nothing else in the app notices — the row is categorized, just not the
    way the user intended. So the signal that matters is the row that missed by a little, with the
    inside-but-near-the-edge case as the same warning one occurrence earlier.

    A row that already carries the rule's own category is not reported: whatever the range says, nothing
    about that row went wrong.
    """
    rules = _load_ranged_rules(conn)
    if not rules:
        return []
    rows = _load_recent_rows(conn, _RULE_RANGE_WINDOW_DAYS)
    signals: list[dict] = []
    for rule in rules:
        relaxed = {**rule, "amount_min": None, "amount_max": None}
        emitted = 0
        for row in rows:
            if emitted >= _RULE_RANGE_PER_RULE_CAP:
                break
            # Distance to the bound is arithmetic and rules out almost every row; the merchant match is
            # string work over three name fields. Cheapest discriminating test first.
            amount = abs(float(row["amount"] or 0.0))
            bound, inside, distance = _range_proximity(amount, rule["amount_min"], rule["amount_max"])
            if bound is None or distance is None:
                continue
            if inside:
                if distance > _RULE_RANGE_EDGE_FRACTION:
                    continue
                kind, severity = "rule_range_edge", SEVERITY_INFO
            else:
                if distance > _RULE_RANGE_NEAR_FRACTION:
                    continue
                kind, severity = "rule_range", SEVERITY_WARNING
            if rule["category_id"] is not None and row["category_id"] == rule["category_id"]:
                continue
            if rule["series_id"] and row["recurring_series_id"] == rule["series_id"]:
                continue
            if not rule_matches_row(relaxed, row):
                continue
            emitted += 1
            signals.append({
                "kind": kind,
                "key": f"{kind}:{rule['id']}:{row['id']}",
                "severity": severity,
                "rule_id": rule["id"],
                "rule_keyword": rule["keyword"],
                "rule_category_name": rule["category_name"],
                "rule_is_recurring": bool(rule["is_recurring"]),
                "amount_min": rule["amount_min"],
                "amount_max": rule["amount_max"],
                "bound": bound,
                "inside": inside,
                "percent": round(distance * 100, 1),
                "txn_id": row["id"],
                "txn_date": row["date"],
                "txn_name": row["display_name"] or row["merchant_name"] or row["raw_name"],
                "amount": round(float(row["amount"] or 0.0), 2),
                "current_category_name": row["current_category_name"],
                "series_id": rule["series_id"],
                "series_name": rule["series_name"],
            })
    return signals


# --- Dismissal -------------------------------------------------------------------------------------
# A dismissal is the only durable part of this module. It is keyed by the signal's fingerprint rather
# than by any row id, so it survives the auto-series rebuild; a fingerprint whose subject later
# disappears (the transaction is trashed, the rule deleted) simply stops matching anything, which is
# why nothing prunes them. Stored in the data DB and shared rather than per-user: dismissing a signal
# is curation of the ledger, like confirming or suppressing a series, not a UI preference.

def dismissed_keys(conn: sqlite3.Connection) -> set[str]:
    return {r["signal_key"] for r in conn.execute("SELECT signal_key FROM recurring_signal_dismissal")}


def dismiss_signal(conn: sqlite3.Connection, key: str, kind: str) -> None:
    conn.execute(
        """
        INSERT INTO recurring_signal_dismissal (signal_key, kind, dismissed_at)
        VALUES (?, ?, datetime('now'))
        ON CONFLICT(signal_key) DO UPDATE SET kind = excluded.kind, dismissed_at = excluded.dismissed_at
        """,
        (key, kind),
    )


def restore_signal(conn: sqlite3.Connection, key: str) -> None:
    conn.execute("DELETE FROM recurring_signal_dismissal WHERE signal_key = ?", (key,))


def compute_signals(conn: sqlite3.Connection, *, horizon_days: int = UPCOMING_HORIZON_DAYS,
                    include_dismissed: bool = False) -> dict:
    """Every open signal, plus per-kind counts. One pass over the series and their members; the
    rule-range pass is skipped entirely when no rule gates on amount."""
    today = date.today()
    series_rows = _load_series(conn)
    members = _load_members(conn)
    per_account, ledger_newest = _load_freshness(conn)
    accepted = _load_accepted_amounts(conn)

    signals: list[dict] = []
    for series in series_rows:
        occurrences = members.get(series["id"], [])
        for signal in (
            _upcoming(series, today, horizon_days),
            _missed(series, _reference_now(series, per_account, ledger_newest)),
            _new_series(series, today),
            _price_change(series, occurrences, accepted.get(series["id"])),
        ):
            if signal is not None:
                signals.append(signal)
    signals.extend(_rule_range_signals(conn))

    dismissed = set() if include_dismissed else dismissed_keys(conn)
    open_signals = [s for s in signals if s["key"] not in dismissed]
    dismissed_count = len(signals) - len(open_signals)

    # Warnings first, then most recent — the order the review surface reads top to bottom.
    def _sort_key(s):
        when = s.get("txn_date") or s.get("expected_date") or s.get("due_date") or s.get("first_seen") or ""
        return (0 if s["severity"] == SEVERITY_WARNING else 1, str(when))
    open_signals.sort(key=_sort_key)

    counts: dict[str, int] = {}
    for s in open_signals:
        counts[s["kind"]] = counts.get(s["kind"], 0) + 1
    return {
        "signals": open_signals,
        "counts": counts,
        "anomaly_count": sum(counts.get(k, 0) for k in ANOMALY_KINDS),
        "dismissed_count": dismissed_count,
        "horizon_days": horizon_days,
    }


def dismissed_signals(conn: sqlite3.Connection, *, horizon_days: int = UPCOMING_HORIZON_DAYS) -> list[dict]:
    """The signals a dismissal is currently hiding — what the review surface offers to bring back. Only
    signals that still compute are listed: a dismissal whose subject is gone has nothing to restore."""
    dismissed = dismissed_keys(conn)
    if not dismissed:
        return []
    everything = compute_signals(conn, horizon_days=horizon_days, include_dismissed=True)["signals"]
    return [s for s in everything if s["key"] in dismissed]
