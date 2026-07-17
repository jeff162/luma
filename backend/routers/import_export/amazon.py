# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
The Amazon order engine: turn a parsed :class:`AmazonOrder` into ledger state (orders-only model, see
``docs/backlog/paypal-amazon-enrichment.md`` → "Amazon — orders-only model"). Given one parsed order and
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
from typing import Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from backend.db.database import get_db, get_tenant_workflow_state, set_tenant_workflow_state
from backend.services import amazon_funding, txn_links
from backend.services.amazon_import import (
    AmazonItem,
    AmazonOrder,
    OrderDisposition,
    classify_order,
    merge,
    parse_item_rows,
    parse_order_rows,
    read_export,
)

from .core import IMPORT_SUMMARY_KEY, _insert_imported_transaction, is_demo_data_loaded, make_hash, make_import_file_hash

router = APIRouter()

LINK_KIND = "amazon_order"
# Import-batch provenance marker (import_batch.source_kind) so the import history groups Amazon batches
# under an "Amazon" entry rather than "unknown data source". Vendor-qualified for future marketplaces.
BATCH_SOURCE_KIND = "marketplace:amazon"
AMAZON_FUNDING_CATEGORY = "Amazon purchase"
_CHARGE_DATE_WINDOW_DAYS = 3
# Global (tenant-wide) setting: which category the matched card charge is moved into. Stored in
# import_workflow_state; absent = use the seeded default below. A change takes effect on the *next*
# import only — an already-imported charge keeps the category it was assigned.
FUNDING_CATEGORY_STATE_KEY = "amazon_funding_category"


def _default_funding_category(conn: sqlite3.Connection) -> str:
    """The seeded default excluded category: a leaf under the always-seeded ``Transfers`` group (which
    carries ``exclude_from_totals = 1``, evaluated as ``COALESCE(parent, leaf, 0)``), so the charge drops
    out of spending totals without a per-row flag."""
    transfers = conn.execute(
        "SELECT id FROM category WHERE name = 'Transfers' AND parent_id IS NULL"
    ).fetchone()
    parent_id = transfers["id"] if transfers else None
    existing = conn.execute(
        "SELECT id FROM category WHERE name = ? AND parent_id IS ?",
        (AMAZON_FUNDING_CATEGORY, parent_id),
    ).fetchone()
    if existing:
        return existing["id"]
    new_id = str(uuid.uuid4())
    conn.execute(
        """INSERT INTO category (id, parent_id, name, category_type, exclude_from_totals)
           VALUES (?, ?, ?, 'expense', 1)""",
        (new_id, parent_id, AMAZON_FUNDING_CATEGORY),
    )
    return new_id


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
    ``amazon_funding``): when set, the search is constrained to that one account, and the last-4 clause is
    dropped entirely — the map already says which account, and narrowing to it is exactly what resolves an
    otherwise-ambiguous same-amount collision across accounts. When it is **not** set (an unmapped
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
                          window_days: int = _CHARGE_DATE_WINDOW_DAYS) -> list[str]:
    """Every card charge eligible to be *this* order's charge — the matcher's candidate set: a positive
    amount equal to the gross charge, unlinked, within the date window, on an account permitted by the
    funding map (``restrict_account_id``) or, absent a map, the card's last-4 (a carded account whose mask
    contradicts the last-4 is excluded; a maskless one stays eligible). ``find_matching_charge`` links only
    when this returns exactly one; the reconciliation report uses the full list to tell a *duplicate* (two or
    more) from a clean match, so both read from the same rule."""
    if amount is None or amount <= 0:
        return []
    clauses = [
        "t.trashed_at IS NULL",
        "ROUND(t.amount, 2) = ?",
        "NOT EXISTS (SELECT 1 FROM txn_link_member m WHERE m.txn_id = t.id)",
    ]
    params: list = [round(amount, 2)]
    if exclude_account_id:
        clauses.append("t.account_id != ?")
        params.append(exclude_account_id)
    if match_date:
        clauses.append("ABS(julianday(t.date) - julianday(?)) <= ?")
        params += [match_date, window_days]
    if restrict_account_id:
        clauses.append("t.account_id = ?")
        params.append(restrict_account_id)
    elif last4:
        clauses.append("(COALESCE(p.mask, a.mask) = ? OR COALESCE(p.mask, a.mask) IS NULL OR COALESCE(p.mask, a.mask) = '')")
        params.append(last4)
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
                             window_days: int = _CHARGE_DATE_WINDOW_DAYS) -> list[str]:
    """The eligible card charges for an already-imported order, reconstructed post-hoc from the link metadata
    (charge amount + the paying instrument) so the reconciliation report and the equal-count pass see exactly
    what the matcher saw. Resolves the funding map from the stored instrument: untracked → none expected;
    mapped → constrained to that account; otherwise the last-4 fallback. Empty for a non-cash / amount-less
    order or an untracked card. ``window_days`` widens the date window for the review-flavored consumers
    (the Duplicate·review bucket and its merge), which must see the same set; auto-actions keep the ±3
    default."""
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
        window_days=window_days)


def _order_label(order: AmazonOrder) -> str:
    """The order transaction's display name: the concatenated item list the *orders* file already
    carries (so it reads like "Air Widget; Widget Picks"), falling back to the joined item descriptions,
    then to the order id."""
    return (
        order.items_summary
        or "; ".join(i.description for i in order.items if i.description)
        or f"Amazon order {order.order_id}"
    )


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
    return evidence


def _create_order_txn(conn, order, amount, *, account_id, owner_id, batch_id, category_id) -> str:
    """Create the single spending transaction for one order in the Amazon account (amount = net cash;
    the item list is the memo; per-item reference detail rides in evidence). One row per order — never
    per item."""
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
    })


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
    card but discloses no per-leg amounts (``Riverstone ending in 5093; Rewards Points;`` — the
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


def apply_amazon_order(
    conn: sqlite3.Connection,
    order: AmazonOrder,
    *,
    account_id: str,
    batch_id: str,
) -> dict:
    """Materialize one parsed order as a single spending transaction in the Amazon account and link its
    funding card charge. Orders-only model: one row per order (amount = net cash, memo = the item list),
    never per-item — the items file's per-item data rides in evidence. Behavior by input:

      * **Order already linked** → if this import carries item detail, fold it into the existing order
        transaction's evidence (``enriched``), or report ``already_enriched`` if that order already had item
        detail (a re-imported items file); a bare re-import with no new item detail is ``already_applied``.
        The card charge is matched once, at first import — a mapping added later is not applied
        retroactively (like the category setting, it affects future imports only).
      * **Items-only, no existing order** → nothing to attach to, so it's discarded (``items_discarded``);
        reported so the user can re-import after the orders file.
      * **Order detail present** → create the order transaction, match + exclude + link the card charge.
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

    # Items file rows whose order was never imported: no order transaction to enrich. Discard (reported;
    # the user re-imports once the orders file is in). Nothing incomplete enters the ledger.
    if not order.has_order_detail:
        return {"order_id": order.order_id, "status": "items_discarded"}

    disposition = classify_order(order)
    # Bare-card orders: let the ledger settle the undisclosed card/points split before honoring
    # non-cash. (The probe finds the same unique charge _match_charge then links — one extra read.)
    disposition = _resolve_bare_card_order(conn, order, account_id, disposition)
    owner_id = _account_owner(conn, account_id)
    non_cash = disposition.kind == "non_cash"

    # A cash order counts (its net cash, categorized by the user's rules); a non-cash order (points /
    # gift-card funded) is recorded in the excluded category so it doesn't inflate spending.
    category_id = find_or_create_funding_category(conn) if non_cash else None
    order_txn_id = _create_order_txn(
        conn, order, disposition.net_cash,
        account_id=account_id, owner_id=owner_id, batch_id=batch_id, category_id=category_id,
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
    for row in rows:
        source_text = source_match_text_from_json(row["import_evidence_json"]) if needs_source_text else None
        result = categorize_transaction(
            row["merchant_name"], row["raw_name"], row["display_name"], row["amount"], conn,
            owner_id=row["owner_id"], account_id=row["account_id"],
            rules=rules, rule_tags_by_id=rule_tags_by_id, source_text=source_text,
        )
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


def run_amazon_import(
    conn: sqlite3.Connection,
    orders: list[AmazonOrder],
    *,
    account_id: str,
    filename: str = "amazon.csv",
    apply_categorization: bool = True,
    file_hashes: Optional[list[dict]] = None,
) -> dict:
    """Create an import batch and apply every parsed order into it. Returns a summary with the batch id,
    the per-outcome counts (orders imported, charges matched, item-files enriched, items discarded,
    already applied), and the instruments seen with their funding-map state. When ``apply_categorization``
    is set (the default), the user's category rules are run over the newly-created order rows.
    ``file_hashes`` (``{filename, hash}`` per taken file) is persisted so a later upload of the same file is
    recognized and skipped (see ``_imported_amazon_file_hashes``)."""
    batch_id = str(uuid.uuid4())
    conn.execute(
        "INSERT INTO import_batch (id, filename, status, source_kind) VALUES (?, ?, 'completed', ?)",
        (batch_id, filename, BATCH_SOURCE_KIND),
    )
    counts = {"orders_imported": 0, "non_cash": 0, "charges_matched": 0,
              "items_enriched": 0, "already_enriched": 0, "items_discarded": 0, "already_applied": 0}
    # Investigable detail for the import-detail report: item rows that enriched an order (which usually lives
    # in the orders file's batch, so they can't be found from this batch's transactions), item rows whose
    # order was already enriched, item rows with no matching order (discarded), and orders already imported —
    # each with the file it came from.
    enriched_items: list[dict] = []
    already_enriched_items: list[dict] = []
    discarded_items: list[dict] = []
    duplicate_orders: list[dict] = []
    # Distinct instruments seen this run, keyed on (last4, network), each carrying its current map state
    # so the UI can prompt to map the ones that are still `unmapped`.
    instruments: dict[tuple, dict] = {}
    # Outcome kinds per source file, driving two decisions below: a file with any *discarded* rows keeps its
    # hash un-persisted (so it can be re-imported once the missing orders file is in), and a file that was
    # *only* discards is listed in `skipped_files` (nothing loaded — the card strikes it through).
    file_outcomes: dict[str, set] = {}

    def _note_outcome(source_file, kind):
        if source_file:
            file_outcomes.setdefault(source_file, set()).add(kind)

    for order in orders:
        result = apply_amazon_order(conn, order, account_id=account_id, batch_id=batch_id)
        status = result["status"]
        if status == "already_applied":
            counts["already_applied"] += 1
            duplicate_orders.append({"order_id": order.order_id, "date": order.order_date, "source_file": order.source_file})
            _note_outcome(order.source_file, "already")
            continue
        if status in ("enriched", "already_enriched"):
            bucket = "items_enriched" if status == "enriched" else "already_enriched"
            counts[bucket] += 1
            detail = {"order_id": order.order_id, "txn_id": result.get("enriched_txn_id"),
                      "description": _order_label(order), "source_file": order.source_file}
            (enriched_items if status == "enriched" else already_enriched_items).append(detail)
            _note_outcome(order.source_file, "enriched" if status == "enriched" else "already")
            continue
        # Items file rows with no imported order to attach to — discarded, not staged (re-import later).
        if status == "items_discarded":
            counts["items_discarded"] += 1
            discarded_items.append({"order_id": order.order_id, "description": _order_label(order),
                                    "date": order.order_date, "source_file": order.source_file})
            _note_outcome(order.source_file, "discarded")
            continue
        _note_outcome(order.source_file, "taken")
        inst = result.get("instrument")
        if inst:
            key = (inst["last4"], inst["network"])
            instruments.setdefault(key, {**inst, "state": result.get("funding_state") or "unmapped"})
        if result.get("charge_linked"):
            counts["charges_matched"] += 1
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

    total = len(orders)
    conn.execute(
        "UPDATE import_batch SET row_count = ? WHERE id = ?",
        (counts["orders_imported"] + counts["non_cash"], batch_id),
    )
    # A file with any discarded rows stays re-importable (its hash is NOT persisted): once the missing
    # orders file is in, a re-import attaches the previously-discarded items (the rest no-op). A file whose
    # rows were *only* discards loaded nothing at all → listed so the card can strike it through.
    files_with_discards = {f for f, kinds in file_outcomes.items() if "discarded" in kinds}
    skipped_files = sorted(f for f, kinds in file_outcomes.items() if kinds == {"discarded"})
    persistable_hashes = [f for f in (file_hashes or []) if f.get("filename") not in files_with_discards]

    # Persist the outcome + investigable detail so the file card and the import-detail report can show it on
    # a later page load (the counts otherwise live only in this return value → the live completion screen).
    conn.execute(
        "UPDATE import_batch SET config_snapshot = ? WHERE id = ?",
        (json.dumps({IMPORT_SUMMARY_KEY: {**counts,
                                          "enriched_items": enriched_items,
                                          "already_enriched_items": already_enriched_items,
                                          "discarded_items": discarded_items,
                                          "duplicate_orders": duplicate_orders,
                                          "skipped_files": skipped_files},
                     # Per-file content hashes (kept out of import_summary — provenance, not outcome), so a
                     # re-uploaded file is recognized and skipped instead of re-processed as all-duplicates.
                     "amazon_file_hashes": persistable_hashes}), batch_id),
    )
    return {
        "batch_id": batch_id,
        "order_count": total,
        "counts": counts,
        # Instruments seen this run with their current map state, so the UI can prompt to map the unmapped
        # ones inline (already-mapped/untracked resolve silently).
        "instruments": list(instruments.values()),
    }


_REVERSE_SCAN_WINDOW_DAYS = 7
# Ledger charge whose payee looks like Amazon (the reverse scan is heuristic by design — see doc).
_AMAZON_NAME_LIKE = "(UPPER(t.merchant_name) LIKE '%AMZN%' OR UPPER(t.merchant_name) LIKE '%AMAZON%' " \
                    "OR UPPER(t.raw_name) LIKE '%AMZN%' OR UPPER(t.raw_name) LIKE '%AMAZON%')"

# Split-charge suggestion (Matched·review): Amazon often bills one order as several shipment charges, so no
# single charge equals the order total. We look for a *unique* set of unaccounted charges — at most this many
# parts, within this many days of the order, summing to the order total within this tolerance — and surface
# it for the user to Accept/Dismiss. A wider window than the auto-matcher's ±3 since the user confirms each.
_SPLIT_SUGGESTION_WINDOW_DAYS = 14
_SPLIT_SUGGESTION_MAX_PARTS = 4
_SPLIT_SUGGESTION_TOLERANCE = 0.02


def _txn_summary(conn: sqlite3.Connection, txn_id: str) -> Optional[dict]:
    row = conn.execute(
        """SELECT t.id, t.date, t.amount, t.display_name, t.merchant_name, t.raw_name, t.account_id,
                  t.category_source, t.imported_category, t.import_evidence_json,
                  a.display_name AS account_name,
                  t.import_batch_id           AS source_batch_id,
                  ib.filename                 AS source_filename,
                  ib.imported_at              AS source_imported_at
           FROM   txn t
           JOIN   account a ON a.id = t.account_id
           LEFT   JOIN import_batch ib ON ib.id = t.import_batch_id
           WHERE  t.id = ?""",
        (txn_id,),
    ).fetchone()
    if not row:
        return None
    # Provenance: where this charge came from, so the reconciliation report can show "from <file>" on
    # hover (and, with a drill-through handler, open that file's ledger). Absent for non-imported rows.
    source = None
    if row["source_filename"]:
        source = {
            "batchId": row["source_batch_id"],
            "filename": row["source_filename"],
            "importedAt": row["source_imported_at"],
        }
    return {
        "id": row["id"], "date": row["date"], "amount": row["amount"],
        "name": row["display_name"] or row["merchant_name"],
        "account_id": row["account_id"], "account": row["account_name"],
        "source": source,
        # Full origin fields, keyed as the ledger's origin-fields hover card (importSourceFields.js) expects,
        # so the report can render the same rich "where did this come from" detail on hover.
        "display_name": row["display_name"],
        "merchant_name": row["merchant_name"],
        "raw_name": row["raw_name"],
        "category_source": row["category_source"],
        "imported_category": row["imported_category"],
        "import_evidence_json": row["import_evidence_json"],
        "import_batch_filename": row["source_filename"],
        "import_batch_imported_at": row["source_imported_at"],
    }


def _charge_accounts(conn: sqlite3.Connection, seed_accounts) -> set:
    """The accounts Amazon charges land on: the given seed (this batch's matched-charge accounts) plus every
    globally-mapped funding account. The shared search space for the reverse scan and duplicate detection."""
    accounts = set(seed_accounts)
    for r in conn.execute(
        "SELECT DISTINCT funding_account_id FROM amazon_funding_map WHERE funding_account_id IS NOT NULL"
    ).fetchall():
        accounts.add(r["funding_account_id"])
    return {a for a in accounts if a}


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
    Copies of one real charge (bank post-date vs. an aggregator's date) land on the *same account* with
    the *same amount* a day or three apart — so cluster by (account, rounded amount) with dates chained
    within the matcher's ±3-day window. Clusters of 2+ become Unaccounted·duplicate groups for per-row
    review (same-amount-nearby is weaker evidence than an order-anchored duplicate — repeated same-price
    purchases are real); the rest stay informational. Pairs the user has declared **Not duplicates**
    (``amazon_charge_distinct``) never chain, so the assertion sticks across refreshes. Cross-account
    copies are deliberately not paired here — that's the unified duplicates system's job, with its
    keep/reject account-pair semantics. Returns ``(singles, groups)``; groups carry ``{"charges": [...]}``."""
    distinct = _distinct_charge_pairs(conn, [c["id"] for c in charges])
    by_key: dict[tuple, list[dict]] = {}
    for c in charges:
        by_key.setdefault((c.get("account_id"), round(c.get("amount") or 0, 2)), []).append(c)
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
        the matcher's window, so auto-matching bailed on the ambiguity (or a matched charge that has an extra
        duplicate copy). Carries every copy (``charges`` with a ``matched`` flag) so the user can trash the
        redundant one, which then lets the order match. The common Mint-double-import case.
      * **duplicate_review**  — same shape, but the equal-amount copies only turn up in the *wider review
        window* (±14 days — outside the auto-matcher's ±3), so the dates don't corroborate the way an
        in-window duplicate's do. Kept out of the plain duplicate bucket so each copy gets eyeballed
        before Merge/Discard.
      * **amazon_unmatched**  — a cash order with *no* candidate charge at all (untracked card / a real miss);
        surfaced for a manual link.
      * **payment_unmatched** — Amazon-looking ledger charges the export didn't account for (reverse scan).
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

    matched, duplicate, duplicate_review, amazon_unmatched, matched_review = [], [], [], [], []
    unmatched_candidates = []   # (link_id, meta, order): cash orders with no charge — try split suggestions
    for link_id, meta, order, charge_ids in order_rows:
        # The order's eligible charges beyond any it already links — the matcher's own candidate set (respects
        # last-4 / funding map, empty for an untracked card), so "duplicate" means exactly what blocked a match.
        candidates = _order_charge_candidates(conn, meta, order)
        if charge_ids:
            # A matched charge that *also* has extra eligible duplicate copies → surface the redundancy —
            # unless the user marked the whole group Not duplicates (the extras are distinct purchases),
            # in which case the match stands clean and the extras stay in the reverse scan.
            if candidates and not _charges_marked_distinct(conn, [charge_ids[0], *candidates]):
                charges = [_charge_entry(charge_ids[0], is_matched=True, link_id=link_id)]
                for sid in candidates:
                    charges.append(_charge_entry(sid, is_matched=False, link_id=link_id))
                    consumed.add(sid)
                duplicate.append({"link_id": link_id, "order": order, "charges": charges,
                                  "mergeable": _is_mergeable(meta, has_charge=True)})
            else:
                # A matched order carries every charge it links — usually one, several for an accepted split.
                matched.append({"link_id": link_id, "order": order,
                                "charges": [_txn_summary(conn, cid) for cid in charge_ids]})
        elif meta.get("disposition") == "cash":
            if len(candidates) >= 2 and not _charges_marked_distinct(conn, candidates):
                charges = []
                for cid in candidates:
                    charges.append(_charge_entry(cid, is_matched=False, link_id=link_id))
                    consumed.add(cid)
                duplicate.append({"link_id": link_id, "order": order, "charges": charges,
                                  "mergeable": _is_mergeable(meta, has_charge=False)})
            elif len(candidates) >= 2:
                # Every pair marked Not duplicates: distinct purchases, not copies — so no duplicate row.
                # The order still can't auto-match (distinctness doesn't say which charge is *its* match);
                # it falls to the suggestion pass, whose exact-date tie-break may still nominate one.
                unmatched_candidates.append((link_id, meta, order, candidates))
            else:
                # Under two eligible copies in the strict window — check the wider review window before
                # giving up: equal-amount copies out there are still likely a double import, but the dates
                # don't corroborate, so they get their own review bucket (never the plain duplicate one).
                wide = _order_charge_candidates(conn, meta, order, window_days=_SPLIT_SUGGESTION_WINDOW_DAYS)
                if len(wide) >= 2 and not _charges_marked_distinct(conn, wide):
                    charges = []
                    for cid in wide:
                        charges.append(_charge_entry(cid, is_matched=False, link_id=link_id))
                        consumed.add(cid)
                    duplicate_review.append({"link_id": link_id, "order": order, "charges": charges,
                                             "mergeable": _is_mergeable(meta, has_charge=False)})
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
            amazon_unmatched.append({"link_id": link_id, "order": order})

    # ±7-day informational scan, minus anything shown in a duplicate group or consumed by a suggestion —
    # then carve out same-account same-amount near-date clusters as suspected double imports.
    unaccounted, unaccounted_duplicate = _group_unaccounted_duplicates(
        conn, _reverse_scan(conn, order_dates, charge_accounts, consumed))
    return {
        "matched": matched,
        "matched_review": matched_review,
        "duplicate": duplicate,
        "duplicate_review": duplicate_review,
        "amazon_unmatched": amazon_unmatched,
        "payment_unmatched": unaccounted,
        "unaccounted_duplicate": unaccounted_duplicate,
    }


def reconciliation_attention_count(conn: sqlite3.Connection, batch_id: str) -> int:
    """How many of a batch's orders need the user to *act* — a duplicate charge to merge/discard, or a
    Matched·review split suggestion to accept/dismiss. Powers the import card's warning tint and the Tasks
    nag. Deliberately excludes plain 'No charge found' (usually an untracked card / pre-coverage gap with
    nothing to resolve, so it would nag forever). Reuses the on-demand reconciliation."""
    recon = amazon_reconciliation(conn, batch_id)
    return (len(recon["duplicate"]) + len(recon["duplicate_review"])
            + len(recon["matched_review"]) + len(recon["unaccounted_duplicate"]))


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
        "duplicate_orders": summary.get("duplicate_orders") or [],
        "payments": payments,
    }


@router.get("/amazon/import-detail/{batch_id}")
async def amazon_import_detail_endpoint(batch_id: str):
    """The import-detail report for one Amazon batch (orders / items matched / discarded / duplicates / payments)."""
    with get_db() as conn:
        if not conn.execute("SELECT 1 FROM import_batch WHERE id = ?", (batch_id,)).fetchone():
            raise HTTPException(status_code=404, detail="Unknown batch")
        return amazon_import_detail(conn, batch_id)


def link_amazon_charges(conn: sqlite3.Connection, link_id: str, charge_txn_ids) -> dict:
    """Hand-reconcile an unmatched order to one *or more* card charges — one for a plain manual link, several
    when a split order was paid as multiple shipment charges (see the reconciliation's Matched·review
    suggestion). For each charge: do exactly what the auto-matcher does — exclude it (recategorize into the
    Amazon Funding category, prior categorization stashed **per charge** in ``charge_priors`` for undo) and
    add it as a ``charge`` member. Reversal flows through the batch-undo path via those stashed priors.

    Guarded: the link must be an Amazon order that has no charge yet, and no charge may already belong to
    another Amazon link (so one action can't double-exclude or steal a linked charge)."""
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
    meta["charge_priors"] = priors
    meta["charge_linked_manually"] = True
    meta.pop("split_suggestion_dismissed", None)   # the order is reconciled now — clear any stale dismissal
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
             int(prior.get("category_overridden") or 0), charge_id),
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


def _pair_equal_amount_clusters(conn: sqlite3.Connection, batch_id: str) -> int:
    """Second pass over a batch's still-unmatched cash orders: when a set of same-amount orders is exactly
    balanced by the same number of unlinked Amazon charges (in the matcher's window), they're *distinct*
    purchases the matcher only left unmatched because their equal amounts made *which* order pairs with
    *which* charge ambiguous — and that assignment is immaterial (each charge is excluded either way). Pair
    them 1:1 by date so they resolve to matched instead of showing as false 'duplicate detected'. A *surplus*
    of charges (more charges than orders) is a real duplicate and is deliberately left alone. Returns the
    number of orders newly paired."""
    clusters: dict = {}
    for o in _unmatched_cash_orders(conn, batch_id):
        clusters.setdefault(round(o["amount"], 2), []).append(o)

    paired = 0
    for group in clusters.values():
        pairable_orders: list[dict] = []   # only orders that actually have an eligible charge count toward balance
        candidate_ids: list[str] = []
        seen: set = set()
        for o in group:
            cands = _order_charge_candidates(conn, o["meta"], o["order"])
            if not cands:
                continue   # untracked / last-4 mismatch: this order can't take any of these charges
            pairable_orders.append(o)
            for cid in cands:
                if cid not in seen:
                    seen.add(cid)
                    candidate_ids.append(cid)
        if candidate_ids and len(candidate_ids) == len(pairable_orders):
            ordered_orders = sorted(pairable_orders, key=lambda g: g["order"]["date"] or "")
            ordered_charges = sorted(candidate_ids, key=lambda cid: (_txn_summary(conn, cid) or {}).get("date") or "")
            for o, charge_id in zip(ordered_orders, ordered_charges):
                manual_link_charge(conn, o["link_id"], charge_id)
                paired += 1
    return paired


def _order_batch_id(conn: sqlite3.Connection, link_id: str) -> Optional[str]:
    order_ids = txn_links.member_txn_ids(conn, link_id, role="order")
    if not order_ids:
        return None
    row = conn.execute("SELECT import_batch_id FROM txn WHERE id = ?", (order_ids[0],)).fetchone()
    return row["import_batch_id"] if row else None


def trash_duplicate_charge(conn: sqlite3.Connection, charge_txn_id: str,
                           order_link_id: Optional[str] = None) -> dict:
    """Discard one duplicate copy from the reconciliation report, then let the order match. If the trashed
    copy was the order's *linked* charge, detach + restore it first; then re-run the equal-count pairing pass
    for the batch so the now-balanced cluster (e.g. one order, one surviving charge) links up. Returns
    ``status`` plus whether the order matched as a result."""
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

    # Tagged like a merge loser (minus the kept-copy pointer, which a per-copy discard doesn't always
    # know) so the Trash page groups it under import reconciliation rather than manual deletes.
    conn.execute(
        """UPDATE txn SET trashed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                          rejection_reason = 'duplicate_confirmed',
                          dedupe_resolved_by = 'amazon_discard'
           WHERE id = ?""",
        (charge_txn_id,),
    )

    matched = False
    if link:
        batch_id = _order_batch_id(conn, order_link_id)
        if batch_id:
            _pair_equal_amount_clusters(conn, batch_id)
            matched = bool(txn_links.member_txn_ids(conn, order_link_id, role="charge"))
    return {"status": "trashed", "matched": matched}


class TrashDuplicateChargeRequest(BaseModel):
    charge_txn_id: str
    order_link_id: Optional[str] = None


@router.post("/amazon/trash-duplicate-charge")
async def amazon_trash_duplicate_charge_endpoint(body: TrashDuplicateChargeRequest):
    """Trash one duplicate card charge from the reconciliation report, re-matching the order if it's now
    unambiguous."""
    with get_db() as conn:
        try:
            return trash_duplicate_charge(conn, body.charge_txn_id, body.order_link_id)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))


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
    window = _SPLIT_SUGGESTION_WINDOW_DAYS if review_window else _CHARGE_DATE_WINDOW_DAYS
    copies = list(dict.fromkeys(
        list(linked) + _order_charge_candidates(conn, link.get("metadata") or {}, order, window_days=window)
    ))
    if len(copies) < 2:
        raise ValueError("Nothing to merge")

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
        """UPDATE txn SET trashed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                          suspect_duplicate_of = ?,
                          rejection_reason = 'duplicate_confirmed',
                          dedupe_resolved_by = 'amazon_merge'
           WHERE id = ?""",
        (survivor_id, loser_id),
    )


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
    if len({r["account_id"] for r in rows}) != 1 or len({round(r["amount"], 2) for r in rows}) != 1:
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


class MergeUnaccountedChargesRequest(BaseModel):
    charge_txn_ids: list[str]


@router.post("/amazon/merge-unaccounted-charges")
async def amazon_merge_unaccounted_charges_endpoint(body: MergeUnaccountedChargesRequest):
    """Merge an unaccounted duplicate-charge group into its richest copy (trashing the rest)."""
    with get_db() as conn:
        try:
            return merge_unaccounted_charges(conn, body.charge_txn_ids)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))


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


def reverse_batch_amazon_links(conn: sqlite3.Connection, batch_id: str) -> int:
    """Undo the Amazon links a batch created, restoring each matched charge's prior category from the
    link metadata and deleting the link. Mirrors `reverse_batch_enrichments`: it must run *before* the
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
        link = txn_links.get_link(conn, link_id)
        meta = (link.get("metadata") or {}) if link else {}
        for charge_id in txn_links.member_txn_ids(conn, link_id, role="charge"):
            prior = _charge_prior_for(meta, charge_id)
            if prior:
                conn.execute(
                    "UPDATE txn SET category_id = ?, category_source = ?, category_overridden = ? WHERE id = ?",
                    (prior.get("category_id"), prior.get("category_source"),
                     int(prior.get("category_overridden") or 0), charge_id),
                )
        txn_links.delete_link(conn, link_id)
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


async def _read_amazon_uploads(files, known_hashes: "set | frozenset" = frozenset()):
    """Decode + parse the uploaded AZAD files into
    ``(orders, items_by_order, names, unrecognized, already_imported, file_hashes)``. Shared by the scan and
    import endpoints; files are sniffed by header, so upload order and file names don't matter.

    Each file is content-hashed: one whose hash is in ``known_hashes`` (a file a completed import already
    took — or a second copy earlier in this same upload) is **skipped** and listed in ``already_imported``,
    so a re-import reports "already imported" instead of producing a confusing all-duplicates batch (the
    file already has its card). ``file_hashes`` carries ``{filename, hash}`` for the files actually taken,
    for the batch to persist; ``names`` likewise lists only the files taken."""
    orders: list[AmazonOrder] = []
    items_by_order: dict[str, list[AmazonItem]] = {}
    names: list[str] = []
    unrecognized: list[str] = []
    already_imported: list[str] = []
    file_hashes: list[dict] = []
    seen_hashes: set = set(known_hashes)
    for upload in files:
        content = await upload.read()
        try:
            text = content.decode("utf-8-sig")
        except UnicodeDecodeError:
            text = content.decode("latin-1")
        filename = upload.filename or "amazon.csv"
        content_hash = make_import_file_hash(text)
        if content_hash in seen_hashes:
            already_imported.append(filename)
            continue
        kind, rows = read_export(text)
        # Tag each parsed row with the file it came from so the import-detail report can answer
        # "which file did this order / discarded item come from?".
        if kind == "orders":
            parsed = parse_order_rows(rows)
            for order in parsed:
                order.source_file = filename
            orders.extend(parsed)
        elif kind == "items":
            for order_id, items in parse_item_rows(rows).items():
                for item in items:
                    item.source_file = filename
                items_by_order.setdefault(order_id, []).extend(items)
        else:
            unrecognized.append(upload.filename or "(unnamed)")
            continue
        names.append(filename)
        seen_hashes.add(content_hash)
        file_hashes.append({"filename": filename, "hash": content_hash})
    return orders, items_by_order, names, unrecognized, already_imported, file_hashes


def _imported_amazon_file_hashes(conn: sqlite3.Connection) -> set:
    """Content hashes of every file a *completed* Amazon import has taken (persisted per batch in the config
    snapshot — an undone batch's files can be re-imported). Batches imported before hashing existed simply
    aren't listed, so their files aren't skipped."""
    hashes: set = set()
    rows = conn.execute(
        "SELECT config_snapshot FROM import_batch WHERE source_kind = ? AND status = 'completed'",
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
                hashes.add(f["hash"])
    return hashes


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
        if funding.state == "mapped" and funding.funding_account_id:
            row = conn.execute(
                "SELECT display_name, name FROM account WHERE id = ?", (funding.funding_account_id,)
            ).fetchone()
            if row:
                account_name = row["display_name"] or row["name"]
        seen[key] = {**inst, "state": funding.state,
                     "funding_account_id": funding.funding_account_id, "funding_account_name": account_name}
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
    orders, items_by_order, names, unrecognized, already_imported, _hashes = await _read_amazon_uploads(files, known)
    with get_db() as conn:
        instruments = _scan_instruments(conn, orders, account_id)
    return {
        "instruments": instruments,
        "order_count": len(orders),
        "has_items": bool(items_by_order),
        "names": names,
        "unrecognized_files": unrecognized,
        "already_imported_files": already_imported,
    }


@router.post("/amazon/import")
async def amazon_import_endpoint(
    files: list[UploadFile] = File(...),
    account_id: str = Form(...),
    apply_categorization: bool = Form(True),
):
    """Import one or both AZAD exports (orders + items) into the chosen Amazon account. Files are
    sniffed by header, so upload order doesn't matter and either file alone is accepted (degrading as
    documented). This endpoint owns only the HTTP/multipart envelope and the demo guard; the work is
    :func:`run_amazon_import`, kept callable in-process."""
    with get_db() as conn:
        if is_demo_data_loaded(conn):
            raise HTTPException(status_code=409, detail={
                "code": "demo_data_loaded",
                "message": "Clear the demo data before importing your own data.",
            })
        known = _imported_amazon_file_hashes(conn)

    orders, items_by_order, names, unrecognized, already_imported, file_hashes = await _read_amazon_uploads(files, known)
    if not orders and not items_by_order:
        if already_imported:
            # Every usable file was already imported — nothing to do, and deliberately *no new batch* (the
            # files already have their cards). The completion screen reports it from this summary.
            return {"batch_id": None, "order_count": 0, "counts": {}, "instruments": [],
                    "already_imported_files": already_imported, "unrecognized_files": unrecognized}
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
    summary["already_imported_files"] = already_imported
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
    """The category the matched card charge is recategorized into (global setting; see the Amazon tab)."""
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
    from the link metadata, and delete the link. Safe to call once per link."""
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
                 int(prior.get("category_overridden") or 0), charge_id),
            )
    # Delete the link first so its members' FK rows go, then the order transaction itself.
    txn_links.delete_link(conn, link_id)
    for order_id in order_ids:
        conn.execute("DELETE FROM txn WHERE id = ?", (order_id,))
    return {"status": "reversed", "orders_removed": len(order_ids), "charges_restored": len(charge_ids)}
