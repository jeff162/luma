# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Pair the two rows one movement of money leaves behind, and read the rhythm off the pairs.

A transfer between two tracked accounts — or a credit-card payment — is a single movement that a ledger
organized by account necessarily records twice. Grouping by payee, the detector saw two unrelated things
and had to reconcile them afterwards; grouping by *pair*, it sees the movement itself. That reordering is
the whole point, because **the pair is identified by the money, never by the name**, and the name is the
part that does not hold still:

    one monthly card payment, ten years, **sixteen different descriptors** across the two institutions.
    Payee-grouped, it fell into three series with 15, 16 and 3 members — two of them carrying cadences
    invented from a stale slice — and 210 of its 244 rows belonged to no series at all. Paired, it is
    96 pairs at a median gap of 30 days.

**What makes a pair.** Two rows with the same absolute amount and the same category, on *different*
accounts, in opposite directions, within `PAIR_WINDOW_DAYS` of each other. Amounts are compared in cents;
the accounts are compared after merge resolution, so a merged child never appears to face its own parent.

**Why a date window rather than an exact date.** Two institutions post one movement on their own
schedules, and on the reference ledger a third of the pairs of a single card payment are one to three
days apart. Exact-date matching found 293 pairs across that ledger; ±3 days finds 660. The same width is
already used for the duplicate report's cross-account transfer twin.

**Why money movement only.** The category gate is what makes this safe rather than merely plausible: of
637 unambiguous pairs on the reference ledger, **634 were already in an excluded category**. The three
that were not are one-off coincidences — a shared meal, a refund — where two people's rows offset by
chance. Pairing those would invent a relationship; the gate costs nothing and removes the whole class.
"Money movement" is `excluded_categories.money_movement_sql`, not the exclusion alone: a shared meal filed
under Reimbursable is excluded too, and its repayment would otherwise pair with it here.

**Ambiguity refuses, and asks.** Where one row's best candidate is a tie, no pairing is recorded and the
case is surfaced for the user to settle — the app cannot tell which of two identical rows is the other
half, and picking one silently would file real money against the wrong movement. Ties are rare (23 rows
in 18,400 on the reference ledger) and an unsettled one costs nothing: its rows fall through to
payee-based detection, which is what they had before any of this existed.

**What the user settles is remembered, and is the only stored thing here.** `chosen` names a counterpart
outright and `dismissed` says a row has none — both taken as given, ahead of any inference, in the same
spirit as `account_pair_distinct` in the dedupe service: the pairing never learns from a decision it made
itself, only from one a person made. Everything else — the pairs, the groups, the rhythm — is re-derived
from the pool on each scan, exactly as membership is.
"""

from __future__ import annotations

from collections import defaultdict

# How far apart the two halves of one movement may post. See the module docstring: two institutions
# settle on their own schedules, and the same width backs the duplicate report's transfer twin.
PAIR_WINDOW_DAYS = 3


def _cents(amount) -> int:
    """Amounts in whole cents. The two halves of one movement carry the same magnitude exactly, but they
    arrive as floats, and 24.0 != 24.000000000000004 would quietly cost a pair."""
    return int(round(float(amount or 0.0) * 100))


def group_key(pair: dict) -> tuple:
    """What makes two pairs occurrences of the same recurring movement: the accounts it runs between,
    the direction it runs, and the category it is filed under. Deliberately **no payee** — that is the
    field this whole module exists to stop depending on."""
    return (pair["from_account_id"], pair["to_account_id"], pair["category_id"])


def pair_money_movements(rows: list[dict], *, window_days: int = PAIR_WINDOW_DAYS,
                         chosen: dict[str, str] | None = None,
                         dismissed: set[str] | None = None):
    """Pair the money-movement rows in a detection pool. Returns `(pairs, ambiguous)`.

    Each pair is one movement: the paying row, the receiving row, and the identity they share. `ambiguous`
    holds the paying rows whose best candidate was a tie — reported rather than resolved, since nothing in
    the ledger distinguishes two same-day, same-amount candidates and choosing between them silently
    would file real money against the wrong movement.

    Resolution is **nearest date first**, globally: every candidate edge is considered in order of how
    far apart its two rows posted, and an edge is taken only if neither row is already spoken for. So a
    same-day match always wins over a three-day one regardless of which row is examined first, which is
    what keeps the result independent of pool order.

    `chosen` and `dismissed` are the user's own answers to ties, and they are applied **before** any of
    that: a chosen pair is taken outright and both its rows leave the field, a dismissed row is withdrawn
    from matching entirely. Neither is re-examined, because inference is exactly what was found wanting
    in the case that produced the question.
    """
    chosen = chosen or {}
    dismissed = dismissed or set()
    movement = [r for r in rows if r.get("money_movement")]

    # The user's own answers first, and before the field is even laid out: a chosen pair is a fact, so
    # its rows are spoken for ahead of anything inferred, and a dismissed row is simply not there.
    by_id = {row["id"]: row for row in movement}
    settled_pairs, spoken_for = [], set(dismissed)
    for paying_id, receiving_id in chosen.items():
        out, inc = by_id.get(paying_id), by_id.get(receiving_id)
        if out is None or inc is None or out["account_id"] == inc["account_id"]:
            continue  # one of the rows has left the window, or is no longer a movement at all
        spoken_for.add(paying_id)
        spoken_for.add(receiving_id)
        settled_pairs.append({
            "date": out["date"],
            "amount": abs(float(out["amount"] or 0.0)),
            "category_id": out["category_id"],
            "from_account_id": out["account_id"],
            "to_account_id": inc["account_id"],
            "out_id": out["id"],
            "in_id": inc["id"],
            "day_offset": abs((inc["date"] - out["date"]).days),
        })
    movement = [row for row in movement if row["id"] not in spoken_for]

    buckets: dict[tuple, list[dict]] = defaultdict(list)
    for row in movement:
        buckets[(row["category_id"], abs(_cents(row["amount"])))].append(row)

    edges = []
    candidates_for: dict[str, list[tuple[int, dict]]] = defaultdict(list)
    for (category_id, _amount), bucket in buckets.items():
        outs = [r for r in bucket if _cents(r["amount"]) > 0]
        ins = [r for r in bucket if _cents(r["amount"]) < 0]
        for out in outs:
            for inc in ins:
                if out["account_id"] == inc["account_id"]:
                    continue  # a movement crosses accounts by definition
                distance = abs((inc["date"] - out["date"]).days)
                if distance > window_days:
                    continue
                edges.append((distance, str(out["date"]), out["id"], inc["id"], out, inc, category_id))
                candidates_for[out["id"]].append((distance, inc))

    # A tie at the closest distance is undecidable, so the paying row is withdrawn from matching entirely
    # rather than being handed to whichever candidate sorts first.
    tied: dict[str, dict] = {}
    for out_id, cands in candidates_for.items():
        best = min(d for d, _ in cands)
        closest = [row for d, row in cands if d == best]
        if len(closest) > 1:
            tied[out_id] = {"candidates": closest, "distance": best}

    pairs, used = list(settled_pairs), set()
    for distance, _d, out_id, in_id, out, inc, category_id in sorted(edges, key=lambda e: e[:4]):
        if out_id in tied or out_id in used or in_id in used:
            continue
        used.add(out_id)
        used.add(in_id)
        pairs.append({
            "date": out["date"],
            "amount": abs(float(out["amount"] or 0.0)),
            "category_id": category_id,
            "from_account_id": out["account_id"],
            "to_account_id": inc["account_id"],
            "out_id": out["id"],
            "in_id": inc["id"],
            "day_offset": distance,
        })

    ambiguous = [
        {
            "row": by_id[out_id],
            "candidates": info["candidates"],
            "day_offset": info["distance"],
        }
        for out_id, info in tied.items()
    ]
    pairs.sort(key=lambda p: (p["date"], p["out_id"]))
    ambiguous.sort(key=lambda a: a["row"]["date"], reverse=True)
    return pairs, ambiguous


def pairs_by_movement(pairs: list[dict]) -> dict[tuple, list[dict]]:
    """The pairs grouped into candidate recurring movements — one group per accounts+direction+category."""
    grouped: dict[tuple, list[dict]] = defaultdict(list)
    for pair in pairs:
        grouped[group_key(pair)].append(pair)
    for group in grouped.values():
        group.sort(key=lambda p: (p["date"], p["out_id"]))
    return dict(grouped)
