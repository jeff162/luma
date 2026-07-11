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

import json
import sqlite3
import uuid
from typing import Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from backend.db.database import get_db, get_tenant_workflow_state, set_tenant_workflow_state
from backend.services import amazon_funding, txn_links
from backend.services.amazon_import import (
    AmazonItem,
    AmazonOrder,
    classify_order,
    merge,
    parse_item_rows,
    parse_order_rows,
    read_export,
)

from .core import _insert_imported_transaction, is_demo_data_loaded, make_hash

router = APIRouter()

LINK_KIND = "amazon_order"
# Import-batch provenance marker (import_batch.source_kind) so the import history groups Amazon batches
# under an "Amazon" entry rather than "unknown data source". Vendor-qualified for future marketplaces.
BATCH_SOURCE_KIND = "marketplace:amazon"
AMAZON_FUNDING_CATEGORY = "Amazon Funding"
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
    clauses = [
        "t.trashed_at IS NULL",
        "ROUND(t.amount, 2) = ?",
        "NOT EXISTS (SELECT 1 FROM txn_link_member m WHERE m.txn_id = t.id)",
    ]
    params: list = [round(disposition.charge_amount, 2)]
    if exclude_account_id:
        clauses.append("t.account_id != ?")
        params.append(exclude_account_id)
    if disposition.match_date:
        clauses.append("ABS(julianday(t.date) - julianday(?)) <= ?")
        params += [disposition.match_date, _CHARGE_DATE_WINDOW_DAYS]
    if restrict_account_id:
        clauses.append("t.account_id = ?")
        params.append(restrict_account_id)
    elif disposition.match_last4:
        clauses.append("(COALESCE(p.mask, a.mask) = ? OR COALESCE(p.mask, a.mask) IS NULL OR COALESCE(p.mask, a.mask) = '')")
        params.append(disposition.match_last4)
    rows = conn.execute(
        f"""SELECT t.id
            FROM   txn t
            JOIN   account a ON a.id = t.account_id
            LEFT   JOIN account p ON p.id = a.parent_account_id
            WHERE  {' AND '.join(clauses)}
            LIMIT  2""",
        params,
    ).fetchall()
    return rows[0]["id"] if len(rows) == 1 else None


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
    evidence = {"extra_text_fields": extra}
    summary = order.items_summary or "; ".join(i.description for i in order.items if i.description)
    if summary:
        evidence["description"] = {"header": "Items", "value": summary}
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

      * **Order already linked** → if this import also carries item detail, fold that detail into the
        existing order transaction's evidence (``enriched``); otherwise a no-op (``already_applied``).
        The card charge is matched once, at first import — a mapping added later is not applied
        retroactively (like the category setting, it affects future imports only).
      * **Items-only, no existing order** → nothing to attach to, so it's discarded (``items_discarded``);
        reported so the user can re-import after the orders file.
      * **Order detail present** → create the order transaction, match + exclude + link the card charge.
    """
    existing = txn_links.find_link(conn, LINK_KIND, order.order_id)
    if existing:
        if order.has_item_detail and order.items:
            enriched = _enrich_order_txn(conn, existing, order)
            return {"order_id": order.order_id, "status": "enriched" if enriched else "already_applied"}
        return {"order_id": order.order_id, "status": "already_applied"}

    # Items file rows whose order was never imported: no order transaction to enrich. Discard (reported;
    # the user re-imports once the orders file is in). Nothing incomplete enters the ledger.
    if not order.has_order_detail:
        return {"order_id": order.order_id, "status": "items_discarded"}

    disposition = classify_order(order)
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


def _enrich_order_txn(conn: sqlite3.Connection, link: dict, order: AmazonOrder) -> bool:
    """Fold a later items file's per-item detail into an already-imported order transaction's evidence.
    Idempotent: if the order transaction already carries item detail (a prior items import), it's a
    no-op. Returns whether anything was added."""
    order_txn_ids = [m["txn_id"] for m in link.get("members", []) if m["role"] == "order"]
    if not order_txn_ids:
        return False
    txn_id = order_txn_ids[0]
    row = conn.execute("SELECT import_evidence_json FROM txn WHERE id = ?", (txn_id,)).fetchone()
    if not row:
        return False
    try:
        evidence = json.loads(row["import_evidence_json"]) if row["import_evidence_json"] else {}
    except (TypeError, ValueError):
        evidence = {}
    existing_fields = evidence.get("extra_text_fields") or []
    if any((f.get("header") == "Item") for f in existing_fields):
        return False  # already enriched with item detail
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
    return True


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
) -> dict:
    """Create an import batch and apply every parsed order into it. Returns a summary with the batch id,
    the per-outcome counts (orders imported, charges matched, item-files enriched, items discarded,
    already applied), and the instruments seen with their funding-map state. When ``apply_categorization``
    is set (the default), the user's category rules are run over the newly-created order rows."""
    batch_id = str(uuid.uuid4())
    conn.execute(
        "INSERT INTO import_batch (id, filename, status, source_kind) VALUES (?, ?, 'completed', ?)",
        (batch_id, filename, BATCH_SOURCE_KIND),
    )
    counts = {"orders_imported": 0, "non_cash": 0, "charges_matched": 0,
              "items_enriched": 0, "items_discarded": 0, "already_applied": 0}
    # Distinct instruments seen this run, keyed on (last4, network), each carrying its current map state
    # so the UI can prompt to map the ones that are still `unmapped`.
    instruments: dict[tuple, dict] = {}
    for order in orders:
        result = apply_amazon_order(conn, order, account_id=account_id, batch_id=batch_id)
        status = result["status"]
        if status == "already_applied":
            counts["already_applied"] += 1
            continue
        if status == "enriched":
            counts["items_enriched"] += 1
            continue
        # Items file rows with no imported order to attach to — discarded, not staged (re-import later).
        if status == "items_discarded":
            counts["items_discarded"] += 1
            continue
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

    if apply_categorization:
        _categorize_batch_orders(conn, batch_id)

    total = len(orders)
    conn.execute(
        "UPDATE import_batch SET row_count = ? WHERE id = ?",
        (counts["orders_imported"] + counts["non_cash"], batch_id),
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


def _txn_summary(conn: sqlite3.Connection, txn_id: str) -> Optional[dict]:
    row = conn.execute(
        """SELECT t.id, t.date, t.amount, t.display_name, t.merchant_name, t.account_id,
                  a.display_name AS account_name
           FROM   txn t JOIN account a ON a.id = t.account_id WHERE t.id = ?""",
        (txn_id,),
    ).fetchone()
    if not row:
        return None
    return {
        "id": row["id"], "date": row["date"], "amount": row["amount"],
        "name": row["display_name"] or row["merchant_name"],
        "account_id": row["account_id"], "account": row["account_name"],
    }


def _reverse_scan(conn, order_dates: list[str], seed_accounts: set) -> list[dict]:
    """The payment side of the reconciliation: ledger charges that *look* like Amazon on the cards Amazon
    charges (this batch's matched-charge accounts plus every globally-mapped funding account), within the
    batch's date range, that no Amazon order is linked to. Purely informational — the user may have bought
    something the export missed, or it may be a name that merely resembles Amazon (hence heuristic)."""
    dates = [d for d in order_dates if d]
    if not dates:
        return []
    accounts = set(seed_accounts)
    for r in conn.execute(
        "SELECT DISTINCT funding_account_id FROM amazon_funding_map WHERE funding_account_id IS NOT NULL"
    ).fetchall():
        accounts.add(r["funding_account_id"])
    accounts = {a for a in accounts if a}
    if not accounts:
        return []
    placeholders = ",".join("?" * len(accounts))
    rows = conn.execute(
        f"""SELECT t.id
            FROM   txn t
            WHERE  t.account_id IN ({placeholders})
              AND  t.trashed_at IS NULL
              AND  t.amount > 0
              AND  date(t.date) BETWEEN date(?, '-{_REVERSE_SCAN_WINDOW_DAYS} days')
                                   AND date(?, '+{_REVERSE_SCAN_WINDOW_DAYS} days')
              AND  {_AMAZON_NAME_LIKE}
              AND  NOT EXISTS (SELECT 1 FROM txn_link_member m WHERE m.txn_id = t.id)
            ORDER BY t.date""",
        [*accounts, min(dates), max(dates)],
    ).fetchall()
    return [_txn_summary(conn, r["id"]) for r in rows]


def amazon_reconciliation(conn: sqlite3.Connection, batch_id: str) -> dict:
    """Reconcile the Amazon orders imported in a batch against the ledger's card charges, for the
    reconciliation report. Three buckets: **matched** (order ↔ the card charge it excluded), **amazon
    unmatched** (a cash order whose card charge wasn't found — surfaced for a manual link), and **payment
    unmatched** (Amazon-looking ledger charges the export didn't account for — the reverse scan)."""
    links = conn.execute(
        """SELECT DISTINCT l.id
           FROM   txn_link l
           JOIN   txn_link_member m ON m.link_id = l.id
           JOIN   txn t ON t.id = m.txn_id
           WHERE  l.kind = ? AND m.role = 'order' AND t.import_batch_id = ?""",
        (LINK_KIND, batch_id),
    ).fetchall()

    matched, amazon_unmatched = [], []
    order_dates: list[str] = []
    charge_accounts: set = set()
    for lk in links:
        link = txn_links.get_link(conn, lk["id"])
        meta = link.get("metadata") or {}
        order_ids = txn_links.member_txn_ids(conn, lk["id"], role="order")
        charge_ids = txn_links.member_txn_ids(conn, lk["id"], role="charge")
        order = _txn_summary(conn, order_ids[0]) if order_ids else None
        if order and order["date"]:
            order_dates.append(order["date"])
        if charge_ids:
            charge = _txn_summary(conn, charge_ids[0])
            if charge:
                charge_accounts.add(charge["account_id"])
            matched.append({"link_id": lk["id"], "order": order, "charge": charge})
        elif meta.get("disposition") == "cash":
            amazon_unmatched.append({"link_id": lk["id"], "order": order})

    return {
        "matched": matched,
        "amazon_unmatched": amazon_unmatched,
        "payment_unmatched": _reverse_scan(conn, order_dates, charge_accounts),
    }


@router.get("/amazon/reconciliation/{batch_id}")
async def amazon_reconciliation_endpoint(batch_id: str):
    """The reconciliation report for one Amazon import batch (matched / unmatched / reverse-scan)."""
    with get_db() as conn:
        if not conn.execute("SELECT 1 FROM import_batch WHERE id = ?", (batch_id,)).fetchone():
            raise HTTPException(status_code=404, detail="Unknown batch")
        return amazon_reconciliation(conn, batch_id)


def manual_link_charge(conn: sqlite3.Connection, link_id: str, charge_txn_id: str) -> dict:
    """Hand-reconcile: attach a user-chosen card charge to an order that auto-matching couldn't pair,
    doing exactly what the auto-matcher does — exclude the charge (recategorize into the Amazon Funding
    category, prior categorization stashed for undo) and add it to the order's link as its ``charge``
    member. Reversal already flows through the batch-undo path via the stashed ``charge_prior``.

    Guarded: the link must be an Amazon order that has no charge yet, and the charge must not already
    belong to another Amazon link (so one manual click can't double-exclude or steal a linked charge)."""
    link = txn_links.get_link(conn, link_id)
    if not link or link.get("kind") != LINK_KIND:
        raise ValueError("Unknown Amazon order link")
    if txn_links.member_txn_ids(conn, link_id, role="charge"):
        raise ValueError("This order already has a linked charge")
    charge = conn.execute("SELECT id FROM txn WHERE id = ? AND trashed_at IS NULL", (charge_txn_id,)).fetchone()
    if not charge:
        raise ValueError("Unknown charge")
    already_linked = conn.execute(
        """SELECT 1 FROM txn_link_member m JOIN txn_link l ON l.id = m.link_id
           WHERE m.txn_id = ? AND l.kind = ?""",
        (charge_txn_id, LINK_KIND),
    ).fetchone()
    if already_linked:
        raise ValueError("That charge is already linked to an Amazon order")

    charge_prior = _exclude_charge(conn, charge_txn_id)
    txn_links.add_member(conn, link_id, charge_txn_id, "charge")
    meta = link.get("metadata") or {}
    meta["charge_prior"] = charge_prior
    meta["charge_linked_manually"] = True
    txn_links.set_metadata(conn, link_id, meta)
    return {"status": "linked"}


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
        prior = (link.get("metadata") or {}).get("charge_prior") if link else None
        for charge_id in txn_links.member_txn_ids(conn, link_id, role="charge"):
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


async def _read_amazon_uploads(files):
    """Decode + parse the uploaded AZAD files into ``(orders, items_by_order, names, unrecognized)``.
    Shared by the scan and import endpoints; files are sniffed by header, so upload order and file names
    don't matter."""
    orders: list[AmazonOrder] = []
    items_by_order: dict[str, list[AmazonItem]] = {}
    names: list[str] = []
    unrecognized: list[str] = []
    for upload in files:
        content = await upload.read()
        try:
            text = content.decode("utf-8-sig")
        except UnicodeDecodeError:
            text = content.decode("latin-1")
        kind, rows = read_export(text)
        names.append(upload.filename or "amazon.csv")
        if kind == "orders":
            orders.extend(parse_order_rows(rows))
        elif kind == "items":
            for order_id, items in parse_item_rows(rows).items():
                items_by_order.setdefault(order_id, []).extend(items)
        else:
            unrecognized.append(upload.filename or "(unnamed)")
    return orders, items_by_order, names, unrecognized


def _scan_instruments(conn, orders, account_id: Optional[str]) -> list[dict]:
    """The distinct payment cards the orders were paid with, each resolved against the funding map (using
    the chosen Amazon account for override resolution when given). Powers the pre-import "map these cards"
    step so a card is mapped *before* the import that needs it — the map is never applied retroactively."""
    seen: dict[tuple, dict] = {}
    for order in orders:
        if not order.has_order_detail:
            continue
        disposition = classify_order(order)
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
    current funding-map state), so the UI can get any unmapped card mapped up front. No ledger changes."""
    orders, items_by_order, names, unrecognized = await _read_amazon_uploads(files)
    with get_db() as conn:
        instruments = _scan_instruments(conn, orders, account_id)
    return {
        "instruments": instruments,
        "order_count": len(orders),
        "has_items": bool(items_by_order),
        "names": names,
        "unrecognized_files": unrecognized,
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

    orders, items_by_order, names, unrecognized = await _read_amazon_uploads(files)
    if not orders and not items_by_order:
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
            apply_categorization=apply_categorization,
        )
    summary["unrecognized_files"] = unrecognized
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

    prior = (link.get("metadata") or {}).get("charge_prior")
    for charge_id in charge_ids:
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
