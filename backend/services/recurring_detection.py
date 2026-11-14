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

import json
import sqlite3
import statistics
import uuid
from collections import Counter, defaultdict
from datetime import date, timedelta
from typing import NamedTuple

from backend.app_logging import log_error
from backend.db.database import get_db
from backend.services.account_groups import effective_account_id_sql
from backend.services.categorizer import rule_matches_row, rule_scope_account_sql, rule_specificity_order_sql
from backend.services.link_held_rows import second_record_txn_ids_sql
from backend.services.transaction_facets import UNASSIGNED_OWNER_ID, owner_lens_admits
from backend.services.transfer_pairs import (
    group_key, pair_money_movements, pairs_by_movement,
)

# `recurring_series.account_id` is a matching *scope*: "this series only owns rows on that account".
# It is written as an already-effective (group-root) id, but a later merge can turn that root into a
# child — at which point no transaction resolves to it any more and the series silently owns nothing.
# Every read that compares or displays the scope projects it through this rather than reading the raw
# column, which is what keeps the scope correct as the account graph changes (`account_groups.py`).
# Requires the `recurring_series` table to be aliased `s`.
SERIES_SCOPE_ACCOUNT_SQL = f"{effective_account_id_sql('s.account_id')} AS scope_account_id"
# The same projection for a transfer series' far account — see `ACCOUNT_REFERENCE_KINDS`, where it is
# classified as a scope for exactly this reason: pairing compares it against the row side's already-
# resolved account, so an unresolved counterpart would silently stop matching after a merge.
COUNTERPART_SCOPE_ACCOUNT_SQL = (
    f"{effective_account_id_sql('s.counterpart_account_id')} AS counterpart_scope_account_id"
)

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

# The app-load catch-up rescans at most this often. Ingest and edit triggers bypass this gate with scoped
# scans of their own, which do not restamp the watermark: only a full scan does.
_AUTO_SCAN_MIN_INTERVAL_HOURS = 20.0


# Whose transactions a series holds, for the owner lens (`data-model.md` → *Owner lens*): the owners of
# its linked rows, and for a suppressed series, which links none, of the rows it held when suppressed.
# `UNASSIGNED_OWNER_ID` stands for a row with no owner, as in the owner facet. Two subqueries rather than one OR, so
# the linked-row half keeps `idx_txn_recurring`.
SERIES_OWNERS_SQL = f"""
    (SELECT group_concat(DISTINCT COALESCE(t.owner_id, '{UNASSIGNED_OWNER_ID}')) FROM txn t
     WHERE  t.recurring_series_id = s.id AND t.trashed_at IS NULL) AS linked_owner_ids,
    (SELECT group_concat(DISTINCT COALESCE(t.owner_id, '{UNASSIGNED_OWNER_ID}')) FROM txn t
     WHERE  s.suppressed_member_ids IS NOT NULL
       AND  t.id IN (SELECT value FROM json_each(s.suppressed_member_ids))) AS suppressed_owner_ids
"""


def series_owner_ids(row) -> list[str]:
    owners = set()
    for column in ("linked_owner_ids", "suppressed_owner_ids"):
        if column in row.keys() and row[column]:
            owners.update(row[column].split(","))
    return sorted(owners)



def series_shown_under_lens(conn: sqlite3.Connection, lens: list[str]) -> set[str]:
    """The series the owner lens shows: those holding a lens owner's rows, and those holding none."""
    rows = conn.execute(f"SELECT s.id, {SERIES_OWNERS_SQL} FROM recurring_series s").fetchall()
    return {row["id"] for row in rows if owner_lens_admits(series_owner_ids(row), lens)}


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


def _pool_cutoff(window_months: int) -> str:
    return (date.today() - timedelta(days=int(window_months * 30.44))).isoformat()


# Recent, live transactions eligible for detection. Trashed and pending rows excluded; account resolved to
# its effective (top-level) account so merged children fold into the parent.
_POOL_SQL = """
    SELECT t.id,
           COALESCE(a.parent_account_id, t.account_id) AS effective_account_id,
           COALESCE(p.type, a.type) AS effective_account_type,
           t.category_id, t.category_source, t.amount, t.date,
           t.merchant_name, t.display_name, t.raw_name,
           t.owner_id, t.import_evidence_json,
           -- Whether the row is money movement rather than spending or income, read through the
           -- category's group exactly as the reports read it. Carried on the pool because transfer
           -- pairing is gated on it (services/transfer_pairs.py) and re-querying per row would turn
           -- one scan into thousands of lookups.
           COALESCE(pc.exclude_from_totals, c.exclude_from_totals, 0) AS money_movement
    FROM   txn t
    JOIN   account a ON a.id = t.account_id
    LEFT   JOIN account p ON p.id = a.parent_account_id
    LEFT   JOIN category c  ON c.id = t.category_id
    LEFT   JOIN category pc ON pc.id = c.parent_id
    WHERE  t.trashed_at IS NULL
      AND  t.is_pending = 0
      AND  t.date >= ?
      AND  t.id NOT IN ({second_records})
"""


def _pool_sql() -> tuple[str, tuple]:
    """`_POOL_SQL` with its clause binding the rows a link set aside as a second record of money another
    row counts (`services/link_held_rows.py`): the counted row carries the series, and the second record
    would surface the same obligation again as money movement. Its parameters follow the cutoff."""
    second_records, params = second_record_txn_ids_sql()
    return _POOL_SQL.format(second_records=second_records), params

# Narrows the pool to money-movement rows, the only ones transfer pairing reads.
_MONEY_MOVEMENT_SQL = " AND COALESCE(pc.exclude_from_totals, c.exclude_from_totals, 0) <> 0"


def _pool_rows(conn: sqlite3.Connection, window_months: int, where: str = "", params=()) -> list[dict]:
    """The detection pool, optionally narrowed by `where` (an `AND …` clause over `_POOL_SQL`'s aliases).
    A row with no date or no payee key is not a candidate for anything and is left out."""
    pool: list[dict] = []
    pool_sql, pool_params = _pool_sql()
    for r in conn.execute(pool_sql + where, (_pool_cutoff(window_months), *pool_params, *params)).fetchall():
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
            "money_movement": bool(r["money_movement"]),
            "amount": amount,
            "date": d,
            "payee_key": payee_key,
            "display": resolved,
            "sign": 1 if amount >= 0 else -1,
        })
    return pool


def _pool_rows_by_id(conn: sqlite3.Connection, window_months: int, ids) -> list[dict]:
    ids = list(ids)
    rows: list[dict] = []
    for start in range(0, len(ids), 500):
        chunk = ids[start:start + 500]
        rows += _pool_rows(conn, window_months, f" AND t.id IN ({','.join('?' * len(chunk))})", chunk)
    return rows


def _payee_rows(conn: sqlite3.Connection, window_months: int, payee_keys: set[str]) -> list[dict]:
    """The pool rows whose payee key is one of `payee_keys`."""
    return [r for r in _pool_rows(conn, window_months) if r["payee_key"] in payee_keys]


def _reference_now(conn: sqlite3.Connection, window_months: int) -> date:
    """The reference "now": the newest live, posted date in the window, robust to imported/demo data that
    lags real today. Read with its own query so a scan that loads only part of the pool measures every
    series against the same date a full scan does."""
    pool_sql, pool_params = _pool_sql()
    row = conn.execute(
        "SELECT MAX(t.date) AS newest FROM (" + pool_sql + ") t", (_pool_cutoff(window_months), *pool_params)
    ).fetchone()
    return _parse_date(row["newest"]) or date.today()


def _load_pool(conn: sqlite3.Connection, window_months: int) -> tuple[list[dict], date]:
    """The whole detection pool plus the reference "now"."""
    return _pool_rows(conn, window_months), _reference_now(conn, window_months)


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


def _counterpart_of(series) -> str | None:
    """A series' far account, or None for an ordinary payee series. Read through a key check because not
    every caller hands this code a full `recurring_series` row — several build one from a narrower
    SELECT, and a missing column there means "not a transfer", not an error."""
    try:
        keys = series.keys()
    except AttributeError:
        return series.get("counterpart_account_id")
    return series["counterpart_account_id"] if "counterpart_account_id" in keys else None


def _transfer_payee_key(from_account_id: str, to_account_id: str) -> str:
    """A stable internal key for a movement between two accounts. A transfer series has no payee — that
    is the point of it — but `payee_key` is the column every other part of the subsystem groups and
    scopes by, so it carries the identity that *does* hold still. Never shown; the card is titled by the
    accounts and by the most common recent descriptor among its members."""
    return f"transfer:{from_account_id}:{to_account_id}"


def load_transfer_decisions(conn: sqlite3.Connection) -> tuple[dict[str, str], set[str]]:
    """The user's answers to ambiguous pairings: which counterpart a row has (`chosen`), and which rows
    were told to stop asking (`dismissed`). A NULL counterpart is the dismissal — one column expressing
    both answers, because they answer the same question."""
    chosen: dict[str, str] = {}
    dismissed: set[str] = set()
    for row in conn.execute(
        "SELECT paying_txn_id, receiving_txn_id FROM transfer_pair_decision"
    ).fetchall():
        if row["receiving_txn_id"]:
            chosen[row["paying_txn_id"]] = row["receiving_txn_id"]
        else:
            dismissed.add(row["paying_txn_id"])
    return chosen, dismissed


def detect_transfer_series(pool: list[dict], ref_now: date, *, chosen: dict[str, str] | None = None,
                           dismissed: set[str] | None = None) -> tuple[list[dict], set]:
    """Candidate series for movements between two tracked accounts, and **every** row that turned out to
    be half of a movement. Returns `(candidates, paired_ids)`.

    Rows are paired first and scored second, which is the inversion this exists for: the rhythm is read
    off the *movements*, so a payee spelled sixteen ways over ten years is one series rather than three
    broken ones and a couple of hundred orphans. A candidate owns **both** legs of each pair it claims,
    which is what stops the payee pass from re-deriving those rows into per-account series afterwards.

    **`paired_ids` is wider than the candidates on purpose, and that is the point of returning it
    separately.** A pair that never settles into a rhythm is still a pair: the money moved between two of
    the user's own accounts, so those rows are not merchant activity and must not be read as a payee
    series. Withholding only the rows a *series* claimed left a card paid at irregular intervals (gaps of
    1 to 50 days, amounts $400 to $5,600) surfacing as a handful of one-sided suggestions on each
    account — the same per-account fragments the pairing exists to remove, minus the rhythm that would
    have justified them. Not being a series is a fine answer for such a movement; being a merchant is not.
    """
    pairs, _ambiguous = pair_money_movements(pool, chosen=chosen, dismissed=dismissed)
    paired_ids = {i for pair in pairs for i in (pair["out_id"], pair["in_id"])}
    by_id = {row["id"]: row for row in pool}
    candidates = []
    for (from_account_id, to_account_id, category_id), group in pairs_by_movement(pairs).items():
        # One movement per date, as everywhere else in this file: a periodic series holds at most one
        # occurrence per date, and a second same-day pair is a different movement, not a faster cadence.
        occ_rows = [{"id": p["out_id"], "date": p["date"], "amount": p["amount"], "_pair": p}
                    for p in group]
        occ = _one_per_date(occ_rows, _reference_amount(occ_rows))
        scored = _score(occ, ref_now)
        if scored is None:
            continue
        cadence, period_days, confidence = scored
        amounts = [o["amount"] for o in occ]
        last_date = occ[-1]["date"]
        paying_rows = [by_id[o["_pair"]["out_id"]] for o in occ]
        member_ids = [i for o in occ for i in (o["_pair"]["out_id"], o["_pair"]["in_id"])]
        candidates.append({
            "payee_key": _transfer_payee_key(from_account_id, to_account_id),
            "display_name": _select_display_name(paying_rows, ref_now, period_days) or "Transfer",
            "category_id": category_id,
            "account_id": from_account_id,
            "counterpart_account_id": to_account_id,
            "cadence": cadence,
            "period_days": period_days,
            # Magnitudes: a movement has a size and a direction, and the direction is the account pair.
            "expected_amount": round(statistics.median(amounts), 2),
            "amount_min": round(min(amounts), 2),
            "amount_max": round(max(amounts), 2),
            "last_txn_date": last_date.isoformat(),
            "next_due_date": (last_date + timedelta(days=period_days)).isoformat(),
            # Rows, not movements — the count beside a link is what the link opens, and the drill-down
            # lists both legs. `transfer_count` carries the number of times the money actually moved.
            "occurrence_count": len(member_ids),
            "transfer_count": len(occ),
            "confidence": confidence,
            "member_ids": member_ids,
            "amount_tight": _amount_is_tight(occ),
            "amount_mode": AMOUNT_MODE_VARIABLE,
        })
    return candidates, paired_ids


def transfer_review(conn: sqlite3.Connection, *, window_months: int = _WINDOW_MONTHS_DEFAULT) -> dict:
    """The pairings the detector refused to make, for the user to settle.

    One case reaches here, and it is a refusal rather than a failure: a paying row whose nearest
    candidate counterpart is a **tie**. Nothing in the ledger distinguishes two same-day, same-amount
    rows on different accounts, and guessing files real money against the wrong payment. Ties are rare
    (one row in 18,400 on the reference ledger) and an unsettled one costs nothing — its rows fall
    through to payee matching, which is what they had before any of this existed.

    **Nothing else is reported, on purpose.** A movement between two tracked accounts under one category
    *is* the payment, so it claims its rows outright rather than asking permission of whatever payee
    series happens to hold them (`scan_and_store`). The one claim it yields to is a rule-backed series,
    where membership is an instruction the user wrote; that is not a question either, so it is not asked.

    Derived on read, like the pairing itself, so it always describes the ledger as it stands.
    """
    pool, _ref_now = _load_pool(conn, window_months)
    chosen, dismissed = load_transfer_decisions(conn)
    _pairs, ambiguous = pair_money_movements(pool, chosen=chosen, dismissed=dismissed)
    names = {r["id"]: r["display_name"] for r in conn.execute(
        "SELECT id, display_name FROM account").fetchall()}

    def _row_view(row):
        return {
            "id": row["id"],
            "date": row["date"].isoformat(),
            "amount": row["amount"],
            "name": row["display"],
            "account_id": row["account_id"],
            "account_name": names.get(row["account_id"]),
        }

    # Everything the user has already answered, so a decision can be taken back. Kept in the same
    # payload rather than behind a second request: a hidden item is only interesting beside the list it
    # was hidden from, and one fetch means the count and the list can never disagree.
    txn_names = {}
    settled_ids = list(chosen.keys()) + list(dismissed)
    if settled_ids:
        marks = ",".join("?" * len(settled_ids))
        txn_names = {
            r["id"]: (r["date"], r["amount"], names.get(r["account_id"]))
            for r in conn.execute(
                f"SELECT t.id AS id, t.date AS date, t.amount AS amount, "
                f"       COALESCE(a.parent_account_id, t.account_id) AS account_id "
                f"FROM txn t JOIN account a ON a.id = t.account_id WHERE t.id IN ({marks})",
                settled_ids,
            ).fetchall()
        }
    hidden = [
        {
            "kind": "paired" if paying in chosen else "dismissed",
            "label": (f"{txn_names[paying][2]} · {txn_names[paying][0]}"
                      if paying in txn_names else "A transaction no longer in range"),
            "detail": txn_names[paying][1] if paying in txn_names else None,
            "paying_txn_id": paying,
        }
        for paying in settled_ids
    ]

    return {
        "ambiguous": [
            {
                "row": _row_view(a["row"]),
                "day_offset": a["day_offset"],
                "candidates": [_row_view(c) for c in a["candidates"]],
            }
            for a in ambiguous
        ],
        "hidden": hidden,
    }


def _match_transfer_members(pool: list[dict], series: sqlite3.Row, decisions) -> list[dict]:
    """The rows a user-owned transfer series currently owns: both legs of every pair running between its
    two accounts under its category. Re-pairs the pool rather than trusting the stored membership, for
    the same reason payee membership is recomputed — it is a cache of what currently matches."""
    chosen, dismissed = decisions
    pairs, _ = pair_money_movements(pool, chosen=chosen, dismissed=dismissed)
    keys = series.keys()
    wanted = (series["scope_account_id"] or series["account_id"],
              (series["counterpart_scope_account_id"] if "counterpart_scope_account_id" in keys
               else _counterpart_of(series)),
              series["category_id"])
    by_id = {row["id"]: row for row in pool}
    out = []
    for pair in pairs:
        if group_key(pair) != wanted:
            continue
        out.extend(by_id[i] for i in (pair["out_id"], pair["in_id"]) if i in by_id)
    return out


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
            (id, payee_key, display_name, category_id, account_id, counterpart_account_id, cadence,
             period_days, expected_amount, amount_min, amount_max, amount_mode, last_txn_date,
             next_due_date, occurrence_count, confidence, status, source, confirmed, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?,
                COALESCE(?, datetime('now')), datetime('now'))
        """,
        (
            series_id, series["payee_key"], series["display_name"], series["category_id"],
            series["account_id"], series.get("counterpart_account_id"),
            series["cadence"], series["period_days"],
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


def _reconcile_priority(series: sqlite3.Row, rule_rank: dict[str, int]):
    """Order series so exclusive row-claiming is deterministic and sensible: rule-backed first, in rule
    precedence, then active before ended, account-scoped before account-agnostic, higher confidence first,
    then id for a stable tiebreak."""
    is_rule = series["source"] == "rule" and series["rule_id"]
    return (
        # A rule's matches are the rule's. Membership there is an instruction the user wrote, not a
        # reading taken off the ledger, so it claims ahead of everything, ended or not — including a
        # movement, whose own precedence below exists to beat *inferred* payee series rather than authored
        # ones. It is also what lets a scoped scan leave the rule-backed series alone when no edited row
        # touches one: no other series can take their rows.
        0 if is_rule else 1,
        # Between two rule-backed series matching one row, the rule that wins its category takes it, ended
        # or not, so a row's series and its category come from the same rule (`docs/data-model.md` → *How
        # matching rules combine*). A rule no longer live sorts last; its series has no members anyway.
        rule_rank.get(series["rule_id"], len(rule_rank)) if is_rule else 0,
        1 if series["status"] == "ended" else 0,       # active before ended
        # A two-legged movement claims next. Its rows are the ones a payee reading gets *wrong* — the
        # same movement described differently by each institution — so letting a payee series take them
        # first would recreate the per-account fragments the pairing exists to replace.
        0 if _counterpart_of(series) else 1,
        0 if series["account_id"] else 1,              # account-scoped before agnostic
        -(series["confidence"] or 0.0),                # higher confidence first
        series["id"],                                  # stable
    )


def _rule_precedence_rank(conn: sqlite3.Connection) -> dict[str, int]:
    """rule_id -> position in the categorization precedence order (0 wins), read from the engine's own
    ordering so a series cannot rank its rule differently from how the rule categorizes."""
    rows = conn.execute(
        f"SELECT id FROM category_rule WHERE deleted_at IS NULL ORDER BY {rule_specificity_order_sql('')}"
    ).fetchall()
    return {row["id"]: index for index, row in enumerate(rows)}


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
    loaded once so membership can be computed from the pool without a per-series query. Membership reads
    the matcher columns (categorizer.rule_matches_row); `priority_level` rides along because the rows are
    also the series' fingerprint (`_rule_fingerprint`), and priority decides which of two recurring rules
    takes a row they both match."""
    rule_ids = {s["rule_id"] for s in series_list if s["source"] == "rule" and s["rule_id"]}
    if not rule_ids:
        return {}
    placeholders = ",".join("?" * len(rule_ids))
    rows = conn.execute(
        f"""SELECT id, keyword, match_expr, owner_id, {rule_scope_account_sql()}, account_type,
                   amount_min, amount_max, debit_credit, match_source_text, priority_level
            FROM category_rule WHERE id IN ({placeholders})""",
        list(rule_ids),
    ).fetchall()
    return {r["id"]: r for r in rows}


def _rule_fingerprint(series_rules: dict, rule_id: str) -> str:
    """The matcher a rule-backed series was last reconciled against, as stored in
    `recurring_series.rule_fingerprint`. A scoped scan compares it with the rule as it stands, so an edit
    to the rule, made on any of the paths that write one, brings the series back into scope without each
    of those paths having to say so. A rule that no longer exists has a fingerprint of its own."""
    rule = series_rules.get(rule_id)
    return json.dumps(dict(rule), sort_keys=True, default=str) if rule is not None else "missing"


def _candidate_members(pool: list[dict], series: sqlite3.Row, series_rules: dict, decisions) -> list[dict]:
    """The rows a series should currently own, before overrides/exclusivity. A rule-backed series
    (`source='rule'`) owns exactly its rule's matches (the shared categorizer predicate, so membership
    equals what the rule categorizes); every other series uses the derived payee/category/account match."""
    if _counterpart_of(series):
        return _match_transfer_members(pool, series, decisions)
    if series["source"] == "rule" and series["rule_id"]:
        rule = series_rules.get(series["rule_id"])
        if rule is None:  # rule deleted out from under the series — no members until it's cleaned up
            return []
        return [row for row in pool if rule_matches_row(rule, row)]
    return _match_members(pool, series)


def _rule_backed_holdings(conn: sqlite3.Connection, pool: list[dict]) -> set:
    """The rows the rule-backed series will hold, read ahead of the reconcile that assigns them.

    A movement about to be created needs to know which rows it may not take, and a rule's matches are
    the only claim that outranks it — every other holder yields (see `scan_and_store`). `pool` is the
    rows the movements would take, so every rule-backed series is asked about those rows alone, whether
    or not the scan has it in scope.

    Deliberately an over-estimate: it stops at candidate membership, where the reconcile goes on to
    thin the rows down by occurrence and exclusivity. Erring this way makes a movement defer to a rule
    slightly more often than it strictly must, which is the harmless direction — the other one would
    have a movement quietly take a row the rule names.
    """
    rule_series = conn.execute(
        f"SELECT s.*, {SERIES_SCOPE_ACCOUNT_SQL}, {COUNTERPART_SCOPE_ACCOUNT_SQL} FROM recurring_series s "
        f"WHERE s.source = 'rule' AND s.rule_id IS NOT NULL AND s.status != 'suppressed'"
    ).fetchall()
    if not rule_series:
        return set()
    series_rules = _load_series_rules(conn, rule_series)
    excludes = _load_overrides(conn)
    decisions = load_transfer_decisions(conn)
    held = set()
    for series in rule_series:
        excluded = excludes.get(series["id"], frozenset())
        held.update(m["id"] for m in _candidate_members(pool, series, series_rules, decisions)
                    if m["id"] not in excluded)
    return held


def reconcile_series(conn: sqlite3.Connection, series_list, pool: list[dict], *,
                     reserved: set | None = None) -> ReconcileResult:
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

    An ended series resumes (→ active) only when a charge it owns lands on/after its frozen next_due.

    `reserved` names rows a two-legged movement is about to be created around, and holds them back from
    the payee series that would otherwise match them. It is the mechanism behind "the pair wins": one
    payment recorded twice is one thing, identified by the money rather than by two descriptions that
    drift apart, so a payee reading of those rows is simply the wrong reading and does not get to keep
    them by having been confirmed first. Rule-backed series and existing movements are exempt — neither
    is that wrong reading."""
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
    # A transfer series' membership is re-paired here, so it has to pair the way the detector did —
    # including the user's own answers to ties, or reconcile would quietly hand back a different set.
    decisions = load_transfer_decisions(conn)

    rule_rank = (_rule_precedence_rank(conn)
                 if any(s["source"] == "rule" and s["rule_id"] for s in series_list) else {})

    resumed = 0
    for series in sorted((s for s in series_list if s["status"] != "suppressed"),
                         key=lambda s: _reconcile_priority(s, rule_rank)):
        sid = series["id"]
        excluded = excludes.get(sid, frozenset())
        members = [m for m in _candidate_members(pool, series, series_rules, decisions)
                   if m["id"] not in excluded]
        occ = [o for o in _series_occurrences(series, members) if o["id"] not in claimed]
        if reserved and series["source"] != "rule" and not _counterpart_of(series):
            occ = [o for o in occ if o["id"] not in reserved]
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
        if series["source"] == "rule" and series["rule_id"]:
            conn.execute("UPDATE recurring_series SET rule_fingerprint = ? WHERE id = ?",
                         (_rule_fingerprint(series_rules, series["rule_id"]), sid))
        claimed.update(o["id"] for o in occ)
    return ReconcileResult(claimed, resumed)


def link_series_members(conn: sqlite3.Connection, series_id: str, *, window_months: int = _WINDOW_MONTHS_DEFAULT) -> int:
    """Match one user-owned series to its transactions right now and refresh its observed stats, so a
    freshly created (or edited) series shows its members immediately instead of only after the next full
    scan. A single-series `reconcile_series` call — same matching, same never-steal-another-series'-row
    guard, scoped to this one series. Returns its member count."""
    series = conn.execute(
        f"SELECT s.*, {SERIES_SCOPE_ACCOUNT_SQL}, {COUNTERPART_SCOPE_ACCOUNT_SQL} "
        f"FROM recurring_series s WHERE s.id = ?", (series_id,)
    ).fetchone()
    if series is None:
        return 0
    # A rule-backed series is linked together with the others, since rule precedence decides which of
    # them holds a row both rules match (see `scan_and_store`).
    if series["source"] == "rule" and series["rule_id"]:
        relink_rule_series(conn, window_months=window_months)
    else:
        pool, _ = _load_pool(conn, window_months)
        reconcile_series(conn, [series], pool)
    return conn.execute(
        "SELECT COUNT(*) FROM txn WHERE recurring_series_id = ?", (series_id,)
    ).fetchone()[0]


def relink_rule_series(conn: sqlite3.Connection, *, window_months: int = _WINDOW_MONTHS_DEFAULT) -> None:
    """Reconcile every rule-backed series together, now. Called when one is created, edited or removed:
    rule precedence decides which of two holds a row both rules match, so a change to one can move rows
    into or out of another, and a removed one leaves rows another rule may claim."""
    rule_series = conn.execute(
        f"SELECT s.*, {SERIES_SCOPE_ACCOUNT_SQL}, {COUNTERPART_SCOPE_ACCOUNT_SQL} FROM recurring_series s "
        f"WHERE s.source = 'rule' AND s.rule_id IS NOT NULL AND s.status != 'suppressed'"
    ).fetchall()
    if not rule_series:
        return
    pool, _ = _load_pool(conn, window_months)
    reconcile_series(conn, rule_series, pool)


def _payee_keys_holding(conn: sqlite3.Connection, txn_ids: set[str]) -> set[str]:
    """The payee-series keys currently owning any of these rows — the scope a scoped scan has to add to
    its own so a series that must give up a paired row is actually reconsidered.

    Movement series are excluded (their key is a synthetic account pair, and they are always in scope
    already) and so are rule-backed ones, whose membership is the user's instruction rather than a
    reading to revisit. Reads the whole set of series links rather than querying by id: membership is a
    small, indexed slice of the ledger, and `txn_ids` here is every paired row, which would otherwise
    mean chunking hundreds of parameters into a query to learn the same thing."""
    if not txn_ids:
        return set()
    return {
        r["payee_key"] for r in conn.execute(
            """SELECT s.payee_key, t.id FROM txn t
               JOIN recurring_series s ON s.id = t.recurring_series_id
               WHERE s.counterpart_account_id IS NULL AND s.source != 'rule'"""
        ).fetchall()
        if r["id"] in txn_ids and r["payee_key"]
    }


def scan_and_store(conn: sqlite3.Connection, *, window_months: int = _WINDOW_MONTHS_DEFAULT,
                   payee_keys: set[str] | None = None) -> dict:
    """Idempotent rebuild. Rewrites auto+unconfirmed series from a fresh scan while preserving manual,
    confirmed, and suppressed series; a candidate matching a user-owned identity is not re-proposed.
    Recomputes txn membership across the board. Returns summary counts.

    `payee_keys` scopes the rebuild. `None` is the full global scan. A set restricts *every* step —
    detection, series partitioning, auto-series removal, reconciliation, and candidate insertion — to
    those payee keys, leaving every other payee's series and membership exactly as they are, and reads
    only the rows those steps can match. That is the cheap path every owed rescan takes
    (`settle_owed_rescans`): reprocess only the payees a write touched instead of the whole ledger. It is
    correct because detection groups by payee (so a scoped pool yields the same per-payee result) and
    `reconcile_series` never disturbs out-of-scope rows. The one thing a scoped pass skips is the
    payee-key re-derivation below — a global normalization-repair step the daily full-scan catch-up owns —
    so a scoped pass trusts the stored keys.

    Three things are deliberate exceptions to scoping by payee, because their membership is not decided
    by one. **Movements**: their identity is two accounts, so every money-movement row is read and every
    transfer series reconciled. **Rule-backed series**: their members are the rule's matches, which can
    span payees the scope doesn't name (varying names — the whole reason a rule is used). They are in scope
    when an edited row touches one (`_rule_series_touching`, recorded with the debt) or one's rule has
    changed since it was last reconciled (`_rule_fingerprint`), and then all of them are reconciled against
    the whole window, since rule precedence decides which of two holds a row both rules match. That is how a newly imported row matching a recurring rule attaches to its series right away
    without stamping membership through every insert path. **Payee series holding a paired row**: pairing
    is decided by the money, so a movement's two legs normally sit in different payee groups, and an edit
    to one leg's group changes what the other's may claim — the scope is widened to those groups below.

    **Every scan settles the rescans owed within its scope** (see `owe_recurring_rescan`), so a scoped
    scan takes the owed payees into its scope, and one owing a full scan becomes one."""
    owed = _owed_rescans(conn)
    if payee_keys is not None and owed:
        payee_keys = None if _FULL_SCAN_OWED in owed else set(payee_keys) | set(owed)
    owed_series: set[str] = set()
    if payee_keys is not None:
        owed_series = {k[len(_SERIES_OWED_PREFIX):] for k in payee_keys if k.startswith(_SERIES_OWED_PREFIX)}
        payee_keys = {k for k in payee_keys if not k.startswith(_SERIES_OWED_PREFIX)}
    ref_now = _reference_now(conn, window_months)
    full_pool = _pool_rows(conn, window_months) if payee_keys is None else None
    # Movements between two tracked accounts are detected first, and always over every money-movement row
    # in the window: a movement's identity is its two accounts, not a payee, so a pool scoped to one payee
    # holds only part of it and would pair the halves it happens to contain.
    movement_pool = ([r for r in full_pool if r["money_movement"]] if full_pool is not None
                     else _pool_rows(conn, window_months, _MONEY_MOVEMENT_SQL))
    chosen, dismissed = load_transfer_decisions(conn)
    transfer_candidates, paired = detect_transfer_series(
        movement_pool, ref_now, chosen=chosen, dismissed=dismissed)
    if payee_keys is not None:
        # Scope is a pure cost knob for the derived path: filtering the pool changes which payees are
        # processed, not the per-payee outcome (see reconcile_series) — with one exception, and it is the
        # one relationship in the detector that crosses payee groups. **A payee series holding a row that
        # pairs is always in scope**, whatever the caller asked for.
        #
        # Pairing is decided by the money, so the two legs of a movement usually sit in *different* payee
        # groups (that is the whole reason it exists). Categorizing one leg is therefore an edit whose
        # consequence lands on the other's group: filing a card payment's counterpart makes the pair, and
        # the payee series over the card's own legs — legitimately detected while nothing paired — becomes
        # a reading of one payment off two descriptions. Scoped to the edited payee alone, the scan would
        # never look at the group that has to give the rows up, and the stale series would survive until
        # the next full scan, sitting in the review list beside a Confirm that makes it permanent.
        payee_keys = payee_keys | _payee_keys_holding(conn, paired)
        pool = _payee_rows(conn, window_months, payee_keys)
    else:
        pool = full_pool
    # A rule says which rows belong to its series, so a movement never takes one. Every *other* holder
    # yields — see `reserved` below — because a payee series over these rows is a reading of two
    # descriptions of one payment, and the pair is that same payment read off the money instead. Whole
    # movements defer, never half of one: an occurrence is a pair, so a candidate that gave up one leg
    # would carry the wrong count and the wrong totals.
    movement_by_id = {r["id"]: r for r in movement_pool}
    rule_held = _rule_backed_holdings(conn, [
        movement_by_id[i] for cand in transfer_candidates for i in cand["member_ids"] if i in movement_by_id
    ])
    transfer_candidates = [cand for cand in transfer_candidates
                           if not any(i in rule_held for i in cand["member_ids"])]
    # **Every** paired row is withheld from the payee pass, not just the ones a movement series claimed.
    # This is what "the pair replaces the legs" means mechanically, and the wider set is deliberate: a
    # pair with no rhythm is still a pair, so reading its rows as a merchant is wrong even though reading
    # them as a series would also have been. `reserved` is the narrower set, because taking rows *away*
    # from an existing series needs somewhere for them to go.
    candidates = transfer_candidates + detect_recurring_series(
        [r for r in pool if r["id"] not in paired], ref_now)
    reserved = {i for cand in transfer_candidates for i in cand["member_ids"]}

    # Re-derive each existing series' stored payee_key from the names of the transactions it currently
    # owns, so a change to the normalization (or to name resolution) can't strand an existing series
    # with a stale key that no longer matches the pool. Derived from members, not the (editable) display
    # name, so renaming a series never breaks its matching. Suppressed series own no rows, so they fall
    # back to their display name. Skipped on a scoped pass (it is a global repair; the full catch-up
    # owns it), which therefore matches series by their stored key.
    if payee_keys is None:
        # Transfer series are excluded: their `payee_key` is a synthetic account-pair identity, not a
        # name, so re-deriving it from member descriptors would overwrite the one thing about them that
        # deliberately does not depend on descriptors.
        for r in conn.execute(
            "SELECT id, display_name FROM recurring_series WHERE counterpart_account_id IS NULL"
        ).fetchall():
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
    all_series = conn.execute(
        f"SELECT s.*, {SERIES_SCOPE_ACCOUNT_SQL}, {COUNTERPART_SCOPE_ACCOUNT_SQL} FROM recurring_series s"
    ).fetchall()
    rules_now = _load_series_rules(conn, all_series) if payee_keys is not None else {}

    def _rule_series_due(r) -> bool:
        return r["status"] != "suppressed" and (
            r["id"] in owed_series or r["rule_fingerprint"] != _rule_fingerprint(rules_now, r["rule_id"]))

    # The rule-backed series are reconciled together or not at all. Two can match one row, and rule
    # precedence decides which holds it, so a change to one can move rows into or out of another; and
    # reconcile never takes a row from a series outside the set it is given.
    rule_series_due = payee_keys is None or any(
        _rule_series_due(r) for r in all_series if r["source"] == "rule" and r["rule_id"])

    def _in_scope(r) -> bool:
        if payee_keys is None or r["counterpart_account_id"] is not None:
            return True  # a movement's identity is its accounts; a payee scope can't name it
        if r["source"] == "rule" and r["rule_id"]:
            return rule_series_due and r["status"] != "suppressed"
        return r["payee_key"] in payee_keys

    existing = [r for r in all_series if _in_scope(r)]
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
    # membership + stats + ended→resume. On a full scan this is *every* survivor (global exclusivity); on a
    # scoped pass reconcile leaves out-of-scope rows claimed by their own series alone. The rows it reads
    # are what the in-scope series can match: their payees and the money movements, and the whole window
    # once a rule-backed series is among them, since a rule's matches can span any payee.
    if full_pool is None and any(r["source"] == "rule" and r["rule_id"] for r in user_owned):
        full_pool = _pool_rows(conn, window_months)
    if full_pool is not None:
        reconcile_pool = full_pool
    else:
        pool_ids = {r["id"] for r in pool}
        reconcile_pool = pool + [r for r in movement_pool if r["id"] not in pool_ids]
    reconciled = reconcile_series(conn, user_owned, reconcile_pool, reserved=reserved)
    claimed, resumed = reconciled.claimed, reconciled.resumed

    # Auto candidates: skip any a user-owned series already covers — same payee+category whose account
    # scope overlaps (a NULL/account-agnostic series covers every account). This stops a redundant second
    # series (account-agnostic vs account-scoped) from being minted and fighting over the same rows.
    #
    # An amount-gated owned series covers only its own price point. Without that test, confirming one of
    # a biller's two subscriptions suppressed the other as redundant, and its charges were left linked to
    # nothing — the sibling was destroyed by the act of endorsing its neighbour.
    # A missing category on either side is agnostic, exactly as a missing account scope is. The category
    # is *derived from the member rows* and those rows keep changing — a rule or a hand edit recategorizes
    # them long after the fact — so an identity that treats NULL as a specific value lets a decision the
    # user already made walk out from under itself: a series suppressed while its charges were
    # uncategorized stopped covering the very same charges once they were categorized, and came back as a
    # fresh suggestion at the same payee, cadence and amounts. Nothing looks wrong in either row.
    #
    # Category stays part of the identity when both sides *have* one, and that is not a compromise: one
    # payee can carry genuinely different obligations, and collapsing them would destroy a correctly
    # detected series the same way ignoring the price point once did.
    #
    # A rule-backed series out of scope still covers: it keeps its rows, and its identity still names them.
    covering = user_owned + [r for r in all_series if r["source"] == "rule" and r["id"] not in user_owned_ids]

    def _covered_by_owned(cand):
        for r in covering:
            if not (r["payee_key"] == cand["payee_key"]
                    and (r["category_id"] == cand["category_id"]
                         or r["category_id"] is None or cand["category_id"] is None)
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
        if cand.get("counterpart_account_id"):
            # A movement is all-or-nothing. Its occurrences are *pairs*, so a candidate that could only
            # take the halves nobody else claimed would be a series of orphaned legs — the wrong count,
            # the wrong amounts, and a drill-down showing one side of a two-sided thing. Reconcile has
            # already reserved these rows, so this can only fire on a **scoped** scan, where a payee
            # series outside the scope keeps its links and is never asked to give them up. Deferring is
            # right there: the next full scan sees the whole ledger and takes them.
            if any(i in claimed for i in cand["member_ids"]):
                continue
            member_ids = list(cand["member_ids"])
        else:
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

    _settle_owed_rescans(conn, owed)
    return {
        "detected": len(candidates),
        "transfers": len(transfer_candidates),
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


# --- Owed rescans ---------------------------------------------------------------------------------------
# Every path that writes something a series is read off (a category, a name, a date, an amount, trash
# state, new rows) owes the payees it touched a rescan, because membership is a cache only a scan rewrites.
# Left stale, an edited row stays linked to a series it no longer belongs to: its menu opens the old series,
# the new series' drill-down never gains it, a missed-charge finding about it stays open, and a phantom
# series can sit in *Needs attention* beside a Confirm that would make the wrong reading permanent.
#
# **The debt is recorded in the write's own transaction, and the scan runs after it commits.** A scan is
# seconds of reading, and run inside the write it held the write lock for all of them, which is what
# starved other requests into "database is locked". Recording the debt durably is what makes the split
# safe: a scan that fails, or a process that stops before the scan runs, leaves the debt in
# `recurring_rescan_owed` rather than losing it, and whichever scan runs next settles it — every scan
# drains what is owed within its scope (`scan_and_store`). A debt that outlives
# `OWED_RESCAN_OVERDUE_MINUTES` is one whose settling scan failed or never ran: the app-load catch-up retries
# it, and Tasks reports it, since recurring results are then known to be out of date.
#
# A row's `generation` moves each time its payee is owed again, so a scan that read the debt before a
# later write settles only what it read, never the later write's claim.

# Owes a full scan rather than one payee's. Not a payee key: `_normalize_payee` keeps only letters, digits
# and spaces.
_FULL_SCAN_OWED = "*"

# Owes the rule-backed series named after the prefix. Not a payee key either: a payee key has no colon.
_SERIES_OWED_PREFIX = "series:"

# A debt is ordinarily settled within seconds of its write committing, so one still standing after this long
# means the settling scan failed or never ran. Younger debts are left alone: their own settling scan is
# running, and a second one beside it would only repeat its work.
OWED_RESCAN_OVERDUE_MINUTES = 2


def _owe(conn: sqlite3.Connection, payee_keys) -> None:
    conn.executemany(
        """INSERT INTO recurring_rescan_owed (payee_key, generation, owed_at) VALUES (?, 1, datetime('now'))
           ON CONFLICT(payee_key) DO UPDATE SET generation = generation + 1""",
        [(key,) for key in sorted(payee_keys)],
    )


# Bulk paths call this once per request, never once per row: each settling scan reads the window's money
# movements and its payees' rows, and one call per request keeps it to one scan.
def owe_recurring_rescan(conn: sqlite3.Connection, txn_ids, *, prior_payee_keys=frozenset()) -> None:
    """Record, inside the caller's write transaction, that the payees of `txn_ids` need a rescan, and so do
    the rule-backed series the rows touch (`_rule_series_touching`).

    The scope is the payees the rows belong to *now*, plus any they belonged to *before* — a rename moves
    a row between payee groups, so the group it left has to be reconsidered too, and the caller captures
    those keys before it writes. A category edit needs no prior key: the key is derived from the name, so
    both the old and the new series for that payee are already in scope.

    Re-evaluation is the whole contract, not re-attachment: a row that still belongs where it was stays
    put, and one that no longer matches is released for whatever else claims it. The caller runs
    `settle_owed_rescans` once its transaction has committed.
    """
    ids = [i for i in txn_ids if i]
    _owe(conn, set(prior_payee_keys) | payee_keys_for_ids(conn, ids)
         | {_SERIES_OWED_PREFIX + sid for sid in _rule_series_touching(conn, ids)})


def _rule_series_touching(conn: sqlite3.Connection, txn_ids: list[str]) -> set[str]:
    """The rule-backed series an edit to these rows can change: one that holds a row now (it may be
    leaving), and one whose rule matches a row as it now stands (it may be joining). Nothing else about a
    rule-backed series moves with an edit, because its members are its rule's matches and it claims ahead
    of every other series (`_reconcile_priority`), so an edit touching none of them leaves them alone; one
    touching any brings them all into the scan, since they share rows by rule precedence. A change to the
    rule itself is caught by the scan instead (`_rule_fingerprint`)."""
    rule_series = conn.execute(
        "SELECT * FROM recurring_series WHERE source = 'rule' AND rule_id IS NOT NULL AND status != 'suppressed'"
    ).fetchall()
    if not rule_series or not txn_ids:
        return set()
    by_id = {r["id"]: r for r in rule_series}
    touched: set[str] = set()
    for start in range(0, len(txn_ids), 500):
        chunk = txn_ids[start:start + 500]
        touched |= {
            r["recurring_series_id"] for r in conn.execute(
                f"SELECT recurring_series_id FROM txn WHERE id IN ({','.join('?' * len(chunk))})", chunk
            ).fetchall()
            if r["recurring_series_id"] in by_id
        }
    rows = _pool_rows_by_id(conn, _WINDOW_MONTHS_DEFAULT, txn_ids)
    rules = _load_series_rules(conn, rule_series)
    for series in rule_series:
        rule = rules.get(series["rule_id"])
        if rule is not None and series["id"] not in touched and any(rule_matches_row(rule, row) for row in rows):
            touched.add(series["id"])
    return touched


def owe_full_recurring_scan(conn: sqlite3.Connection) -> None:
    """Record, inside the caller's write transaction, that the whole ledger needs a rescan — for a write
    whose effect is not confined to payees it can name."""
    _owe(conn, {_FULL_SCAN_OWED})


def _owed_rescans(conn: sqlite3.Connection, *, overdue_only: bool = False) -> dict[str, int]:
    sql = "SELECT payee_key, generation FROM recurring_rescan_owed"
    params: tuple = ()
    if overdue_only:
        sql += " WHERE owed_at <= datetime('now', ?)"
        params = (f"-{OWED_RESCAN_OVERDUE_MINUTES} minutes",)
    return {r["payee_key"]: r["generation"] for r in conn.execute(sql, params).fetchall()}


def _settle_owed_rescans(conn: sqlite3.Connection, owed: dict[str, int]) -> None:
    conn.executemany(
        "DELETE FROM recurring_rescan_owed WHERE payee_key = ? AND generation = ?", list(owed.items()),
    )


def _run_owed(conn: sqlite3.Connection, owed: dict[str, int], window_months: int) -> dict:
    if _FULL_SCAN_OWED in owed:
        return run_auto_scan(conn, window_months=window_months)
    return scan_and_store(conn, window_months=window_months, payee_keys=set(owed))


def settle_owed_rescans(*, window_months: int = _WINDOW_MONTHS_DEFAULT) -> dict | None:
    """Run the rescans owed, in a connection of its own, after the caller's write has committed.

    Never raises: the write it follows has already succeeded and must not be reported as failed. A failure
    leaves the debt standing for the next scan to settle, and is logged for whoever investigates why.
    Returns the scan summary, or None when nothing was owed or the scan failed."""
    try:
        with get_db() as conn:
            owed = _owed_rescans(conn)
            if not owed:
                return None
            return _run_owed(conn, owed, window_months)
    except Exception as err:
        log_error(f"[recurring] owed rescan failed: {err}", exc_info=err)
        return None


def overdue_owed_rescan_count(conn: sqlite3.Connection) -> int:
    """How many owed rescans have outlived `OWED_RESCAN_OVERDUE_MINUTES` — what Tasks reports."""
    return len(_owed_rescans(conn, overdue_only=True))


def auto_scan_due(conn: sqlite3.Connection, *,
                  min_interval_hours: float = _AUTO_SCAN_MIN_INTERVAL_HOURS) -> bool:
    """Whether `maybe_auto_scan` would do any work. Read-only, so the app-load caller can answer the common
    case (nothing due) without claiming the scan, which takes the write lock."""
    row = conn.execute("SELECT value FROM db_meta WHERE key = ?", (_LAST_SCAN_META_KEY,)).fetchone()
    if not row:
        return True
    due = conn.execute(
        "SELECT ((julianday('now') - julianday(?)) * 24.0 >= ?) IS NOT 0 AS due",
        (row["value"], min_interval_hours),
    ).fetchone()["due"]
    return bool(due) or bool(_owed_rescans(conn, overdue_only=True))


def maybe_auto_scan(conn: sqlite3.Connection, *, window_months: int = _WINDOW_MONTHS_DEFAULT,
                    min_interval_hours: float = _AUTO_SCAN_MIN_INTERVAL_HOURS) -> dict:
    """Scan only if one is *due*: never scanned (a fresh, or pre-recurring/older-schema, database), the
    last scan is older than `min_interval_hours`, or an owed rescan is overdue. This is the app-load
    catch-up, so detection stays current even when data arrives outside the import/sync paths (a restore,
    another tab, a schema migration) and a rescan whose settling scan failed is retried on the next load.
    Returns the scan summary, or ``{"skipped": True}`` when a recent scan makes it a no-op. `auto_scan_due`
    asks the same question without doing the work."""
    row = conn.execute("SELECT value FROM db_meta WHERE key = ?", (_LAST_SCAN_META_KEY,)).fetchone()
    last = row["value"] if row else None
    if last:
        # julianday() parses the stored datetime; a malformed value yields NULL → treat as due (rescan).
        due = conn.execute(
            "SELECT ((julianday('now') - julianday(?)) * 24.0 >= ?) IS NOT 0 AS due",
            (last, min_interval_hours),
        ).fetchone()["due"]
        if not due:
            if _owed_rescans(conn, overdue_only=True):
                return _run_owed(conn, _owed_rescans(conn), window_months)
            return {"skipped": True, "last_scan_at": last}
    return run_auto_scan(conn, window_months=window_months)
