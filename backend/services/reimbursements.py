# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Reimbursable expenses — money that leaves as an expense and comes back later.

Three $250 concert tickets on one $750 card charge, two of them for friends who will pay their portion
back. A work expense paid personally and claimed afterwards. The ledger already records both movements
correctly; what it cannot say is that February's $750 was really $250 of spending, because the $500 that
offsets it does not arrive until July. The netting is right, it just crosses a period boundary.

The fix is a **holding category** rather than a restatement: the reimbursable portion is allocated (via
``txn_split``) to a leaf under the seeded, excluded ``Reimbursable`` group, and the later inflow lands
against the same group instead of against income. February then reports its own spending correctly on
its own, July reports no income, and the outstanding balance is simply the group's sum.

**A reimbursement tracks a *portion of* a transaction, not the transaction.** This is the load-bearing
decision and it was got wrong first time round. Splits exist so that one ledger row can mean several
things, so a consumer that treats a row as meaning one thing to it is fighting the feature it is built
on — and the cases that break are ordinary, not exotic:

- one $750 charge split three ways, two portions owed by *different* friends, is two separate debts that
  must be namable, repayable and settleable independently;
- one ATM deposit split across several buckets can carry repayments for two different debts at once.

So a link records a **claim** per transaction — how much of that row's receivable belongs to *this*
reimbursement — and a transaction may appear in as many reimbursements as it has receivable money to
divide between them. ``txn_link_member`` is keyed ``(link_id, txn_id)``, so several links over one
transaction need no schema change; the claims live in the link's ``metadata_json``, which is exactly
what that blob is for.

**Claims are stored as amounts, deliberately, not as split-part ids.** ``save_split`` deletes and
reinserts a transaction's parts on every edit, so part ids are not stable across an ordinary
re-split and a claim keyed on one would break the first time the user adjusted an amount. A part is
still how the *user* picks a portion — the picker offers "Dave's ticket $250" — but what is written down
is the amount, with the part's label kept alongside as display provenance that no arithmetic reads.

**The invariant is per portion, not per row.** A transaction's claims across all reimbursements may not
exceed its receivable, and what is left over is *unclaimed* — which is what the outstanding report lists
as loose and what the link picker offers. "At most one reimbursement per transaction" was the earlier
rule and is exactly what could not express the two cases above; do not reintroduce it.

**Completing is the terminal act, and it is not the same thing as settling a residual.** A
reimbursement that was repaid in full has nothing to move and still needs to be finishable — otherwise
it sits on the open list forever, which is precisely what happened when "already square" was an error
rather than the easy case. So `complete` means *this is finished*: it moves a residual where there is
one and simply closes where there is not. `reopen` reverses either.

**The residual is the feature.** A repayment is not reliably equal to the expense — tickets bought for
$250 may be sold on for $225 or $275 — so the receivable rarely closes cleanly, and what is left is the
point: repaid short leaves a real cost genuinely incurred, repaid over leaves a genuine gain, and not
repaid at all leaves money still outstanding. A short repayment and an unpaid one are indistinguishable
by amount and only the user can tell them apart, which is what makes **settling** an explicit act.

**Where a residual lands is decided by its sign, not by preference.** The residual is a category balance
rather than a row, so moving it means rewriting the allocations of a transaction that already exists:

- **positive** (repaid short, or never repaid) settles on an **expense** — the shortfall is money
  genuinely spent, and only an outbound row points the right way to absorb it. This restates the
  original period, deliberately.
- **negative** (repaid over) settles on a **repayment** — the surplus came back when the overpayment
  arrived, not when the tickets were bought.

That asymmetry is also why this feature needs no mixed-sign split. Settling *everything* on the expense
is the uniform-looking trap: a surplus larger than the buyer's own portion would drive the expense's real
category part negative, which ``txn_splits.validate_parts`` refuses by design. Sending a surplus to the
repayment instead is legal at any magnitude. Do not reach for a mixed-sign relaxation on this
feature's behalf.

**Roles are derived, never stated.** A member's role follows the sign of its claim — positive is an
expense, negative a repayment — so there is no second truth to drift from the ledger.

Follows the ``txn_link`` contract: the link never mutates what it joins. Settlement is performed here
and recorded in ``metadata_json`` — the target's prior allocations *and* the prior claims — so it can be
reversed exactly.

See ``docs/data-model.md`` -> *Reimbursable expenses* for the model, its invariants, the reminder rules
and the alternatives rejected on the way; ``docs/mechanism-index.md`` for the neighbouring mechanisms
this is not.
"""

from __future__ import annotations

import sqlite3
from datetime import date as date_cls, datetime, timedelta, timezone
from typing import Iterable, Optional, Sequence

from backend.json_utils import safe_json_dict
from backend.services.excluded_categories import reimbursable_leaf_ids
from backend.services.preferences import get_shared_preference, set_shared_preference
from backend.services.txn_links import (
    add_member,
    create_link,
    delete_link,
    get_link,
    remove_member,
    set_metadata,
)
from backend.services.txn_splits import SplitValidationError, get_split_parts, save_split

# The `txn_link.kind` this feature owns, and the two roles its members carry.
REIMBURSEMENT_LINK_KIND = "reimbursement"
EXPENSE_ROLE = "expense"
REPAYMENT_ROLE = "repayment"

# The record's name — a person, an employer, an occasion. Bounded because it is a name, not a
# description, and has to fit a row marker's tooltip on one line.
MAX_COUNTERPARTY_LENGTH = 120
# Display provenance for a claim ("Dave's ticket"), copied from the split part the user picked. Capped
# like a split label, which is where it comes from.
MAX_CLAIM_LABEL_LENGTH = 200

# Money reconciles at cent precision; comparing floats for equality would reject a claim that
# round-tripped through JSON. Mirrors `txn_splits._CENT`.
_CENT = 0.005

# How long a receivable is left alone before it is worth mentioning, and where that answer is kept.
#
# **Measured from the transaction's own date, never from when the record was made.** A reimbursement
# entered today for a charge in February is already seven months old, and dating the clock from the
# record would reset it every time the user got round to tidying up — the one action that must not
# postpone the reminder.
#
# 30 days rather than 45: the cost of firing early is one click to push it out, and the cost of firing
# late is the whole point of the feature, since an unsettled receivable is under-reported spending for
# as long as it sits there. Ledger-level rather than per-user (see `preferences.SHARED_SCOPE_ID`) —
# one ledger has one answer, and the reminders are shown to everyone regardless of whose accounts they
# are on.
DEFAULT_REMINDER_DAYS = 30
REMINDER_DAYS_PREF_KEY = "reimbursements.reminder_days"
# The ceiling is a sanity bound rather than a policy: a reminder further out than a few years is not a
# reminder. 0 means "never remind by default", which is the disable switch — a record may still carry a
# date of its own, which is what stops disabling the default from being a dead end.
MAX_REMINDER_DAYS = 3650


class ReimbursementError(ValueError):
    """A requested change would break one of this module's invariants. Carries a user-facing message."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _clean_text(value: Optional[str], limit: int) -> Optional[str]:
    text = (value or "").strip()
    return text[:limit] if text else None


def _round(value) -> float:
    try:
        return round(float(value), 2)
    except (TypeError, ValueError):
        raise ReimbursementError("That is not an amount.")


def _same_direction(a: float, b: float) -> bool:
    return (a > 0) == (b > 0)


def _today() -> str:
    return date_cls.today().isoformat()


def _clean_date(value: Optional[str]) -> Optional[str]:
    """An ISO date, or None. Anything unparseable is refused rather than stored: a reminder that never
    fires because its date is nonsense is worse than no reminder, since the screen still shows one."""
    text = (value or "").strip()
    if not text:
        return None
    try:
        return date_cls.fromisoformat(text[:10]).isoformat()
    except ValueError:
        raise ReimbursementError("That is not a date.")


# ---------------------------------------------------------------------------
# Reminders
# ---------------------------------------------------------------------------

def default_reminder_days(conn: sqlite3.Connection) -> int:
    """The household's default gap, clamped. An unreadable stored value falls back to the default rather
    than raising: this is read on the Tasks path, and a bad preference must not take the page down."""
    raw = get_shared_preference(conn, REMINDER_DAYS_PREF_KEY)
    if raw is None:
        return DEFAULT_REMINDER_DAYS
    try:
        days = int(str(raw).strip().strip('"'))
    except (TypeError, ValueError):
        return DEFAULT_REMINDER_DAYS
    return max(0, min(days, MAX_REMINDER_DAYS))


def set_default_reminder_days(conn: sqlite3.Connection, days: int) -> int:
    try:
        value = int(days)
    except (TypeError, ValueError):
        raise ReimbursementError("That is not a number of days.")
    if value < 0 or value > MAX_REMINDER_DAYS:
        raise ReimbursementError(f"Choose between 0 and {MAX_REMINDER_DAYS} days.")
    set_shared_preference(conn, REMINDER_DAYS_PREF_KEY, str(value))
    return value


def _default_due_date(from_date: Optional[str], days: int) -> Optional[str]:
    """When a receivable dated `from_date` starts being worth mentioning, or None where the default is
    switched off. Kept separate from the stored per-record date because they answer different questions:
    this one is derived and moves if the default changes, that one is a decision the user made."""
    if not days or not from_date:
        return None
    try:
        start = date_cls.fromisoformat(str(from_date)[:10])
    except ValueError:
        return None
    return (start + timedelta(days=days)).isoformat()


# ---------------------------------------------------------------------------
# Receivable money, and how much of it is spoken for
# ---------------------------------------------------------------------------

def receivable_amounts(conn: sqlite3.Connection, txn_ids: Sequence[str]) -> dict[str, float]:
    """Per transaction, how much of it sits in the receivable group.

    Keys on whether allocation rows **matched**, not on `txn.is_split`, for the same reason the split
    expansion seam does: a row flagged split with no parts, or parts with no flag, must not be able to
    make money appear or vanish. A transaction with parts is read entirely from its parts; one without
    is read from its own category.
    """
    ids = _unique(txn_ids)
    if not ids:
        return {}
    leaves = reimbursable_leaf_ids(conn)
    if not leaves:
        return {txn_id: 0.0 for txn_id in ids}

    id_places = ",".join("?" for _ in ids)
    leaf_places = ",".join("?" for _ in leaves)
    rows = conn.execute(
        f"""
        SELECT t.id AS txn_id,
               COALESCE(
                   sp.receivable,
                   CASE WHEN t.category_id IN ({leaf_places}) THEN t.amount ELSE 0 END
               ) AS receivable
        FROM   txn t
        LEFT   JOIN (
                   SELECT txn_id,
                          SUM(CASE WHEN category_id IN ({leaf_places}) THEN amount ELSE 0 END) AS receivable
                   FROM   txn_split
                   WHERE  txn_id IN ({id_places})
                   GROUP  BY txn_id
               ) sp ON sp.txn_id = t.id
        WHERE  t.id IN ({id_places})
        """,
        [*leaves, *leaves, *ids, *ids],
    ).fetchall()
    found = {row["txn_id"]: round(float(row["receivable"] or 0.0), 2) for row in rows}
    return {txn_id: found.get(txn_id, 0.0) for txn_id in ids}


def receivable_parts(conn: sqlite3.Connection, txn_id: str) -> list[dict]:
    """The receivable portions of one transaction, as the picker offers them.

    A split row yields one entry per receivable allocation — which is what lets two portions of a single
    charge belong to two different people — while an unsplit row yields the single portion it is. The
    entries carry no durable identity on purpose: they are a way to *choose* an amount, and what gets
    stored is the amount (see the module docstring).
    """
    leaves = set(reimbursable_leaf_ids(conn))
    if not leaves:
        return []
    parts = get_split_parts(conn, txn_id)
    if parts:
        return [
            {"amount": round(float(part["amount"]), 2), "label": part["label"] or part["category_name"]}
            for part in parts
            if part["category_id"] in leaves
        ]
    row = conn.execute("SELECT amount, category_id FROM txn WHERE id = ?", (txn_id,)).fetchone()
    if not row or row["category_id"] not in leaves:
        return []
    return [{"amount": round(float(row["amount"]), 2), "label": None}]


def _claims_by_txn(conn: sqlite3.Connection, txn_ids: Sequence[str]) -> dict[str, list[dict]]:
    """Every reimbursement claim standing against these transactions, whichever link holds it."""
    ids = _unique(txn_ids)
    if not ids:
        return {}
    places = ",".join("?" for _ in ids)
    rows = conn.execute(
        f"""SELECT DISTINCT l.id AS link_id, l.metadata_json
            FROM   txn_link l
            JOIN   txn_link_member m ON m.link_id = l.id
            WHERE  l.kind = ? AND m.txn_id IN ({places})""",
        [REIMBURSEMENT_LINK_KIND, *ids],
    ).fetchall()
    wanted = set(ids)
    claimed: dict[str, list[dict]] = {}
    for row in rows:
        for txn_id, claim in _read_claims(row["metadata_json"]).items():
            if txn_id in wanted:
                claimed.setdefault(txn_id, []).append({"link_id": row["link_id"], **claim})
    return claimed


def claimed_amounts(conn: sqlite3.Connection, txn_ids: Sequence[str]) -> dict[str, float]:
    """Per transaction, how much of its receivable is already spoken for by some reimbursement."""
    by_txn = _claims_by_txn(conn, txn_ids)
    return {
        txn_id: round(sum(claim["amount"] for claim in by_txn.get(txn_id, [])), 2)
        for txn_id in _unique(txn_ids)
    }


def unclaimed_amounts(conn: sqlite3.Connection, txn_ids: Sequence[str]) -> dict[str, float]:
    """Per transaction, the receivable money no reimbursement has claimed yet.

    This is the figure the outstanding report lists as loose and the link picker offers, and it is what
    makes a split ATM deposit work: claim $250 of it for one debt and $350 is still there to claim for
    another.
    """
    receivable = receivable_amounts(conn, txn_ids)
    claimed = claimed_amounts(conn, txn_ids)
    return {
        txn_id: round(receivable.get(txn_id, 0.0) - claimed.get(txn_id, 0.0), 2)
        for txn_id in _unique(txn_ids)
    }


def _unique(txn_ids: Iterable[str]) -> list[str]:
    """De-duplicate while keeping the caller's order — a repeated id is a selection artifact."""
    seen: set[str] = set()
    ordered: list[str] = []
    for txn_id in txn_ids or []:
        if txn_id and txn_id not in seen:
            seen.add(txn_id)
            ordered.append(txn_id)
    return ordered


def _role_for(amount: float) -> str:
    return EXPENSE_ROLE if amount > 0 else REPAYMENT_ROLE


# ---------------------------------------------------------------------------
# The link's own payload
# ---------------------------------------------------------------------------

def _read_claims(metadata) -> dict[str, dict]:
    """The claims out of a link's metadata, tolerant of a payload written by an older build.

    A link with no claims block is read as claiming nothing rather than as claiming everything: an
    unreadable payload must not be able to silently absorb a transaction's whole receivable into a
    reimbursement nobody said it belonged to.
    """
    data = metadata if isinstance(metadata, dict) else safe_json_dict(metadata)
    raw = data.get("claims")
    if not isinstance(raw, dict):
        return {}
    claims: dict[str, dict] = {}
    for txn_id, value in raw.items():
        if not isinstance(value, dict):
            continue
        try:
            amount = round(float(value.get("amount")), 2)
        except (TypeError, ValueError):
            continue
        if abs(amount) < _CENT:
            continue
        claims[str(txn_id)] = {"amount": amount, "label": value.get("label")}
    return claims


def _read_remind_on(metadata) -> Optional[str]:
    """The record's own reminder date, if it has been given one. Absent means *use the household
    default*; the explicit string `""` means the user turned this record's reminder off, which is a
    different answer and has to survive as one — collapsing them would make "no reminder" revert to the
    default on the next save."""
    # `get_link` hands back an already-parsed dict; `safe_json_dict` is the fallback for a raw payload.
    # Mirrors `_read_claims` — reading only the string form here is what made every stored reminder read
    # as absent, so a switched-off one quietly returned to following the default on the next save.
    data = metadata if isinstance(metadata, dict) else safe_json_dict(metadata)
    if "remind_on" not in data:
        return None
    value = data.get("remind_on")
    return "" if not value else str(value)[:10]


def _metadata(
    claims: dict[str, dict],
    completion: Optional[dict] = None,
    remind_on: Optional[str] = None,
) -> dict:
    """The link's stored blob: its claims, the settlement record once it has one, and the reminder.

    A free-text **note** used to ride here too. It was removed because it earned nothing: the record's
    name is free text already and appears everywhere the record does, while the note reached exactly one
    surface. Nothing migrates — metadata is a JSON blob, so a note stored by an earlier version simply
    stops being read.
    """
    data: dict = {"claims": {
        txn_id: {"amount": claim["amount"], "label": claim.get("label")}
        for txn_id, claim in claims.items()
    }}
    if completion is not None:
        data["completion"] = completion
    # Written only when the record has an answer of its own, so an untouched record keeps following the
    # household default rather than being frozen at whatever it happened to be on the day it was made.
    if remind_on is not None:
        data["remind_on"] = remind_on
    return data


# ---------------------------------------------------------------------------
# Reading a reimbursement
# ---------------------------------------------------------------------------

def _member_rows(conn: sqlite3.Connection, link: dict) -> list[dict]:
    """The link's transactions, oldest first, each carrying **this link's claim** rather than the row's
    whole receivable — which is the difference that lets one charge serve two reimbursements."""
    claims = _read_claims(link.get("metadata"))
    txn_ids = [member["txn_id"] for member in link.get("members", [])]
    if not txn_ids:
        return []
    places = ",".join("?" for _ in txn_ids)
    rows = conn.execute(
        f"""
        SELECT t.id AS txn_id, t.date, t.amount, t.trashed_at, t.owner_id,
               COALESCE(NULLIF(t.display_name, ''), NULLIF(t.merchant_name, ''), NULLIF(t.raw_name, ''), '') AS payee,
               COALESCE(a.display_name, a.name, '') AS account_name,
               o.name AS owner_name
        FROM   txn t
        LEFT   JOIN account a ON a.id = t.account_id
        LEFT   JOIN owner   o ON o.id = t.owner_id
        WHERE  t.id IN ({places})
        ORDER  BY t.date, t.id
        """,
        txn_ids,
    ).fetchall()
    receivable = receivable_amounts(conn, txn_ids)
    members = []
    for row in rows:
        claim = claims.get(row["txn_id"])
        if not claim:
            continue
        members.append({
            "txn_id": row["txn_id"],
            "date": row["date"],
            "amount": row["amount"],
            "payee": row["payee"],
            "account_name": row["account_name"],
            # `txn.owner_id`, not a join through to the account's: the transaction's own owner is what
            # every owner filter in the app reads, and it is stamped from the account when the row is
            # created. Reading the account here instead would disagree with the ledger the moment an
            # owner had been corrected on a single row.
            "owner_id": row["owner_id"],
            "owner_name": row["owner_name"],
            "trashed": row["trashed_at"] is not None,
            "claim": claim["amount"],
            "claim_label": claim.get("label"),
            # What the whole row holds, so the panel can say "$250 of this $750 charge" without a
            # second request — and so a claim that has outgrown its row is visible rather than silent.
            "receivable": receivable.get(row["txn_id"], 0.0),
            "role": _role_for(claim["amount"]),
        })
    return members


def _summarize(link: dict, members: Sequence[dict]) -> dict:
    """The reimbursement as every read path returns it.

    The residual is the sum of this link's claims — its slice of the receivable balance — which is why
    no role special-casing appears in the arithmetic: an expense portion contributes what is owed and a
    repayment portion what came back, already signed.

    Trashed members are excluded from the figures but kept in the list: a transaction that silently
    vanishes from a reimbursement is worse than one shown as removed, and trash is reversible.
    """
    metadata = link.get("metadata") or {}
    live = [member for member in members if not member["trashed"]]
    owed = round(sum(m["claim"] for m in live if m["claim"] > 0), 2)
    repaid = round(sum(m["claim"] for m in live if m["claim"] < 0), 2)
    remind_on = _read_remind_on(metadata)
    # The record's clock starts at its **oldest expense**, not at its creation or its earliest member of
    # any kind: a repayment arriving is progress, and letting it restart the clock would postpone the
    # reminder every time something came back. Where nothing is owed yet — a credit recorded on its own
    # — there is nothing to be waiting for, so there is no date to derive.
    expense_dates = sorted(m["date"] for m in live if m["claim"] > 0 and m.get("date"))
    return {
        "id": link["id"],
        "counterparty": link.get("external_ref"),
        "owed": owed,
        "repaid": repaid,
        "residual": round(owed + repaid, 2),
        "completion": metadata.get("completion"),
        "completed": bool(metadata.get("completion")),
        "created_at": link.get("created_at"),
        # `None` means "follow the household default", `""` means the user switched this one off, and a
        # date means they chose it. The three are distinct on purpose — see `_read_remind_on`.
        "remind_on": remind_on,
        "expense_date": expense_dates[0] if expense_dates else None,
        "members": list(members),
    }


def _load(conn: sqlite3.Connection, link_id: str) -> dict:
    link = get_link(conn, link_id)
    if not link or link["kind"] != REIMBURSEMENT_LINK_KIND:
        raise ReimbursementError("No such reimbursement.")
    return _summarize(link, _member_rows(conn, link))


def get_reimbursement(conn: sqlite3.Connection, link_id: str) -> dict:
    return _load(conn, link_id)


def reimbursements_for_txn(conn: sqlite3.Connection, txn_id: str) -> list[dict]:
    """Every reimbursement this transaction has a portion in — a list, because a split row may serve
    several. Newest last, so the panel reads in the order they were created."""
    rows = conn.execute(
        """SELECT l.id
           FROM   txn_link l
           JOIN   txn_link_member m ON m.link_id = l.id
           WHERE  m.txn_id = ? AND l.kind = ?
           ORDER  BY l.created_at, l.rowid""",
        (txn_id, REIMBURSEMENT_LINK_KIND),
    ).fetchall()
    return [_load(conn, row["id"]) for row in rows]


# ---------------------------------------------------------------------------
# Building and editing a reimbursement
# ---------------------------------------------------------------------------

def _normalize_claims(raw_claims: Iterable[dict]) -> dict[str, dict]:
    """A caller's requested claims, de-duplicated by transaction and with amounts rounded.

    A repeated transaction is a selection artifact rather than a request to claim it twice, so the last
    entry wins — the alternative, summing them, would silently double a portion the user only meant once.
    """
    normalized: dict[str, dict] = {}
    for entry in raw_claims or []:
        txn_id = (entry or {}).get("txn_id")
        if not txn_id:
            continue
        amount = entry.get("amount")
        normalized[str(txn_id)] = {
            "amount": None if amount is None else _round(amount),
            "label": _clean_text(entry.get("label"), MAX_CLAIM_LABEL_LENGTH),
        }
    return normalized


def _resolve_claims(
    conn: sqlite3.Connection,
    requested: dict[str, dict],
    *,
    excluding_link_id: Optional[str] = None,
) -> dict[str, dict]:
    """Turn requested claims into stored ones, or say why they cannot stand.

    An amount left unstated claims whatever of that row is still going spare, which is the whole answer
    for the ordinary case — an expense with one receivable portion and nothing else laying claim to it.
    Where an amount *is* stated it must point the same way as the row's receivable and must fit inside
    what is unclaimed, since two reimbursements between them may not claim more of a row than it holds.
    """
    if not requested:
        raise ReimbursementError("Select the transactions this reimbursement covers.")

    txn_ids = list(requested)
    places = ",".join("?" for _ in txn_ids)
    found = {
        row["id"]: row["trashed_at"]
        for row in conn.execute(
            f"SELECT id, trashed_at FROM txn WHERE id IN ({places})", txn_ids
        )
    }
    if [txn_id for txn_id in txn_ids if txn_id not in found]:
        raise ReimbursementError("One of the selected transactions no longer exists.")
    if any(found[txn_id] is not None for txn_id in txn_ids):
        raise ReimbursementError("A transaction in the trash cannot be added to a reimbursement.")

    receivable = receivable_amounts(conn, txn_ids)
    standing = _claims_by_txn(conn, txn_ids)

    resolved: dict[str, dict] = {}
    for txn_id, request in requested.items():
        total = receivable.get(txn_id, 0.0)
        if abs(total) < _CENT:
            raise ReimbursementError(
                "Every transaction in a reimbursement needs an amount in the Reimbursable group — "
                "split the expense so the part owed back lands there, and categorize the repayment "
                "to it."
            )
        # Claims held by *other* links; this link's own are being replaced by what is passed.
        others = round(
            sum(
                claim["amount"]
                for claim in standing.get(txn_id, [])
                if claim["link_id"] != excluding_link_id
            ),
            2,
        )
        available = round(total - others, 2)
        if abs(available) < _CENT:
            raise ReimbursementError(
                "Every part of that transaction is already claimed by another reimbursement."
            )
        amount = request["amount"]
        if amount is None:
            amount = available
        if abs(amount) < _CENT:
            raise ReimbursementError("A claim on a transaction cannot be zero.")
        if not _same_direction(amount, total):
            raise ReimbursementError(
                "A portion has to move money the same direction as the transaction it comes from."
            )
        if abs(amount) - abs(available) > _CENT:
            raise ReimbursementError(
                f"Only {abs(available):.2f} of that transaction is still unclaimed."
            )
        resolved[txn_id] = {"amount": amount, "label": request["label"]}
    return resolved


def create_reimbursement(
    conn: sqlite3.Connection,
    claims: Iterable[dict],
    *,
    counterparty: Optional[str] = None,
) -> dict:
    """Start tracking a reimbursement over these portions. Never touches the transactions themselves.

    A single expense portion with no repayment yet is a perfectly good reimbursement — it is the "nobody
    has paid me back" case and the state most of them live in — so there is deliberately no minimum.
    """
    resolved = _resolve_claims(conn, _normalize_claims(claims))
    link_id = create_link(
        conn,
        REIMBURSEMENT_LINK_KIND,
        [(txn_id, _role_for(claim["amount"])) for txn_id, claim in resolved.items()],
        external_ref=_clean_text(counterparty, MAX_COUNTERPARTY_LENGTH),
        # No reminder of its own: a new record follows the household default, measured from its own
        # oldest expense. Stamping a date here would freeze it at today's setting.
        metadata=_metadata(resolved),
    )
    return _load(conn, link_id)


def update_reimbursement(
    conn: sqlite3.Connection,
    link_id: str,
    *,
    counterparty: Optional[str] = None,
    remind_on: Optional[str] = None,
    clear_reminder: bool = False,
    follow_default_reminder: bool = False,
) -> dict:
    """Rewrite the reimbursement's name and reminder. Both are replaced with what is passed, so clearing
    a name is sending it empty — a partial update would leave no way to remove one that was wrong.
    Claims and the settlement record are preserved: they describe what was done rather than what was
    typed.

    **The reminder has three states rather than two**, which is why it takes three arguments instead of
    one nullable date. A record can carry a date of its own, can be switched off (`clear_reminder`), or
    can go back to following the household default (`follow_default_reminder`). Collapsing "off" and
    "follow the default" into a single empty value is what would make turning a reminder off silently
    undo itself the next time the default was consulted.

    Allowed after completion on purpose: a name is documentation, not an accounting fact, and a finished
    record nobody named is exactly the one worth labelling."""
    existing = _load(conn, link_id)
    link = get_link(conn, link_id)
    if follow_default_reminder:
        next_reminder = None
    elif clear_reminder:
        next_reminder = ""
    elif remind_on is not None:
        next_reminder = _clean_date(remind_on)
    else:
        next_reminder = _read_remind_on(link.get("metadata"))
    conn.execute(
        "UPDATE txn_link SET external_ref = ? WHERE id = ?",
        (_clean_text(counterparty, MAX_COUNTERPARTY_LENGTH), link_id),
    )
    set_metadata(
        conn,
        link_id,
        _metadata(
            _read_claims(link.get("metadata")),
            existing.get("completion"),
            next_reminder,
        ),
    )
    return _load(conn, link_id)


def add_claims(conn: sqlite3.Connection, link_id: str, claims: Iterable[dict]) -> dict:
    """Attach more portions — the "the repayment finally arrived" path."""
    reimbursement = _require_open(_load(conn, link_id), "add transactions to")
    link = get_link(conn, link_id)
    existing = _read_claims(link.get("metadata"))
    resolved = _resolve_claims(
        conn, _normalize_claims(claims), excluding_link_id=link_id
    )
    # A transaction already in this link has its claim replaced rather than added to, which is what
    # makes re-picking a portion a correction instead of a silent doubling.
    merged = {**existing, **resolved}
    for txn_id, claim in resolved.items():
        add_member(conn, link_id, txn_id, _role_for(claim["amount"]))
    set_metadata(
        conn, link_id,
        _metadata(merged, reimbursement.get("completion"), _read_remind_on(link.get("metadata")))
    )
    return _load(conn, link_id)


def remove_transaction(conn: sqlite3.Connection, link_id: str, txn_id: str) -> Optional[dict]:
    """Detach one portion. Removing the last one drops the link, which would otherwise describe nothing."""
    reimbursement = _require_open(_load(conn, link_id), "change")
    link = get_link(conn, link_id)
    claims = _read_claims(link.get("metadata"))
    if txn_id not in claims:
        raise ReimbursementError("That transaction is not part of this reimbursement.")
    if len(claims) <= 1:
        delete_link(conn, link_id)
        return None
    claims.pop(txn_id)
    remove_member(conn, link_id, txn_id)
    set_metadata(
        conn, link_id,
        _metadata(claims, reimbursement.get("completion"), _read_remind_on(link.get("metadata")))
    )
    return _load(conn, link_id)


def move_claim(conn: sqlite3.Connection, link_id: str, txn_id: str, from_link_id: str) -> dict:
    """Take a portion another reimbursement is holding and attach it to this one instead.

    **Why this needs an operation of its own.** Claims are exclusive — what one record holds, another
    cannot — so the ordinary picker offers only *unclaimed* money. That is right for adding, and it
    leaves a row whose receivable is entirely spoken for unreachable: attaching it somewhere else meant
    releasing it from its current record first, and a record with nothing left is deleted on the way, so
    the release and the re-attach could not be one act. Rows landing on the wrong record are ordinary —
    a repayment matched to the wrong friend — and the fix should not be two destructive steps.

    Order is load-bearing: the claim is released **before** it is re-attached, because the invariant
    counts claims across every record and the add would otherwise be refused as an over-claim of a row
    that is merely mid-move. Both halves ride the caller's transaction, so a failure on the second
    leaves the first unwritten rather than stranding the portion between records.
    """
    if link_id == from_link_id:
        raise ReimbursementError("That portion is already part of this reimbursement.")
    _require_open(_load(conn, link_id), "move a transaction into")
    source = _require_open(_load(conn, from_link_id), "move a transaction out of")
    claims = _read_claims(get_link(conn, from_link_id).get("metadata"))
    claim = claims.get(txn_id)
    if not claim:
        raise ReimbursementError("That transaction is not part of the reimbursement it is being moved from.")
    # A record holds at most one claim per transaction, so an add here would *replace* what is already
    # there rather than accumulate — silently discarding money the target was tracking.
    if _read_claims(get_link(conn, link_id).get("metadata")).get(txn_id):
        raise ReimbursementError(
            "This reimbursement already covers part of that transaction — change the amount here instead."
        )
    amount, label = claim["amount"], claim.get("label")
    remove_transaction(conn, from_link_id, txn_id)
    add_claims(conn, link_id, [{"txn_id": txn_id, "amount": amount, "label": label}])
    # Named for the caller's benefit: the source may have been deleted by the removal, and a surface
    # showing it needs to know rather than re-fetching a record that is gone.
    result = _load(conn, link_id)
    result["moved_from"] = {
        "id": from_link_id,
        "counterparty": source.get("counterparty"),
        "deleted": len(claims) <= 1,
    }
    return result


def delete_reimbursement(conn: sqlite3.Connection, link_id: str) -> None:
    """Stop tracking it. The transactions stay exactly as they were — the link never changed them.

    A completed reimbursement is refused rather than silently unlinked: completing it may have moved
    money between categories, and its record is the only thing that can put that back.
    """
    _require_open(_load(conn, link_id), "delete")
    delete_link(conn, link_id)


def _require_open(reimbursement: dict, action: str) -> dict:
    if reimbursement.get("completed"):
        raise ReimbursementError(
            f"This reimbursement is complete. Reopen it before trying to {action} it."
        )
    return reimbursement


# ---------------------------------------------------------------------------
# Settling
# ---------------------------------------------------------------------------

def _current_allocations(conn: sqlite3.Connection, txn_id: str) -> tuple[float, list[dict]]:
    """A transaction's amount and its allocations, with an unsplit row read as its single allocation.

    Treating "not split" as one allocation is what lets settlement be a single algorithm instead of
    four cases: a wholly reimbursable expense, a partially reimbursable one, a repayment categorized
    straight to the holding group, and one split across several all reduce to the same list-rewrite.
    """
    row = conn.execute("SELECT amount, category_id FROM txn WHERE id = ?", (txn_id,)).fetchone()
    if not row:
        raise ReimbursementError("That transaction no longer exists.")
    parts = get_split_parts(conn, txn_id)
    if parts:
        allocations = [
            {"category_id": p["category_id"], "amount": round(float(p["amount"]), 2), "label": p["label"]}
            for p in parts
        ]
    else:
        allocations = [
            {"category_id": row["category_id"], "amount": round(float(row["amount"]), 2), "label": None}
        ]
    return round(float(row["amount"]), 2), allocations


def _capture_state(conn: sqlite3.Connection, txn_id: str) -> dict:
    """Everything settlement is about to overwrite on a transaction, in the form `_restore_state` puts
    back. Recorded on the link because after the move nothing in the ledger says what the allocation
    used to be — the same reason an excluded Amazon charge stashes its prior category in link metadata.
    """
    row = conn.execute(
        "SELECT category_id, category_source, category_overridden, is_split FROM txn WHERE id = ?",
        (txn_id,),
    ).fetchone()
    if not row:
        raise ReimbursementError("That transaction no longer exists.")
    return {
        "category_id": row["category_id"],
        "category_source": row["category_source"],
        "category_overridden": row["category_overridden"],
        "is_split": row["is_split"],
        "parts": [
            {"category_id": p["category_id"], "amount": round(float(p["amount"]), 2), "label": p["label"]}
            for p in get_split_parts(conn, txn_id)
        ],
    }


def _restore_state(conn: sqlite3.Connection, txn_id: str, state: dict) -> None:
    """Put a transaction back exactly as `_capture_state` found it, allocations and provenance both."""
    conn.execute("DELETE FROM txn_split WHERE txn_id = ?", (txn_id,))
    if state.get("parts"):
        save_split(conn, txn_id, state["parts"])
    conn.execute(
        "UPDATE txn SET is_split = ?, category_id = ?, category_source = ?, category_overridden = ? "
        "WHERE id = ?",
        (
            1 if state.get("is_split") else 0,
            state.get("category_id"),
            state.get("category_source"),
            1 if state.get("category_overridden") else 0,
            txn_id,
        ),
    )


def _write_allocations(conn: sqlite3.Connection, txn_id: str, allocations: Sequence[dict]) -> None:
    """Store a rewritten allocation list, collapsing a single remaining allocation back to a plain
    category rather than leaving a one-part split behind — which `txn_splits` refuses anyway, and which
    would report identically to an ordinary row while being skipped by every automatic pass."""
    if len(allocations) == 1:
        only = allocations[0]
        conn.execute("DELETE FROM txn_split WHERE txn_id = ?", (txn_id,))
        conn.execute(
            "UPDATE txn SET is_split = 0, category_id = ?, category_overridden = 1, "
            "category_source = 'manual', needs_review = 0 WHERE id = ?",
            (only["category_id"], txn_id),
        )
        return
    try:
        save_split(conn, txn_id, allocations)
    except SplitValidationError as exc:
        raise ReimbursementError(str(exc)) from exc


def _destination_category(conn: sqlite3.Connection, category_id: str) -> str:
    """Validate where a residual is being sent. A group is refused because a transaction may only ever
    be assigned to a leaf, and a receivable leaf because settling into the holding group would move the
    residual nowhere while reporting that the books had been made true."""
    if not category_id:
        raise ReimbursementError("Choose the category this residual belongs to.")
    row = conn.execute(
        "SELECT id, parent_id, is_active FROM category WHERE id = ?", (category_id,)
    ).fetchone()
    if not row:
        raise ReimbursementError("That category no longer exists.")
    if row["parent_id"] is None:
        raise ReimbursementError("Choose a category, not a group.")
    if "is_active" in row.keys() and not row["is_active"]:
        raise ReimbursementError("That category has been deleted.")
    if category_id in set(reimbursable_leaf_ids(conn)):
        raise ReimbursementError(
            "A residual has to move out of the Reimbursable group — choose the category the expense "
            "really belonged to."
        )
    return category_id


def _settlement_target(reimbursement: dict, residual: float, target_txn_id: Optional[str]) -> dict:
    """Which member carries the residual. The sign decides the *role*; the user decides which member
    when the role has more than one, because nothing in the ledger can say which expense fell short."""
    wanted_role = EXPENSE_ROLE if residual > 0 else REPAYMENT_ROLE
    candidates = [
        member
        for member in reimbursement["members"]
        if not member["trashed"] and member["role"] == wanted_role
    ]
    if not candidates:
        raise ReimbursementError(
            "There is no expense in this reimbursement to absorb the shortfall."
            if residual > 0
            else "There is no repayment in this reimbursement to carry the surplus."
        )
    if target_txn_id:
        for member in candidates:
            if member["txn_id"] == target_txn_id:
                return member
        raise ReimbursementError(
            "That transaction cannot carry this residual. A shortfall settles against an expense and a "
            "surplus against a repayment."
        )
    if len(candidates) > 1:
        raise ReimbursementError(
            "This reimbursement covers more than one transaction, so choose which one the residual "
            "belongs to."
        )
    return candidates[0]


def complete(
    conn: sqlite3.Connection,
    link_id: str,
    *,
    category_id: Optional[str] = None,
    target_txn_id: Optional[str] = None,
) -> dict:
    """Finish a reimbursement: move whatever is left over into a real category, and close it.

    **A reimbursement with nothing left over completes with no move at all**, and that case is the
    reason this is "complete" rather than "settle". Repaid in full is the outcome the whole feature is
    aiming at; treating it as an error — which it was — left the commonest happy ending unreachable and
    the record stranded on the open list forever.

    Where there *is* a residual, moving it is the moment the books become true, and it is deliberately a
    user action: a repayment that fell short and one that never came look identical by amount.

    **The residual is drawn against this link's own claim, never against the whole row.** A charge whose
    other portion belongs to a different reimbursement must not have that portion consumed here, so the
    limit is the claim and the claim is reduced along with the allocation — which keeps the row's claims
    and its receivable in step. One consequence worth knowing: *which* receivable allocation shrinks is
    taken in order, so on a row holding two portions the labels are not evidence of whose money moved.
    Nothing reported anywhere depends on it — the row's receivable, each link's residual and every
    category total are the same either way — and the alternative is a durable part identity that
    `save_split` cannot provide.
    """
    reimbursement = _require_open(_load(conn, link_id), "complete")
    link = get_link(conn, link_id)
    prior_claims = _read_claims(link.get("metadata"))
    residual = reimbursement["residual"]

    if abs(residual) < _CENT:
        # Repaid in full: the two sides already cancel inside the excluded group, so there is nothing
        # to move and nothing to ask. The record of having finished is the whole of what changes.
        set_metadata(
            conn,
            link_id,
            _metadata(
                prior_claims,
                {
                    "txn_id": None,
                    "residual": 0.0,
                    "category_id": None,
                    "completed_at": _now(),
                    "prior": None,
                    "prior_claims": prior_claims,
                },
                _read_remind_on(link.get("metadata")),
            ),
        )
        return _load(conn, link_id)

    destination = _destination_category(conn, category_id)
    target = _settlement_target(reimbursement, residual, target_txn_id)

    if abs(target["claim"]) - abs(residual) < -_CENT:
        raise ReimbursementError(
            "This reimbursement's portion of that transaction is smaller than the residual. Settle the "
            "rest against another transaction in this reimbursement."
        )

    prior_state = _capture_state(conn, target["txn_id"])
    amount, allocations = _current_allocations(conn, target["txn_id"])
    leaves = set(reimbursable_leaf_ids(conn))

    remaining = residual
    rewritten: list[dict] = []
    for allocation in allocations:
        allocated = allocation["amount"]
        if allocation["category_id"] in leaves and abs(remaining) >= _CENT:
            taken = remaining if abs(remaining) <= abs(allocated) else allocated
            allocated = round(allocated - taken, 2)
            remaining = round(remaining - taken, 2)
        if abs(allocated) >= _CENT:
            rewritten.append({**allocation, "amount": allocated})
    if abs(remaining) >= _CENT:
        raise ReimbursementError(
            "That transaction does not have enough left in the Reimbursable group to absorb the whole "
            "residual. Settle the rest against another transaction in this reimbursement."
        )

    for allocation in rewritten:
        if allocation["category_id"] == destination:
            allocation["amount"] = round(allocation["amount"] + residual, 2)
            break
    else:
        rewritten.append({"category_id": destination, "amount": residual, "label": None})

    # The allocations must total the transaction exactly. Any cent of rounding drift is absorbed by the
    # destination, which is the allocation this operation created rather than one the user entered.
    drift = round(amount - sum(allocation["amount"] for allocation in rewritten), 2)
    if abs(drift) >= _CENT:
        for allocation in rewritten:
            if allocation["category_id"] == destination:
                allocation["amount"] = round(allocation["amount"] + drift, 2)
                break

    _write_allocations(conn, target["txn_id"], rewritten)

    settled_claims = dict(prior_claims)
    reduced = round(settled_claims[target["txn_id"]]["amount"] - residual, 2)
    if abs(reduced) < _CENT:
        # The portion is fully accounted for. The membership stays so the reimbursement still lists the
        # transaction it was about; only the claim on the row is spent.
        settled_claims[target["txn_id"]] = {**settled_claims[target["txn_id"]], "amount": 0.0}
    else:
        settled_claims[target["txn_id"]] = {**settled_claims[target["txn_id"]], "amount": reduced}

    set_metadata(
        conn,
        link_id,
        _metadata(
            settled_claims,
            {
                "txn_id": target["txn_id"],
                "residual": residual,
                "category_id": destination,
                "completed_at": _now(),
                "prior": prior_state,
                "prior_claims": prior_claims,
            },
            _read_remind_on(link.get("metadata")),
        ),
    )
    return _load(conn, link_id)


def reopen(conn: sqlite3.Connection, link_id: str) -> dict:
    """Reopen a completed reimbursement, restoring any allocations and claims it moved.

    The reversal reads the stashed prior rather than recomputing an inverse: a residual moved into a
    category that may since have been edited, and re-deriving "what it must have been" would quietly
    launder those edits into the restore. A completion that moved nothing has nothing to restore, which
    is why the transaction half is conditional rather than assumed.
    """
    reimbursement = _load(conn, link_id)
    completion = reimbursement.get("completion")
    if not completion:
        raise ReimbursementError("This reimbursement is not complete.")
    if completion.get("txn_id"):
        _restore_state(conn, completion["txn_id"], completion.get("prior") or {})
    link = get_link(conn, link_id)
    set_metadata(
        conn,
        link_id,
        _metadata(
            _read_claims({"claims": completion.get("prior_claims") or {}}),
            None,
            # The reminder is not part of what completing moved, so reopening leaves it alone. A record
            # reopened past its date is due again immediately, which is the honest reading: it is
            # outstanding once more.
            _read_remind_on(link.get("metadata")),
        ),
    )
    return _load(conn, link_id)


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------

def outstanding(conn: sqlite3.Connection) -> dict:
    """Everything currently sitting in the receivable group, as the report needs it.

    Two piles, and the split between them is what "pairing is optional and late" means in practice:
    **tracked** reimbursements are the ones the user has grouped, which is what completing requires, and
    **loose** money is receivable nobody has claimed yet. A loose row is not a defect — it is the normal
    state of a reimbursable between the purchase and the repayment.

    **Only open reimbursements are listed.** A completed one has no work left on it and is deliberately
    not offered as a second list to read; it stays reachable from any of its transactions. The headline
    total is unaffected either way, because a completed reimbursement's claims sum to zero.

    Loose is measured per *portion*, not per row, so a $750 charge with one $250 portion already claimed
    still appears with the $500 that is not. The total is the two piles added together and therefore
    equals the receivable group's own balance, which is the property that lets the headline figure be
    trusted without anything being linked.
    """
    # Carried on the report so every surface derives "is this overdue?" from one number rather than
    # fetching the setting separately and drifting from the Tasks signal that counts the same rows.
    days = default_reminder_days(conn)
    leaves = reimbursable_leaf_ids(conn)
    if not leaves:
        return {"total": 0.0, "reimbursements": [], "loose": [], "reminder_days": days}

    leaf_places = ",".join("?" for _ in leaves)
    holder_ids = [
        row["txn_id"]
        for row in conn.execute(
            f"""
            SELECT t.id AS txn_id
            FROM   txn t
            WHERE  t.trashed_at IS NULL
              AND  (
                     EXISTS (SELECT 1 FROM txn_split s
                              WHERE s.txn_id = t.id AND s.category_id IN ({leaf_places}))
                     OR (t.is_split = 0 AND t.category_id IN ({leaf_places}))
                   )
            """,
            [*leaves, *leaves],
        )
    ]
    if not holder_ids:
        return {"total": 0.0, "reimbursements": [], "loose": [], "reminder_days": days}

    link_ids: list[str] = []
    for claims in _claims_by_txn(conn, holder_ids).values():
        for claim in claims:
            if claim["link_id"] not in link_ids:
                link_ids.append(claim["link_id"])
    reimbursements = [_load(conn, link_id) for link_id in link_ids]
    reimbursements = [item for item in reimbursements if not item["completed"]]
    reimbursements.sort(key=lambda item: item.get("created_at") or "")

    unclaimed = unclaimed_amounts(conn, holder_ids)
    loose = _loose_rows(conn, [txn_id for txn_id in holder_ids if abs(unclaimed[txn_id]) >= _CENT], unclaimed)

    total = round(
        sum(item["residual"] for item in reimbursements) + sum(row["unclaimed"] for row in loose), 2
    )
    return {
        "total": total,
        "reimbursements": reimbursements,
        "loose": loose,
        "reminder_days": days,
    }


# ---------------------------------------------------------------------------
# Reminders that have come due
# ---------------------------------------------------------------------------

# The bucket a receivable on an account nobody owns falls into. `unassigned` rather than a null owner id
# because that is the token the transaction list's owner facet already understands, which is what lets a
# task deep-link to exactly the rows it counted.
UNASSIGNED_OWNER = "unassigned"


def _due_date_for_record(record: dict, days: int) -> Optional[str]:
    """When this record starts nagging, or None where it never does.

    A record's own date wins over the default, and an empty one means the user switched it off. Only
    money still *owed* is ever due: a surplus is a gain waiting to be booked rather than something to
    chase, and a record with nothing owed at all is a credit sitting on its own.
    """
    if record.get("completed") or record.get("residual", 0) < _CENT:
        return None
    own = record.get("remind_on")
    if own == "":
        return None
    if own:
        return own
    return _default_due_date(record.get("expense_date"), days)


def _record_owners(record: dict) -> list[tuple[Optional[str], Optional[str]]]:
    """Whose reminder this is: the owners of its **expense** members.

    The question a reminder asks is "has this come back yet?", so the person it concerns is the one the
    money left — the repayment side does not get a vote on who is owed. A record whose expenses sit on
    two people's accounts is genuinely both their business and appears under each; that is rare, and
    surfacing it twice is the failure worth having over hiding it from the person who is owed.
    """
    seen: list[tuple[Optional[str], Optional[str]]] = []
    for member in record.get("members", []):
        if member.get("trashed") or member.get("claim", 0) <= 0:
            continue
        key = (member.get("owner_id"), member.get("owner_name"))
        if key not in seen:
            seen.append(key)
    return seen or [(None, None)]


def owner_grouping_applies(conn: sqlite3.Connection) -> bool:
    """Whether this household has enough people for per-owner reminders to mean anything.

    The test is **more than one personal owner**, not "any owner exists". `ensure_shared_owner` mints a
    built-in *Shared* row the first time the Owners page is opened, so the looser test would split a
    single-person install into owner groups that all say the same thing. This is the same threshold
    `routers/owners.py` uses when it decides Shared has stopped being meaningful.
    """
    from backend.db.database import SHARED_OWNER_NAME

    personal = conn.execute(
        "SELECT COUNT(*) AS n FROM owner WHERE LOWER(name) <> LOWER(?)", (SHARED_OWNER_NAME,)
    ).fetchone()["n"]
    return personal > 1


def due_reminders(conn: sqlite3.Connection, *, today: Optional[str] = None) -> dict:
    """Receivables that have gone quiet for longer than they should have, grouped by whose they are.

    **Why this exists at all**: until a receivable is settled, spending is under-reported — the exact
    disease the flag-and-exclude model was rejected for. The only difference is that here the amount is
    visible, and a reminder is what makes someone go and look at it.

    Both piles are counted. A *record* is due against its own reminder date or the household default; a
    *loose* row has nowhere to store a date of its own, so it only ever answers to the default, and
    changing that is what "Track this" is for. Only money still owed is ever due — see
    `_due_date_for_record`.

    Grouping is by the owner of the transaction, which is `txn.owner_id` rather than a join through to
    the account: it is stamped from the account when a row is created and it is the axis every owner
    filter reads, so a task can deep-link to precisely the rows it counted.
    """
    now = today or _today()
    days = default_reminder_days(conn)
    report = outstanding(conn)

    # Keyed by owner so a record touching two of them lands in both; the value carries what the task
    # needs to describe itself and nothing more.
    groups: dict[str, dict] = {}

    def add(owner_id, owner_name, amount, due_on):
        key = owner_id or UNASSIGNED_OWNER
        group = groups.setdefault(key, {
            "owner_id": key,
            "owner_name": owner_name or "Unassigned",
            "count": 0,
            "amount": 0.0,
            "oldest_due": due_on,
        })
        group["count"] += 1
        group["amount"] = round(group["amount"] + abs(amount), 2)
        if due_on < (group["oldest_due"] or due_on):
            group["oldest_due"] = due_on

    for record in report["reimbursements"]:
        due_on = _due_date_for_record(record, days)
        if not due_on or due_on > now:
            continue
        for owner_id, owner_name in _record_owners(record):
            add(owner_id, owner_name, record["residual"], due_on)

    for row in report["loose"]:
        unclaimed = row.get("unclaimed", 0.0)
        if unclaimed < _CENT:
            continue
        due_on = _default_due_date(row.get("date"), days)
        if not due_on or due_on > now:
            continue
        add(row.get("owner_id"), row.get("owner_name"), unclaimed, due_on)

    ordered = sorted(groups.values(), key=lambda g: (-g["count"], g["owner_name"]))
    return {
        "grouped": owner_grouping_applies(conn),
        "total": sum(group["count"] for group in ordered),
        "groups": ordered,
    }


def _loose_rows(
    conn: sqlite3.Connection, txn_ids: Sequence[str], unclaimed: dict[str, float]
) -> list[dict]:
    """Receivable money no reimbursement has claimed, newest first, with the portions it is made of.

    The portions ride along because a row is often several: one charge split between two friends offers
    two of them to claim, and a picker that showed only the combined figure would be describing the
    model rather than the money — which is exactly the reading this feature had to be corrected out of.
    """
    if not txn_ids:
        return []
    places = ",".join("?" for _ in txn_ids)
    rows = conn.execute(
        f"""
        SELECT t.id AS txn_id, t.date, t.amount, t.owner_id,
               COALESCE(NULLIF(t.display_name, ''), NULLIF(t.merchant_name, ''), NULLIF(t.raw_name, ''), '') AS payee,
               COALESCE(a.display_name, a.name, '') AS account_name,
               o.name AS owner_name
        FROM   txn t
        LEFT   JOIN account a ON a.id = t.account_id
        LEFT   JOIN owner   o ON o.id = t.owner_id
        WHERE  t.id IN ({places})
        ORDER  BY t.date DESC, t.id
        """,
        list(txn_ids),
    ).fetchall()
    receivable = receivable_amounts(conn, [row["txn_id"] for row in rows])
    return [
        {
            "txn_id": row["txn_id"],
            "date": row["date"],
            "amount": row["amount"],
            "payee": row["payee"],
            "account_name": row["account_name"],
            "owner_id": row["owner_id"],
            "owner_name": row["owner_name"],
            "receivable": receivable.get(row["txn_id"], 0.0),
            "unclaimed": unclaimed.get(row["txn_id"], 0.0),
            "parts": receivable_parts(conn, row["txn_id"]),
            "role": _role_for(unclaimed.get(row["txn_id"], 0.0)),
        }
        for row in rows
    ]


def reimbursement_map_for(conn: sqlite3.Connection, txn_ids) -> dict[str, list[dict]]:
    """Per transaction, the reimbursements it has a portion in, as a ledger row needs them.

    A **list**, because a split row may serve several — the marker has to be able to say "2
    reimbursements" rather than picking one and hiding the other. Resolved for the whole page in a
    handful of indexed queries rather than one per row, the same call `split_parts`, `documents` and
    `purchases` already make.
    """
    ids = _unique(txn_ids)
    if not ids:
        return {}
    by_txn = _claims_by_txn(conn, ids)
    if not by_txn:
        return {}
    wanted_links = {claim["link_id"] for claims in by_txn.values() for claim in claims}
    summaries = {link_id: _load(conn, link_id) for link_id in wanted_links}
    mapped: dict[str, list[dict]] = {}
    for txn_id, claims in by_txn.items():
        mapped[txn_id] = [
            {
                "id": summary["id"],
                "counterparty": summary["counterparty"],
                "owed": summary["owed"],
                "repaid": summary["repaid"],
                "residual": summary["residual"],
                "completed": summary["completed"],
                "claim": claim["amount"],
                "claim_label": claim.get("label"),
            }
            for claim in claims
            for summary in [summaries[claim["link_id"]]]
        ]
    return mapped
