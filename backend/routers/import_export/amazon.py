# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
The Amazon enrich-via-link engine: turn a parsed :class:`AmazonOrder` into ledger state.

This is the core business logic of the Amazon feature (see ``docs/backlog/paypal-amazon-enrichment.md``
→ "the account + link model"). Given one parsed order and a chosen Amazon account, it:

  * creates the order's items as first-class transactions in the Amazon account (categorized later by
    the normal rule pipeline — the Amazon taxonomy rides into evidence + ``imported_category``);
  * for a **cash** order, allocates the net cash charge (``charge − refund``) across those items by
    list-price weight, finds the matching card charge in the ledger, recategorizes it into the excluded
    "Amazon Funding" category, and **links** charge↔items — so the money counts once, on the itemized
    side (the charge's prior category is stashed in the link ``metadata`` for a clean undo);
  * for a **non-cash** order (points / gift-card funded), records the items *excluded* (not counted)
    and links them without a charge — surfaced for manual handling;
  * for a cash order whose card charge isn't in the ledger (untracked card), keeps the items counted as
    the sole record and links them without a charge.

It lives in the import package (not ``services/``) because it reuses the canonical imported-transaction
creator and hashing from :mod:`core`; the *pure* pieces (classification, allocation) live in
``services/amazon_import.py`` and are unit-tested without any ledger.
"""

from __future__ import annotations

import sqlite3
import uuid
from typing import Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from backend.db.database import get_db
from backend.services import amazon_funding, txn_links
from backend.services.amazon_import import (
    AmazonItem,
    AmazonOrder,
    allocate,
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


def find_or_create_funding_category(conn: sqlite3.Connection) -> str:
    """The excluded category the matched card charge is moved into. A leaf under the always-seeded
    ``Transfers`` group (which carries ``exclude_from_totals = 1``, and exclusion is evaluated as
    ``COALESCE(parent, leaf, 0)``), so the charge drops out of spending totals without a per-row flag."""
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


def _item_evidence(order: AmazonOrder, item) -> dict:
    extra = []
    if item.category:
        extra.append({"header": "Amazon Category", "value": item.category})
    if item.asin:
        extra.append({"header": "ASIN", "value": item.asin})
    extra.append({"header": "Amazon Order", "value": order.order_id})
    return {
        "description": {"header": "Item", "value": item.description},
        "extra_text_fields": extra,
    }


def _create_item_txn(conn, order, item, amount, *, account_id, owner_id, batch_id, category_id) -> str:
    return _insert_imported_transaction(conn, batch_id, {
        "account_id": account_id,
        "owner_id": owner_id,
        "category_id": category_id,
        "amount": amount,
        "merchant_name": item.description or "Amazon item",
        "display_name": item.description or "Amazon item",
        "raw_name": item.description or "Amazon item",
        "date": order.order_date,
        "is_pending": 0,
        "content_hash": make_hash(order.order_date or "", amount, f"{order.order_id}:{item.description}"),
        "import_evidence": _item_evidence(order, item),
        "imported_category": item.category,
        "category_source": "import",
        "display_name_source": "import",
    })


def apply_amazon_order(
    conn: sqlite3.Connection,
    order: AmazonOrder,
    *,
    account_id: str,
    batch_id: str,
) -> dict:
    """Materialize one parsed order into the ledger and link it. Idempotent by order id: if a link for
    this order already exists, it is left untouched (re-import is a no-op — refinement of an existing
    order is a separate path). Returns a summary of what happened."""
    if txn_links.find_link(conn, LINK_KIND, order.order_id):
        return {"order_id": order.order_id, "status": "already_applied"}

    disposition = classify_order(order)
    owner_id = _account_owner(conn, account_id)
    non_cash = disposition.kind == "non_cash"

    # Cash items count (uncategorized → Unassigned until the rule pipeline/user categorizes); non-cash
    # items are recorded excluded so they don't inflate spending (no cash actually moved).
    item_category_id = find_or_create_funding_category(conn) if non_cash else None

    # Which rows to create: per-item when we have the items detail; otherwise, for a cash order with no
    # items yet (activated by the orders file alone), a single coarse row carrying the whole net cash —
    # so the excluded charge's money still counts once, on the itemized side, pending later refinement.
    if order.items:
        item_specs = list(zip(order.items, allocate(disposition.net_cash, order.items)))
    elif not non_cash and disposition.net_cash > 0:
        coarse = AmazonItem(
            description=order.items_summary or f"Amazon order {order.order_id}",
            price=None, category=None,
        )
        item_specs = [(coarse, disposition.net_cash)]
    else:
        item_specs = []

    item_ids = [
        _create_item_txn(conn, order, item, amount,
                         account_id=account_id, owner_id=owner_id, batch_id=batch_id,
                         category_id=item_category_id)
        for item, amount in item_specs
    ]

    members = [(txn_id, "item") for txn_id in item_ids]
    charge_prior = None
    charge_id = None
    # Resolve the paying instrument against the funding-source → account map (override → global). A
    # mapped instrument constrains the charge search to its account (and resolves same-amount ambiguity);
    # an untracked instrument short-circuits — no charge, the items are the sole record and count directly
    # (already the case, since a cash order's items are created counted); unmapped falls to the search's
    # own graceful-last-4 fallback.
    funding = amazon_funding.resolve_funding_account(
        conn, account_id, disposition.match_last4, disposition.match_network
    )
    if not non_cash and funding.state != "untracked":
        charge_id = find_matching_charge(
            conn, disposition, exclude_account_id=account_id,
            restrict_account_id=funding.funding_account_id if funding.state == "mapped" else None,
        )
        if charge_id:
            charge_prior = _exclude_charge(conn, charge_id)
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
        "item_count": len(item_ids),
        "charge_linked": bool(charge_id),
        "funding_state": funding.state,
        # The paying instrument, so the run can report which instruments were seen and which still need
        # mapping (a bare off-card leg with no last-4 isn't a mappable instrument).
        "instrument": (
            {"last4": disposition.match_last4, "network": disposition.match_network}
            if disposition.kind == "cash" and disposition.match_last4 else None
        ),
    }


def run_amazon_import(
    conn: sqlite3.Connection,
    orders: list[AmazonOrder],
    *,
    account_id: str,
    filename: str = "amazon.csv",
) -> dict:
    """Create an import batch and apply every parsed order into it. Returns a summary with the batch id,
    per-disposition counts, and the bimodal orphan signal (whole-file orphans read as "waiting for the
    partner file"; a small fraction reads as a genuine gap)."""
    batch_id = str(uuid.uuid4())
    conn.execute(
        "INSERT INTO import_batch (id, filename, status, source_kind) VALUES (?, ?, 'completed', ?)",
        (batch_id, filename, BATCH_SOURCE_KIND),
    )
    counts = {"applied_full": 0, "applied_coarse": 0, "non_cash": 0, "items_pending": 0,
              "charges_matched": 0, "already_applied": 0}
    # Distinct instruments seen this run, keyed on (last4, network), each carrying its current map state
    # so the UI can prompt to map the ones that are still `unmapped`.
    instruments: dict[tuple, dict] = {}
    for order in orders:
        result = apply_amazon_order(conn, order, account_id=account_id, batch_id=batch_id)
        if result["status"] == "already_applied":
            counts["already_applied"] += 1
            continue
        inst = result.get("instrument")
        if inst:
            key = (inst["last4"], inst["network"])
            instruments.setdefault(key, {**inst, "state": result.get("funding_state", "unmapped")})
        if result["charge_linked"]:
            counts["charges_matched"] += 1
        if result["disposition"] == "non_cash":
            counts["non_cash"] += 1
        elif order.has_item_detail and not order.has_order_detail:
            counts["items_pending"] += 1
        elif order.has_item_detail:
            counts["applied_full"] += 1
        else:
            counts["applied_coarse"] += 1

    total = len(orders)
    order_only = sum(1 for o in orders if o.has_order_detail and not o.has_item_detail)
    items_only = sum(1 for o in orders if o.has_item_detail and not o.has_order_detail)
    conn.execute(
        "UPDATE import_batch SET row_count = ? WHERE id = ?",
        (counts["applied_full"] + counts["applied_coarse"] + counts["non_cash"] + counts["items_pending"], batch_id),
    )
    return {
        "batch_id": batch_id,
        "order_count": total,
        "counts": counts,
        # Orphans: a file present without its partner orphans (almost) all of that side. A small fraction
        # is instead a genuine export gap worth a look (see doc). Surface both counts; the UI tones it.
        "orphans": {"orders_without_items": order_only, "items_without_orders": items_only},
        # Instruments seen this run with their current map state, so the UI can prompt to map the unmapped
        # ones inline (already-mapped/untracked resolve silently).
        "instruments": list(instruments.values()),
    }


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


@router.post("/amazon/import")
async def amazon_import_endpoint(
    files: list[UploadFile] = File(...),
    account_id: str = Form(...),
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
        summary = run_amazon_import(conn, merged, account_id=account_id, filename=", ".join(names) or "amazon")
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


def reverse_amazon_order(conn: sqlite3.Connection, link_id: str) -> dict:
    """Undo an applied order: delete its item transactions, restore the charge's prior categorization
    from the link metadata, and delete the link. Safe to call once per link."""
    link = txn_links.get_link(conn, link_id)
    if not link:
        return {"status": "not_found"}
    item_ids = txn_links.member_txn_ids(conn, link_id, role="item")
    charge_ids = txn_links.member_txn_ids(conn, link_id, role="charge")

    prior = (link.get("metadata") or {}).get("charge_prior")
    for charge_id in charge_ids:
        if prior:
            conn.execute(
                "UPDATE txn SET category_id = ?, category_source = ?, category_overridden = ? WHERE id = ?",
                (prior.get("category_id"), prior.get("category_source"),
                 int(prior.get("category_overridden") or 0), charge_id),
            )
    # Delete the link first so its members' FK rows go, then the item transactions themselves.
    txn_links.delete_link(conn, link_id)
    for item_id in item_ids:
        conn.execute("DELETE FROM txn WHERE id = ?", (item_id,))
    return {"status": "reversed", "items_removed": len(item_ids), "charges_restored": len(charge_ids)}
