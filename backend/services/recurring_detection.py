# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Recurring-transaction detection.

Finds ongoing obligations (subscriptions, bills, taxes) whose charges recur on a cadence and records
them in `recurring_series`. Two operations, split by cost the way the online-categorizer note frames
"the rule is the cache":

- **Detection** (`detect_recurring_series`) is the pure, expensive pass over a bounded recent window.
  It groups transactions and scores each group's *timing regularity* — deliberately the primary
  signal, not frequency — so a high-volume but irregular payee (Amazon, Venmo, PayPal) scores itself
  out without any name blocklist, while a low-volume-but-regular one (an annual tax) survives.
- **Scan-and-store** (`scan_and_store`) is the idempotent rebuild: auto+unconfirmed series are the
  detector's to rewrite each scan, while manual, user-confirmed, and suppressed series are user-owned
  — never overwritten, and a candidate matching a user-owned identity is not re-proposed.

Grouping key is **(payee, category, sign)**, not payee alone: one payee can host several series
distinguished by category — a town billing property tax quarterly, excise annually, water monthly.
Category is the strong discriminator when present; within a group, amount separates same-category series
(a fixed subscription hiding inside a noisy merchant, or two same-category bills at different amounts).
A group is read two ways — as one rhythm over the whole set, and as a rhythm inside each price point —
and the split wins only when the whole-set reading is amount-incoherent, which is what stops two
concurrent subscriptions being reported as one faster series at an average price neither one costs.

Amount is a confidence booster and a forecast hint, and gates membership only for a series that says it
does (`amount_mode='fixed'`) — variable bills (utilities) still recur on schedule while their amount
swings, and gating those would evict their own charges. Every amount gate carries a grace band so a
price rise stays in the series that should report it. See `docs/data-model.md` → Recurring series.
"""

from __future__ import annotations

import sqlite3
import statistics
import uuid
from collections import Counter, defaultdict
from datetime import date, timedelta
from typing import NamedTuple

from backend.services.account_groups import effective_account_id_sql
from backend.services.categorizer import rule_matches_row, rule_scope_account_sql

# `recurring_series.account_id` is a matching *scope*: "this series only owns rows on that account".
# It is written as an already-effective (group-root) id, but a later merge can turn that root into a
# child — at which point no transaction resolves to it any more and the series silently owns nothing.
# Every read that compares or displays the scope projects it through this rather than reading the raw
# column, which is what keeps the scope correct as the account graph changes (`account_groups.py`).
# Requires the `recurring_series` table to be aliased `s`.
SERIES_SCOPE_ACCOUNT_SQL = f"{effective_account_id_sql('s.account_id')} AS scope_account_id"

# Canonical cadences: (name, period in days). Monthly/quarterly/etc. use average calendar lengths so a
# calendar-aligned series (same day-of-month) still snaps cleanly despite 28–31-day months.
CADENCES: list[tuple[str, float]] = [
    ("weekly", 7.0),
    ("biweekly", 14.0),
    ("monthly", 30.44),
    ("quarterly", 91.31),
    ("semiannual", 182.62),
    ("annual", 365.25),
]

# A median gap must fall within this relative tolerance of a canonical period to count as that cadence.
# 0.25 is loose enough for calendar drift (28–31-day months) yet tight enough that adjacent canonical
# periods (e.g. biweekly 14 vs. monthly 30) don't overlap.
_SNAP_TOLERANCE = 0.25

# Minimum occurrences to trust a period. Short cadences need 3 (two gaps confirm the rhythm); long
# cadences (>= ~2 months) are allowed at 2 because two years of data may only hold two annual charges —
# these surface at reduced confidence for the user to confirm.
_LONG_PERIOD_DAYS = 60.0

# Confidence a candidate must reach to be emitted. Tunable; the scan is re-runnable so the user can see
# the effect of curation without a code change.
_CONFIDENCE_THRESHOLD = 0.55

_WINDOW_MONTHS_DEFAULT = 25

# Auto-scan watermark: when detection last ran end-to-end, stored in `db_meta` (data-DB-level and shared
# across users — deliberately not a per-user `ui_preference`, since one data DB has one set of series).
# The app-load catch-up reads it to decide whether a fresh scan is due; every auto-scan restamps it. A
# database that predates recurring detection (or one migrated from an older schema) has no watermark, so
# the catch-up treats "never scanned" as due and populates both the series and the watermark.
_LAST_SCAN_META_KEY = "recurring_last_scan_at"

# The app-load catch-up rescans at most this often. Ingest triggers (import/sync) bypass this gate — data
# demonstrably changed — and restamp the watermark, so the catch-up won't then redundantly re-run.
_AUTO_SCAN_MIN_INTERVAL_HOURS = 20.0


# Trailing domain endings dropped from the grouping key so "Mierf.org" and "MIERF" group together. Kept
# deliberately small and unambiguous (not "co", which is also a real word/suffix).
_TLD_TOKENS = {"org", "com", "net", "io", "gov", "edu"}


def resolve_txn_name(merchant_name, display_name, raw_name) -> str:
    """The user-facing name for a transaction — display_name first, matching the ledger's
    getTxnMerchantLabel. display_name is where rule clean_names and user edits land, so this surfaces the
    name the user actually curated rather than the raw/original one."""
    return (display_name or merchant_name or raw_name or "").strip()


def _normalize_payee(name) -> str:
    """Grouping/matching key derived from a transaction's resolved name. Lower-cased, punctuation
    flattened to spaces, trailing pure-digit tokens (store numbers, ``#1234``) and domain endings
    (``.org``/``.com`` …) dropped so ``AMZN Mktp #12``/``AMZN Mktp #34`` and ``Mierf.org``/``MIERF``
    each group together. Because it keys off the resolved (user-facing) name, a rule/rename that unifies
    a vendor's spelling makes its variants group automatically."""
    name = (name or "").strip().lower()
    if not name:
        return ""
    cleaned = "".join(ch if ch.isalnum() else " " for ch in name)
    tokens = [t for t in cleaned.split() if t]
    while tokens and (tokens[-1].isdigit() or tokens[-1] in _TLD_TOKENS):
        tokens.pop()
    return " ".join(tokens)


def _parse_date(value):
    try:
        return date.fromisoformat(str(value)[:10])
    except (TypeError, ValueError):
        return None


def _clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


def _snap_to_cadence(median_gap: float):
    """Nearest canonical cadence to a median inter-arrival gap, or None if none is within tolerance."""
    best = None
    best_rel = None
    for name, period in CADENCES:
        rel = abs(median_gap - period) / period
        if rel <= _SNAP_TOLERANCE and (best_rel is None or rel < best_rel):
            best, best_rel = (name, period), rel
    return best


def _load_pool(conn: sqlite3.Connection, window_months: int) -> tuple[list[dict], date]:
    """Recent, live transactions eligible for detection, plus the reference "now" (the newest date in
    the ledger — robust to imported/demo data that lags real today). Trashed and pending rows excluded;
    account resolved to its effective (top-level) account so merged children fold into the parent."""
    cutoff = (date.today() - timedelta(days=int(window_months * 30.44))).isoformat()
    rows = conn.execute(
        """
        SELECT t.id,
               COALESCE(a.parent_account_id, t.account_id) AS effective_account_id,
               COALESCE(p.type, a.type) AS effective_account_type,
               t.category_id, t.category_source, t.amount, t.date,
               t.merchant_name, t.display_name, t.raw_name,
               t.owner_id, t.import_evidence_json
        FROM   txn t
        JOIN   account a ON a.id = t.account_id
        LEFT   JOIN account p ON p.id = a.parent_account_id
        WHERE  t.trashed_at IS NULL
          AND  t.is_pending = 0
          AND  t.date >= ?
        """,
        (cutoff,),
    ).fetchall()

    pool: list[dict] = []
    max_date = None
    for r in rows:
        d = _parse_date(r["date"])
        if d is None:
            continue
        resolved = resolve_txn_name(r["merchant_name"], r["display_name"], r["raw_name"])
        payee_key = _normalize_payee(resolved)
        if not payee_key:
            continue
        amount = float(r["amount"] or 0.0)
        pool.append({
            "id": r["id"],
            "account_id": r["effective_account_id"],
            # effective_account_id/effective_account_type/owner_id/name fields/import_evidence_json carry the
            # columns the shared rule matcher (categorizer.rule_matches_row) reads, so a rule-backed series
            # can compute its members straight from the pool without a second query per row.
            "effective_account_id": r["effective_account_id"],
            "effective_account_type": r["effective_account_type"],
            "owner_id": r["owner_id"],
            "merchant_name": r["merchant_name"],
            "raw_name": r["raw_name"],
            "display_name": r["display_name"],
            "import_evidence_json": r["import_evidence_json"],
            "category_id": r["category_id"],
            "category_source": r["category_source"],
            "amount": amount,
            "date": d,
            "payee_key": payee_key,
            "display": resolved,
            "sign": 1 if amount >= 0 else -1,
        })
        if max_date is None or d > max_date:
            max_date = d
    return pool, (max_date or date.today())


def _reference_amount(rows: list[dict]) -> float:
    """The series' typical amount, used to decide which charge on a crowded date belongs to it. Estimated
    from dates that carry exactly one charge (unambiguous), falling back to all charges if every date is
    contested."""
    by_date: dict[date, list[float]] = defaultdict(list)
    for row in rows:
        by_date[row["date"]].append(row["amount"])
    singles = [amts[0] for amts in by_date.values() if len(amts) == 1]
    pool = singles if singles else [row["amount"] for row in rows]
    return statistics.median(pool) if pool else 0.0


def _one_per_date(rows: list[dict], ref_amount: float) -> list[dict]:
    """One charge per date, sorted by date — a periodic series holds at most one charge per occurrence.
    When a date carries several charges the representative is the one whose amount is closest to
    `ref_amount`; the rest are NOT part of this series. This is what keeps an annual tax filing that
    lands on the same day as a quarterly estimate from being folded into the quarterly series (and its
    amount summed into a bogus total). Returns the chosen member rows themselves (each has date/amount/
    id), usable directly as occurrences for scoring."""
    by_date: dict[date, dict] = {}
    for row in rows:
        cur = by_date.get(row["date"])
        if cur is None or abs(row["amount"] - ref_amount) < abs(cur["amount"] - ref_amount):
            by_date[row["date"]] = row
    return [by_date[d] for d in sorted(by_date)]


def _score(occ: list[dict], ref_now: date):
    """Score a set of occurrences as a periodic series. Returns (cadence, period_days, confidence) or
    None. Confidence weights timing regularity highest, then recency, occurrence count, and amount
    consistency as a small booster."""
    if len(occ) < 2:
        return None
    dates = [o["date"] for o in occ]
    gaps = [(dates[i + 1] - dates[i]).days for i in range(len(dates) - 1)]
    gaps = [g for g in gaps if g > 0]
    if not gaps:
        return None
    median_gap = statistics.median(gaps)
    snapped = _snap_to_cadence(median_gap)
    if snapped is None:
        return None
    cadence, period = snapped

    n = len(occ)
    min_occ = 2 if period >= _LONG_PERIOD_DAYS else 3
    if n < min_occ:
        return None

    # Regularity: low coefficient of variation of the gaps = tight rhythm. A single gap (n == 2) tells
    # us nothing about consistency, so it gets a neutral score rather than a misleading perfect one.
    if len(gaps) >= 2:
        mean_gap = statistics.mean(gaps)
        cv = (statistics.pstdev(gaps) / mean_gap) if mean_gap else 1.0
        regularity = _clamp(1.0 - cv / 0.5)
    else:
        regularity = 0.6

    # Recency: an ongoing series' last charge is within ~1.5 periods of now; decays to 0 by 3 periods.
    days_since_last = (ref_now - dates[-1]).days
    if days_since_last <= 1.5 * period:
        recency = 1.0
    elif days_since_last >= 3.0 * period:
        recency = 0.0
    else:
        recency = _clamp(1.0 - (days_since_last - 1.5 * period) / (1.5 * period))

    count_score = _clamp(n / 6.0)

    amounts = [abs(o["amount"]) for o in occ]
    mean_amt = statistics.mean(amounts) if amounts else 0.0
    if mean_amt > 0 and len(amounts) >= 2:
        amt_cv = statistics.pstdev(amounts) / mean_amt
        amount_consistency = _clamp(1.0 - amt_cv / 0.6)
    else:
        amount_consistency = 0.5

    confidence = (
        0.45 * regularity
        + 0.25 * recency
        + 0.20 * count_score
        + 0.10 * amount_consistency
    )
    if n == 2:
        confidence *= 0.65  # a two-point series is a guess, not an established rhythm

    # A dead series (no recent activity) is not "ongoing recurring" regardless of how regular it was.
    if recency <= 0.0 or confidence < _CONFIDENCE_THRESHOLD:
        return None
    return cadence, int(round(period)), round(confidence, 3)


def _cluster_by_amount(rows: list[dict]) -> list[list[dict]]:
    """Split rows into clusters where the absolute amount jumps by more than 40% between neighbors.
    The fallback for a payee whose same-category charges are actually several series at distinct price
    points (a fixed subscription buried in noise, or two bills of different size)."""
    ordered = sorted(rows, key=lambda r: abs(r["amount"]))
    clusters: list[list[dict]] = []
    current: list[dict] = []
    prev = None
    for row in ordered:
        amt = abs(row["amount"])
        if prev is not None and prev > 0 and amt > prev * 1.4:
            clusters.append(current)
            current = []
        current.append(row)
        prev = amt
    if current:
        clusters.append(current)
    return clusters


def _select_display_name(occ: list[dict], ref_now: date, period_days: int) -> str:
    """The human label for a series, chosen from its members by precedence: (1) a rule-authored name —
    a member whose category came from a rule carries that rule's clean_name in its display_name, the
    user's deliberate target; else (2) the most common name that still appears *recently*, so a high-
    count but abandoned spelling doesn't beat the current one; else (3) the most recent member's name."""
    rule_named = [m["display"] for m in occ if m.get("category_source") == "rule" and m["display"]]
    if rule_named:
        return Counter(rule_named).most_common(1)[0][0]
    recent_cutoff = ref_now - timedelta(days=int(round(1.5 * period_days)))
    recent_names = {m["display"] for m in occ if m["display"] and m["date"] >= recent_cutoff}
    for name, _ in Counter(m["display"] for m in occ if m["display"]).most_common():
        if name in recent_names:
            return name
    return max(occ, key=lambda m: m["date"])["display"] or ""


def _build_series(payee_key: str, category_id, sign: int, rows: list[dict], ref_now: date):
    """Turn a homogeneous set of rows into a scored series dict, or None if it isn't periodic. Selects
    one charge per date (dropping same-date outliers) so amounts and membership reflect only the rhythm."""
    occ = _one_per_date(rows, _reference_amount(rows))
    scored = _score(occ, ref_now)
    if scored is None:
        return None
    cadence, period_days, confidence = scored

    display_name = _select_display_name(occ, ref_now, period_days) or payee_key

    account_ids = {row["account_id"] for row in occ}
    account_id = next(iter(account_ids)) if len(account_ids) == 1 else None

    amounts = [o["amount"] for o in occ]
    last_date = occ[-1]["date"]
    return {
        "payee_key": payee_key,
        "display_name": display_name,
        "category_id": category_id,
        "account_id": account_id,
        "cadence": cadence,
        "period_days": period_days,
        "expected_amount": round(statistics.median(amounts), 2),
        "amount_min": round(min(amounts), 2),
        "amount_max": round(max(amounts), 2),
        "last_txn_date": last_date.isoformat(),
        "next_due_date": (last_date + timedelta(days=period_days)).isoformat(),
        "occurrence_count": len(occ),
        "confidence": confidence,
        "member_ids": [o["id"] for o in occ],
        # Whether this series' own charges cluster at one price point. Carried on the candidate (rather
        # than recomputed) because two consumers need it: choosing between the rhythm and amount-split
        # readings of a group, and deciding whether the series' identity includes its amount.
        "amount_tight": _amount_is_tight(occ),
    }


# A fallback amount cluster must be this tight (coefficient of variation of its amounts) to count. The
# amount-cluster path exists only to recover *fixed-price* sub-series hiding in a noisy same-category
# payee (an Audible charge inside Amazon); a variable-amount bill is handled by the category split, not
# here. Without this gate, any few coincidentally-spaced charges in a noisy stream cluster into a
# spurious "series" — the exact false positive that makes name-blocklist approaches tempting.
_FALLBACK_AMOUNT_CV_MAX = 0.15

# A series' `amount_mode`. `fixed` means amount is part of the series' identity: it matches only charges
# near its band, which is what keeps two same-payee, same-category subscriptions at different price
# points from collapsing into each other. `variable` is the default and the right answer for a bill whose
# amount is the thing that moves.
AMOUNT_MODE_FIXED = "fixed"
AMOUNT_MODE_VARIABLE = "variable"

# How far outside its observed band an amount-gated series still claims a charge. Every amount gate in
# this subsystem needs one: without it a price rise stops matching the series that should report it, so
# the charge falls out of its own series and the price-change signal never fires. Deliberately narrower
# than the 1.4× neighbour jump `_cluster_by_amount` splits on, so the gate can never re-merge a pair the
# detector separated on price.
_AMOUNT_GATE_GRACE = 0.25


def _amount_is_tight(rows: list[dict]) -> bool:
    amounts = [abs(r["amount"]) for r in rows]
    mean_amt = statistics.mean(amounts) if amounts else 0.0
    if mean_amt <= 0 or len(amounts) < 2:
        return False
    return (statistics.pstdev(amounts) / mean_amt) <= _FALLBACK_AMOUNT_CV_MAX


def _detect_by_rhythm(payee_key, category_id, sign, rows, ref_now) -> list[dict]:
    """Claim series iteratively from the whole set: build one, remove the charges it claimed (one per
    date), then retry on what's left. This lets same-date leftovers form their own series — e.g. the
    quarterly estimates claim their dates and the annual filings (dropped from those dates) coalesce
    into an annual series of their own rather than contaminating the quarterly one."""
    results = []
    remaining = list(rows)
    while len(remaining) >= 2:
        series = _build_series(payee_key, category_id, sign, remaining, ref_now)
        if series is None:
            break
        results.append(series)
        claimed = set(series["member_ids"])
        next_remaining = [r for r in remaining if r["id"] not in claimed]
        if len(next_remaining) == len(remaining):
            break  # safety: nothing claimed — avoid looping forever
        remaining = next_remaining
    return results


def _detect_by_amount_clusters(payee_key, category_id, sign, rows, ref_now) -> list[dict]:
    """The amount-split reading of a group: partition by price point, then look for a rhythm inside each
    partition. Each cluster must be amount-tight, or a coincidental subset of noise would masquerade as
    a series."""
    clusters = _cluster_by_amount(rows)
    if len(clusters) <= 1:
        return []
    found = []
    for cluster in clusters:
        if not _amount_is_tight(cluster):
            continue
        series = _build_series(payee_key, category_id, sign, cluster, ref_now)
        if series is not None:
            found.append(series)
    return found


def _prefer_amount_split(rhythm: list[dict], split: list[dict]) -> bool:
    """Whether a group is better read as several price points than as one rhythm.

    Two concurrent subscriptions from one biller interleave into a plausible faster cadence — a $4 and a
    $20 monthly charge a fortnight apart read as one biweekly series at $12 whose band spans both, a
    cadence and an expected amount that describe nothing that happens. Preferring the split needs all
    three conditions, and the middle one is what keeps a variable bill intact: a utility's amounts drift
    without a >40% neighbour jump, so it never splits into more than one cluster, and even when a single
    outlier does split it off, the leftover cluster cannot form a series on its own."""
    if len(split) <= len(rhythm):
        return False
    if all(s["amount_tight"] for s in rhythm):
        return False  # the rhythm reading is already amount-coherent — nothing the split would fix
    # Never trade coverage for tidiness: a split that explains fewer charges is a worse account of the
    # group, not a better one.
    return (sum(len(s["member_ids"]) for s in split)
            >= sum(len(s["member_ids"]) for s in rhythm))


def _detect_in_group(payee_key, category_id, sign, rows, ref_now) -> list[dict]:
    rhythm = _detect_by_rhythm(payee_key, category_id, sign, rows, ref_now)
    split = _detect_by_amount_clusters(payee_key, category_id, sign, rows, ref_now)
    found = split if _prefer_amount_split(rhythm, split) else (rhythm or split)
    return _assign_amount_modes(found)


def _assign_amount_modes(found: list[dict]) -> list[dict]:
    """Mark which of a group's series carry their amount as part of their identity. A series is `fixed`
    only when amount is doing discriminating work — the group resolved into more than one series and
    this one sits at a single price point. A lone series never needs the gate (nothing to be confused
    with) and a loose one must not have it (its amounts are the thing that varies)."""
    discriminating = len(found) > 1
    for series in found:
        series["amount_mode"] = AMOUNT_MODE_FIXED if (discriminating and series["amount_tight"]) else AMOUNT_MODE_VARIABLE
    return found


def detect_recurring_series(pool: list[dict], ref_now: date) -> list[dict]:
    """Pure detection over an already-loaded pool: returns candidate series dicts, no DB writes."""
    groups: dict[tuple, list[dict]] = defaultdict(list)
    for row in pool:
        groups[(row["payee_key"], row["category_id"], row["sign"])].append(row)
    candidates: list[dict] = []
    for (payee_key, category_id, sign), rows in groups.items():
        candidates.extend(_detect_in_group(payee_key, category_id, sign, rows, ref_now))
    return candidates


def _match_members(pool: list[dict], series: sqlite3.Row) -> list[dict]:
    """Rows a user-owned series (manual/confirmed) should currently own: same payee, and same category/
    account/sign where the series constrains them.

    Amount gates membership **only** for a series that declares `amount_mode='fixed'` — one whose price
    point is what distinguishes it from a sibling series on the same payee and category. For everything
    else amount is a forecast hint and never a gate, because a variable bill recurs on schedule while
    its amount swings. The gate carries a grace band so a price step does not evict a charge from the
    series that should report it."""
    exp = series["expected_amount"]
    want_sign = None if exp is None else (1 if exp >= 0 else -1)
    gate = _series_amount_gate(series)
    out = []
    for row in pool:
        if row["payee_key"] != series["payee_key"]:
            continue
        if series["category_id"] is not None and row["category_id"] != series["category_id"]:
            continue
        if series["scope_account_id"] is not None and row["account_id"] != series["scope_account_id"]:
            continue
        if want_sign is not None and row["sign"] != want_sign:
            continue
        if gate is not None and not (gate[0] <= row["amount"] <= gate[1]):
            continue
        out.append(row)
    return out


def _assign_membership(conn: sqlite3.Connection, series_id: str, member_ids: list[str]) -> None:
    if member_ids:
        conn.executemany(
            "UPDATE txn SET recurring_series_id = ? WHERE id = ?",
            [(series_id, mid) for mid in member_ids],
        )


def _insert_series(conn: sqlite3.Connection, series: dict, *, source: str, confirmed: int,
                   created_at: str | None = None) -> str:
    """Insert a series row. `created_at` is passed when an auto series is being re-minted over an
    identity a previous scan had already detected, so the column means "first detected" rather than
    "last rebuilt" — see `_auto_first_seen`. Omitted, it takes the DDL default (now)."""
    series_id = str(uuid.uuid4())
    conn.execute(
        """
        INSERT INTO recurring_series
            (id, payee_key, display_name, category_id, account_id, cadence, period_days,
             expected_amount, amount_min, amount_max, amount_mode, last_txn_date, next_due_date,
             occurrence_count, confidence, status, source, confirmed, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?,
                COALESCE(?, datetime('now')), datetime('now'))
        """,
        (
            series_id, series["payee_key"], series["display_name"], series["category_id"],
            series["account_id"], series["cadence"], series["period_days"],
            series["expected_amount"], series["amount_min"], series["amount_max"],
            series.get("amount_mode", AMOUNT_MODE_VARIABLE),
            series["last_txn_date"], series["next_due_date"], series["occurrence_count"],
            series["confidence"], source, confirmed, created_at,
        ),
    )
    return series_id


def _amount_gate_bounds(amount_min, amount_max):
    """The band an amount-gated series claims within, widened by the grace margin. None when the series
    has no observed band yet, which reads as "no gate" rather than "matches nothing"."""
    if amount_min is None or amount_max is None:
        return None
    lo, hi = min(amount_min, amount_max), max(amount_min, amount_max)
    margin = max(abs(lo), abs(hi)) * _AMOUNT_GATE_GRACE
    return lo - margin, hi + margin


def _series_amount_gate(series) -> tuple | None:
    """The amount band a series matches within, or None when it does not gate on amount. Reading the
    mode through a default keeps every legacy row (written before the column existed) variable.

    A pinned band wins over the derived one, and is the only way to express a bound a percentage cannot
    — separating a town's water bill from its property tax by size, where both are "about right" for each
    other's grace margin. The derived band is rewritten by every scan from the rows the series owns; the
    pinned one is the user's claim and is never rewritten."""
    if _row_get(series, "amount_mode", AMOUNT_MODE_VARIABLE) != AMOUNT_MODE_FIXED:
        return None
    pinned_lo = _row_get(series, "expected_min")
    pinned_hi = _row_get(series, "expected_max")
    if pinned_lo is not None and pinned_hi is not None:
        return _amount_gate_bounds(pinned_lo, pinned_hi)
    return _amount_gate_bounds(series["amount_min"], series["amount_max"])


def _row_get(row, key, default=None):
    """`sqlite3.Row` has no `.get`, and a series reaches this module from several SELECTs."""
    try:
        value = row[key]
    except (IndexError, KeyError):
        return default
    return default if value is None else value


def _amount_identity_key(series):
    """The amount component of an auto series' identity — its price point, rounded, for a fixed series
    and None for a variable one. Without it the two price points of one payee share an identity, which
    silently collapses `_auto_first_seen` and makes `_covered_by_owned` suppress the sibling of any
    series the user confirms."""
    if _row_get(series, "amount_mode", AMOUNT_MODE_VARIABLE) != AMOUNT_MODE_FIXED:
        return None
    expected = series["expected_amount"]
    return None if expected is None else round(expected, 2)


def _auto_identity(payee_key, category_id, account_id, amount_key=None) -> tuple:
    """The identity an auto series keeps across rebuilds — the same tuple `_covered_by_owned` dedupes
    candidates by. An auto series' *id* cannot carry anything across a scan (each scan deletes and
    re-inserts it), so anything that must outlive a rebuild is keyed by this instead.

    `amount_key` is the price point of an amount-gated series and None otherwise, so two fixed-price
    subscriptions from one biller are two identities rather than one."""
    return (payee_key, category_id, account_id, amount_key)


def _series_occurrences(series: sqlite3.Row, members: list[dict]) -> list[dict]:
    """One charge per date for a user-owned series, closest to its expected amount — the candidate rows
    it would own before exclusive de-duplication against other series."""
    ref = series["expected_amount"] if series["expected_amount"] is not None else _reference_amount(members)
    return _one_per_date(members, ref if ref is not None else 0.0)


def _write_series_stats(conn: sqlite3.Connection, series: sqlite3.Row, occ: list[dict], *,
                        advance_next_due: bool = True) -> None:
    """Write a series' observed stats from the exact rows it *owns* (`occ`, already one-per-date and
    de-duplicated against other series). occurrence_count therefore always equals the series' linked-row
    count — the two can't drift. next_due advances off the series' own period, except for an ended series
    (`advance_next_due=False`) whose next_due is frozen as the resume threshold."""
    if occ:
        amounts = [o["amount"] for o in occ]
        last_date = occ[-1]["date"]
        if advance_next_due:
            conn.execute(
                """
                UPDATE recurring_series
                SET occurrence_count = ?, expected_amount = ?, amount_min = ?, amount_max = ?,
                    last_txn_date = ?, next_due_date = ?, updated_at = datetime('now')
                WHERE id = ?
                """,
                (
                    len(occ), round(statistics.median(amounts), 2), round(min(amounts), 2),
                    round(max(amounts), 2), last_date.isoformat(),
                    (last_date + timedelta(days=series["period_days"])).isoformat(), series["id"],
                ),
            )
        else:
            conn.execute(
                """
                UPDATE recurring_series
                SET occurrence_count = ?, expected_amount = ?, amount_min = ?, amount_max = ?,
                    last_txn_date = ?, updated_at = datetime('now')
                WHERE id = ?
                """,
                (
                    len(occ), round(statistics.median(amounts), 2), round(min(amounts), 2),
                    round(max(amounts), 2), last_date.isoformat(), series["id"],
                ),
            )
    else:
        conn.execute(
            "UPDATE recurring_series SET occurrence_count = 0, updated_at = datetime('now') WHERE id = ?",
            (series["id"],),
        )


class ReconcileResult(NamedTuple):
    claimed: set          # txn ids now owned by a reconciled (or an untouched) series — for downstream exclusivity
    resumed: int          # ended series reactivated by a resubscribe charge


def _reconcile_priority(series: sqlite3.Row):
    """Order series so exclusive row-claiming is deterministic and sensible: active before ended,
    account-scoped before account-agnostic, higher confidence first, then id for a stable tiebreak."""
    return (
        1 if series["status"] == "ended" else 0,       # active before ended
        0 if series["account_id"] else 1,              # account-scoped before agnostic
        -(series["confidence"] or 0.0),                # higher confidence first
        series["id"],                                  # stable
    )


def _load_overrides(conn: sqlite3.Connection) -> dict:
    """Sparse per-transaction exclusions, grouped by series: rows the user has taken *out* of a series
    they match. Applied on every reconcile so the correction survives a rescan (the "cache" is rebuilt,
    the override isn't).

    Only exclusions. The table's `state` also allowed `pinned` — forcing a row *into* a series it does
    not match — which was withdrawn deliberately: a series is defined by what recurs, so a charge that
    only happens to share a payee and category (a late fee on a tax payment) is not part of it, and
    forcing it in misrepresents the series and every total derived from it. The endpoint now rejects the
    state, so no row can carry it; a legacy row would simply never match this filter. See
    `docs/data-model.md` -> Recurring series.
    """
    excludes: dict = defaultdict(set)
    for r in conn.execute(
        "SELECT txn_id, series_id FROM recurring_membership_override WHERE state = 'excluded'"
    ).fetchall():
        excludes[r["series_id"]].add(r["txn_id"])
    return excludes


def _load_series_rules(conn: sqlite3.Connection, series_list) -> dict:
    """The category_rule rows backing any `source='rule'` series in `series_list`, keyed by rule id —
    loaded once so membership can be computed from the pool without a per-series query. Only the matcher
    columns are needed (categorizer.rule_matches_row)."""
    rule_ids = {s["rule_id"] for s in series_list if s["source"] == "rule" and s["rule_id"]}
    if not rule_ids:
        return {}
    placeholders = ",".join("?" * len(rule_ids))
    rows = conn.execute(
        f"""SELECT id, keyword, match_expr, owner_id, {rule_scope_account_sql()}, account_type,
                   amount_min, amount_max, debit_credit, match_source_text
            FROM category_rule WHERE id IN ({placeholders})""",
        list(rule_ids),
    ).fetchall()
    return {r["id"]: r for r in rows}


def _candidate_members(pool: list[dict], series: sqlite3.Row, series_rules: dict) -> list[dict]:
    """The rows a series should currently own, before overrides/exclusivity. A rule-backed series
    (`source='rule'`) owns exactly its rule's matches (the shared categorizer predicate, so membership
    equals what the rule categorizes); every other series uses the derived payee/category/account match."""
    if series["source"] == "rule" and series["rule_id"]:
        rule = series_rules.get(series["rule_id"])
        if rule is None:  # rule deleted out from under the series — no members until it's cleaned up
            return []
        return [row for row in pool if rule_matches_row(rule, row)]
    return _match_members(pool, series)


def reconcile_series(conn: sqlite3.Connection, series_list, pool: list[dict]) -> ReconcileResult:
    """Assign each series in `series_list` the transactions it currently owns and refresh its stats — the
    shared matching core behind both the full scan and the single-series relink (and, in future, a
    targeted per-import update). Three properties make it reusable at any scope:

    - **Exclusive membership.** Within `series_list` a higher-priority series claims a contested row
      first, so every transaction lands in at most one series — this is what keeps occurrence_count equal
      to a series' linked-row count (the "27 charges but 3 shown" bug was those two diverging).
    - **Non-destructive to the rest.** Only these series' links are reclaimed; rows owned by series
      *outside* `series_list` are treated as already claimed and never stolen. So a scoped reconcile can
      touch just the payees an import hit without disturbing everything else.
    - **Scope-independent correctness.** Candidate membership filters `pool` by each series' own matcher
      (payee/category/account for derived series, the rule for `source='rule'` series), so the result is
      identical whether `pool` is the full window or a scoped slice — callers narrow the pool purely to
      save work, never to change the outcome.

    Per-transaction overrides layer on top: an `excluded` row is dropped from its series even when it
    matches. It survives the rescan because it lives in its own table, not the rebuilt cache.

    An ended series resumes (→ active) only when a charge it owns lands on/after its frozen next_due."""
    ids = [s["id"] for s in series_list]
    if ids:
        # Reclaim only these series' current links; the partial index on recurring_series_id keeps both
        # this clear and the "owned by others" probe below cheap (they scan only linked rows).
        placeholders = ",".join("?" * len(ids))
        conn.execute(
            f"UPDATE txn SET recurring_series_id = NULL WHERE recurring_series_id IN ({placeholders})", ids
        )
    # Any row still linked belongs to a series we are NOT reconciling — off-limits.
    claimed = {
        r["id"] for r in conn.execute("SELECT id FROM txn WHERE recurring_series_id IS NOT NULL").fetchall()
    }
    excludes = _load_overrides(conn)
    series_rules = _load_series_rules(conn, series_list)

    resumed = 0
    for series in sorted((s for s in series_list if s["status"] != "suppressed"), key=_reconcile_priority):
        sid = series["id"]
        excluded = excludes.get(sid, frozenset())
        members = [m for m in _candidate_members(pool, series, series_rules) if m["id"] not in excluded]
        occ = [o for o in _series_occurrences(series, members) if o["id"] not in claimed]
        advance_next_due = True
        if series["status"] == "ended":
            # Resume only if a charge the series actually owns landed on/after its frozen next_due.
            newest = max((o["date"] for o in occ), default=None)
            next_due = series["next_due_date"]
            if next_due and newest and newest.isoformat() >= next_due:
                conn.execute(
                    "UPDATE recurring_series SET status = 'active', updated_at = datetime('now') WHERE id = ?",
                    (series["id"],),
                )
                resumed += 1
            else:
                advance_next_due = False
        _write_series_stats(conn, series, occ, advance_next_due=advance_next_due)
        _assign_membership(conn, series["id"], [o["id"] for o in occ])
        claimed.update(o["id"] for o in occ)
    return ReconcileResult(claimed, resumed)


def link_series_members(conn: sqlite3.Connection, series_id: str, *, window_months: int = _WINDOW_MONTHS_DEFAULT) -> int:
    """Match one user-owned series to its transactions right now and refresh its observed stats, so a
    freshly created (or edited) series shows its members immediately instead of only after the next full
    scan. A single-series `reconcile_series` call — same matching, same never-steal-another-series'-row
    guard, scoped to this one series. Returns its member count."""
    series = conn.execute(
        f"SELECT s.*, {SERIES_SCOPE_ACCOUNT_SQL} FROM recurring_series s WHERE s.id = ?", (series_id,)
    ).fetchone()
    if series is None:
        return 0
    pool, _ = _load_pool(conn, window_months)
    reconcile_series(conn, [series], pool)
    return conn.execute(
        "SELECT COUNT(*) FROM txn WHERE recurring_series_id = ?", (series_id,)
    ).fetchone()[0]


def scan_and_store(conn: sqlite3.Connection, *, window_months: int = _WINDOW_MONTHS_DEFAULT,
                   payee_keys: set[str] | None = None) -> dict:
    """Idempotent rebuild. Rewrites auto+unconfirmed series from a fresh scan while preserving manual,
    confirmed, and suppressed series; a candidate matching a user-owned identity is not re-proposed.
    Recomputes txn membership across the board. Returns summary counts.

    `payee_keys` scopes the rebuild. `None` is the full global scan. A set restricts *every* step —
    detection, series partitioning, auto-series removal, reconciliation, and candidate insertion — to
    those payee keys, leaving every other payee's series and membership exactly as they are. That is the
    cheap per-import/sync path (`scan_imported_payees`): reprocess only the payees a batch touched instead
    of the whole ledger. It is correct because detection groups by payee (so a scoped pool yields the same
    per-payee result) and `reconcile_series` never disturbs out-of-scope rows. The one thing a scoped pass
    skips is the payee-key re-derivation below — a global normalization-repair step the daily full-scan
    catch-up owns — so a scoped pass trusts the stored keys.

    Rule-backed series are the deliberate exception to scoping: their members are the rule's matches,
    which can span payees the scoped pool doesn't hold (varying names — the whole reason a rule is used).
    So they are always reconciled against the *full* pool, even on a scoped pass, and are never scoped out
    of `existing`. That is how a newly imported row that matches a recurring rule attaches to its series
    right away without stamping membership through every insert path."""
    full_pool, ref_now = _load_pool(conn, window_months)
    if payee_keys is not None:
        # Scope is a pure cost knob for the derived path: filtering the pool changes which payees are
        # processed, not the per-payee outcome (see reconcile_series).
        pool = [r for r in full_pool if r["payee_key"] in payee_keys]
    else:
        pool = full_pool
    candidates = detect_recurring_series(pool, ref_now)

    # Re-derive each existing series' stored payee_key from the names of the transactions it currently
    # owns, so a change to the normalization (or to name resolution) can't strand an existing series
    # with a stale key that no longer matches the pool. Derived from members, not the (editable) display
    # name, so renaming a series never breaks its matching. Suppressed series own no rows, so they fall
    # back to their display name. Skipped on a scoped pass (it is a global repair; the full catch-up
    # owns it), which therefore matches series by their stored key.
    if payee_keys is None:
        for r in conn.execute("SELECT id, display_name FROM recurring_series").fetchall():
            names = [
                resolve_txn_name(m["merchant_name"], m["display_name"], m["raw_name"])
                for m in conn.execute(
                    "SELECT merchant_name, display_name, raw_name FROM txn WHERE recurring_series_id = ? AND trashed_at IS NULL",
                    (r["id"],),
                ).fetchall()
            ]
            keys = [k for k in (_normalize_payee(n) for n in names) if k]
            new_key = Counter(keys).most_common(1)[0][0] if keys else _normalize_payee(r["display_name"] or "")
            if new_key:
                conn.execute("UPDATE recurring_series SET payee_key = ? WHERE id = ?", (new_key, r["id"]))

    # Series for the payees in scope are eligible to be touched; the rest are left untouched (and, for
    # reconcile below, their rows stay off-limits). Rule-backed series are always in scope — their
    # membership is the rule's matches, which can span payees a scoped pool doesn't contain, so scoping
    # them out would strand new members between full scans.
    existing = [
        r for r in conn.execute(
            f"SELECT s.*, {SERIES_SCOPE_ACCOUNT_SQL} FROM recurring_series s").fetchall()
        if payee_keys is None or r["payee_key"] in payee_keys or r["source"] == "rule"
    ]
    user_owned = [
        r for r in existing
        if r["source"] in ("manual", "rule") or r["confirmed"] == 1 or r["status"] == "suppressed"
    ]
    user_owned_ids = {r["id"] for r in user_owned}
    auto_ids = [r["id"] for r in existing if r["id"] not in user_owned_ids]

    # When each auto identity was FIRST detected, captured before the rows carrying it are dropped. An
    # auto series is re-minted from scratch on every scan, so without this its created_at would advance
    # to the last rebuild and "detected since you last looked" could never be answered — every daily
    # catch-up would re-announce the entire list.
    first_seen = {
        _auto_identity(r["payee_key"], r["category_id"], r["scope_account_id"],
                       _amount_identity_key(r)): r["created_at"]
        for r in existing if r["id"] in set(auto_ids)
    }

    # Drop the auto-managed series, clearing their members' links first so those rows are free to be
    # reassigned and never dangle at a now-deleted series. User-owned series keep their links until
    # reconcile reclaims them (the partial index on recurring_series_id keeps the clear cheap).
    if auto_ids:
        placeholders = ",".join("?" * len(auto_ids))
        conn.execute(
            f"UPDATE txn SET recurring_series_id = NULL WHERE recurring_series_id IN ({placeholders})", auto_ids
        )
        conn.executemany("DELETE FROM recurring_series WHERE id = ?", [(i,) for i in auto_ids])

    # Reconcile the surviving (user-owned) in-scope series via the shared core: exclusive, priority-ordered
    # membership + stats + ended→resume. Always over the FULL pool: the reconciled set is small (user-owned
    # series only), so scanning the whole window costs little, and it is what lets a rule-backed series
    # match its rule across payees a scoped pass wouldn't include. On a full scan this is *every* survivor
    # (global exclusivity); on a scoped pass reconcile still leaves out-of-scope rows claimed by their own
    # series alone.
    reconciled = reconcile_series(conn, user_owned, full_pool)
    claimed, resumed = reconciled.claimed, reconciled.resumed

    # Auto candidates: skip any a user-owned series already covers — same payee+category whose account
    # scope overlaps (a NULL/account-agnostic series covers every account). This stops a redundant second
    # series (account-agnostic vs account-scoped) from being minted and fighting over the same rows.
    #
    # An amount-gated owned series covers only its own price point. Without that test, confirming one of
    # a biller's two subscriptions suppressed the other as redundant, and its charges were left linked to
    # nothing — the sibling was destroyed by the act of endorsing its neighbour.
    def _covered_by_owned(cand):
        for r in user_owned:
            if not (r["payee_key"] == cand["payee_key"] and r["category_id"] == cand["category_id"]
                    and (r["scope_account_id"] == cand["account_id"]
                         or r["scope_account_id"] is None or cand["account_id"] is None)):
                continue
            gate = _series_amount_gate(r)
            if gate is not None and cand["expected_amount"] is not None:
                if not (gate[0] <= cand["expected_amount"] <= gate[1]):
                    continue  # a different price point on the same payee — its own series
            return True
        return False

    inserted = 0
    for cand in candidates:
        if _covered_by_owned(cand):
            continue
        member_ids = [i for i in cand["member_ids"] if i not in claimed]
        if not member_ids:
            continue
        cand["occurrence_count"] = len(member_ids)  # keep count == rows actually assigned
        series_id = _insert_series(
            conn, cand, source="auto", confirmed=0,
            created_at=first_seen.get(_auto_identity(
                cand["payee_key"], cand["category_id"], cand["account_id"], _amount_identity_key(cand))),
        )
        _assign_membership(conn, series_id, member_ids)
        claimed.update(member_ids)
        inserted += 1

    return {
        "detected": len(candidates),
        "inserted": inserted,
        "preserved": len(user_owned),
        "removed_auto": len(auto_ids),
        "resumed": resumed,
    }


def _stamp_scan(conn: sqlite3.Connection) -> None:
    conn.execute(
        "INSERT OR REPLACE INTO db_meta (key, value) VALUES (?, datetime('now'))",
        (_LAST_SCAN_META_KEY,),
    )


def run_auto_scan(conn: sqlite3.Connection, *, window_months: int = _WINDOW_MONTHS_DEFAULT) -> dict:
    """Run a full scan and stamp the watermark. The app-load catch-up (`maybe_auto_scan`) calls this —
    a global rebuild is what the watermark records as 'last full scan'."""
    summary = scan_and_store(conn, window_months=window_months)
    _stamp_scan(conn)
    return summary


def payee_keys_for_ids(conn: sqlite3.Connection, ids: list[str]) -> set[str]:
    """The distinct payee keys of the given transactions — the payee scope a per-import/sync scan
    reprocesses. Derived with the same name-resolution + normalization the detector groups by, so the
    scope lines up exactly with the series those rows would match."""
    keys: set[str] = set()
    for start in range(0, len(ids), 500):
        chunk = ids[start:start + 500]
        placeholders = ",".join("?" * len(chunk))
        for r in conn.execute(
            f"SELECT merchant_name, display_name, raw_name FROM txn WHERE id IN ({placeholders})", chunk
        ).fetchall():
            key = _normalize_payee(resolve_txn_name(r["merchant_name"], r["display_name"], r["raw_name"]))
            if key:
                keys.add(key)
    return keys


def scan_imported_payees(conn: sqlite3.Connection, payee_keys: set[str], *,
                         window_months: int = _WINDOW_MONTHS_DEFAULT) -> dict:
    """Cheap per-import/sync scan: rebuild recurring series for only the payees a batch touched, via the
    scoped `scan_and_store`. Every other payee is left untouched. This is the "the rule is the cache" fast
    path — new charges for an existing series are matched and its next_due advanced, and a new series among
    the touched payees is detected, without re-scanning the whole ledger.

    Deliberately does NOT stamp the full-scan watermark: a scoped pass cannot see cross-payee effects
    (dedupe merges, a normalization change) or repair stale payee keys, so the daily app-load catch-up
    must still run a global `run_auto_scan`. Scoped passes give immediacy between those daily rebuilds.

    Anomaly/forecast signals deliberately do NOT hang off this function, although it was long marked as
    their natural home. They are derived on read instead (`services/recurring_signals.py`): a finding
    stored here would be orphaned within a day (an auto series is re-minted with a new id on every scan)
    and stale on the next recategorize, trash or membership override. Nothing about the signals needs a
    hook in the ingest path."""
    if not payee_keys:
        return {"detected": 0, "inserted": 0, "preserved": 0, "removed_auto": 0, "resumed": 0}
    return scan_and_store(conn, window_months=window_months, payee_keys=payee_keys)


# Bulk-edit paths call this once per request, never once per row: a scan loads the whole detection
# window before it filters by payee, so per-row calls would repeat that load for every row in a batch.
def rescan_edited_transactions(conn: sqlite3.Connection, txn_ids, *,
                               prior_payee_keys=frozenset(),
                               window_months: int = _WINDOW_MONTHS_DEFAULT) -> dict:
    """Re-evaluate recurring membership after the user edits transactions by hand.

    Membership is a cache only a scan rewrites, so before this existed an edit could leave a row linked
    to a series it no longer belonged to — recategorizing a bill still showed it under its old series,
    the series' own drill-down never gained it, and a missed-charge signal about it stayed open. None of
    the existing triggers covered the case: import and sync scan the payees they touched, a global
    recategorize scans everything, and the app-load catch-up is watermark-gated to roughly a day.

    The scope is the payees the edited rows belong to *now*, plus any they belonged to *before* — a
    rename moves a row between payee groups, so the group it left has to be reconsidered too, and the
    caller captures those keys before it writes. A category edit needs no prior key: the key is derived
    from the name, so both the old and the new series for that payee are already in scope.

    Re-evaluation is the whole contract, not re-attachment: a row that still belongs where it was stays
    put, and one that no longer matches is released for whatever else claims it.
    """
    keys = set(prior_payee_keys) | payee_keys_for_ids(conn, [i for i in txn_ids if i])
    if not keys:
        return {"detected": 0, "inserted": 0, "preserved": 0, "removed_auto": 0, "resumed": 0}
    return scan_imported_payees(conn, keys, window_months=window_months)


def maybe_auto_scan(conn: sqlite3.Connection, *, window_months: int = _WINDOW_MONTHS_DEFAULT,
                    min_interval_hours: float = _AUTO_SCAN_MIN_INTERVAL_HOURS) -> dict:
    """Scan only if one is *due*: never scanned (a fresh, or pre-recurring/older-schema, database) or the
    last scan is older than `min_interval_hours`. This is the app-load catch-up, so detection stays
    current even when data arrives outside the import/sync paths (a restore, another tab, a schema
    migration). Returns the scan summary, or ``{"skipped": True}`` when a recent scan makes it a no-op."""
    row = conn.execute("SELECT value FROM db_meta WHERE key = ?", (_LAST_SCAN_META_KEY,)).fetchone()
    last = row["value"] if row else None
    if last:
        # julianday() parses the stored datetime; a malformed value yields NULL → treat as due (rescan).
        due = conn.execute(
            "SELECT ((julianday('now') - julianday(?)) * 24.0 >= ?) IS NOT 0 AS due",
            (last, min_interval_hours),
        ).fetchone()["due"]
        if not due:
            return {"skipped": True, "last_scan_at": last}
    return run_auto_scan(conn, window_months=window_months)
