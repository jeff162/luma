# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
The Amazon order engine: turn a parsed :class:`AmazonOrder` into ledger state (orders-only model, see
``docs/data-model.md`` → "Transaction links and Amazon order import"). Given one parsed order and
a chosen Amazon account, it:

  * creates **one spending transaction per order** in the Amazon account (amount = net cash
    ``total − refund``, memo = the order's item list), categorized later by the user's normal rules; the
    optional items file's per-item detail (ASIN / list price / quantity) is folded into that row's
    evidence, never as separate rows;
  * for a **cash** order, finds the matching card charge in the ledger (funding-source → account map,
    then graceful-last-4), recategorizes it into the excluded "Amazon Funding" category, and **links**
    charge↔order — so the money counts once, on the Amazon side (the charge's prior category is stashed
    in the link ``metadata`` for a clean undo);
  * for a **non-cash** order (points / gift-card funded), records the order *excluded* (not counted);
  * for a cash order whose card charge isn't in the ledger (untracked card), keeps the order counted as
    the sole record; and
  * offers a **reconciliation report** (:func:`amazon_reconciliation`) over a batch — matched / unmatched
    orders and a reverse scan for Amazon-looking ledger charges no order accounts for.

It lives in the import package (not ``services/``) because it reuses the canonical imported-transaction
creator and hashing from :mod:`core`; the *pure* pieces (parsing, classification) live in
``services/amazon_import.py`` and are unit-tested without any ledger.
"""

from __future__ import annotations

import itertools
import json
import re
import sqlite3
import uuid
from collections import Counter
from datetime import date
from urllib.parse import urlsplit
from typing import NamedTuple, Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from backend.app_logging import log_error
from backend.db.database import get_db, get_tenant_workflow_state, set_tenant_workflow_state
from backend.json_utils import safe_json_dict
from backend.services import amazon_funding, txn_links
from backend.services.amazon_order_amount import (
    ADDED_CHARGES_KEY, BASE_AMOUNT_KEY, added_charge_ids, refresh_order_amount,
)
from backend.services.account_groups import account_group_member_ids, effective_account_id
from backend.services.categorizer import category_lock_for
from backend.services.excluded_categories import ensure_excluded_transfers_leaf
from backend.services.import_batch_totals import refresh_batch_coverage
from backend.services.reconciliation_attention import batch_attention
from backend.services.review_flagging import flags_new_transactions
from backend.services.rule_suggestion_review import release_rule_suggestion_rows
from backend.services.recurring_detection import owe_recurring_rescan, settle_owed_rescans
from backend.services.restore_state import require_no_pending_restore
from backend.services.txn_summaries import txn_summaries
from backend.services.txn_trash import trash_txns
from backend.services.amazon_import import (
    AmazonItem,
    AmazonOrder,
    OrderDisposition,
    classify_order,
    merge,
    parse_item_evidence,
    parse_item_rows,
    parse_order_rows,
    read_export,
)

from .core import IMPORT_SUMMARY_KEY, _insert_imported_transaction, is_demo_data_loaded, make_hash, make_import_file_hash, read_import_upload

router = APIRouter()

LINK_KIND = "amazon_order"
# Import-batch provenance marker (import_batch.source_kind) so the import history groups Amazon batches
# under an "Amazon" entry rather than "unknown data source". Vendor-qualified for future marketplaces.
BATCH_SOURCE_KIND = "marketplace:amazon"
AMAZON_FUNDING_CATEGORY = "Amazon purchase"
_CHARGE_DATE_WINDOW_DAYS = 3
# Link metadata: the charges the user unlinked from this order, which no automatic pass offers it again.
DECLINED_CHARGES_KEY = "declined_charge_ids"
# Global (tenant-wide) setting: which category the matched card charge is moved into. Stored in
# import_workflow_state; absent = use the seeded default below. A change takes effect on the *next*
# import only — an already-imported charge keeps the category it was assigned.
FUNDING_CATEGORY_STATE_KEY = "amazon_funding_category"


def _default_funding_category(conn: sqlite3.Connection) -> str:
    """The seeded default excluded category: a leaf under the ``Transfers`` group (which carries
    ``exclude_from_totals = 1``, evaluated as ``COALESCE(parent, leaf, 0)``), so the charge drops out of
    spending totals without a per-row flag. Shared with wallet money-movement suppression via
    ``ensure_excluded_transfers_leaf``, which also recreates the group if the user deleted it (so the
    excluded category never lands as a parentless leaf a transaction couldn't be assigned to)."""
    return ensure_excluded_transfers_leaf(conn, AMAZON_FUNDING_CATEGORY)


def find_or_create_funding_category(conn: sqlite3.Connection) -> str:
    """The category the matched card charge is moved into: the user's globally-chosen category if one is
    set (and still exists), else the seeded default. Read at import time, so changing the choice affects
    only future imports."""
    state = get_tenant_workflow_state(conn, FUNDING_CATEGORY_STATE_KEY)
    chosen = state.get("category_id") if isinstance(state, dict) else None
    if chosen and conn.execute("SELECT 1 FROM category WHERE id = ?", (chosen,)).fetchone():
        return chosen
    return _default_funding_category(conn)


def _account_owner(conn: sqlite3.Connection, account_id: str) -> Optional[str]:
    row = conn.execute("SELECT owner_id FROM account WHERE id = ?", (account_id,)).fetchone()
    return row["owner_id"] if row else None


def find_matching_charge(
    conn: sqlite3.Connection,
    disposition,
    *,
    exclude_account_id: Optional[str] = None,
    restrict_account_id: Optional[str] = None,
) -> Optional[str]:
    """Find the single card charge this order paid: a positive (expense) amount equal to the gross
    charge, within a few days of the charge date, that isn't already linked, on some *other* account —
    never the Amazon account itself (``exclude_account_id``), so a coincidental same-amount item can't be
    mistaken for the charge. Returns the txn id, or ``None`` if there's no match **or** the match is
    ambiguous (more than one candidate) — ambiguity is left for manual resolution, per the doc.

    A ``$0`` charge has nothing to reconcile (fully gift-card/points funded, reported as a bare $0 card
    leg), so it never matches — otherwise it would pair with any stray $0 row.

    ``restrict_account_id`` is the authoritative funding-source → account map's answer (see
    ``amazon_funding``): when set, the search is constrained to that account's **group**, and the last-4
    clause is dropped entirely — the map already says which account, and narrowing to it is exactly what
    resolves an otherwise-ambiguous same-amount collision across accounts. The group rather than the bare
    id because the map stores a plain account id that a later merge can turn into a child, after which the
    charges arrive on the parent (see ``services/account_groups.py``). When it is **not** set (an unmapped
    instrument), the card's last-4 is a *disambiguator among accounts that carry a mask*, not a hard
    requirement: a maskless account (e.g. CSV-imported, no card number on file) can't contradict the
    last-4, so it stays eligible and is carried by the amount + date + uniqueness guard instead. Without
    this, a ledger whose accounts have no masks — the common case for imported data — would match nothing."""
    if disposition.kind != "cash" or not disposition.charge_amount or disposition.charge_amount <= 0:
        return None
    ids = _charge_candidate_ids(
        conn, amount=disposition.charge_amount, match_date=disposition.match_date,
        last4=disposition.match_last4, exclude_account_id=exclude_account_id,
        restrict_account_id=restrict_account_id)
    return ids[0] if len(ids) == 1 else None


def _charge_candidate_ids(conn: sqlite3.Connection, *, amount, match_date, last4,
                          exclude_account_id=None, restrict_account_id=None,
                          window_days: int = _CHARGE_DATE_WINDOW_DAYS, forward_only: bool = False) -> list[str]:
    """Every card charge eligible to be *this* order's charge — the matcher's candidate set: a positive
    amount equal to the gross charge, unlinked, within the date window, on an account permitted by the
    funding map (``restrict_account_id``) or, absent a map, the card's last-4 (a carded account whose mask
    contradicts the last-4 is excluded; a maskless one stays eligible). ``find_matching_charge`` links only
    when this returns exactly one; the reconciliation report uses the full list to tell a *duplicate* (two or
    more) from a clean match, so both read from the same rule.

    **No instrument at all** (neither a mapped account nor a last-4 — an order whose payments string names
    no card, e.g. a digital D01 order) leaves amount + date as the only constraints, which drags in every
    coincidental same-amount charge in the window on *any* account: that is what produced both a wrong
    auto-match to an unrelated charge and a bogus duplicate group of someone else's payments. With no
    account signal left, the payee is the only one there is, so the charge must at least *look* like Amazon
    (``_AMAZON_NAME_LIKE``, the same predicate the reverse scan uses). The deliberate trade: an off-card
    order whose real charge carries a non-Amazon descriptor now shows as "No charge found" (a miss, fixable
    with Link charges…) instead of silently excluding an unrelated charge from the user's totals.

    ``forward_only`` takes charges dated on or after ``match_date`` only, for a window too wide for a charge
    before the order to be anything but someone else's purchase: Amazon bills when an order ships."""
    if amount is None or amount <= 0:
        return []
    clauses = [
        "t.trashed_at IS NULL",
        "ROUND(t.amount, 2) = ?",
        "NOT EXISTS (SELECT 1 FROM txn_link_member m WHERE m.txn_id = t.id)",
    ]
    params: list = [round(amount, 2)]
    # Both account constraints compare *group roots*, never raw ids: the Amazon account and the mapped
    # funding account are both stored ids that a merge can turn into children, while the charges keep
    # arriving on whichever account is the root. `COALESCE(a.parent_account_id, a.id)` reuses the join
    # this query already has (`effective_account_id_sql` is the same resolution as a subquery).
    if exclude_account_id:
        clauses.append("COALESCE(a.parent_account_id, a.id) != ?")
        params.append(effective_account_id(conn, exclude_account_id))
    if match_date:
        if forward_only:
            clauses.append("julianday(t.date) - julianday(?) BETWEEN 0 AND ?")
        else:
            clauses.append("ABS(julianday(t.date) - julianday(?)) <= ?")
        params += [match_date, window_days]
    if restrict_account_id:
        clauses.append("COALESCE(a.parent_account_id, a.id) = ?")
        params.append(effective_account_id(conn, restrict_account_id))
    elif last4:
        clauses.append("(COALESCE(p.mask, a.mask) = ? OR COALESCE(p.mask, a.mask) IS NULL OR COALESCE(p.mask, a.mask) = '')")
        params.append(last4)
    else:
        # No account signal at all — fall back to the payee (see the docstring's no-instrument case).
        clauses.append(_AMAZON_NAME_LIKE)
    rows = conn.execute(
        f"""SELECT t.id
            FROM   txn t
            JOIN   account a ON a.id = t.account_id
            LEFT   JOIN account p ON p.id = a.parent_account_id
            WHERE  {' AND '.join(clauses)}
            ORDER BY t.date""",
        params,
    ).fetchall()
    return [r["id"] for r in rows]


def _order_charge_candidates(conn: sqlite3.Connection, meta: dict, order: dict,
                             window_days: int = _CHARGE_DATE_WINDOW_DAYS, forward_only: bool = False) -> list[str]:
    """The eligible card charges for an already-imported order, reconstructed post-hoc from the link metadata
    (charge amount + the paying instrument) so the reconciliation report and the equal-count pass see exactly
    what the matcher saw. Resolves the funding map from the stored instrument: untracked → none expected;
    mapped → constrained to that account; otherwise the last-4 fallback. Empty for a non-cash / amount-less
    order or an untracked card. ``window_days`` widens the date window for the review-flavored consumers
    (the Duplicate·review bucket and its merge), which must see the same set, and, forward only, for the
    equal-count pass; every other auto-action keeps the ±3 default."""
    amount = meta.get("charge_amount")
    if amount is None or not order:
        return []
    inst = meta.get("instrument") or {}
    last4, network = inst.get("last4"), inst.get("network")
    funding = amazon_funding.resolve_funding_account(conn, order["account_id"], last4, network)
    if funding.state == "untracked":
        return []
    restrict = funding.funding_account_id if funding.state == "mapped" else None
    return _charge_candidate_ids(
        conn, amount=amount, match_date=order["date"], last4=last4,
        exclude_account_id=order["account_id"], restrict_account_id=restrict,
        window_days=window_days, forward_only=forward_only)


def _effective_account_map(conn: sqlite3.Connection, txn_ids, cache: Optional[dict] = None) -> dict:
    """``txn id → effective account id`` (the linked-group root, or the account itself). ``cache`` is a
    caller-owned dict that survives across calls — the reconciliation loop passes one for the whole run,
    so ids are resolved once instead of per order (the wide-window pass re-asks about the same charges
    the strict pass just looked up). Ids with no row are cached as ``None`` so a miss isn't re-queried."""
    ids = [t for t in dict.fromkeys(txn_ids) if t]
    if not ids:
        return {}
    if cache is None:
        cache = {}
    missing = [t for t in ids if t not in cache]
    if missing:
        placeholders = ",".join("?" * len(missing))
        rows = conn.execute(
            f"""SELECT t.id, COALESCE(a.parent_account_id, a.id) AS eff
                FROM   txn t JOIN account a ON a.id = t.account_id
                WHERE  t.id IN ({placeholders})""",
            missing,
        ).fetchall()
        for r in rows:
            cache[r["id"]] = r["eff"]
        for t in missing:
            cache.setdefault(t, None)
    return {t: cache[t] for t in ids if cache.get(t)}


def _same_account_copies(conn: sqlite3.Connection, charge_ids: list, anchor: Optional[str] = None,
                         eff_cache: Optional[dict] = None) -> list[str]:
    """Narrow a candidate set to charges that could actually be *copies of one charge*: those sharing an
    effective account. Two imports of the same charge always land on the same physical account (the
    Mint double-sync case); same-amount charges on **different** accounts are distinct transactions —
    or the cross-account dedupe system's business, which has its own keep/reject and account-merge
    semantics. This guard matters because an order with no instrument has no last-4/account constraint
    at all, so every same-amount charge in the date window on *any* account is a candidate; without it a
    Merge would trash a real transaction on another account (see the D01 digital-order case).

    With ``anchor`` (an order's already-linked charge) returns that charge's account-mates; without one,
    the largest same-account cluster. Fewer than two copies → no duplicate group."""
    ids = [c for c in dict.fromkeys(charge_ids) if c]
    eff = _effective_account_map(conn, ids + ([anchor] if anchor else []), eff_cache)
    if anchor:
        target = eff.get(anchor)
        return [c for c in ids if c != anchor and target and eff.get(c) == target]
    clusters: dict = {}
    for cid in ids:
        key = eff.get(cid)
        if key:
            clusters.setdefault(key, []).append(cid)
    best = max(clusters.values(), key=len, default=[])
    return best if len(best) >= 2 else []


class _DuplicateGroup(NamedTuple):
    """The answer to "are these charges duplicates of one another?". ``copies`` is the group to report
    (empty when there is none); ``settled`` distinguishes *no cluster at all* from *a real cluster the
    user already declared Not duplicates*, which callers must not then re-derive in a wider window."""

    copies: list
    settled: bool


def _duplicate_group(conn: sqlite3.Connection, candidates: list, *, anchor: Optional[str] = None,
                     eff_cache: Optional[dict] = None) -> _DuplicateGroup:
    """Every guard a **duplicate claim** must pass, in one place, so a consumer inherits them instead of
    re-deriving them. Each guard exists because omitting it destroyed real data:

      * **same effective account** — two imports of one charge always land on one physical account, so
        same-amount rows on *different* accounts are distinct transactions and merging them trashes a
        real one (see :func:`_same_account_copies`).
      * **the user's "Not duplicates" assertion** — a group explicitly settled as distinct purchases
        must never re-flag (``amazon_charge_distinct``).

    With ``anchor`` (an order's already-linked charge) ``copies`` are that charge's account-mates and
    exclude the anchor itself; without one it is the largest same-account cluster.

    Callers wanting the *matcher's* candidate set rather than a duplicate claim — the equal-count pairing
    pass, the split-suggestion pass — should keep calling :func:`_order_charge_candidates` directly; only
    the "these are copies of each other" question belongs here."""
    copies = _same_account_copies(conn, candidates, anchor=anchor, eff_cache=eff_cache)
    if not copies:
        return _DuplicateGroup([], False)
    # With an anchor a non-empty result is already a group of 2+; without one _same_account_copies
    # only returns clusters of 2+, so the group is well-formed either way.
    group = [anchor, *copies] if anchor else copies
    if _charges_marked_distinct(conn, group):
        return _DuplicateGroup([], True)
    return _DuplicateGroup(copies, False)


def _order_label(order: AmazonOrder) -> str:
    """The order transaction's display name: the concatenated item list the *orders* file already
    carries (so it reads like "Air Widget; Widget Picks"), falling back to the joined item descriptions,
    then to the order id."""
    return (
        order.items_summary
        or "; ".join(i.description for i in order.items if i.description)
        or f"Amazon order {order.order_id}"
    )


def _safe_source_url(value: Optional[str]) -> Optional[str]:
    """An ``http(s)`` URL captured from an imported file, or ``None``. Captured URLs are rendered as real
    links, so a crafted export could otherwise smuggle a ``javascript:`` URL into the ledger and have it
    execute when a user clicks it in the origin hover. The render side validates too; this keeps the bad
    value out of the database in the first place, so the guard doesn't depend on every future renderer
    remembering it."""
    text = (value or "").strip()
    if not text:
        return None
    try:
        scheme = urlsplit(text).scheme.lower()
    except ValueError:
        return None
    return text if scheme in ("http", "https") else None


def _order_evidence(order: AmazonOrder) -> dict:
    """Import evidence for one order transaction. The description is the item list (present in the orders
    file itself); when the *items* file is also available, each item contributes a detail line carrying
    the reference metadata that only that file has (list price, quantity, ASIN) — folded in as evidence,
    never as separate rows. Amazon's own category taxonomy is deliberately not captured (the user
    categorizes by their own rules)."""
    extra = []
    for item in order.items:
        bits = []
        if item.quantity and item.quantity != 1:
            bits.append(f"×{item.quantity}")
        if item.price is not None:
            bits.append(f"list ${item.price:.2f}")
        if item.asin:
            bits.append(item.asin)
        label = item.description or "item"
        extra.append({"header": "Item", "value": f"{label} ({', '.join(bits)})" if bits else label})
    extra.append({"header": "Amazon Order", "value": order.order_id})
    evidence: dict = {"extra_text_fields": extra}
    summary = order.items_summary or "; ".join(i.description for i in order.items if i.description)
    if summary:
        evidence["description"] = {"header": "Items", "value": summary}
    if order.source_file:
        evidence["source_file"] = order.source_file   # which uploaded file this order came from
    # A deep link to the order's own Amazon page — the only place the full detail lives for a thin
    # export row (a digital D01 order often carries no item text at all). Deliberately its own key
    # rather than another `extra_text_fields` entry: those feed rule source-text matching and the
    # duplicate-merge "richest text" comparison, which a long URL would pollute.
    source_url = _safe_source_url(order.order_url)
    if source_url:
        evidence["source_url"] = source_url
    return evidence


def _create_order_txn(conn, order, amount, *, account_id, owner_id, batch_id, category_id,
                      flag_for_review: bool) -> str:
    """Create the single spending transaction for one order in the Amazon account (amount = net cash;
    the item list is the memo; per-item reference detail rides in evidence). One row per order — never
    per item.

    A **$0 order is a real record here** — fully gift-carded, promotional, or a return that nets out —
    not a pending charge awaiting an amount, which is why this source keeps them where CSV import refuses
    them (`SOURCE_AMAZON` in `services/source_capabilities.py`). Reconciliation depends on it: a $0 order
    that never landed would read as an order whose charge could not be found. Keeping them means there is
    no filter to write here; the declaration is held to the behaviour by test, not by a branch that can
    never fire.
    """
    label = _order_label(order)
    return _insert_imported_transaction(conn, batch_id, {
        "account_id": account_id,
        "owner_id": owner_id,
        "category_id": category_id,
        "amount": amount,
        "merchant_name": label,
        "display_name": label,
        "raw_name": label,
        "date": order.order_date,
        "is_pending": 0,
        "content_hash": make_hash(order.order_date or "", amount, order.order_id),
        "import_evidence": _order_evidence(order),
        "category_source": "import",
        "display_name_source": "import",
    }, flag_for_review=flag_for_review)


def _match_charge(conn, order, account_id, disposition):
    """Resolve the paying instrument against the funding-source → account map (override → global) and find
    + exclude the matching card charge for a **cash** order. A mapped instrument constrains the search to
    its account (and resolves same-amount ambiguity); an untracked instrument short-circuits (no charge —
    the order counts directly); unmapped falls to the search's own graceful-last-4 fallback. Returns
    ``(charge_id, charge_prior, funding_state)`` — ``charge_id`` is ``None`` when untracked or no
    unambiguous charge is found."""
    funding = amazon_funding.resolve_funding_account(
        conn, account_id, disposition.match_last4, disposition.match_network
    )
    if funding.state == "untracked":
        return None, None, funding.state
    charge_id = find_matching_charge(
        conn, disposition, exclude_account_id=account_id,
        restrict_account_id=funding.funding_account_id if funding.state == "mapped" else None,
    )
    if not charge_id:
        return None, None, funding.state
    return charge_id, _exclude_charge(conn, charge_id), funding.state


def _resolve_bare_card_order(conn, order, account_id, disposition):
    """The bare-card probe (decision doc, settled 2026-07-16): resolve a payments string that names a
    card but discloses no per-leg amounts (``Visa ending in 5093; Rewards Points;`` — the
    2024+ points-order shape). Classification alone conservatively lands non-cash ($0: points may have
    paid everything), but the ledger can settle it: if a *unique* eligible charge equal to the order's
    **full total** exists on the named card (the matcher's own rules — funding map / last-4, ±3-day
    window), the card demonstrably paid the whole order, so return the cash disposition it would have
    had with a disclosed amount; the normal match path then links + excludes that same charge. No
    unique full-total charge → keep non-cash: a genuine points/gift-funded order stays
    recorded-but-not-counted, and a partial card/points split stays conservative (no full-total charge
    exists; we never guess the card's share)."""
    if (disposition.kind != "non_cash"
            or not (disposition.bare_card_last4 or disposition.bare_card_network)
            or not order.total or order.total <= 0):
        return disposition
    tentative = OrderDisposition(
        kind="cash",
        net_cash=round(max(0.0, order.total - (order.refund or 0.0)), 2),
        charge_amount=round(order.total, 2),
        match_last4=disposition.bare_card_last4,
        match_date=order.order_date,
        match_network=disposition.bare_card_network,
    )
    funding = amazon_funding.resolve_funding_account(
        conn, account_id, tentative.match_last4, tentative.match_network)
    if funding.state == "untracked":
        return disposition
    charge_id = find_matching_charge(
        conn, tentative, exclude_account_id=account_id,
        restrict_account_id=funding.funding_account_id if funding.state == "mapped" else None,
    )
    return tentative if charge_id else disposition


def _instrument_of(disposition) -> Optional[dict]:
    """The paying instrument (last-4 + network) for the run's map-state reporting; ``None`` for a non-cash
    order or a bare off-card leg with no last-4 (not a mappable instrument)."""
    if disposition and disposition.kind == "cash" and disposition.match_last4:
        return {"last4": disposition.match_last4, "network": disposition.match_network}
    return None


# Item fields worth retaining for a parked (orders-file-not-yet-imported) item — the detail `_order_evidence`
# folds into an order row. Amazon's own category is deliberately omitted (the user categorizes their own way).
_PENDING_ITEM_FIELDS = ("description", "price", "asin", "quantity", "item_url", "order_date")


def _park_items(conn: sqlite3.Connection, order: AmazonOrder, batch_id: str) -> None:
    """Retain an items-only order's per-item detail (its orders file hasn't been imported yet), keyed by order
    id, so importing the matching orders file later auto-attaches it instead of the user re-importing the items
    file. Upsert by order id so a re-imported items file refreshes the parked detail rather than duplicating
    it, and is waiting again whatever it was before. See :func:`_take_parked_items` (the consume side) and
    ``amazon_pending_item``."""
    if not order.items:
        return
    payload = [{f: getattr(item, f, None) for f in _PENDING_ITEM_FIELDS} for item in order.items]
    conn.execute(
        """INSERT INTO amazon_pending_item (order_id, items_json, source_file, source_file_hash, parked_batch_id)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(order_id) DO UPDATE SET
               items_json       = excluded.items_json,
               source_file      = excluded.source_file,
               source_file_hash  = excluded.source_file_hash,
               parked_batch_id   = excluded.parked_batch_id,
               consumed_batch_id = NULL""",
        (order.order_id, json.dumps(payload), order.source_file, order.source_file_hash, batch_id),
    )


def _take_parked_items(conn: sqlite3.Connection, order_id: str,
                       batch_id: str) -> tuple[list[AmazonItem], Optional[dict]]:
    """Take any items waiting for this order id (an items file imported before this orders file), rebuilt as
    ``AmazonItem``s, and mark the parked row consumed by ``batch_id``. The row is kept rather than deleted
    because the attachment has to be reversible: undoing that orders import returns the items to waiting
    (see :func:`reverse_batch_amazon_links`), where deleting them would leave the items card claiming orders
    it no longer holds detail for. Returns ``(items, source)`` where ``source`` is the parked row's
    ``{batch_id, source_file, source_file_hash}`` (so the caller can fold that items-file card into the
    orders card), or ``([], None)`` when none are waiting."""
    row = conn.execute(
        """SELECT items_json, source_file, source_file_hash, parked_batch_id FROM amazon_pending_item
           WHERE order_id = ? AND consumed_batch_id IS NULL""",
        (order_id,)).fetchone()
    if not row:
        return [], None
    conn.execute("UPDATE amazon_pending_item SET consumed_batch_id = ? WHERE order_id = ?", (batch_id, order_id))
    source = {"batch_id": row["parked_batch_id"], "source_file": row["source_file"],
              "source_file_hash": row["source_file_hash"]}
    try:
        payload = json.loads(row["items_json"]) or []
    except (TypeError, ValueError):
        return [], source
    items = [
        AmazonItem(description=d.get("description") or "", price=d.get("price"), asin=d.get("asin"),
                   quantity=d.get("quantity") or 1, item_url=d.get("item_url"), order_date=d.get("order_date"))
        for d in payload if isinstance(d, dict)
    ]
    return items, source


def apply_amazon_order(
    conn: sqlite3.Connection,
    order: AmazonOrder,
    *,
    account_id: str,
    batch_id: str,
    flag_for_review: bool,
) -> dict:
    """Materialize one parsed order as a single spending transaction in the Amazon account and link its
    funding card charge. Orders-only model: one row per order (amount = net cash, memo = the item list),
    never per-item — the items file's per-item data rides in evidence. Behavior by input:

      * **Order already linked** → if this import carries item detail, fold it into the existing order
        transaction's evidence (``enriched``), or report ``already_enriched`` if that order already had item
        detail (a re-imported items file); a bare re-import with no new item detail is ``already_applied``.
        The card charge is matched here at first import; one that arrives later is matched by
        :func:`match_orders_after_ingest` when a sync or CSV import brings it. A mapping added later is not
        applied to a charge already matched (like the category setting, it affects future matches only).
      * **Items-only, no existing order** → no order row to attach to, so the items are **parked** by order
        id (``items_discarded``) rather than dropped; importing the matching orders file later auto-attaches
        them (see ``amazon_pending_item`` / :func:`_park_items`).
      * **Order detail present** → create the order transaction, match + exclude + link the card charge; if
        items for this order were parked by an earlier items-only import, attach that detail on the spot.
    """
    existing = txn_links.find_link(conn, LINK_KIND, order.order_id)
    if existing:
        if order.has_item_detail and order.items:
            enriched_txn_id, added = _enrich_order_txn(conn, existing, order)
            if added:
                return {"order_id": order.order_id, "status": "enriched", "enriched_txn_id": enriched_txn_id}
            if enriched_txn_id and not order.has_order_detail:
                # A re-imported *items* file whose order already had item detail. (A re-imported orders file
                # — which carries order detail — stays `already_applied` below.)
                return {"order_id": order.order_id, "status": "already_enriched", "enriched_txn_id": enriched_txn_id}
        return {"order_id": order.order_id, "status": "already_applied"}

    # Items file rows whose orders file hasn't been imported yet: park their detail (keyed by order id) so a
    # later import of the orders file auto-attaches it — no manual re-import. Nothing enters the ledger now.
    if not order.has_order_detail:
        _park_items(conn, order, batch_id)
        return {"order_id": order.order_id, "status": "items_discarded"}

    disposition = classify_order(order)
    # Bare-card orders: let the ledger settle the undisclosed card/points split before honoring
    # non-cash. (The probe finds the same unique charge _match_charge then links — one extra read.)
    disposition = _resolve_bare_card_order(conn, order, account_id, disposition)
    owner_id = _account_owner(conn, account_id)
    non_cash = disposition.kind == "non_cash"

    # Items parked by an earlier items-only import of this order attach now, so the order row is created
    # already enriched. A same-drop items file (order already carries item detail) supersedes them, but the
    # obsolete parked row is still consumed. `parked_source` (which items-file card parked them) is reported
    # whenever a parked row was consumed — used to fold that card into this orders card.
    parked_items, parked_source = _take_parked_items(conn, order.order_id, batch_id)
    attached_from_parked = False
    if parked_items and not order.items:
        order.items = parked_items
        order.has_item_detail = True
        attached_from_parked = True

    # A cash order counts (its net cash, categorized by the user's rules); a non-cash order (points /
    # gift-card funded) is recorded in the excluded category so it doesn't inflate spending.
    category_id = find_or_create_funding_category(conn) if non_cash else None
    order_txn_id = _create_order_txn(
        conn, order, disposition.net_cash,
        account_id=account_id, owner_id=owner_id, batch_id=batch_id, category_id=category_id,
        flag_for_review=flag_for_review,
    )

    members = [(order_txn_id, "order")]
    charge_id = charge_prior = None
    funding_state = None
    if not non_cash:
        charge_id, charge_prior, funding_state = _match_charge(conn, order, account_id, disposition)
        if charge_id:
            members.append((charge_id, "charge"))

    link_id = txn_links.create_link(
        conn, LINK_KIND, members,
        external_ref=order.order_id,
        metadata={
            "disposition": disposition.kind,
            "charge_amount": disposition.charge_amount,
            "net_cash": disposition.net_cash,
            "charge_prior": charge_prior,
            # The paying instrument + funding state, so the reconciliation report and the equal-count pass can
            # reconstruct the matcher's candidate set post-hoc (respecting the card last-4 / funding map, and
            # skipping untracked cards that expect no charge) instead of pairing any stray same-amount charge.
            "funding_state": funding_state,
            "instrument": _instrument_of(disposition),
        },
    )
    return {
        "order_id": order.order_id,
        "status": "applied",
        "link_id": link_id,
        "disposition": disposition.kind,
        "charge_linked": bool(charge_id),
        "has_items": bool(order.items),
        "attached_from_parked": attached_from_parked,
        "parked_source": parked_source,   # the items-file card this order drew parked detail from (or None)
        "funding_state": funding_state,
        "instrument": _instrument_of(disposition),
    }


def _enrich_order_txn(conn: sqlite3.Connection, link: dict, order: AmazonOrder) -> tuple[Optional[str], bool]:
    """Fold a later items file's per-item detail into an already-imported order transaction's evidence.
    Idempotent: if the order transaction already carries item detail (a prior items import), it's a no-op.
    Returns ``(order_txn_id, added)`` — ``added`` is False when the order was already enriched (or its txn is
    missing); the txn id is returned either way so the import-detail report can show which order it hit."""
    order_txn_ids = [m["txn_id"] for m in link.get("members", []) if m["role"] == "order"]
    if not order_txn_ids:
        return None, False
    txn_id = order_txn_ids[0]
    row = conn.execute("SELECT import_evidence_json FROM txn WHERE id = ?", (txn_id,)).fetchone()
    if not row:
        return txn_id, False
    try:
        evidence = json.loads(row["import_evidence_json"]) if row["import_evidence_json"] else {}
    except (TypeError, ValueError):
        evidence = {}
    existing_fields = evidence.get("extra_text_fields") or []
    if any((f.get("header") == "Item") for f in existing_fields):
        return txn_id, False  # already enriched with item detail
    new_evidence = _order_evidence(order)
    # Merge: keep any existing description; append the item detail fields ahead of the bare order-id field.
    merged_fields = new_evidence["extra_text_fields"] + [
        f for f in existing_fields if f.get("header") != "Amazon Order"
    ]
    evidence["extra_text_fields"] = merged_fields
    if "description" not in evidence and "description" in new_evidence:
        evidence["description"] = new_evidence["description"]
    conn.execute(
        "UPDATE txn SET import_evidence_json = ? WHERE id = ?", (json.dumps(evidence), txn_id)
    )
    return txn_id, True


def _categorize_batch_orders(conn: sqlite3.Connection, batch_id: str) -> None:
    """Run the user's categorization rules over this batch's freshly-created, still-uncategorized order
    rows (the "apply categorizations" option) — the same category + rule-rename + rule-tag apply the CSV
    importer does. Non-cash orders sit in the excluded funding category (not NULL) and are skipped."""
    # Imported here (not at module load) to avoid a service→router import cycle; the pass is per-import.
    from backend.services.categorizer import (
        categorize_transaction,
        load_categorization_rules,
        load_rule_tags_by_id,
        rule_scalar_effects,
        source_match_text_from_json,
    )
    from backend.services import rule_conflicts
    from backend.services.transaction_tags import sync_rule_tags_for_transaction

    rules = load_categorization_rules(conn)
    if not rules:
        return
    rule_tags_by_id = load_rule_tags_by_id(conn)
    needs_source_text = any(rule["match_source_text"] for rule in rules)
    rows = conn.execute(
        """SELECT id, merchant_name, raw_name, display_name, amount, owner_id, account_id, import_evidence_json
           FROM   txn WHERE import_batch_id = ? AND category_id IS NULL""",
        (batch_id,),
    ).fetchall()
    results = []
    for row in rows:
        source_text = source_match_text_from_json(row["import_evidence_json"]) if needs_source_text else None
        result = categorize_transaction(
            row["merchant_name"], row["raw_name"], row["amount"], conn,
            owner_id=row["owner_id"], account_id=row["account_id"],
            rules=rules, rule_tags_by_id=rule_tags_by_id, source_text=source_text,
        )
        results.append((row["id"], result))
        if not result:
            continue
        cat_id = result.get("category_id")
        name_effects = rule_scalar_effects(result, fallback_name=row["display_name"] or row["merchant_name"])
        set_parts, params = [], []
        if cat_id:
            set_parts += ["category_id = ?", "category_source = 'rule'"]
            params.append(cat_id)
        if name_effects["renamed_by_rule"]:
            set_parts += ["display_name = ?", "display_name_source = 'rule'"]
            params.append(name_effects["display_name"])
        if set_parts:
            conn.execute(f"UPDATE txn SET {', '.join(set_parts)} WHERE id = ?", (*params, row["id"]))
        sync_rule_tags_for_transaction(conn, row["id"], result.get("tag_ids", []))
    rule_conflicts.record(conn, results)


_COUNT_KEYS = ("orders_imported", "non_cash", "charges_matched",
               "items_enriched", "already_enriched", "items_discarded", "already_applied",
               "items_attached_from_parked")


def _group_label(group_orders: list[AmazonOrder], fallback: str) -> str:
    """The card label for a source-file group: the distinct files that fed it — the orders file plus any
    items file whose rows folded into these orders — in first-seen order, so a paired drop reads
    ``"2023-orders.csv, 2023-items.csv"`` and an orphan items card reads just its own name. Falls back to the
    run-level filename when the orders carry no source file (in-process callers / tests)."""
    seen: list[str] = []
    for order in group_orders:
        for sf in [order.source_file, *(item.source_file for item in order.items)]:
            if sf and sf not in seen:
                seen.append(sf)
    return ", ".join(seen) or fallback


def _import_group_to_batch(
    conn: sqlite3.Connection,
    orders: list[AmazonOrder],
    *,
    account_id: str,
    filename: str,
    apply_categorization: bool,
    flag_for_review: bool,
    profile_id: Optional[str] = None,
) -> dict:
    """Create one import batch (one card) and apply every order of a *single source-file group* into it — the
    per-file unit the orchestrator splits a drop into. Returns the batch's counts, investigable detail, the
    instruments it saw, and its per-file outcomes (keyed by content hash), leaving the config-snapshot /
    file-hash persistence to :func:`run_amazon_import`, which needs the whole drop's outcomes to decide which
    files are re-importable."""
    batch_id = str(uuid.uuid4())
    conn.execute(
        "INSERT INTO import_batch (id, filename, status, source_kind, profile_id) VALUES (?, ?, 'completed', ?, ?)",
        (batch_id, filename, BATCH_SOURCE_KIND, profile_id),
    )
    counts = {k: 0 for k in _COUNT_KEYS}
    # Investigable detail for the import-detail report: item rows that enriched an order (which usually lives
    # in the orders file's batch, so they can't be found from this batch's transactions), item rows whose
    # order was already enriched, item rows with no matching order (discarded), and orders already imported —
    # each with the file it came from.
    enriched_items: list[dict] = []
    already_enriched_items: list[dict] = []
    discarded_items: list[dict] = []
    duplicate_orders: list[dict] = []
    # Items-file cards (prior items-only imports) whose parked detail this batch's orders consumed, keyed by
    # that card's batch id → its {source_file, source_file_hash}. The orchestrator folds a fully-consumed one
    # into this card, so a split items-then-orders import ends on a single card like a combined drop would.
    consumed_sources: dict[str, dict] = {}
    # Order transactions this batch *enriched* (an items file attaching to already-imported orders). Their
    # batches are the orders cards this items-only card belongs with — the mirror of `consumed_sources`, so the
    # orchestrator can fold an enrichment-only items card into the orders card it enriched (orders-then-items).
    enriched_txn_ids: list[str] = []
    # Distinct instruments seen this run, keyed on (last4, network), each carrying its current map state
    # so the UI can prompt to map the ones that are still `unmapped`.
    instruments: dict[tuple, dict] = {}
    # Outcome kinds per source *file hash* (carrying the filename), so the orchestrator can decide, across the
    # whole drop, which files are re-importable: a file with any *discarded* rows keeps its hash un-persisted
    # (once the missing orders file is in, a re-import attaches the previously-discarded items). Keyed by hash
    # rather than name so two different files that share a name are still told apart.
    file_outcomes: dict[str, dict] = {}

    def _note_outcome(source_file, source_file_hash, kind):
        if source_file_hash:
            entry = file_outcomes.setdefault(source_file_hash, {"filename": source_file, "kinds": set()})
            entry["kinds"].add(kind)

    for order in orders:
        result = apply_amazon_order(conn, order, account_id=account_id, batch_id=batch_id,
                                    flag_for_review=flag_for_review)
        status = result["status"]
        if status == "already_applied":
            counts["already_applied"] += 1
            duplicate_orders.append({"order_id": order.order_id, "date": order.order_date, "source_file": order.source_file})
            _note_outcome(order.source_file, order.source_file_hash, "already")
            continue
        if status in ("enriched", "already_enriched"):
            bucket = "items_enriched" if status == "enriched" else "already_enriched"
            counts[bucket] += 1
            detail = {"order_id": order.order_id, "txn_id": result.get("enriched_txn_id"),
                      "description": _order_label(order), "source_file": order.source_file}
            (enriched_items if status == "enriched" else already_enriched_items).append(detail)
            _note_outcome(order.source_file, order.source_file_hash, "enriched" if status == "enriched" else "already")
            if result.get("enriched_txn_id"):
                enriched_txn_ids.append(result["enriched_txn_id"])
            continue
        # Items file rows with no imported order to attach to — discarded, not staged (re-import later).
        if status == "items_discarded":
            counts["items_discarded"] += 1
            discarded_items.append({"order_id": order.order_id, "description": _order_label(order),
                                    "date": order.order_date, "source_file": order.source_file})
            _note_outcome(order.source_file, order.source_file_hash, "discarded")
            continue
        _note_outcome(order.source_file, order.source_file_hash, "taken")
        # An items file whose rows folded into this order (an orders+items paired drop) contributed to the card
        # too — record it as taken so its hash is remembered, even though its detail rides inside the order row.
        for item in order.items:
            _note_outcome(item.source_file, item.source_file_hash, "taken")
        inst = result.get("instrument")
        if inst:
            key = (inst["last4"], inst["network"])
            instruments.setdefault(key, {**inst, "state": result.get("funding_state") or "unmapped"})
        if result.get("charge_linked"):
            counts["charges_matched"] += 1
        if result.get("attached_from_parked"):
            counts["items_attached_from_parked"] += 1
        src = result.get("parked_source")
        if src and src.get("batch_id"):
            consumed_sources[src["batch_id"]] = {"source_file": src.get("source_file"),
                                                 "source_file_hash": src.get("source_file_hash")}
        if result.get("disposition") == "non_cash":
            counts["non_cash"] += 1
        else:
            counts["orders_imported"] += 1

    # Equal-count pass: same-amount orders exactly balanced by same-amount charges are distinct purchases the
    # matcher only left unmatched on the which-pairs-with-which ambiguity — pair them so they don't surface as
    # false duplicates. (A surplus of charges is a real duplicate and is left for the reconciliation report.)
    counts["charges_matched"] += _pair_equal_amount_clusters(conn, batch_id)

    if apply_categorization:
        _categorize_batch_orders(conn, batch_id)

    conn.execute(
        "UPDATE import_batch SET row_count = ? WHERE id = ?",
        (counts["orders_imported"] + counts["non_cash"], batch_id),
    )
    refresh_batch_coverage(conn, [batch_id])
    # The orders cards this items-only card enriched (distinct batches of the order rows it attached to) — the
    # orchestrator folds this card into that orders card when they're all one.
    enriched_into_batches: set = set()
    if enriched_txn_ids:
        placeholders = ",".join("?" * len(enriched_txn_ids))
        for row in conn.execute(
            f"SELECT DISTINCT import_batch_id FROM txn WHERE id IN ({placeholders})", enriched_txn_ids):
            if row["import_batch_id"]:
                enriched_into_batches.add(row["import_batch_id"])
    return {
        "batch_id": batch_id,
        "filename": filename,
        "account_id": account_id,
        "order_count": len(orders),
        "counts": counts,
        "instruments": list(instruments.values()),
        "enriched_items": enriched_items,
        "already_enriched_items": already_enriched_items,
        "discarded_items": discarded_items,
        "duplicate_orders": duplicate_orders,
        "file_outcomes": file_outcomes,
        "consumed_sources": consumed_sources,
        "enriched_into_batches": enriched_into_batches,
    }


def run_amazon_import(
    conn: sqlite3.Connection,
    orders: list[AmazonOrder],
    *,
    account_id: str,
    filename: str = "amazon.csv",
    apply_categorization: bool = True,
    file_hashes: Optional[list[dict]] = None,
    profile_id: Optional[str] = None,
) -> dict:
    """Import a drop of parsed Amazon orders, split into **one batch (card) per source file** rather than one
    card for the whole drop: orders are grouped by the file they came from (``source_file_hash``), and each
    group becomes its own reversible batch — with an orders file's items folded into that same card, and an
    items file dropped without its orders file surfacing as its own card of discards. This makes a drop of
    several order-history periods behave exactly as if each file had been imported one at a time (independent
    coverage / undo / reconciliation), instead of bundling unrelated periods onto one card.

    Returns a summary carrying every batch created (``batches``) plus drop-level aggregates — the total order
    count, summed counts, and the union of instruments seen — and, for the common single-file drop, the
    single ``batch_id`` at top level (``None`` when the drop produced several cards). ``file_hashes``
    (``{filename, hash}`` per taken file) is persisted per card so a later upload of the same file is
    recognized and skipped (see ``_imported_amazon_file_hashes``); a file with any discarded rows is left
    re-importable across the whole drop, not just within one card."""
    # Group by the source file's content hash, preserving first-seen order so cards list in upload order.
    groups: dict = {}
    for order in orders:
        groups.setdefault(order.source_file_hash, []).append(order)
    if not groups:
        groups = {None: []}   # an empty drop still yields one (empty) batch, as before

    # Every order lands in the one Amazon account, so the drop has a single owner to ask.
    flag_for_review = flags_new_transactions(conn, _account_owner(conn, account_id))
    batch_results = [
        _import_group_to_batch(conn, group_orders, account_id=account_id,
                               filename=_group_label(group_orders, filename),
                               apply_categorization=apply_categorization,
                               flag_for_review=flag_for_review, profile_id=profile_id)
        for group_orders in groups.values()
    ]

    # A file with any discarded rows stays re-importable (its hash is NOT persisted) — decided across the
    # *whole drop*, since one items file can fold into an orders card here yet leave orphans on its own card.
    discard_hashes = {h for res in batch_results for h, info in res["file_outcomes"].items()
                      if "discarded" in info["kinds"]}
    persistable = [f for f in (file_hashes or []) if f.get("hash") and f["hash"] not in discard_hashes]

    for res in batch_results:
        touched = set(res["file_outcomes"].keys())
        # Persist each taken file's hash on every card its rows fed (so undoing a card frees exactly the files
        # it took); a hash matched to no card is pinned to the first so the drop as a whole still remembers it.
        attributed = [f for f in persistable if f["hash"] in touched]
        _persist_batch_snapshot(conn, res, attributed)
    orphans = [f for f in persistable if not any(f["hash"] in res["file_outcomes"] for res in batch_results)]
    if orphans and batch_results:
        _persist_batch_snapshot(conn, batch_results[0], orphans, append=True)

    # Fold an empty items-only card into the orders card that holds its matching orders — so a split
    # items↔orders import ends on one card, labeled with both files, exactly as a combined drop would. Both
    # import orderings are handled, each only when a *single* orders card is involved:
    #   * items-before-orders (parked) — a prior items-only card whose parked detail this drop's orders
    #     consumed folds into this drop's orders card (`consumed_sources`).
    #   * orders-before-items (enrichment) — this drop's items-only card, which only enriched already-imported
    #     orders, folds into the (prior) orders card it enriched (`enriched_into_batches`).
    res_by_id = {res["batch_id"]: res for res in batch_results}
    source_to_order_batches: dict[str, set] = {}
    source_info: dict[str, dict] = {}
    for res in batch_results:
        for src_id, info in res["consumed_sources"].items():
            source_to_order_batches.setdefault(src_id, set()).add(res["batch_id"])
            source_info[src_id] = info
    for src_id, into_ids in source_to_order_batches.items():
        if len(into_ids) == 1:
            into_res = res_by_id[next(iter(into_ids))]
            info = source_info[src_id]
            merged = _merge_items_card_into_orders(
                conn, items_card_id=src_id, items_filename=info.get("source_file"),
                items_hash=info.get("source_file_hash"), orders_card_id=into_res["batch_id"])
            if merged:
                into_res["filename"] = merged

    for res in batch_results:
        c = res["counts"]
        into_batches = res.get("enriched_into_batches") or set()
        # An enrichment-only card: it created no orders of its own and parked nothing (everything it carried
        # attached to existing orders), and all those orders live in one prior orders card.
        enrichment_only = (c["orders_imported"] == 0 and c["non_cash"] == 0 and c["items_discarded"] == 0
                           and c["items_attached_from_parked"] == 0
                           and (c["items_enriched"] > 0 or c["already_enriched"] > 0))
        if enrichment_only and len(into_batches) == 1:
            orders_card_id = next(iter(into_batches))
            items_file = next(iter(res["file_outcomes"].values()), {})
            items_hash = next(iter(res["file_outcomes"].keys()), None)
            merged = _merge_items_card_into_orders(
                conn, items_card_id=res["batch_id"], items_filename=items_file.get("filename") or res["filename"],
                items_hash=items_hash, orders_card_id=orders_card_id)
            if merged:
                # This card is now deleted; repoint its completion-screen entry at the surviving orders card
                # (so its "N matched" line links to the merged card rather than a deleted one).
                res["batch_id"], res["filename"] = orders_card_id, merged

    agg = {k: sum(res["counts"][k] for res in batch_results) for k in _COUNT_KEYS}
    instruments: dict[tuple, dict] = {}
    for res in batch_results:
        for inst in res["instruments"]:
            instruments.setdefault((inst["last4"], inst["network"]), inst)
    return {
        "batches": [{k: res[k] for k in ("batch_id", "filename", "order_count", "counts", "instruments")}
                    for res in batch_results],
        # Back-compatible single-batch fields: the lone card's id for a one-file drop (else None), the drop's
        # total order count, its summed counts, and the union of instruments seen across cards.
        "batch_id": batch_results[0]["batch_id"] if len(batch_results) == 1 else None,
        "order_count": sum(res["order_count"] for res in batch_results),
        "counts": agg,
        "instruments": list(instruments.values()),
    }


def _persist_batch_snapshot(conn: sqlite3.Connection, res: dict, file_hashes: list[dict], *, append: bool = False) -> None:
    """Persist a card's investigable ``import_summary`` + the per-file content hashes it took, so the file
    card and the import-detail report can show the outcome on a later page load (the counts otherwise live
    only in the endpoint's return value → the notice shown as the import lands). ``append`` merges extra hashes into an
    already-written snapshot (for a file that fed no card's rows but still belongs to the drop)."""
    if append:
        row = conn.execute("SELECT config_snapshot FROM import_batch WHERE id = ?", (res["batch_id"],)).fetchone()
        snap = json.loads(row["config_snapshot"]) if row and row["config_snapshot"] else {}
        existing = snap.get("amazon_file_hashes") or []
        seen = {f["hash"] for f in existing}
        snap["amazon_file_hashes"] = existing + [f for f in file_hashes if f["hash"] not in seen]
    else:
        snap = {IMPORT_SUMMARY_KEY: {**res["counts"],
                                     "enriched_items": res["enriched_items"],
                                     "already_enriched_items": res["already_enriched_items"],
                                     "discarded_items": res["discarded_items"],
                                     "duplicate_orders": res["duplicate_orders"]},
                # The Amazon account this card imported into. Recorded rather than derived from the card's
                # rows because a card need not have any — an items-only card holds parked detail and no
                # transactions at all, and it still belongs under the account it was imported into.
                "amazon_account_id": res.get("account_id"),
                # Per-file content hashes (kept out of import_summary — provenance, not outcome), so a
                # re-uploaded file is recognized and skipped instead of re-processed as all-duplicates.
                "amazon_file_hashes": [{"filename": f["filename"], "hash": f["hash"]} for f in file_hashes]}
    conn.execute("UPDATE import_batch SET config_snapshot = ? WHERE id = ?", (json.dumps(snap), res["batch_id"]))


def _merge_items_card_into_orders(conn: sqlite3.Connection, *, items_card_id: str, items_filename: Optional[str],
                                  items_hash: Optional[str], orders_card_id: str) -> Optional[str]:
    """Fold an empty items-only card into the orders card that holds its matching orders — the single-card
    result a combined drop produces. Used for both import orderings (items-before-orders parking and
    orders-before-items enrichment): in each the *items* card carries no ledger rows of its own (its detail
    rides on the orders card's rows), so deleting it loses nothing. Moves the items file's name + hash onto
    the orders card (so a later re-drop of it is recognized as already imported) and returns the orders
    card's new filename, or ``None`` if a guard blocked the merge (items card not empty, either card missing
    or not a marketplace batch, or the two are the same card)."""
    if not orders_card_id or items_card_id == orders_card_id:
        return None
    # Every item this card parked must have been taken by *this* orders card. One still waiting means the
    # card is not resolved; one taken by another orders card means undoing that card must find the items
    # card again to return them to, so it is kept, as an items file enriching two orders cards is.
    if conn.execute(
        """SELECT 1 FROM amazon_pending_item
           WHERE parked_batch_id = ? AND (consumed_batch_id IS NULL OR consumed_batch_id != ?) LIMIT 1""",
        (items_card_id, orders_card_id),
    ).fetchone():
        return None
    items_card = conn.execute(
        "SELECT row_count, source_kind, config_snapshot FROM import_batch WHERE id = ?", (items_card_id,)).fetchone()
    if (not items_card or items_card["source_kind"] != BATCH_SOURCE_KIND or (items_card["row_count"] or 0) > 0
            or conn.execute("SELECT 1 FROM txn WHERE import_batch_id = ? LIMIT 1", (items_card_id,)).fetchone()):
        return None   # defensive: only an empty items-only card is safe to delete
    orders_card = conn.execute(
        "SELECT filename, source_kind, config_snapshot FROM import_batch WHERE id = ?", (orders_card_id,)).fetchone()
    if not orders_card or orders_card["source_kind"] != BATCH_SOURCE_KIND:
        return None

    names = [n for n in (orders_card["filename"] or "").split(", ") if n]
    for name in (items_filename or "").split(", "):
        if name and name not in names:
            names.append(name)
    merged_filename = ", ".join(names)

    snap = json.loads(orders_card["config_snapshot"]) if orders_card["config_snapshot"] else {}
    hashes = snap.get("amazon_file_hashes") or []
    if items_hash and not any(h.get("hash") == items_hash for h in hashes):
        hashes.append({"filename": items_filename, "hash": items_hash})
        snap["amazon_file_hashes"] = hashes
    # Carry the items card's *enrichment* summary onto the orders card, so the merged card's import-detail
    # report still shows which orders the items file matched (and its "N matched" pill) — otherwise deleting
    # the items card would drop that provenance. A no-op for the parked direction (a parked card enriched
    # nothing); the resolved discards / order counts are deliberately not carried (the orders card owns them).
    _merge_enrichment_summary(snap, _summary_of(items_card["config_snapshot"]))
    conn.execute("UPDATE import_batch SET filename = ?, config_snapshot = ? WHERE id = ?",
                 (merged_filename, json.dumps(snap), orders_card_id))
    # The orders card now carries both files, so undoing it undoes the items file too: its parked rows have
    # no card to return to and go with the one they were parked by.
    conn.execute("DELETE FROM amazon_pending_item WHERE parked_batch_id = ?", (items_card_id,))
    conn.execute("DELETE FROM import_batch WHERE id = ?", (items_card_id,))
    return merged_filename


def _summary_of(config_snapshot: Optional[str]) -> dict:
    """The ``import_summary`` dict from a batch's ``config_snapshot`` JSON, or ``{}``."""
    try:
        snap = json.loads(config_snapshot) if config_snapshot else {}
    except (TypeError, ValueError):
        return {}
    summary = snap.get(IMPORT_SUMMARY_KEY) if isinstance(snap, dict) else {}
    return summary if isinstance(summary, dict) else {}


def _merge_enrichment_summary(orders_snap: dict, items_summary: dict) -> None:
    """Fold an items card's enrichment counts + detail into the orders card's ``import_summary`` in place."""
    orders_summary = orders_snap.get(IMPORT_SUMMARY_KEY)
    orders_summary = orders_summary if isinstance(orders_summary, dict) else {}
    for key in ("items_enriched", "already_enriched"):
        moved = int(items_summary.get(key) or 0)
        if moved:
            orders_summary[key] = int(orders_summary.get(key) or 0) + moved
    for key in ("enriched_items", "already_enriched_items"):
        extra = items_summary.get(key) or []
        if extra:
            orders_summary[key] = (orders_summary.get(key) or []) + extra
    if orders_summary:
        orders_snap[IMPORT_SUMMARY_KEY] = orders_summary


_REVERSE_SCAN_WINDOW_DAYS = 7
# The names an Amazon charge reaches the card under, as families: each one's payee substrings, checked in
# order so a service is named before the generic Amazon match takes it. Amazon bills its own digital
# services under their brand names, so a Prime Video channel, a Kindle subscription or an Audible membership
# reaches the card as "Prime Video", "Kindle" or "Audible" while its order sits in the order history like
# any other. "Prime" alone is not enough: unrelated businesses carry it. The same list decides which charges
# look like Amazon (`_AMAZON_NAME_LIKE`) and labels each charge on the reconciliation report
# (`payee_family`), so a new name is added once.
AMAZON_PAYEE_FAMILIES = (
    ("Prime Video", ("PRIME VIDEO",)),
    ("Audible", ("AUDIBLE",)),
    ("Kindle", ("KINDLE",)),
    ("Amazon Music", ("AMAZON MUSIC",)),
    ("Amazon", ("AMZN", "AMAZON")),
)
OTHER_PAYEE_FAMILY = "Other"
_AMAZON_PAYEE_PATTERNS = tuple(dict.fromkeys(p for _, patterns in AMAZON_PAYEE_FAMILIES for p in patterns))


def payee_family(charge: dict) -> str:
    """The family a charge's payee belongs to, read from the same fields the Amazon-name test reads."""
    text = f"{charge.get('merchant_name') or ''} {charge.get('raw_name') or ''}".upper()
    for family, patterns in AMAZON_PAYEE_FAMILIES:
        if any(pattern in text for pattern in patterns):
            return family
    return OTHER_PAYEE_FAMILY


_AMAZON_NAME_LIKE = "(" + " OR ".join(
    f"UPPER({column}) LIKE '%{pattern}%'"
    for pattern in _AMAZON_PAYEE_PATTERNS for column in ("t.merchant_name", "t.raw_name")) + ")"

# Split-charge suggestion (Matched·review): Amazon often bills one order as several shipment charges, so no
# single charge equals the order total. We look for a *unique* set of unaccounted charges — at most this many
# parts, within this many days of the order, summing to the order total within this tolerance — and surface
# it for the user to Accept/Dismiss. A wider window than the auto-matcher's ±3 since the user confirms each.
_SPLIT_SUGGESTION_WINDOW_DAYS = 14
_SPLIT_SUGGESTION_MAX_PARTS = 4
_SPLIT_SUGGESTION_TOLERANCE = 0.02


def _txn_summary(conn: sqlite3.Connection, txn_id: str) -> Optional[dict]:
    return txn_summaries(conn, [txn_id]).get(txn_id)


def _charge_accounts(conn: sqlite3.Connection, seed_accounts) -> set:
    """The accounts Amazon charges land on: the given seed (this batch's matched-charge accounts) plus every
    globally-mapped funding account. The shared search space for the reverse scan and duplicate detection.

    Expanded to whole account *groups* because the pool is expressed as `t.account_id IN (...)`: a mapped
    funding account that has since been merged names a child no charge lands on any more, so without the
    expansion an unmatched order gets neither a split suggestion nor an "unaccounted charge" listing —
    the charge is simply invisible to the report (see ``services/account_groups.py``)."""
    accounts = set(seed_accounts)
    for r in conn.execute(
        "SELECT DISTINCT funding_account_id FROM amazon_funding_map WHERE funding_account_id IS NOT NULL"
    ).fetchall():
        accounts.add(r["funding_account_id"])
    return account_group_member_ids(conn, accounts)


def _amazon_charge_pool(conn, order_dates: list[str], seed_accounts: set, window_days: int) -> list[dict]:
    """Unlinked ledger charges that *look* like Amazon, on the cards Amazon charges, within ``window_days``
    of the batch's order-date range — the shared candidate set for the reverse scan (informational
    unaccounted charges) and the split-charge suggestion (which uses a wider window)."""
    dates = [d for d in order_dates if d]
    if not dates:
        return []
    accounts = _charge_accounts(conn, seed_accounts)
    if not accounts:
        return []
    placeholders = ",".join("?" * len(accounts))
    rows = conn.execute(
        f"""SELECT t.id
            FROM   txn t
            WHERE  t.account_id IN ({placeholders})
              AND  t.trashed_at IS NULL
              AND  t.amount > 0
              AND  date(t.date) BETWEEN date(?, '-{int(window_days)} days')
                                   AND date(?, '+{int(window_days)} days')
              AND  {_AMAZON_NAME_LIKE}
              AND  NOT EXISTS (SELECT 1 FROM txn_link_member m WHERE m.txn_id = t.id)
            ORDER BY t.date""",
        [*accounts, min(dates), max(dates)],
    ).fetchall()
    return [c for c in (_txn_summary(conn, r["id"]) for r in rows) if c]


def _reverse_scan(conn, order_dates: list[str], seed_accounts: set, exclude_ids: "set | frozenset" = frozenset()) -> list[dict]:
    """The payment side of the reconciliation: Amazon-looking ledger charges within the batch's date range
    that no Amazon order is linked to. Purely informational — the user may have bought something the export
    missed, or a name that merely resembles Amazon (hence heuristic). ``exclude_ids`` drops charges already
    surfaced in a duplicate group or consumed by an accepted split suggestion."""
    return [c for c in _amazon_charge_pool(conn, order_dates, seed_accounts, _REVERSE_SCAN_WINDOW_DAYS)
            if c and c["id"] not in exclude_ids]


def _sorted_pair(a: str, b: str) -> tuple:
    return (a, b) if a < b else (b, a)


def _distinct_charge_pairs(conn: sqlite3.Connection, ids: list) -> set:
    """The user's accumulated "not duplicates" assertions among these charge ids (see
    ``amazon_charge_distinct``), as sorted-id pairs."""
    if len(ids) < 2:
        return set()
    placeholders = ",".join("?" * len(ids))
    rows = conn.execute(
        f"""SELECT txn_id_low, txn_id_high FROM amazon_charge_distinct
            WHERE txn_id_low IN ({placeholders}) AND txn_id_high IN ({placeholders})""",
        [*ids, *ids],
    ).fetchall()
    return {(r["txn_id_low"], r["txn_id_high"]) for r in rows}


def _reviewed_charge_ids(conn: sqlite3.Connection, ids: list) -> set:
    """The subset of ``ids`` the user acknowledged via **Mark reviewed** on the reconciliation report's
    reverse-scan ('Unaccounted charge') bucket (see ``amazon_charge_reviewed``). An acknowledged charge
    stays listed in the bucket but drops out of the batch's attention count — the escape valve that lets
    the informational bucket be surfaced for a look without nagging forever."""
    if not ids:
        return set()
    placeholders = ",".join("?" * len(ids))
    rows = conn.execute(
        f"SELECT txn_id FROM amazon_charge_reviewed WHERE txn_id IN ({placeholders})", list(ids)
    ).fetchall()
    return {r["txn_id"] for r in rows}


def _charges_marked_distinct(conn: sqlite3.Connection, ids: list) -> bool:
    """True when *every* pair among ``ids`` carries a user "Not duplicates" assertion — the group is
    settled as distinct purchases, so the report must not re-flag it as a duplicate. A partially
    marked group (3+ copies with only some pairs asserted) still flags: the unresolved ambiguity
    remains."""
    if len(ids) < 2:
        return False
    pairs = _distinct_charge_pairs(conn, ids)
    return all(_sorted_pair(a, b) in pairs for i, a in enumerate(ids) for b in ids[i + 1:])


def _group_unaccounted_duplicates(conn: sqlite3.Connection, charges: list[dict]) -> tuple[list[dict], list[dict]]:
    """Split the reverse scan's unaccounted charges into suspected double imports and true singles.
    Copies of one real charge (bank post-date vs. an aggregator's date) land on the *same effective
    account* with the *same amount* a day or three apart — so cluster by (effective account, rounded
    amount) with dates chained within the matcher's ±3-day window. **Effective** account (the linked-group
    root, ``COALESCE(parent, account)``) so two copies that straddle a parent/child account merge — the
    Mint double-import case this targets — still group, matching the order-anchored path
    (``_same_account_copies``). Clusters of 2+ become Unaccounted·duplicate groups for per-row review
    (same-amount-nearby is weaker evidence than an order-anchored duplicate — repeated same-price purchases
    are real); the rest stay informational. Pairs the user has declared **Not duplicates**
    (``amazon_charge_distinct``) never chain, so the assertion sticks across refreshes. Cross-account
    copies (distinct effective accounts) are deliberately not paired here — that's the unified duplicates
    system's job, with its keep/reject account-pair semantics. Returns ``(singles, groups)``; groups carry
    ``{"charges": [...]}``."""
    distinct = _distinct_charge_pairs(conn, [c["id"] for c in charges])
    eff = _effective_account_map(conn, [c["id"] for c in charges])
    by_key: dict[tuple, list[dict]] = {}
    for c in charges:
        by_key.setdefault((eff.get(c["id"]), round(c.get("amount") or 0, 2)), []).append(c)
    singles: list[dict] = []
    groups: list[dict] = []
    for rows in by_key.values():
        rows.sort(key=lambda c: c.get("date") or "")
        cluster: list[dict] = []
        def flush():
            if len(cluster) > 1:
                groups.append({"charges": list(cluster)})
            else:
                singles.extend(cluster)
        for c in rows:
            prev_day = _parse_day(cluster[-1].get("date")) if cluster else None
            day = _parse_day(c.get("date"))
            if cluster and prev_day is not None and day is not None \
                    and (day - prev_day).days <= _CHARGE_DATE_WINDOW_DAYS \
                    and all(_sorted_pair(c["id"], m["id"]) not in distinct for m in cluster):
                cluster.append(c)
            else:
                flush()
                cluster = [c]
        flush()
    singles.sort(key=lambda c: c.get("date") or "")
    groups.sort(key=lambda g: g["charges"][0].get("date") or "")
    return singles, groups


def _parse_day(value) -> Optional[date]:
    """Parse a transaction date ('YYYY-MM-DD', possibly with a time suffix) to a date, or None."""
    try:
        return date.fromisoformat(str(value)[:10])
    except (ValueError, TypeError):
        return None


def _lone_suggestion_reason(charge: dict, day: date, order_day: date, target: float,
                            matcher_candidates: list) -> str:
    """Why a *single*-charge suggestion needs review instead of having auto-matched: name the matcher
    constraint the charge fails (date window / exact amount / permitted account) — or, when it passes them
    all, the import-time pass simply never saw it (imported later, or ambiguous then). Split (multi-charge)
    suggestions carry no reason — their story is the row's charge count itself."""
    if charge["id"] in matcher_candidates:
        return ("This charge qualifies for an automatic match now, but wasn't available (or wasn't the "
                "only candidate) when the order was imported.")
    gap = (day - order_day).days
    if abs(gap) > _CHARGE_DATE_WINDOW_DAYS:
        return (f"The charge is {abs(gap)} day{'s' if abs(gap) != 1 else ''} "
                f"{'after' if gap > 0 else 'before'} the order — outside the automatic match's "
                f"±{_CHARGE_DATE_WINDOW_DAYS}-day window.")
    if round(charge.get("amount") or 0, 2) != round(target, 2):
        cents = round(abs((charge.get("amount") or 0) - target) * 100)
        return (f"The charge is {cents}¢ off the order total — the automatic match requires the "
                "exact amount.")
    return (f"The charge is on {charge.get('account')}, not the account this card's charges are "
            "expected on.")


def _split_charge_suggestion(order: dict, meta: dict, pool: list, matcher_candidates: list) -> Optional[dict]:
    """When an unmatched cash order's charge was split across shipments, find the charges that cover it: a
    *unique* combination of unaccounted charges (≤ ``_SPLIT_SUGGESTION_MAX_PARTS``, each within
    ``_SPLIT_SUGGESTION_WINDOW_DAYS`` of the order, together summing to the order's charge amount within
    ``_SPLIT_SUGGESTION_TOLERANCE``). Returns ``{charges, total, spans_days, reason}`` — or None when
    nothing sums cleanly, or when more than one distinct combination does (ambiguous, so we never guess) —
    with one exception: if exactly one of the competing combinations is a single charge dated **on the
    order itself** while every rival is off-date, that one is suggested (the case arrives after a
    "Not duplicates" verdict frees same-amount candidates back to this pass, where the date is the best
    remaining evidence for which charge is the order's). Also covers the lone charge that fell just
    outside the auto-matcher's tighter ±3-day / last-4 window — a single-charge suggestion carries a
    ``reason`` (see :func:`_lone_suggestion_reason`) so the report can say why the pairing needs review
    instead of having matched automatically."""
    target = meta.get("charge_amount")
    order_day = _parse_day(order.get("date"))
    if not target or target <= 0 or order_day is None:
        return None
    # (charge, day) for pool charges with a usable amount and a date inside the window.
    near = []
    for c in pool:
        day = _parse_day(c.get("date")) if c else None
        if c and c.get("amount") and day is not None and abs((day - order_day).days) <= _SPLIT_SUGGESTION_WINDOW_DAYS:
            near.append((c, day))
    # Collect every covering combination, de-duped by its set of charge ids; require exactly one.
    distinct: dict = {}
    for size in range(1, _SPLIT_SUGGESTION_MAX_PARTS + 1):
        for combo in itertools.combinations(near, size):
            if abs(sum(c["amount"] for c, _ in combo) - target) <= _SPLIT_SUGGESTION_TOLERANCE:
                distinct[frozenset(c["id"] for c, _ in combo)] = combo
    reason = None
    if len(distinct) == 1:
        combo = next(iter(distinct.values()))
    else:
        # Ambiguous — unless exactly one competitor is a lone charge dated on the order itself.
        exact = [c for c in distinct.values() if len(c) == 1 and c[0][1] == order_day]
        if len(exact) != 1:
            return None
        combo = exact[0]
        reason = (f"Suggested over {len(distinct) - 1} other same-amount candidate"
                  f"{'' if len(distinct) == 2 else 's'} as the only charge dated on the order itself.")
    days = [day for _, day in combo]
    return {
        "charges": [c for c, _ in combo],
        "total": round(sum(c["amount"] for c, _ in combo), 2),
        "spans_days": (max(days) - min(days)).days,
        "reason": reason or (_lone_suggestion_reason(combo[0][0], combo[0][1], order_day, target, matcher_candidates)
                             if len(combo) == 1 else None),
    }


def _added_charge_hint(conn: sqlite3.Connection, charge: dict) -> dict:
    """For an unaccounted charge: the orders it could be added to, and whether it looks paid with card
    rewards.

    ``order_candidates`` are the cash orders with a charge on the same card within the reverse-scan window,
    nearest first. ``rewards_credit`` is a credit of the same amount on that card within the match window —
    how a card records the part of an order its rewards paid for. With that credit present and exactly one
    candidate placed on the charge's own date, that order is ``suggested_link_id``; the user confirms it,
    since a guess at the order should not move money on its own."""
    root = effective_account_id(conn, charge["account_id"])
    day = charge["date"]
    rows = conn.execute(
        f"""SELECT DISTINCT l.id AS link_id, o.id AS order_id, o.date
            FROM   txn_link l
            JOIN   txn_link_member om ON om.link_id = l.id AND om.role = 'order'
            JOIN   txn o ON o.id = om.txn_id AND o.trashed_at IS NULL
            JOIN   txn_link_member cm ON cm.link_id = l.id AND cm.role = 'charge'
            JOIN   txn c ON c.id = cm.txn_id
            JOIN   account ca ON ca.id = c.account_id
            WHERE  l.kind = ?
              AND  json_extract(l.metadata_json, '$.disposition') = 'cash'
              AND  COALESCE(ca.parent_account_id, ca.id) = ?
              AND  ABS(julianday(o.date) - julianday(?)) <= {int(_REVERSE_SCAN_WINDOW_DAYS)}
            ORDER  BY ABS(julianday(o.date) - julianday(?)), o.date""",
        (LINK_KIND, root, day, day),
    ).fetchall()
    summaries = txn_summaries(conn, [r["order_id"] for r in rows])
    candidates = [dict(summaries[r["order_id"]], link_id=r["link_id"]) for r in rows if r["order_id"] in summaries]
    credit = conn.execute(
        f"""SELECT t.id
            FROM   txn t JOIN account a ON a.id = t.account_id
            WHERE  COALESCE(a.parent_account_id, a.id) = ?
              AND  ROUND(t.amount, 2) = ?
              AND  t.trashed_at IS NULL
              AND  ABS(julianday(t.date) - julianday(?)) <= {int(_CHARGE_DATE_WINDOW_DAYS)}
            ORDER  BY ABS(julianday(t.date) - julianday(?))
            LIMIT  1""",
        (root, -round(charge["amount"], 2), day, day),
    ).fetchone()
    same_day = [c for c in candidates if c["date"] == day]
    suggested = same_day[0]["link_id"] if credit and len(same_day) == 1 else None
    return {
        "order_candidates": candidates,
        "rewards_credit": _txn_summary(conn, credit["id"]) if credit else None,
        "suggested_link_id": suggested,
    }


def amazon_reconciliation(conn: sqlite3.Connection, batch_id: str) -> dict:
    """Reconcile the Amazon orders imported in a batch against the ledger's card charges, for the
    reconciliation report. Buckets:

      * **matched**           — order ↔ the card charge(s) it excluded (``charges``: usually one, several
        when a split order was reconciled to multiple shipment charges).
      * **matched_review**    — a would-be *unmatched* cash order for which a unique set of unaccounted
        charges sums to its total (a split order billed as several shipments). Advisory only — carries the
        suggested ``charges`` + ``total`` + ``spans_days`` for the user to Accept (link them) or Dismiss;
        a single-charge suggestion also carries a ``reason`` naming why it wasn't auto-matched.
      * **duplicate**         — an order whose charge is *duplicated*: two or more same-amount charges within
        the matcher's window **on one effective account**, so auto-matching bailed on the ambiguity (or a
        matched charge that has an extra same-account copy). Carries every copy (``charges`` with a
        ``matched`` flag) so the user can trash the redundant one, which then lets the order match. The
        common Mint-double-import case. Candidates spread across *different* accounts are never grouped
        here (see :func:`_same_account_copies`) — they're distinct transactions.
      * **duplicate_review**  — same shape, but the equal-amount copies only turn up in the *wider review
        window* (±14 days — outside the auto-matcher's ±3), so the dates don't corroborate the way an
        in-window duplicate's do. Kept out of the plain duplicate bucket so each copy gets eyeballed
        before Merge/Discard.
      * **amazon_unmatched**  — a cash order with *no* candidate charge at all (untracked card / a real miss);
        surfaced for a manual link, and counts toward attention until acknowledged. Carries ``reviewed``
        (from the link's ``no_charge_reviewed`` flag): an acknowledged order stays in the bucket but drops
        out of the attention count.
      * **payment_unmatched** — Amazon-looking ledger charges the export didn't account for (reverse scan).
        Each carries ``reviewed`` (from ``amazon_charge_reviewed``): counts toward attention until the user
        acknowledges it, after which it stays listed but leaves the count.
      * **unaccounted_duplicate** — reverse-scan charges that look like *copies of each other* (same
        account + amount, dates within ±3 days) with no order accounting for either — the double import
        the general dedupe can't catch (different post dates / payee text). Carved out of
        ``payment_unmatched`` for per-row review: Discard a copy, or merge keeping the richest.
    """
    links = conn.execute(
        """SELECT DISTINCT l.id
           FROM   txn_link l
           JOIN   txn_link_member m ON m.link_id = l.id
           JOIN   txn t ON t.id = m.txn_id
           WHERE  l.kind = ? AND m.role = 'order' AND t.import_batch_id = ?""",
        (LINK_KIND, batch_id),
    ).fetchall()

    order_dates: list[str] = []
    charge_accounts: set = set()
    order_rows = []
    for lk in links:
        link = txn_links.get_link(conn, lk["id"])
        meta = link.get("metadata") or {}
        order_ids = txn_links.member_txn_ids(conn, lk["id"], role="order")
        charge_ids = txn_links.member_txn_ids(conn, lk["id"], role="charge")
        order = _txn_summary(conn, order_ids[0]) if order_ids else None
        if order:
            # How many item lines the order's evidence carries (0 when only the orders file was imported),
            # so the report can tell a one-item order — nothing to divide — from one worth splitting.
            order["item_count"] = len(parse_item_evidence(safe_json_dict(order["import_evidence_json"])))
        if order and order["date"]:
            order_dates.append(order["date"])
        for cid in charge_ids:
            c = _txn_summary(conn, cid)
            if c:
                charge_accounts.add(c["account_id"])
        order_rows.append((lk["id"], meta, order, charge_ids))

    consumed: set = set()   # charge ids shown in a duplicate group — kept out of the reverse scan

    # Whether a duplicate row can be *merged* (keep one copy, trash the rest) vs. must be resolved per-copy.
    # Merge is refused (see merge_duplicate_charges) when another *unmatched* cash order shares the amount —
    # then the extra copies are distinct purchases, not redundant, so merging would steal a charge. We count
    # the unmatched cash orders per amount here so the report can offer Merge only where it would succeed.
    unmatched_by_amount = Counter(
        round(o["amount"], 2) for o in _unmatched_cash_orders(conn, batch_id) if o.get("amount") is not None)

    def _is_mergeable(meta, *, has_charge):
        amt = meta.get("charge_amount")
        if amt is None:
            return False
        peers = unmatched_by_amount.get(round(amt, 2), 0) - (0 if has_charge else 1)  # exclude self if unmatched
        return peers <= 0

    def _charge_entry(txn_id, *, is_matched, link_id):
        return dict(_txn_summary(conn, txn_id), matched=is_matched, order_link_id=link_id)

    def _duplicate_row(link_id, meta, order, copies, *, matched_id=None):
        """One duplicate-bucket row (plain or review). `matched_id` is the order's already-linked charge
        when it has one — it leads the stack, badged, and the copies are the redundant extras. Every
        surfaced copy is consumed so it can't also appear as an unaccounted charge."""
        charges = [_charge_entry(matched_id, is_matched=True, link_id=link_id)] if matched_id else []
        for cid in copies:
            charges.append(_charge_entry(cid, is_matched=False, link_id=link_id))
            consumed.add(cid)
        return {"link_id": link_id, "order": order, "charges": charges,
                "mergeable": _is_mergeable(meta, has_charge=bool(matched_id))}

    matched, duplicate, duplicate_review, amazon_unmatched, matched_review = [], [], [], [], []
    unmatched_candidates = []   # (link_id, meta, order): cash orders with no charge — try split suggestions
    eff_cache: dict = {}        # txn id → effective account, resolved once for the whole run
    for link_id, meta, order, charge_ids in order_rows:
        # The order's eligible charges beyond any it already links — the matcher's own candidate set (respects
        # last-4 / funding map, empty for an untracked card), so "duplicate" means exactly what blocked a match.
        candidates = _order_charge_candidates(conn, meta, order)
        if charge_ids:
            # A matched charge that *also* has redundant copies → surface the redundancy. _duplicate_group
            # owns what counts as a copy (same account, not user-settled); a same-amount charge on another
            # account is a distinct transaction and stays available to the reverse scan.
            group = _duplicate_group(conn, candidates, anchor=charge_ids[0], eff_cache=eff_cache)
            if group.copies:
                duplicate.append(_duplicate_row(link_id, meta, order, group.copies, matched_id=charge_ids[0]))
            else:
                # A matched order carries every charge it links — usually one, several for an accepted split —
                # each flagged when it was added to the order (a part paid with card rewards).
                added = set(added_charge_ids(meta))
                matched.append({"link_id": link_id, "order": order,
                                "charges": [dict(c, added=c["id"] in added)
                                            for c in (_txn_summary(conn, cid) for cid in charge_ids) if c]})
        elif meta.get("disposition") == "cash":
            group = _duplicate_group(conn, candidates, eff_cache=eff_cache)
            if group.copies:
                duplicate.append(_duplicate_row(link_id, meta, order, group.copies))
            elif group.settled:
                # A real cluster the user marked Not duplicates: distinct purchases, so no duplicate row —
                # and deliberately no wider re-derivation, which would only re-flag the settled set with a
                # neighbour attached. The order still can't auto-match (distinctness doesn't say which
                # charge is *its* match); the suggestion pass's exact-date tie-break may still nominate one.
                unmatched_candidates.append((link_id, meta, order, candidates))
            else:
                # No copies in the strict window — try the wider review window before giving up: equal-amount
                # copies out there are still likely a double import, but the dates don't corroborate, so they
                # land in their own review bucket (never the plain duplicate one).
                wide = _duplicate_group(
                    conn, _order_charge_candidates(conn, meta, order, window_days=_SPLIT_SUGGESTION_WINDOW_DAYS),
                    eff_cache=eff_cache)
                if wide.copies:
                    duplicate_review.append(_duplicate_row(link_id, meta, order, wide.copies))
                else:
                    # Keep the matcher's candidate list (0 or 1 ids here): a suggested charge that IS the
                    # live candidate tells the reason note "eligible now, just not at import time".
                    unmatched_candidates.append((link_id, meta, order, candidates))

    # Split-charge suggestions: for each still-unmatched cash order, see whether a unique set of unaccounted
    # charges sums to its total (Amazon often bills a multi-item order as several shipment charges). Surfaced
    # as Matched·review to Accept/Dismiss — never auto-linked; a dismissed order (metadata flag) is skipped.
    # A suggested charge is consumed so it can't be offered to a later order or reappear as unaccounted.
    suggestion_pool = _amazon_charge_pool(conn, order_dates, charge_accounts, _SPLIT_SUGGESTION_WINDOW_DAYS)
    for link_id, meta, order, candidates in unmatched_candidates:
        suggestion = None
        if not meta.get("split_suggestion_dismissed"):
            available = [c for c in suggestion_pool if c and c["id"] not in consumed]
            suggestion = _split_charge_suggestion(order, meta, available, candidates)
        if suggestion:
            matched_review.append({"link_id": link_id, "order": order, **suggestion})
            consumed.update(c["id"] for c in suggestion["charges"])
        else:
            # No charge to resolve — an untracked card or a genuine miss. Surfaced for attention so a real
            # anomaly can't hide in a silent pile, but acknowledgeable: `no_charge_reviewed` (set via
            # mark_orders_no_charge_reviewed) drops it out of the attention count while it stays in the report.
            amazon_unmatched.append(
                {"link_id": link_id, "order": order, "reviewed": bool(meta.get("no_charge_reviewed"))})

    # ±7-day informational scan, minus anything shown in a duplicate group or consumed by a suggestion —
    # then carve out same-account same-amount near-date clusters as suspected double imports.
    unaccounted, unaccounted_duplicate = _group_unaccounted_duplicates(
        conn, _reverse_scan(conn, order_dates, charge_accounts, consumed))
    # Tag each plain unaccounted charge with whether the user has acknowledged it (Mark reviewed) — an
    # acknowledged one stays listed but leaves the attention count. The clustered duplicate bucket resolves
    # by merge/discard/not-duplicates, so it carries no such flag.
    reviewed_ids = _reviewed_charge_ids(conn, [c["id"] for c in unaccounted])
    for c in unaccounted:
        c["reviewed"] = c["id"] in reviewed_ids
        c.update(_added_charge_hint(conn, c))
    result = {
        "matched": matched,
        "matched_review": matched_review,
        "duplicate": duplicate,
        "duplicate_review": duplicate_review,
        "amazon_unmatched": amazon_unmatched,
        "payment_unmatched": unaccounted,
        "unaccounted_duplicate": unaccounted_duplicate,
    }
    # Every charge on the report carries its payee family, which the report filters by.
    for bucket in ("matched", "matched_review", "duplicate", "duplicate_review", "unaccounted_duplicate"):
        for row in result[bucket]:
            for charge in row.get("charges") or []:
                charge["payee_family"] = payee_family(charge)
    for charge in unaccounted:
        charge["payee_family"] = payee_family(charge)
    return result


def _compute_reconciliation_attention(conn: sqlite3.Connection, batch_id: str) -> int:
    """How much of a batch needs the user's eyes — a duplicate charge to merge/discard, a Matched·review
    split suggestion to accept/dismiss, an *unacknowledged* 'No charge found' order, or an *unacknowledged*
    'Unaccounted charge' (reverse-scan) charge. Both of the last two are often benign (an untracked card, a
    purchase the export didn't cover), but a real anomaly — e.g. a stray duplicate — can hide in either
    pile, so each is surfaced until the user acknowledges it (Mark reviewed; the escape valve that keeps it
    from nagging forever). Runs the full reconciliation, so it is the expensive path the cache in
    :func:`reconciliation_attention_count` fronts."""
    recon = amazon_reconciliation(conn, batch_id)
    return (len(recon["duplicate"]) + len(recon["duplicate_review"])
            + len(recon["matched_review"]) + len(recon["unaccounted_duplicate"])
            + sum(1 for u in recon["amazon_unmatched"] if not u.get("reviewed"))
            + sum(1 for c in recon["payment_unmatched"] if not c.get("reviewed")))


def reconciliation_attention_count(conn: sqlite3.Connection, batch_id: str) -> int:
    """The batch's actionable-reconciliation count, powering the import card's warning tint and the Tasks
    nag — cached against the reconciliation epoch (see services/reconciliation_attention.py)."""
    return batch_attention(conn, batch_id, _compute_reconciliation_attention)


@router.get("/amazon/reconciliation/{batch_id}")
async def amazon_reconciliation_endpoint(batch_id: str):
    """The reconciliation report for one Amazon import batch (matched / unmatched / reverse-scan)."""
    with get_db() as conn:
        if not conn.execute("SELECT 1 FROM import_batch WHERE id = ?", (batch_id,)).fetchone():
            raise HTTPException(status_code=404, detail="Unknown batch")
        return amazon_reconciliation(conn, batch_id)


def _import_detail_order_rows(conn: sqlite3.Connection, batch_id: str) -> list[dict]:
    """The order transactions this batch created, each with its source file + whether item detail was
    folded in — the 'Orders' / 'Items matched' views of the import-detail report."""
    rows = conn.execute(
        "SELECT id, import_evidence_json FROM txn WHERE import_batch_id = ? AND trashed_at IS NULL ORDER BY date",
        (batch_id,),
    ).fetchall()
    result = []
    for r in rows:
        summ = _txn_summary(conn, r["id"])
        if not summ:
            continue
        try:
            ev = json.loads(r["import_evidence_json"]) if r["import_evidence_json"] else {}
        except (TypeError, ValueError):
            ev = {}
        ev = ev if isinstance(ev, dict) else {}
        summ["source_file"] = ev.get("source_file")
        summ["has_item_detail"] = any(
            isinstance(f, dict) and f.get("header") == "Item" for f in (ev.get("extra_text_fields") or []))
        result.append(summ)
    return result


def amazon_import_detail(conn: sqlite3.Connection, batch_id: str) -> dict:
    """The investigable 'what did this import do' report for one Amazon batch: the orders it created, the
    items it folded into orders (which usually live in the *orders* file's batch — recorded in the summary,
    since they aren't this batch's transactions), the items whose order was already enriched or had no
    matching order (discarded), the orders already imported (duplicates), and the matched card charges
    tallied by the ledger account they landed on."""
    row = conn.execute("SELECT config_snapshot FROM import_batch WHERE id = ?", (batch_id,)).fetchone()
    try:
        snap = json.loads(row["config_snapshot"]) if row and row["config_snapshot"] else {}
    except (TypeError, ValueError):
        snap = {}
    summary = snap.get(IMPORT_SUMMARY_KEY) if isinstance(snap, dict) else {}
    summary = summary if isinstance(summary, dict) else {}

    orders = _import_detail_order_rows(conn, batch_id)

    def _enriched_rows(items) -> list[dict]:
        """A persisted enriched-item record → the order row it hit (looked up by txn id, so it resolves even
        when the order lives in another batch), or the recorded detail if that order is gone."""
        out = []
        for it in items or []:
            summ = _txn_summary(conn, it.get("txn_id")) if it.get("txn_id") else None
            if summ:
                out.append(dict(summ, source_file=it.get("source_file")))
            else:
                out.append({"id": it.get("order_id"), "order_id": it.get("order_id"),
                            "name": it.get("description"), "source_file": it.get("source_file")})
        return out

    def _duplicate_rows(dups) -> list[dict]:
        """A persisted duplicate-order record → the ledger order it duplicates (found through the order-id
        link, so it resolves for imports recorded before this lookup existed), carrying this import's order id
        and source file; the recorded order id + date when that order is gone."""
        out = []
        for d in dups or []:
            link = txn_links.find_link(conn, LINK_KIND, d.get("order_id"))
            order_txn_id = next((m["txn_id"] for m in (link or {}).get("members", []) if m["role"] == "order"), None)
            summ = _txn_summary(conn, order_txn_id) if order_txn_id else None
            out.append(dict(summ, order_id=d.get("order_id"), source_file=d.get("source_file")) if summ else d)
        return out

    # Items matched: orders enriched from a *separate* items file (recorded) plus orders this batch created
    # with item detail inline (a combined orders+items import). De-duped by id.
    matched_rows = _enriched_rows(summary.get("enriched_items"))
    seen = {r["id"] for r in matched_rows if r.get("id")}
    matched_rows += [o for o in orders if o.get("has_item_detail") and o["id"] not in seen]

    # Matched card charges grouped by the ledger account they hit (payments view).
    by_account: dict[str, dict] = {}
    for m in amazon_reconciliation(conn, batch_id)["matched"]:
        for charge in (m.get("charges") or []):
            acct = charge.get("account") or "—"
            entry = by_account.setdefault(acct, {"account": acct, "count": 0, "total": 0.0})
            entry["count"] += 1
            entry["total"] = round(entry["total"] + (charge.get("amount") or 0.0), 2)
    payments = sorted(by_account.values(), key=lambda e: (-e["count"], e["account"]))

    count_keys = ("orders_imported", "non_cash", "charges_matched", "items_enriched",
                  "already_enriched", "items_discarded", "already_applied")
    return {
        "counts": {k: int(summary.get(k, 0) or 0) for k in count_keys},
        "orders": orders,
        "items_matched": matched_rows,
        "already_enriched": _enriched_rows(summary.get("already_enriched_items")),
        "items_discarded": summary.get("discarded_items") or [],
        "duplicate_orders": _duplicate_rows(summary.get("duplicate_orders")),
        "payments": payments,
    }


@router.get("/amazon/import-detail/{batch_id}")
async def amazon_import_detail_endpoint(batch_id: str):
    """The import-detail report for one Amazon batch (orders / items matched / discarded / duplicates / payments)."""
    with get_db() as conn:
        if not conn.execute("SELECT 1 FROM import_batch WHERE id = ?", (batch_id,)).fetchone():
            raise HTTPException(status_code=404, detail="Unknown batch")
        return amazon_import_detail(conn, batch_id)


def link_amazon_charges(conn: sqlite3.Connection, link_id: str, charge_txn_ids, *, manually: bool = True) -> dict:
    """Hand-reconcile an unmatched order to one *or more* card charges — one for a plain manual link, several
    when a split order was paid as multiple shipment charges (see the reconciliation's Matched·review
    suggestion). For each charge: do exactly what the auto-matcher does — exclude it (recategorize into the
    Amazon Funding category, prior categorization stashed **per charge** in ``charge_priors`` for undo) and
    add it as a ``charge`` member. Reversal flows through the batch-undo path via those stashed priors.

    Guarded: the link must be an Amazon order that has no charge yet, and no charge may already belong to
    another Amazon link (so one action can't double-exclude or steal a linked charge). ``manually`` is False
    for the automatic passes that reuse this (equal-amount pairing, the after-ingest match)."""
    link = txn_links.get_link(conn, link_id)
    if not link or link.get("kind") != LINK_KIND:
        raise ValueError("Unknown Amazon order link")
    if txn_links.member_txn_ids(conn, link_id, role="charge"):
        raise ValueError("This order already has a linked charge")
    ids = list(dict.fromkeys(charge_txn_ids or []))
    if not ids:
        raise ValueError("No charges given")
    for cid in ids:
        if not conn.execute("SELECT 1 FROM txn WHERE id = ? AND trashed_at IS NULL", (cid,)).fetchone():
            raise ValueError("Unknown charge")
        if conn.execute(
            """SELECT 1 FROM txn_link_member m JOIN txn_link l ON l.id = m.link_id
               WHERE m.txn_id = ? AND l.kind = ?""",
            (cid, LINK_KIND),
        ).fetchone():
            raise ValueError("That charge is already linked to an Amazon order")

    meta = link.get("metadata") or {}
    existing_priors = meta.get("charge_priors")
    priors = existing_priors if isinstance(existing_priors, dict) else {}
    for cid in ids:
        priors[cid] = _exclude_charge(conn, cid)
        txn_links.add_member(conn, link_id, cid, "charge")
        # A charge being linked leaves the reverse-scan bucket, so drop any stale "reviewed" acknowledgment
        # it carried there — if it ever returns to unaccounted (unlinked), it deserves a fresh look.
        conn.execute("DELETE FROM amazon_charge_reviewed WHERE txn_id = ?", (cid,))
    meta["charge_priors"] = priors
    if manually:
        meta["charge_linked_manually"] = True
    # A charge the user unlinked from this order and has now linked again is no longer declined.
    declined = [cid for cid in meta.get(DECLINED_CHARGES_KEY) or [] if cid not in ids]
    if declined:
        meta[DECLINED_CHARGES_KEY] = declined
    else:
        meta.pop(DECLINED_CHARGES_KEY, None)
    meta.pop("split_suggestion_dismissed", None)   # the order is reconciled now — clear any stale dismissal
    meta.pop("no_charge_reviewed", None)           # ...and any stale no-charge-found acknowledgment
    txn_links.set_metadata(conn, link_id, meta)
    return {"status": "linked", "count": len(ids)}


def manual_link_charge(conn: sqlite3.Connection, link_id: str, charge_txn_id: str) -> dict:
    """Single-charge hand-reconcile — the one-charge case of :func:`link_amazon_charges`."""
    return link_amazon_charges(conn, link_id, [charge_txn_id])


class ManualLinkRequest(BaseModel):
    link_id: str
    charge_txn_id: str


@router.post("/amazon/link-charge")
async def amazon_link_charge_endpoint(body: ManualLinkRequest):
    """Manually link an unmatched Amazon order (from the reconciliation report) to a card charge."""
    with get_db() as conn:
        try:
            return manual_link_charge(conn, body.link_id, body.charge_txn_id)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))


class LinkChargesRequest(BaseModel):
    link_id: str
    charge_txn_ids: list[str]


@router.post("/amazon/link-charges")
async def amazon_link_charges_endpoint(body: LinkChargesRequest):
    """Link an unmatched Amazon order to several card charges at once (a split order's shipment charges)."""
    with get_db() as conn:
        try:
            return link_amazon_charges(conn, body.link_id, body.charge_txn_ids)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))


def _refuse_if_split(conn: sqlite3.Connection, link_id: str) -> None:
    """A split order's parts must sum to its amount, so a hand action that changes the amount waits for the
    split to be cleared rather than clearing it out from under the user."""
    for order_id in txn_links.member_txn_ids(conn, link_id, role="order"):
        if conn.execute("SELECT 1 FROM txn WHERE id = ? AND is_split = 1", (order_id,)).fetchone():
            raise ValueError("This order is split. Clear its split first, then change its charges.")


def add_order_charge(conn: sqlite3.Connection, link_id: str, charge_txn_id: str) -> dict:
    """Add a further charge to a matched order: the part paid with card rewards, which the card records as
    a charge of its own and the export leaves out of the order's total. The charge is excluded like the
    order's own charge, and the order's amount grows by it (see ``services/amazon_order_amount.py``)."""
    link = txn_links.get_link(conn, link_id)
    if not link or link.get("kind") != LINK_KIND:
        raise ValueError("Unknown Amazon order link")
    meta = link.get("metadata") or {}
    if meta.get("disposition") != "cash":
        raise ValueError("This order was paid without cash, so a charge cannot be added to it.")
    if not txn_links.member_txn_ids(conn, link_id, role="charge"):
        raise ValueError("Link this order's own charge first.")
    _refuse_if_split(conn, link_id)
    order_ids = txn_links.member_txn_ids(conn, link_id, role="order")
    order = conn.execute(
        "SELECT amount, account_id FROM txn WHERE id = ? AND trashed_at IS NULL", (order_ids[0],)
    ).fetchone() if order_ids else None
    if not order:
        raise ValueError("This order's transaction is no longer in the ledger.")
    charge = conn.execute(
        "SELECT account_id, amount, is_pending FROM txn WHERE id = ? AND trashed_at IS NULL", (charge_txn_id,)
    ).fetchone()
    if not charge:
        raise ValueError("Unknown charge")
    if charge["is_pending"] or not charge["amount"] or charge["amount"] <= 0:
        raise ValueError("Only a posted charge can be added to an order.")
    if effective_account_id(conn, charge["account_id"]) == effective_account_id(conn, order["account_id"]):
        raise ValueError("That row is on the Amazon account itself, not a card.")
    if conn.execute(
        """SELECT 1 FROM txn_link_member m JOIN txn_link l ON l.id = m.link_id
           WHERE m.txn_id = ? AND l.kind = ?""",
        (charge_txn_id, LINK_KIND),
    ).fetchone():
        raise ValueError("That charge is already linked to an Amazon order")

    meta.setdefault(BASE_AMOUNT_KEY, round(order["amount"], 2))
    priors = meta.get("charge_priors") if isinstance(meta.get("charge_priors"), dict) else {}
    priors[charge_txn_id] = _exclude_charge(conn, charge_txn_id)
    meta["charge_priors"] = priors
    meta[ADDED_CHARGES_KEY] = [*added_charge_ids(meta), charge_txn_id]
    txn_links.add_member(conn, link_id, charge_txn_id, "charge")
    conn.execute("DELETE FROM amazon_charge_reviewed WHERE txn_id = ?", (charge_txn_id,))
    txn_links.set_metadata(conn, link_id, meta)
    refresh_order_amount(conn, link_id)
    return {"status": "added"}


def remove_order_charge(conn: sqlite3.Connection, link_id: str, charge_txn_id: str) -> dict:
    """Take an added charge back off its order: the charge's category is restored and the order's amount
    returns to what it was without it."""
    link = txn_links.get_link(conn, link_id)
    if not link or link.get("kind") != LINK_KIND:
        raise ValueError("Unknown Amazon order link")
    if charge_txn_id not in added_charge_ids(link.get("metadata") or {}):
        raise ValueError("That charge was not added to this order")
    _refuse_if_split(conn, link_id)
    _detach_charge(conn, link_id, charge_txn_id)
    return {"status": "removed"}


@router.post("/amazon/add-order-charge")
async def amazon_add_order_charge_endpoint(body: ManualLinkRequest):
    """Add a charge paid with card rewards to a matched order (the reconciliation's Add to order…)."""
    with get_db() as conn:
        try:
            return add_order_charge(conn, body.link_id, body.charge_txn_id)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))


@router.post("/amazon/remove-order-charge")
async def amazon_remove_order_charge_endpoint(body: ManualLinkRequest):
    """Take an added charge back off its order."""
    with get_db() as conn:
        try:
            return remove_order_charge(conn, body.link_id, body.charge_txn_id)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))


def dismiss_split_suggestion(conn: sqlite3.Connection, link_id: str) -> dict:
    """Mark an order's split-charge (Matched·review) suggestion dismissed so the reconciliation report stops
    surfacing it. Persisted in the link metadata; naturally cleared if the order is later linked."""
    link = txn_links.get_link(conn, link_id)
    if not link or link.get("kind") != LINK_KIND:
        raise ValueError("Unknown Amazon order link")
    meta = link.get("metadata") or {}
    meta["split_suggestion_dismissed"] = True
    txn_links.set_metadata(conn, link_id, meta)
    return {"status": "dismissed"}


class DismissSplitSuggestionRequest(BaseModel):
    link_id: str


@router.post("/amazon/dismiss-split-suggestion")
async def amazon_dismiss_split_suggestion_endpoint(body: DismissSplitSuggestionRequest):
    """Dismiss a Matched·review split-charge suggestion for an order so it stops re-appearing."""
    with get_db() as conn:
        try:
            return dismiss_split_suggestion(conn, body.link_id)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))


def mark_orders_no_charge_reviewed(conn: sqlite3.Connection, link_ids, reviewed: bool = True) -> dict:
    """Acknowledge (or un-acknowledge) 'No charge found' orders. Sets/clears `no_charge_reviewed` in each
    order link's metadata so the order leaves (or rejoins) the reconciliation attention count — the escape
    valve for the untracked-card orders that have nothing to link. The order stays in the report either way;
    only its attention weight changes. Mirrors the CSV advisory-reject `reviewed_at` acknowledgment. Each
    metadata write bumps the recon epoch (txn_link trigger), so the cached attention count re-derives."""
    updated = 0
    for link_id in link_ids or []:
        link = txn_links.get_link(conn, link_id)
        if not link or link.get("kind") != LINK_KIND:
            continue
        meta = link.get("metadata") or {}
        if reviewed:
            meta["no_charge_reviewed"] = True
        else:
            meta.pop("no_charge_reviewed", None)
        txn_links.set_metadata(conn, link_id, meta)
        updated += 1
    return {"updated": updated, "reviewed": reviewed}


class MarkNoChargeReviewedRequest(BaseModel):
    link_ids: list[str]
    reviewed: bool = True


@router.post("/amazon/mark-no-charge-reviewed")
async def amazon_mark_no_charge_reviewed_endpoint(body: MarkNoChargeReviewedRequest):
    """Acknowledge (or un-acknowledge) a set of 'No charge found' orders so they drop out of (or rejoin) the
    reconciliation attention count. Bulk by `link_ids`; `reviewed=false` un-acknowledges."""
    with get_db() as conn:
        return mark_orders_no_charge_reviewed(conn, body.link_ids, body.reviewed)


def _charge_prior_for(meta: dict, charge_id: str) -> Optional[dict]:
    """The stashed pre-exclusion categorization for one linked charge — from the per-charge ``charge_priors``
    map (multi-charge links, e.g. a split order reconciled to several shipment charges) or the legacy
    singular ``charge_prior`` (auto-matched / single-charge links, which predate the map)."""
    priors = meta.get("charge_priors")
    if isinstance(priors, dict) and charge_id in priors:
        return priors[charge_id]
    return meta.get("charge_prior")


def _detach_charge(conn: sqlite3.Connection, link_id: str, charge_id: str) -> None:
    """Remove a charge from an order link and restore its pre-exclusion categorization (mirrors undo), so a
    charge being trashed or replaced isn't left both categorized-as-funding and orphaned."""
    link = txn_links.get_link(conn, link_id)
    meta = (link.get("metadata") or {}) if link else {}
    prior = _charge_prior_for(meta, charge_id)
    if prior:
        conn.execute(
            "UPDATE txn SET category_id = ?, category_source = ?, category_overridden = ? WHERE id = ?",
            (prior.get("category_id"), prior.get("category_source"),
             category_lock_for(prior.get("category_source"), prior.get("category_overridden")), charge_id),
        )
    txn_links.remove_member(conn, link_id, charge_id)
    priors = meta.get("charge_priors")
    if isinstance(priors, dict):
        priors.pop(charge_id, None)
        if not priors:
            meta.pop("charge_priors", None)
    meta.pop("charge_prior", None)
    meta.pop("charge_linked_manually", None)
    txn_links.set_metadata(conn, link_id, meta)
    refresh_order_amount(conn, link_id)


def _unmatched_cash_orders(conn: sqlite3.Connection, batch_id: str) -> list[dict]:
    """The batch's cash order links that still have no charge, each with its amount, order summary — the
    working set for both the equal-count pairing pass and the 'distinct purchases share this amount?' check."""
    rows = conn.execute(
        """SELECT DISTINCT l.id AS link_id
           FROM   txn_link l
           JOIN   txn_link_member m ON m.link_id = l.id AND m.role = 'order'
           JOIN   txn t ON t.id = m.txn_id
           WHERE  l.kind = ? AND t.import_batch_id = ?
             AND  NOT EXISTS (SELECT 1 FROM txn_link_member mc WHERE mc.link_id = l.id AND mc.role = 'charge')""",
        (LINK_KIND, batch_id),
    ).fetchall()
    out = []
    for r in rows:
        link = txn_links.get_link(conn, r["link_id"])
        meta = link.get("metadata") or {}
        if meta.get("disposition") != "cash" or meta.get("charge_amount") is None:
            continue
        order_ids = txn_links.member_txn_ids(conn, r["link_id"], role="order")
        order = _txn_summary(conn, order_ids[0]) if order_ids else None
        if order:
            out.append({"link_id": r["link_id"], "amount": meta["charge_amount"], "order": order, "meta": meta})
    return out


def _perfect_matching(order_candidates: list[list[str]]) -> Optional[dict[int, str]]:
    """A one-to-one assignment of each order (by index) to one of *its own* candidate charges, each charge
    used once — or ``None`` if no assignment covers every order. Kuhn's augmenting-path bipartite matching;
    the clusters here are tiny (a handful of same-amount orders), so the recursion is trivial. Matching by
    each order's own candidate set is what keeps the equal-count pass from linking an order to a charge on
    a card it never used (two same-amount orders on different cards must not swap charges)."""
    charge_to_order: dict[str, int] = {}

    def _augment(order_index: int, visited: set[str]) -> bool:
        for charge_id in order_candidates[order_index]:
            if charge_id in visited:
                continue
            visited.add(charge_id)
            holder = charge_to_order.get(charge_id)
            if holder is None or _augment(holder, visited):
                charge_to_order[charge_id] = order_index
                return True
        return False

    for order_index in range(len(order_candidates)):
        if not _augment(order_index, set()):
            return None
    return {order_index: charge_id for charge_id, order_index in charge_to_order.items()}


def _competing_groups(orders: list[dict], candidates: dict[str, list[str]]) -> list[list[dict]]:
    """Split same-amount orders into the groups that compete for the same charges: two orders are in one
    group when they share a candidate charge, directly or through other orders. A card's history can hold
    many orders of one amount months apart, and judging them as one pool lets a surplus in one month block
    a clean pairing in another."""
    parent = {o["link_id"]: o["link_id"] for o in orders}

    def root(link_id: str) -> str:
        while parent[link_id] != link_id:
            parent[link_id] = parent[parent[link_id]]
            link_id = parent[link_id]
        return link_id

    holder: dict[str, str] = {}
    for o in orders:
        for charge_id in candidates[o["link_id"]]:
            if charge_id in holder:
                parent[root(o["link_id"])] = root(holder[charge_id])
            else:
                holder[charge_id] = o["link_id"]
    groups: dict[str, list[dict]] = {}
    for o in orders:
        groups.setdefault(root(o["link_id"]), []).append(o)
    return list(groups.values())


def _names_family(order: dict, family: str) -> bool:
    """Whether an order's name names a charge's payee family ("Kindle+;" and a Kindle charge). Plain Amazon
    and Other name nothing, since every order is Amazon's."""
    return family not in ("Amazon", OTHER_PAYEE_FAMILY) and family.lower() in (order.get("name") or "").lower()


def _pair_equal_amount_clusters(conn: sqlite3.Connection, batch_id: str) -> int:
    """Second pass over a batch's still-unmatched cash orders, after its import and after a Discard:
    :func:`_pair_balanced_orders` over them. Returns the number of orders newly paired."""
    return _pair_balanced_orders(conn, _unmatched_cash_orders(conn, batch_id))


def _pair_balanced_orders(conn: sqlite3.Connection, orders: list[dict]) -> int:
    """Pair unmatched cash orders (the shape :func:`_unmatched_cash_orders` returns) with charges: when a group
    of same-amount orders that compete for the same charges is exactly balanced by that many unlinked
    charges, they're *distinct* purchases — and which order pairs with which charge does not change the
    totals (each charge is excluded either way). Pair them 1:1 so they resolve to matched instead of showing
    as false 'duplicate detected'. A lone order with its one charge is a group of one.

    - **Two windows, strict first.** A group is judged in the matcher's ±3-day window, then what is left in
      the 14 days *after* each order: Amazon bills on shipment, and an order it holds to ship with others
      is charged days or weeks after it was placed, never before. The wide window looks forward only, as a
      charge before the order is someone else's purchase, while the strict one keeps its slack both ways for
      dates a time zone moved. Strict first, because the wider window can pull a neighbour's surplus
      charge into a group that balances on its own at ±3.

    - **Balanced per competing group** (:func:`_competing_groups`), not per amount across the batch, so a
      surplus among one month's orders does not block another month's clean pair.
    - **Each order only to a charge in its own candidate set** (respecting the funding map / last-4), via a
      perfect bipartite matching, so same-amount orders paid on different cards can't take each other's
      charge.
    - **A surplus of charges** (more distinct charges than orders) is a real duplicate and is left alone.
    - **Names are preferred where they agree**: an order whose name names a charge's payee family ("Kindle+;"
      and a Kindle charge) tries that charge first, so the report does not pair a Kindle order with an
      Amazon Music charge when both pairings are possible. A preference, not a constraint: a channel billed
      as Prime Video names nothing, and still pairs.
    - **A pending charge competes but is never linked**, so a group holding one waits for it to post: the
      provider may drop it and send the posted row under another id, which would leave the order linked to
      a trashed row.

    Returns the number of orders newly paired."""
    paired = _pair_balanced_groups(conn, orders, _CHARGE_DATE_WINDOW_DAYS, forward_only=False)
    rest = [o for o in orders if o["link_id"] not in paired]
    return len(paired) + len(_pair_balanced_groups(conn, rest, _SPLIT_SUGGESTION_WINDOW_DAYS, forward_only=True))


def _pair_balanced_groups(conn: sqlite3.Connection, orders: list[dict], window_days: int, *,
                          forward_only: bool) -> set[str]:
    """One pass of :func:`_pair_balanced_orders` with candidates drawn from ``window_days``. Returns the
    link ids paired."""
    clusters: dict = {}
    for o in orders:
        clusters.setdefault(round(o["amount"], 2), []).append(o)
    paired: set[str] = set()
    for group in clusters.values():
        candidates: dict[str, list[str]] = {}
        pairable: list[dict] = []   # only orders that actually have an eligible charge count toward balance
        for o in group:
            cands = _eligible_charges(conn, o["meta"], o["order"], window_days, forward_only)
            if cands:   # untracked / last-4 mismatch: an order with none can't take any of these charges
                candidates[o["link_id"]] = cands
                pairable.append(o)
        all_charges = list(dict.fromkeys(c for cs in candidates.values() for c in cs))
        families = {cid: payee_family(summary) for cid, summary in txn_summaries(conn, all_charges).items()}
        pending = _pending_ids(conn, all_charges)
        for competing in _competing_groups(pairable, candidates):
            charge_ids = {cid for o in competing for cid in candidates[o["link_id"]]}
            if len(charge_ids) != len(competing) or charge_ids & pending:
                continue
            # The matcher takes each order's candidates in order, and orders in order, so a name that agrees
            # goes first in both.
            preferred = {o["link_id"]: sorted(candidates[o["link_id"]],
                                              key=lambda cid, o=o: not _names_family(o["order"], families.get(cid, "")))
                         for o in competing}
            competing = sorted(competing, key=lambda o: not any(
                _names_family(o["order"], families.get(cid, "")) for cid in candidates[o["link_id"]]))
            matching = _perfect_matching([preferred[o["link_id"]] for o in competing])
            if matching is None:
                continue
            for order_index, charge_id in matching.items():
                link_amazon_charges(conn, competing[order_index]["link_id"], [charge_id], manually=False)
                paired.add(competing[order_index]["link_id"])
    return paired


def _pending_ids(conn: sqlite3.Connection, txn_ids: list[str]) -> set[str]:
    pending: set[str] = set()
    for start in range(0, len(txn_ids), 500):
        chunk = txn_ids[start:start + 500]
        pending |= {r["id"] for r in conn.execute(
            f"SELECT id FROM txn WHERE is_pending = 1 AND id IN ({','.join('?' * len(chunk))})", chunk)}
    return pending


def _eligible_charges(conn: sqlite3.Connection, meta: dict, order: dict,
                      window_days: int = _CHARGE_DATE_WINDOW_DAYS, forward_only: bool = False) -> list[str]:
    """The matcher's candidates for an already-imported order, less any the user unlinked from it — what an
    *automatic* pass may offer it."""
    declined = set(meta.get(DECLINED_CHARGES_KEY) or [])
    return [cid for cid in _order_charge_candidates(conn, meta, order, window_days, forward_only)
            if cid not in declined]


def _unmatched_orders_for_amounts(conn: sqlite3.Connection, amounts: set) -> list[dict]:
    """Every cash order in the ledger that still has no charge and expects one of ``amounts`` — the orders a
    newly arrived charge of that amount could belong to — in the shape :func:`_unmatched_cash_orders`
    returns."""
    if not amounts:
        return []
    rows = conn.execute(
        f"""SELECT l.id AS link_id, l.metadata_json, o.id AS order_id
            FROM   txn_link l
            JOIN   txn_link_member m ON m.link_id = l.id AND m.role = 'order'
            JOIN   txn o ON o.id = m.txn_id AND o.trashed_at IS NULL
            WHERE  l.kind = ?
              AND  json_extract(l.metadata_json, '$.disposition') = 'cash'
              AND  ROUND(json_extract(l.metadata_json, '$.charge_amount'), 2) IN ({",".join("?" * len(amounts))})
              AND  NOT EXISTS (SELECT 1 FROM txn_link_member mc WHERE mc.link_id = l.id AND mc.role = 'charge')""",
        (LINK_KIND, *sorted(amounts)),
    ).fetchall()
    orders = txn_summaries(conn, [r["order_id"] for r in rows])
    out = []
    for r in rows:
        meta = json.loads(r["metadata_json"] or "{}")
        if r["order_id"] in orders:
            out.append({"link_id": r["link_id"], "amount": meta["charge_amount"], "order": orders[r["order_id"]],
                        "meta": meta})
    return out


def link_orders_to_new_charges(conn: sqlite3.Connection, txn_ids) -> int:
    """Link already-imported orders to card charges that arrived after them — by a later sync or import —
    under the rule the import's own pairing pass applies (:func:`_pair_balanced_orders`): same-amount orders
    competing for the same charges are paired when exactly that many charges balance them, a lone order with
    its one charge included. Every other case stays a suggestion in the reconciliation report.

    Only orders expecting the amount of one of ``txn_ids`` are looked at, so a sync's cost follows what it
    brought rather than the size of the order history. All of them are, not only those dated near an
    arrival: an order that wants an older charge of the same amount competes for it all the same, and
    balance has to see every order that wants a charge. Returns the number linked."""
    ids = [txn_id for txn_id in dict.fromkeys(txn_ids or []) if txn_id]
    amounts: set = set()
    for start in range(0, len(ids), 500):
        chunk = ids[start:start + 500]
        amounts |= {r["amount"] for r in conn.execute(
            f"""SELECT DISTINCT ROUND(amount, 2) AS amount FROM txn
                WHERE  id IN ({",".join("?" * len(chunk))})
                  AND  trashed_at IS NULL AND is_pending = 0 AND amount > 0""",
            chunk,
        )}
    return _pair_balanced_orders(conn, _unmatched_orders_for_amounts(conn, amounts))


def match_orders_after_ingest(connection, *, txn_ids=None, batch_id: Optional[str] = None) -> None:
    """Run :func:`link_orders_to_new_charges` once an import's or a sync's rows are committed, in the
    connection context manager given, over the rows named — ``txn_ids``, or every row of ``batch_id``. Like
    the other after-ingest passes it runs after the ingest transaction, never inside it, and a failure is
    logged rather than allowed to fail what already landed. It runs **before** PayPal pairing, which would
    otherwise claim a PayPal-looking Amazon charge first — the order the two see the rows in when the Amazon
    file is the one imported second."""
    if not txn_ids and not batch_id:
        return
    try:
        with connection as conn:
            ids = list(txn_ids or [])
            if batch_id:
                ids += [r["id"] for r in conn.execute("SELECT id FROM txn WHERE import_batch_id = ?", (batch_id,))]
            link_orders_to_new_charges(conn, ids)
    except Exception as e:
        log_error(f"[amazon] after-ingest order match failed: {e}", exc_info=e)


def _order_batch_id(conn: sqlite3.Connection, link_id: str) -> Optional[str]:
    order_ids = txn_links.member_txn_ids(conn, link_id, role="order")
    if not order_ids:
        return None
    row = conn.execute("SELECT import_batch_id FROM txn WHERE id = ?", (order_ids[0],)).fetchone()
    return row["import_batch_id"] if row else None


def trash_duplicate_charge(conn: sqlite3.Connection, charge_txn_id: str,
                           order_link_id: Optional[str] = None, *, as_duplicate: bool = True) -> dict:
    """Remove one charge from the reconciliation report, then let the order match. If the trashed copy was
    the order's *linked* charge, detach + restore it first; then re-run the equal-count pairing pass for
    the batch so the now-balanced cluster (e.g. one order, one surviving charge) links up. Returns
    ``status`` plus whether the order matched as a result.

    ``as_duplicate`` records *why* the row went to Trash, which decides where it files:

      * ``True`` (the per-copy **Discard** on a stacked duplicate row) — a dedupe resolution, tagged like
        a merge loser minus the kept-copy pointer a discard doesn't always know. Lands in the Trash page's
        *Duplicate transactions* section, grouped by source file.
      * ``False`` (the row-level **Trash** on an unaccounted charge) — the user saying "this shouldn't be
        in my ledger at all". An ordinary delete with no dedupe provenance, so it files under *Deleted
        transactions* with everything else the user removed by hand; tagging it as a confirmed duplicate
        would misdescribe it."""
    row = conn.execute(
        "SELECT id FROM txn WHERE id = ? AND trashed_at IS NULL", (charge_txn_id,)
    ).fetchone()
    if not row:
        raise ValueError("Unknown or already-trashed charge")

    link = txn_links.get_link(conn, order_link_id) if order_link_id else None
    if link and link.get("kind") != LINK_KIND:
        link = None
    if link and charge_txn_id in txn_links.member_txn_ids(conn, order_link_id, role="charge"):
        _detach_charge(conn, order_link_id, charge_txn_id)

    if as_duplicate:
        conn.execute(
            """UPDATE txn SET rejection_reason = 'duplicate_confirmed', dedupe_resolved_by = 'amazon_discard'
               WHERE id = ?""",
            (charge_txn_id,),
        )
    trash_txns(conn, [charge_txn_id])

    matched = False
    if link:
        batch_id = _order_batch_id(conn, order_link_id)
        if batch_id:
            _pair_equal_amount_clusters(conn, batch_id)
            matched = bool(txn_links.member_txn_ids(conn, order_link_id, role="charge"))
    return {"status": "trashed", "matched": matched}


def unlink_order_charges(conn: sqlite3.Connection, order_link_id: str) -> dict:
    """Undo an order↔charge pairing: detach every charge on the link and restore each one's
    pre-exclusion categorization (so it stops sitting in the funding category). The order returns to
    the unmatched path, where the report offers Link charges… to pair it correctly — the correction
    for a wrong match (a coincidental same-amount charge, an accepted suggestion that turned out
    wrong). The order transaction itself is untouched; only the pairing is removed."""
    link = txn_links.get_link(conn, order_link_id)
    if not link or link.get("kind") != LINK_KIND:
        raise ValueError("Unknown Amazon order link")
    charge_ids = txn_links.member_txn_ids(conn, order_link_id, role="charge")
    if not charge_ids:
        raise ValueError("This order has no linked charge")
    if added_charge_ids(link.get("metadata") or {}):
        _refuse_if_split(conn, order_link_id)
    for charge_id in charge_ids:
        _detach_charge(conn, order_link_id, charge_id)
    # Remembered so the after-ingest match never pairs the two again: it would, the next time a sync brings
    # in a row of that amount, since the charge is very likely still the order's only candidate.
    meta = txn_links.get_link(conn, order_link_id).get("metadata") or {}
    meta[DECLINED_CHARGES_KEY] = list(dict.fromkeys([*(meta.get(DECLINED_CHARGES_KEY) or []), *charge_ids]))
    txn_links.set_metadata(conn, order_link_id, meta)
    return {"status": "unlinked", "detached": charge_ids}


class UnlinkOrderChargesRequest(BaseModel):
    order_link_id: str


@router.post("/amazon/unlink-charges")
async def amazon_unlink_charges_endpoint(body: UnlinkOrderChargesRequest):
    """Detach every card charge from an Amazon order (restoring their categories) so a wrong pairing
    can be corrected — the order goes back to needing a charge."""
    with get_db() as conn:
        try:
            return unlink_order_charges(conn, body.order_link_id)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))


class TrashDuplicateChargeRequest(BaseModel):
    charge_txn_id: str
    order_link_id: Optional[str] = None
    # False for the row-level Trash on an unaccounted charge — an ordinary delete rather than a dedupe
    # resolution, so it files under the Trash page's Deleted transactions (see trash_duplicate_charge).
    as_duplicate: bool = True


@router.post("/amazon/trash-duplicate-charge")
async def amazon_trash_duplicate_charge_endpoint(body: TrashDuplicateChargeRequest):
    """Trash one card charge from the reconciliation report, re-matching the order if it's now
    unambiguous. ``as_duplicate`` decides whether it files as a dedupe resolution or an ordinary delete."""
    with get_db() as conn:
        try:
            result = trash_duplicate_charge(conn, body.charge_txn_id, body.order_link_id,
                                            as_duplicate=body.as_duplicate)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
    settle_owed_rescans()
    return result


def _charge_description(conn: sqlite3.Connection, charge_id: str) -> str:
    """The longest 'original description' text captured for a charge — its raw name plus any evidence
    description / extra text fields — used to rank which duplicate copy carries the most detail."""
    row = conn.execute("SELECT raw_name, import_evidence_json FROM txn WHERE id = ?", (charge_id,)).fetchone()
    if not row:
        return ""
    texts = [row["raw_name"] or ""]
    try:
        ev = json.loads(row["import_evidence_json"]) if row["import_evidence_json"] else {}
    except (TypeError, ValueError):
        ev = {}
    if isinstance(ev, dict):
        if isinstance(ev.get("description"), dict):
            texts.append(str(ev["description"].get("value") or ""))
        for f in (ev.get("extra_text_fields") or []):
            if isinstance(f, dict):
                texts.append(str(f.get("value") or ""))
    return max(texts, key=len)


def _richest_charge(conn: sqlite3.Connection, charge_ids) -> str:
    """The copy to keep when merging duplicates: most captured detail (longest description), then one that
    carries a category, then the later date — i.e. the enriched later sync over the preliminary one."""
    def score(cid):
        row = conn.execute("SELECT category_id, date FROM txn WHERE id = ?", (cid,)).fetchone()
        return (len(_charge_description(conn, cid)), 1 if (row and row["category_id"]) else 0,
                (row["date"] if row else "") or "")
    return max(charge_ids, key=score)


def _norm_tokens(text: str) -> list[str]:
    """A description's uppercased alphanumeric tokens — the unit for judging what detail a copy carries."""
    return [t for t in re.split(r"[^0-9A-Za-z]+", text.upper()) if t]


def _is_subsequence(short: str, long: str) -> bool:
    it = iter(long)
    return all(ch in it for ch in short)


def _token_represented(token: str, known: set[str]) -> bool:
    """Whether a token is already conveyed by `known` — exactly, or as a plain abbreviation of a known
    token (or vice versa): the shorter is a subsequence of the longer, ≥4 chars, with ≥2 chars dropped.
    That folds MKTPLACE↔MARKETPLACE together without collapsing a one-letter substitution (RIDER/RIVER)
    or a plural (BLUE/BLUES), which a looser fuzzy-ratio match would. Best-effort: it only aims to catch
    the common near-duplicate phrasings — an unusual case slipping through and being kept is harmless."""
    if token in known:
        return True
    for k in known:
        lo, hi = (token, k) if len(token) <= len(k) else (k, token)
        if len(lo) >= 4 and len(hi) - len(lo) >= 2 and _is_subsequence(lo, hi):
            return True
    return False


def _is_identifier_token(token: str) -> bool:
    """Whether a token looks like a distinguishing identifier rather than a generic word — i.e. it carries
    a digit (an order/reference/transaction number, or a mixed alphanumeric code like BIVQUH2VA022Z). The
    detail worth keeping from a *same* charge's other copy is always an identifier like this; generic
    payment filler (AMAZON, MARKETPLACE, NA, PAYMENTS, DIGITAL DOWNLOADS …) is pure words and adds nothing."""
    return any(ch.isdigit() for ch in token)


def _fold_charge_detail(conn: sqlite3.Connection, survivor_id: str, loser_ids) -> None:
    """Fold a losing copy's original-description detail into the survivor's import evidence, so a merge
    keeps a composite rather than dropping detail the survivor lacked. A copy is folded only when it adds a
    *distinguishing* token — one the survivor doesn't already convey (see `_token_represented`) *and* that
    looks like an identifier (see `_is_identifier_token`). So a near-duplicate restating of the same charge
    in generic words (AMAZON MARKETPLACE / AMAZON MARKETPLACE NA - PAYMENTS next to an existing AMAZON
    MKTPLACE …) is dropped as noise, while a copy carrying a distinct order/reference number is preserved."""
    row = conn.execute("SELECT import_evidence_json FROM txn WHERE id = ?", (survivor_id,)).fetchone()
    try:
        ev = json.loads(row["import_evidence_json"]) if row and row["import_evidence_json"] else {}
    except (TypeError, ValueError):
        ev = {}
    if not isinstance(ev, dict):
        ev = {}
    extras = ev.get("extra_text_fields") if isinstance(ev.get("extra_text_fields"), list) else []
    # Tokens the survivor already conveys: its own longest description plus any detail a prior merge folded
    # in. A loser copy earns a fold only by contributing a token beyond these.
    known = set(_norm_tokens(_charge_description(conn, survivor_id)))
    for f in extras:
        if isinstance(f, dict):
            known.update(_norm_tokens(str(f.get("value") or "")))
    added = False
    for cid in loser_ids:
        detail = _charge_description(conn, cid)
        if detail and any(
            _is_identifier_token(t) and not _token_represented(t, known)
            for t in _norm_tokens(detail)
        ):
            extras.append({"header": "Merged duplicate detail", "value": detail})
            known.update(_norm_tokens(detail))
            added = True
    if added:
        ev["extra_text_fields"] = extras
        conn.execute("UPDATE txn SET import_evidence_json = ? WHERE id = ?", (json.dumps(ev), survivor_id))


def merge_duplicate_charges(conn: sqlite3.Connection, order_link_id: str, *,
                            review_window: bool = False) -> dict:
    """Merge an order's duplicate charges into one: keep the richest copy, fold the others' detail into it,
    trash the rest, and make it the order's linked+excluded charge. For the 'same purchase imported twice'
    case. Guarded: if other unmatched orders in the batch share this amount, the copies are *distinct*
    purchases, not duplicates — merging would steal a charge — so it refuses and steers to per-row Discard.
    ``review_window`` widens the copy derivation to the ±14-day review window so a Duplicate·review group
    merges exactly the set its report row displayed; a plain duplicate merge stays at the matcher's ±3."""
    link = txn_links.get_link(conn, order_link_id)
    if not link or link.get("kind") != LINK_KIND:
        raise ValueError("Unknown Amazon order link")
    order_ids = txn_links.member_txn_ids(conn, order_link_id, role="order")
    if not order_ids:
        raise ValueError("Order has no transaction")
    order = _txn_summary(conn, order_ids[0])
    amount = (link.get("metadata") or {}).get("charge_amount")
    if amount is None or not order:
        raise ValueError("Order has no charge amount to match")

    batch_id = _order_batch_id(conn, order_link_id)
    peers = [o for o in _unmatched_cash_orders(conn, batch_id or "")
             if o["link_id"] != order_link_id and round(o["amount"], 2) == round(amount, 2)]
    if peers:
        raise ValueError("Other orders share this amount — these look like distinct purchases; discard the extra copy instead.")

    linked = txn_links.member_txn_ids(conn, order_link_id, role="charge")
    if len(linked) > 1:
        # A split reconciliation: every linked charge is a real shipment, so there is no single "copy"
        # to keep — merging would trash legitimate rows (each extra shipment looks like a redundant
        # copy of the first). Steer to the per-copy Discard, which names the row to remove.
        raise ValueError("This order is matched to several shipment charges — discard the specific "
                         "redundant copy instead of merging.")
    window = _SPLIT_SUGGESTION_WINDOW_DAYS if review_window else _CHARGE_DATE_WINDOW_DAYS
    # Re-derived through the same _duplicate_group the report used, rather than trusting the client:
    # merging trashes rows, so every guard (same account, not user-settled) has to hold server-side.
    # `derived` already excludes linked charges, so the order's own charge only enters as the anchor.
    derived = _order_charge_candidates(conn, link.get("metadata") or {}, order, window_days=window)
    group = _duplicate_group(conn, derived, anchor=linked[0] if linked else None)
    if group.settled:
        raise ValueError("These charges were marked as not duplicates.")
    if not group.copies:
        raise ValueError("Nothing to merge")
    copies = [linked[0], *group.copies] if linked else list(group.copies)

    survivor = _richest_charge(conn, copies)
    losers = [c for c in copies if c != survivor]
    _fold_charge_detail(conn, survivor, losers)
    for c in losers:
        if c in linked:
            _detach_charge(conn, order_link_id, c)
        _trash_merged_copy(conn, c, survivor)
    if survivor not in txn_links.member_txn_ids(conn, order_link_id, role="charge"):
        manual_link_charge(conn, order_link_id, survivor)
    return {"status": "merged", "survivor_id": survivor, "trashed": losers}


def _trash_merged_copy(conn: sqlite3.Connection, loser_id: str, survivor_id: str) -> None:
    """Trash a merged-away duplicate copy with the dedupe flow's provenance fields
    (``suspect_duplicate_of`` → the kept copy, ``rejection_reason='duplicate_confirmed'``,
    ``dedupe_resolved_by='amazon_merge'``). That routes it into the existing surfaces: the source
    file ledger's "Removed as duplicates" list, and the Trash page's origin grouping — where, unlike
    the unified dedupe flow's hidden rows, it stays visible/restorable (and empties with the trash).
    Restore clears the tags (see transactions.restore_transaction)."""
    conn.execute(
        """UPDATE txn SET suspect_duplicate_of = ?,
                          rejection_reason = 'duplicate_confirmed',
                          dedupe_resolved_by = 'amazon_merge'
           WHERE id = ?""",
        (survivor_id, loser_id),
    )
    trash_txns(conn, [loser_id])


def merge_unaccounted_charges(conn: sqlite3.Connection, charge_txn_ids: list) -> dict:
    """Merge an Unaccounted·duplicate group — copies of one charge that no order accounts for: keep the
    richest copy, fold the others' detail into it, trash the rest. No linking (there is no order); the
    survivor returns to the informational unaccounted list. The client sends the group's explicit ids,
    so re-validate here that they are plausible copies by the report's own grouping rule: every id
    untrashed and unlinked, all on one account with one rounded amount."""
    ids = list(dict.fromkeys(charge_txn_ids or []))
    if len(ids) < 2:
        raise ValueError("Pick at least two charges to merge")
    rows = []
    for cid in ids:
        row = conn.execute("SELECT id, account_id, amount, trashed_at FROM txn WHERE id = ?", (cid,)).fetchone()
        if not row or row["trashed_at"]:
            raise ValueError("Unknown or already-trashed charge")
        if conn.execute("SELECT 1 FROM txn_link_member WHERE txn_id = ?", (cid,)).fetchone():
            raise ValueError("A charge linked to an order can't be merged from here")
        rows.append(row)
    # Compare *effective* accounts (linked-group root), matching how the grouping in
    # `_group_unaccounted_duplicates` clustered these — otherwise a group the report legitimately formed
    # across a parent/child merge would fail re-validation here.
    eff = _effective_account_map(conn, ids)
    if len({eff.get(cid) for cid in ids}) != 1 or len({round(r["amount"], 2) for r in rows}) != 1:
        raise ValueError("These charges don't look like copies of one charge (different account or amount)")
    survivor = _richest_charge(conn, ids)
    losers = [c for c in ids if c != survivor]
    _fold_charge_detail(conn, survivor, losers)
    for c in losers:
        _trash_merged_copy(conn, c, survivor)
    return {"status": "merged", "survivor_id": survivor, "trashed": losers}


def mark_charges_distinct(conn: sqlite3.Connection, charge_txn_ids: list) -> dict:
    """A duplicate group's **Not duplicates**: record every pair in the group as distinct
    (``amazon_charge_distinct``) so the report never re-flags them — an unaccounted group's copies
    return to the informational list; an order-anchored group's order falls back to the normal
    unmatched path (the assertion removes the *duplicate* claim, not the *which charge is the
    order's* question). The accumulated-filter model account_pair_distinct already uses."""
    ids = sorted(dict.fromkeys(charge_txn_ids or []))
    if len(ids) < 2:
        raise ValueError("Pick at least two charges")
    for cid in ids:
        if not conn.execute("SELECT 1 FROM txn WHERE id = ?", (cid,)).fetchone():
            raise ValueError("Unknown charge")
    for i, low in enumerate(ids):
        for high in ids[i + 1:]:
            conn.execute(
                """INSERT OR IGNORE INTO amazon_charge_distinct (txn_id_low, txn_id_high, asserted_at)
                   VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))""",
                (low, high),
            )
    return {"status": "marked_distinct"}


class MarkChargesDistinctRequest(BaseModel):
    charge_txn_ids: list[str]


@router.post("/amazon/charges-not-duplicates")
async def amazon_charges_not_duplicates_endpoint(body: MarkChargesDistinctRequest):
    """Declare a duplicate-charge group 'not duplicates' — never re-flag these pairs."""
    with get_db() as conn:
        try:
            return mark_charges_distinct(conn, body.charge_txn_ids)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))


def mark_unaccounted_charges_reviewed(conn: sqlite3.Connection, charge_txn_ids, reviewed: bool = True) -> dict:
    """Acknowledge (or un-acknowledge) 'Unaccounted charge' reverse-scan charges. Sets/clears a row in
    ``amazon_charge_reviewed`` so the charge leaves (or rejoins) the reconciliation attention count — the
    escape valve for the informational bucket. The charge stays listed in the report either way; only its
    attention weight changes. Each write bumps the recon epoch (amazon_charge_reviewed trigger), so the
    cached attention count re-derives."""
    updated = 0
    for cid in charge_txn_ids or []:
        if not conn.execute("SELECT 1 FROM txn WHERE id = ?", (cid,)).fetchone():
            continue
        if reviewed:
            conn.execute(
                """INSERT OR IGNORE INTO amazon_charge_reviewed (txn_id, reviewed_at)
                   VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))""",
                (cid,),
            )
        else:
            conn.execute("DELETE FROM amazon_charge_reviewed WHERE txn_id = ?", (cid,))
        updated += 1
    return {"updated": updated, "reviewed": reviewed}


class MarkUnaccountedReviewedRequest(BaseModel):
    txn_ids: list[str]
    reviewed: bool = True


@router.post("/amazon/mark-unaccounted-reviewed")
async def amazon_mark_unaccounted_reviewed_endpoint(body: MarkUnaccountedReviewedRequest):
    """Acknowledge (or un-acknowledge) a set of 'Unaccounted charge' reverse-scan charges so they drop out
    of (or rejoin) the reconciliation attention count. Bulk by `txn_ids`; `reviewed=false` un-acknowledges."""
    with get_db() as conn:
        return mark_unaccounted_charges_reviewed(conn, body.txn_ids, body.reviewed)


class MergeUnaccountedChargesRequest(BaseModel):
    charge_txn_ids: list[str]


@router.post("/amazon/merge-unaccounted-charges")
async def amazon_merge_unaccounted_charges_endpoint(body: MergeUnaccountedChargesRequest):
    """Merge an unaccounted duplicate-charge group into its richest copy (trashing the rest)."""
    with get_db() as conn:
        try:
            result = merge_unaccounted_charges(conn, body.charge_txn_ids)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
    settle_owed_rescans()
    return result


class MergeDuplicateChargesRequest(BaseModel):
    order_link_id: str
    # True for a Duplicate·review group: derive the copies at the ±14-day review window (the set the
    # report row displayed) instead of the matcher's ±3.
    review_window: bool = False


@router.post("/amazon/merge-duplicate-charges")
async def amazon_merge_duplicate_charges_endpoint(body: MergeDuplicateChargesRequest):
    """Merge an order's duplicate charges into one composite survivor (trashing the rest) and link it."""
    with get_db() as conn:
        try:
            return merge_duplicate_charges(conn, body.order_link_id, review_window=body.review_window)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))


def unmatched_parked_order_count(conn: sqlite3.Connection, import_summary: Optional[dict]) -> int:
    """How many of an orphan (items-before-orders) batch's discarded orders are *still* waiting — their order
    id has no Amazon order in the ledger yet. Derived live from the ledger rather than the static snapshot
    count, so the card's "no matching order" resolves to zero once a later orders import attaches the items (and
    re-flags if that import is undone). Zero for a batch that discarded nothing."""
    discarded = (import_summary or {}).get("discarded_items") or []
    order_ids = list({d.get("order_id") for d in discarded if isinstance(d, dict) and d.get("order_id")})
    if not order_ids:
        return 0
    placeholders = ",".join("?" * len(order_ids))
    linked = {
        r["external_ref"] for r in conn.execute(
            f"SELECT DISTINCT external_ref FROM txn_link WHERE kind = ? AND external_ref IN ({placeholders})",
            (LINK_KIND, *order_ids),
        ).fetchall()
    }
    return sum(1 for oid in order_ids if oid not in linked)


def reverse_batch_amazon_links(conn: sqlite3.Connection, batch_id: str) -> int:
    """Undo the Amazon links a batch created, restoring each matched charge's prior category from the
    link metadata and deleting the link. A batch that brought only a link's charges, not its order,
    detaches those charges and leaves the order's link in place. Mirrors `reverse_batch_enrichments`: it must run *before* the
    batch's own transactions are deleted, because the charge it restores lives *outside* the batch and
    would otherwise be left silently reclassified. The batch's item rows are deleted by the caller's
    normal `DELETE FROM txn WHERE import_batch_id = ?`."""
    link_ids = [
        row["id"]
        for row in conn.execute(
            """SELECT DISTINCT l.id
               FROM   txn_link l
               JOIN   txn_link_member m ON m.link_id = l.id
               JOIN   txn t ON t.id = m.txn_id
               WHERE  l.kind = ? AND t.import_batch_id = ?""",
            (LINK_KIND, batch_id),
        ).fetchall()
    ]
    for link_id in link_ids:
        in_batch = {r["id"] for r in conn.execute(
            """SELECT t.id FROM txn_link_member m JOIN txn t ON t.id = m.txn_id
               WHERE m.link_id = ? AND t.import_batch_id = ?""", (link_id, batch_id))}
        order_ids = txn_links.member_txn_ids(conn, link_id, role="order")
        if not in_batch & set(order_ids):
            # The batch brought only charges (a sync card holding a matched charge): the order stays, and
            # so does its link; the charges leave it as an unlink would take them.
            for charge_id in txn_links.member_txn_ids(conn, link_id, role="charge"):
                if charge_id in in_batch:
                    _detach_charge(conn, link_id, charge_id)
            continue
        link = txn_links.get_link(conn, link_id)
        meta = (link.get("metadata") or {}) if link else {}
        for charge_id in txn_links.member_txn_ids(conn, link_id, role="charge"):
            prior = _charge_prior_for(meta, charge_id)
            if prior:
                conn.execute(
                    "UPDATE txn SET category_id = ?, category_source = ?, category_overridden = ? WHERE id = ?",
                    (prior.get("category_id"), prior.get("category_source"),
                     category_lock_for(prior.get("category_source"), prior.get("category_overridden")), charge_id),
                )
        txn_links.delete_link(conn, link_id)
    # An items-only import parks its per-item detail for a later orders file; undoing that import must remove
    # what it parked (an orphan/parking batch creates no links, so this is its only undo effect). Undoing the
    # orders import that took parked items returns them to waiting, so importing those orders again
    # attaches them again.
    conn.execute("DELETE FROM amazon_pending_item WHERE parked_batch_id = ?", (batch_id,))
    conn.execute("UPDATE amazon_pending_item SET consumed_batch_id = NULL WHERE consumed_batch_id = ?", (batch_id,))
    return len(link_ids)


def _exclude_charge(conn: sqlite3.Connection, charge_id: str) -> dict:
    """Move the matched charge into the excluded funding category, returning its prior categorization so
    :func:`reverse_amazon_order` can restore it exactly (including a manual category we overrode)."""
    row = conn.execute(
        "SELECT category_id, category_source, category_overridden FROM txn WHERE id = ?", (charge_id,)
    ).fetchone()
    prior = {
        "category_id": row["category_id"],
        "category_source": row["category_source"],
        "category_overridden": row["category_overridden"],
    }
    funding_id = find_or_create_funding_category(conn)
    conn.execute(
        "UPDATE txn SET category_id = ?, category_source = 'enrichment', category_overridden = 0 WHERE id = ?",
        (funding_id, charge_id),
    )
    return prior


async def _read_amazon_uploads(files, known_files: "dict | None" = None):
    """Decode + parse the uploaded AZAD files into
    ``(orders, items_by_order, names, unrecognized, skipped, file_hashes)``. Shared by the scan and
    import endpoints; files are sniffed by header, so upload order and file names don't matter.

    Each file is content-hashed and one whose hash has been seen already is **skipped** rather than
    re-processed into a confusing all-duplicates batch. ``known_files`` maps a hash a *completed* import
    already took to its ``{filename, batch_id}`` (see :func:`_imported_amazon_file_hashes`). ``file_hashes``
    carries ``{filename, hash}`` for the files actually taken, for the batch to persist; ``names`` likewise
    lists only the files taken."""
    named_texts = []
    for upload in files:
        content = await read_import_upload(upload)
        try:
            text = content.decode("utf-8-sig")
        except UnicodeDecodeError:
            text = content.decode("latin-1")
        named_texts.append((upload.filename, text))
    return read_amazon_exports(named_texts, known_files)


def read_amazon_exports(named_texts, known_files: "dict | None" = None):
    """The decoding-free half of `_read_amazon_uploads`: `(filename, text)` pairs in, the same six-tuple
    out. Kept separate so an in-process caller (the demo loader) parses files exactly as an upload is.

    A skipped file is reported as ``{filename, reason, matched_filename, matched_batch_id}``, because the
    two ways a hash repeats need different sentences and only one of them is about a past import: a file
    matching ``known_files`` was taken by a completed card (``reason='already_imported'``, with that card
    named), while a second copy of a file *inside this same drop* was never imported at all
    (``reason='duplicate_in_drop'``, naming the copy that was taken). Reporting both as "already imported"
    sent a reader looking in the ledger for rows that were never created."""
    orders: list[AmazonOrder] = []
    items_by_order: dict[str, list[AmazonItem]] = {}
    names: list[str] = []
    unrecognized: list[str] = []
    skipped: list[dict] = []
    file_hashes: list[dict] = []
    known = dict(known_files or {})
    # Hash → the name it was taken under earlier *in this drop*, which is what a within-drop duplicate
    # is told to look at. Kept apart from `known` so the two reasons stay distinguishable.
    taken_here: dict = {}
    for raw_filename, text in named_texts:
        filename = raw_filename or "amazon.csv"
        content_hash = make_import_file_hash(text)
        if content_hash in known:
            prior = known[content_hash]
            skipped.append({"filename": filename, "reason": "already_imported",
                            "matched_filename": prior.get("filename"),
                            "matched_batch_id": prior.get("batch_id")})
            continue
        if content_hash in taken_here:
            skipped.append({"filename": filename, "reason": "duplicate_in_drop",
                            "matched_filename": taken_here[content_hash],
                            "matched_batch_id": None})
            continue
        kind, rows = read_export(text)
        # Tag each parsed row with the file it came from so the import-detail report can answer
        # "which file did this order / discarded item come from?".
        if kind == "orders":
            parsed = parse_order_rows(rows)
            for order in parsed:
                order.source_file = filename
                order.source_file_hash = content_hash
            orders.extend(parsed)
        elif kind == "items":
            for order_id, items in parse_item_rows(rows).items():
                for item in items:
                    item.source_file = filename
                    item.source_file_hash = content_hash
                items_by_order.setdefault(order_id, []).extend(items)
        else:
            unrecognized.append(raw_filename or "(unnamed)")
            continue
        names.append(filename)
        taken_here[content_hash] = filename
        file_hashes.append({"filename": filename, "hash": content_hash})
    return orders, items_by_order, names, unrecognized, skipped, file_hashes


def _imported_amazon_file_hashes(conn: sqlite3.Connection) -> dict:
    """Every file a *completed* Amazon import has taken, as ``content hash → {filename, batch_id}``
    (persisted per batch in the config snapshot — an undone batch's files can be re-imported). Batches
    imported before hashing existed simply aren't listed, so their files aren't skipped.

    The card is carried, not just the hash, because a skipped file's notice names the card that already
    covers it — "this file is in *that* import" is the only form of the message a reader can act on."""
    taken: dict = {}
    rows = conn.execute(
        "SELECT id, config_snapshot FROM import_batch WHERE source_kind = ? AND status = 'completed'",
        (BATCH_SOURCE_KIND,),
    ).fetchall()
    for r in rows:
        try:
            snap = json.loads(r["config_snapshot"]) if r["config_snapshot"] else {}
        except (TypeError, ValueError):
            continue
        if not isinstance(snap, dict):
            continue
        for f in snap.get("amazon_file_hashes") or []:
            if isinstance(f, dict) and f.get("hash"):
                taken.setdefault(f["hash"], {"filename": f.get("filename"), "batch_id": r["id"]})
    return taken


def _scan_instruments(conn, orders, account_id: Optional[str]) -> list[dict]:
    """The distinct payment cards the orders were paid with, each resolved against the funding map (using
    the chosen Amazon account for override resolution when given). Powers the pre-import "map these cards"
    step so a card is mapped *before* the import that needs it — the map is never applied retroactively."""
    seen: dict[tuple, dict] = {}
    for order in orders:
        if not order.has_order_detail:
            continue
        disposition = classify_order(order)
        # Same bare-card probe the import runs, so a card seen only on bare-card (points) orders still
        # surfaces here for mapping when its full-total charge is in the ledger.
        disposition = _resolve_bare_card_order(conn, order, account_id, disposition)
        inst = _instrument_of(disposition)
        if not inst:
            continue
        key = (inst["last4"], inst["network"])
        if key in seen:
            continue
        funding = amazon_funding.resolve_funding_account(
            conn, account_id, disposition.match_last4, disposition.match_network
        )
        account_name = None
        # Reported as the group root, matching what the search will actually constrain to and what the
        # scan dialog's (top-level-only) picker can preselect — see `amazon_funding.list_funding_map`.
        mapped_account_id = (effective_account_id(conn, funding.funding_account_id)
                             if funding.state == "mapped" else funding.funding_account_id)
        if mapped_account_id:
            row = conn.execute(
                "SELECT display_name, name FROM account WHERE id = ?", (mapped_account_id,)
            ).fetchone()
            if row:
                account_name = row["display_name"] or row["name"]
        seen[key] = {**inst, "state": funding.state,
                     "funding_account_id": mapped_account_id, "funding_account_name": account_name}
    return list(seen.values())


@router.post("/amazon/scan")
async def amazon_scan_endpoint(
    files: list[UploadFile] = File(...),
    account_id: Optional[str] = Form(None),
):
    """Inspect the dropped AZAD files *before* importing: which payment cards they use (with each card's
    current funding-map state), so the UI can get any unmapped card mapped up front. No ledger changes.
    Already-imported files (matched by content hash) are skipped here too, so the scan reflects exactly
    what an import would take."""
    with get_db() as conn:
        known = _imported_amazon_file_hashes(conn)
    orders, items_by_order, names, unrecognized, skipped, _hashes = await _read_amazon_uploads(files, known)
    with get_db() as conn:
        instruments = _scan_instruments(conn, orders, account_id)
    return {
        "instruments": instruments,
        "order_count": len(orders),
        "has_items": bool(items_by_order),
        "names": names,
        "unrecognized_files": unrecognized,
        "skipped_uploads": skipped,
    }


@router.post("/amazon/import")
async def amazon_import_endpoint(
    files: list[UploadFile] = File(...),
    account_id: str = Form(...),
    apply_categorization: bool = Form(True),
):
    """Import one or both AZAD exports (orders + items) into the chosen Amazon account. Files are
    sniffed by header, so upload order doesn't matter and either file alone is accepted (degrading as
    documented). This endpoint owns only the HTTP/multipart envelope and the demo and restore guards; the
    work is :func:`run_amazon_import`, kept callable in-process."""
    with get_db() as conn:
        if is_demo_data_loaded(conn):
            raise HTTPException(status_code=409, detail={
                "code": "demo_data_loaded",
                "message": "Clear the demo data before importing your own data.",
            })
        require_no_pending_restore(conn, "importing")
        known = _imported_amazon_file_hashes(conn)

    orders, items_by_order, names, unrecognized, skipped, file_hashes = await _read_amazon_uploads(files, known)
    if not orders and not items_by_order:
        if skipped:
            # Every usable file was skipped — nothing to do, and deliberately *no new batch* (the files
            # already have their cards). The import form's host reports it from this summary.
            return {"batch_id": None, "batches": [], "order_count": 0, "counts": {}, "instruments": [],
                    "skipped_uploads": skipped, "unrecognized_files": unrecognized}
        raise HTTPException(status_code=400, detail={
            "code": "unrecognized_files",
            "message": "None of the uploaded files looked like an Amazon orders or items export.",
            "unrecognized": unrecognized,
        })

    merged = merge(orders, items_by_order)
    with get_db() as conn:
        if not conn.execute("SELECT 1 FROM account WHERE id = ?", (account_id,)).fetchone():
            raise HTTPException(status_code=400, detail="Unknown account")
        summary = run_amazon_import(
            conn, merged, account_id=account_id, filename=", ".join(names) or "amazon",
            apply_categorization=apply_categorization, file_hashes=file_hashes,
        )
    summary["unrecognized_files"] = unrecognized
    summary["skipped_uploads"] = skipped
    return summary


class FundingSourceUpsert(BaseModel):
    last4: str
    network: Optional[str] = None
    # The system account this instrument charges. NULL together with untracked=True marks the explicit
    # "untracked" state; NULL with untracked=False is rejected (a mapping must name an account).
    funding_account_id: Optional[str] = None
    untracked: bool = False
    # NULL = the global default; a value = a per-account override for that one Amazon account.
    amazon_account_id: Optional[str] = None


@router.get("/amazon/funding-sources")
async def list_funding_sources_endpoint():
    """All funding-source mappings (see :mod:`backend.services.amazon_funding`), for the persistent
    "Amazon funding sources" section under the Amazon upload form."""
    with get_db() as conn:
        return {"mappings": amazon_funding.list_funding_map(conn)}


@router.put("/amazon/funding-sources")
async def upsert_funding_source_endpoint(body: FundingSourceUpsert):
    """Create or update one instrument's mapping (idempotent per instrument + scope)."""
    last4 = (body.last4 or "").strip()
    if not last4:
        raise HTTPException(status_code=400, detail="last4 is required")
    if not body.untracked and not body.funding_account_id:
        raise HTTPException(status_code=400, detail="A mapping must name a funding account or be marked untracked")
    with get_db() as conn:
        for field, account_id in (("funding_account_id", body.funding_account_id),
                                  ("amazon_account_id", body.amazon_account_id)):
            if account_id and not conn.execute(
                "SELECT 1 FROM account WHERE id = ?", (account_id,)
            ).fetchone():
                raise HTTPException(status_code=400, detail=f"Unknown {field}")
        mapping_id = amazon_funding.upsert_funding_source(
            conn,
            last4=last4,
            network=body.network,
            funding_account_id=body.funding_account_id,
            untracked=body.untracked,
            amazon_account_id=body.amazon_account_id,
        )
        mapping = next((m for m in amazon_funding.list_funding_map(conn) if m["id"] == mapping_id), None)
    return {"mapping": mapping}


@router.delete("/amazon/funding-sources/{mapping_id}")
async def delete_funding_source_endpoint(mapping_id: str):
    """Remove a mapping (returning that instrument to the unmapped state). Backs the section's Undo."""
    with get_db() as conn:
        deleted = amazon_funding.delete_funding_source(conn, mapping_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Unknown mapping")
    return {"status": "deleted"}


def _funding_category_info(conn: sqlite3.Connection) -> dict:
    """The effective excluded category (resolving the global choice or the default), with whether it is
    the default and whether it's actually excluded from totals — the UI warns if a chosen category isn't,
    since that would double-count Amazon spend."""
    cat_id = find_or_create_funding_category(conn)
    row = conn.execute(
        """SELECT c.id, c.name, COALESCE(pc.exclude_from_totals, c.exclude_from_totals, 0) AS excl
           FROM   category c LEFT JOIN category pc ON pc.id = c.parent_id WHERE c.id = ?""",
        (cat_id,),
    ).fetchone()
    state = get_tenant_workflow_state(conn, FUNDING_CATEGORY_STATE_KEY)
    is_default = not (isinstance(state, dict) and state.get("category_id"))
    return {"category_id": row["id"], "name": row["name"],
            "is_excluded": bool(row["excl"]), "is_default": is_default}


class FundingCategoryRequest(BaseModel):
    category_id: Optional[str] = None  # None resets to the seeded default


@router.get("/amazon/funding-category")
async def get_funding_category_endpoint():
    """The category the matched card charge is recategorized into (global setting; see the Amazon import form)."""
    with get_db() as conn:
        return _funding_category_info(conn)


@router.put("/amazon/funding-category")
async def set_funding_category_endpoint(body: FundingCategoryRequest):
    """Set (or reset to default) the global category used for the excluded Amazon card charge. Applies to
    future imports only."""
    with get_db() as conn:
        if body.category_id:
            row = conn.execute("SELECT parent_id FROM category WHERE id = ?", (body.category_id,)).fetchone()
            if not row:
                raise HTTPException(status_code=400, detail="Unknown category")
            if row["parent_id"] is None:
                raise HTTPException(status_code=400, detail="Choose a leaf category, not a group")
            set_tenant_workflow_state(conn, FUNDING_CATEGORY_STATE_KEY, {"category_id": body.category_id})
        else:
            set_tenant_workflow_state(conn, FUNDING_CATEGORY_STATE_KEY, {})
        return _funding_category_info(conn)


def reverse_amazon_order(conn: sqlite3.Connection, link_id: str) -> dict:
    """Undo an applied order: delete its order transaction, restore the charge's prior categorization
    from the link metadata, and delete the link. Safe to call once per link.

    No route calls this; only `tests/test_amazon_enrich.py` does."""
    link = txn_links.get_link(conn, link_id)
    if not link:
        return {"status": "not_found"}
    order_ids = txn_links.member_txn_ids(conn, link_id, role="order")
    charge_ids = txn_links.member_txn_ids(conn, link_id, role="charge")

    meta = link.get("metadata") or {}
    for charge_id in charge_ids:
        prior = _charge_prior_for(meta, charge_id)
        if prior:
            conn.execute(
                "UPDATE txn SET category_id = ?, category_source = ?, category_overridden = ? WHERE id = ?",
                (prior.get("category_id"), prior.get("category_source"),
                 category_lock_for(prior.get("category_source"), prior.get("category_overridden")), charge_id),
            )
    # Delete the link first so its members' FK rows go, then the order transaction itself.
    txn_links.delete_link(conn, link_id)
    release_rule_suggestion_rows(conn, order_ids)
    owe_recurring_rescan(conn, [*order_ids, *charge_ids])
    for order_id in order_ids:
        conn.execute("DELETE FROM txn WHERE id = ?", (order_id,))
    return {"status": "reversed", "orders_removed": len(order_ids), "charges_restored": len(charge_ids)}


# -------------------------------------------------------------------------------------------------
# Amazon import profiles
#
# A saved Amazon source: which Amazon account its files import into, and optionally a directory on the
# server to watch. They are rows in `csv_import_profile` carrying `source_kind = 'marketplace:amazon'`
# — the table already holds every field one needs (name, account, apply-categorization, filename
# pattern, and the whole `watch_*` block), and reusing it means the watched-folder machinery (the scan
# loop, the per-file watermark, the purge, the admin gate on naming a directory, the status view) works
# for Amazon without a second copy of any of it. The CSV-only columns (`column_map`, `date_format`,
# `header_fingerprint`) stay unused on these rows: an AZAD export is recognized by its header
# (`sniff_kind`), so there is no mapping to save.
#
# What a profile buys over the one remembered last-used account: two people's exports, landing in two
# Amazon accounts, each with their own directory — which is the same shape as keeping two copies of a
# CSV data source for two accounts at one institution.


class AmazonProfileBody(BaseModel):
    name: str
    account_id: Optional[str] = None
    apply_categorization: bool = True
    # Substring, case-insensitive, matched against the filename — the same meaning the CSV sources give
    # it. It is what lets one watched directory hold several people's exports, and what preselects a
    # profile when a file is dropped by hand.
    filename_pattern: Optional[str] = None


def _amazon_profile_row(conn: sqlite3.Connection, row) -> dict:
    d = dict(row)
    return {
        "id": d["id"],
        "name": d["name"],
        "account_id": d.get("account_id"),
        "account_name": d.get("account_name"),
        "apply_categorization": bool(d.get("apply_categorization")),
        "filename_pattern": d.get("filename_pattern") or "",
        "watch_dir": d.get("watch_dir") or "",
        "watch_enabled": bool(d.get("watch_enabled")),
        "watch_purge_mode": d.get("watch_purge_mode") or "never",
        "watch_purge_days": d.get("watch_purge_days"),
        "watch_notice": d.get("watch_notice"),
        "watch_last_scan_at": d.get("watch_last_scan_at"),
    }


def _list_amazon_profiles(conn: sqlite3.Connection) -> list[dict]:
    rows = conn.execute(
        """
        SELECT p.*, COALESCE(a.display_name, a.name) AS account_name
        FROM   csv_import_profile p
        LEFT JOIN account a ON a.id = p.account_id
        WHERE  p.source_kind = ?
        ORDER  BY p.name
        """,
        (BATCH_SOURCE_KIND,),
    ).fetchall()
    return [_amazon_profile_row(conn, r) for r in rows]


def _assert_amazon_account(conn: sqlite3.Connection, account_id: Optional[str]) -> Optional[str]:
    """A profile's account must be an Amazon account that still exists — it is the one thing the
    unattended path cannot ask about, so it is checked where it is set rather than where it is used."""
    aid = (account_id or "").strip()
    if not aid:
        return None
    row = conn.execute(
        "SELECT type FROM account WHERE id = ? AND trashed_at IS NULL", (aid,)
    ).fetchone()
    if not row:
        raise HTTPException(status_code=400, detail="Unknown account")
    if str(row["type"] or "").lower() != "amazon":
        raise HTTPException(status_code=400, detail="An Amazon source must import into an Amazon account.")
    return aid


def _assert_amazon_profile_name(conn: sqlite3.Connection, name: str, *, profile_id: Optional[str] = None) -> str:
    """Names are unique across *all* data sources, Amazon or CSV, because they are one list to the
    reader and the CSV side already enforces it over the whole table."""
    cleaned = (name or "").strip()
    if not cleaned:
        raise HTTPException(status_code=400, detail="Enter a name for this source.")
    clash = conn.execute(
        "SELECT 1 FROM csv_import_profile WHERE LOWER(name) = LOWER(?) AND id IS NOT ?",
        (cleaned, profile_id),
    ).fetchone()
    if clash:
        raise HTTPException(status_code=400, detail=f'A data source named "{cleaned}" already exists.')
    return cleaned


@router.get("/amazon/profiles")
async def list_amazon_profiles_endpoint():
    with get_db() as conn:
        return {"profiles": _list_amazon_profiles(conn)}


@router.post("/amazon/profiles")
async def create_amazon_profile_endpoint(body: AmazonProfileBody):
    profile_id = str(uuid.uuid4())
    with get_db() as conn:
        name = _assert_amazon_profile_name(conn, body.name)
        account_id = _assert_amazon_account(conn, body.account_id)
        conn.execute(
            """
            INSERT INTO csv_import_profile
              (id, name, source_kind, account_id, apply_categorization, filename_pattern, column_map)
            VALUES (?,?,?,?,?,?,'{}')
            """,
            (profile_id, name, BATCH_SOURCE_KIND, account_id,
             1 if body.apply_categorization else 0, (body.filename_pattern or "").strip() or None),
        )
        created = next((p for p in _list_amazon_profiles(conn) if p["id"] == profile_id), None)
    return {"profile": created}


@router.patch("/amazon/profiles/{profile_id}")
async def update_amazon_profile_endpoint(profile_id: str, body: AmazonProfileBody):
    with get_db() as conn:
        if not conn.execute(
            "SELECT 1 FROM csv_import_profile WHERE id = ? AND source_kind = ?", (profile_id, BATCH_SOURCE_KIND)
        ).fetchone():
            raise HTTPException(status_code=404, detail="Source not found")
        name = _assert_amazon_profile_name(conn, body.name, profile_id=profile_id)
        account_id = _assert_amazon_account(conn, body.account_id)
        conn.execute(
            """
            UPDATE csv_import_profile
            SET    name = ?, account_id = ?, apply_categorization = ?, filename_pattern = ?
            WHERE  id = ?
            """,
            (name, account_id, 1 if body.apply_categorization else 0,
             (body.filename_pattern or "").strip() or None, profile_id),
        )
        updated = next((p for p in _list_amazon_profiles(conn) if p["id"] == profile_id), None)
    return {"profile": updated}


@router.delete("/amazon/profiles/{profile_id}")
async def delete_amazon_profile_endpoint(profile_id: str):
    """Delete the source. Its cards stay: `import_batch.profile_id` is ON DELETE SET NULL, and a card is
    the provenance of transactions still in the ledger, so it outlives the setting that produced it."""
    with get_db() as conn:
        cur = conn.execute(
            "DELETE FROM csv_import_profile WHERE id = ? AND source_kind = ?", (profile_id, BATCH_SOURCE_KIND)
        )
        if not cur.rowcount:
            raise HTTPException(status_code=404, detail="Source not found")
        # `import_watch_file.profile_id` cascades, so the folder's watermark goes with the source.
    return {"deleted": profile_id}
