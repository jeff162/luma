# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Parse an AZAD Amazon order-history export into structured orders.

The AZAD extension (``philipmulcahy/azad``) exports two related CSVs that join on ``order id``:

  * **orders** — one row per order, carrying the charge/link half: ``total``, ``tax``, ``shipping``,
    ``refund`` and the compound ``payments`` string (``"Fablecard ending in 4455: 2024-12-22:
    $9.55; "``).
  * **items** — one row per item, carrying the categorization half: per-item ``price``, Amazon
    ``category``, ``ASIN``.

This module is the **source-pluggable parsing layer** for the Amazon feature (see
``docs/backlog/paypal-amazon-enrichment.md``). It splits cleanly into:

  * a thin ``bytes/text → rows`` front-end (:func:`read_export`, which sniffs whether a file is the
    orders or the items export by its header), and
  * a reusable ``rows → structured orders`` core (:func:`parse_order_rows`, :func:`parse_item_rows`,
    :func:`merge`).

Keeping the front-end thin is deliberate: a future clipboard-paste path or a combined single-file AZAD
export is just another front-end feeding the same core, with no change to the downstream engine. This
layer only produces *facts* — the disposition (which leg is the cash charge, allocation, what counts)
belongs to the enrich-via-link engine that consumes these.
"""

from __future__ import annotations

import csv
import io
import re
from dataclasses import dataclass, field
from typing import Optional

# Known non-cash payment instruments: value is redeemed at spend time but no cash leaves an account,
# and the export never carries the dollar figure for them (see doc — same class as the points question).
_NON_CASH_MARKERS = ("rewards point", "gift card")

_LAST4_RE = re.compile(r"ending in (\d{3,4})")
_DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}")
_AMOUNT_RE = re.compile(r"\$\s*([\d,]+\.\d{2}|[\d,]+)")


@dataclass
class PaymentLeg:
    """One payment method applied to an order, parsed from the compound ``payments`` string.

    ``amount`` is ``None`` when the export gives no dollar figure — either a bare card mention (the
    split isn't disclosed, as on points orders) or a non-cash instrument. ``is_non_cash`` marks a
    known non-cash instrument (Rewards Points / gift-card balance)."""

    method: Optional[str]
    last4: Optional[str]
    date: Optional[str]
    amount: Optional[float]
    is_non_cash: bool = False


@dataclass
class AmazonItem:
    description: str
    price: Optional[float] = None   # list price — reference detail only (kept in evidence), never a ledger amount
    category: Optional[str] = None  # Amazon taxonomy — parsed but deliberately unused (user categorizes their own way)
    asin: Optional[str] = None
    quantity: int = 1
    item_url: Optional[str] = None
    order_date: Optional[str] = None    # the items file's `order date` — promoted to an orphan order in merge
    source_file: Optional[str] = None   # which uploaded items file this row came from (import-detail provenance)
    source_file_hash: Optional[str] = None  # content hash of that file — the per-file batching key (see AmazonOrder)


@dataclass
class AmazonOrder:
    order_id: str
    order_date: Optional[str] = None
    total: Optional[float] = None
    tax: Optional[float] = None
    shipping: Optional[float] = None
    refund: Optional[float] = None
    recipient: Optional[str] = None
    order_url: Optional[str] = None
    # The orders file's concatenated `items` text (e.g. "Air Widget; Widget Picks; "). Used as the
    # description of the single coarse row when an order is activated before its per-item detail arrives.
    items_summary: Optional[str] = None
    payment_legs: list[PaymentLeg] = field(default_factory=list)
    items: list[AmazonItem] = field(default_factory=list)
    # Provenance: which export(s) contributed. `has_order_detail` (from the orders file) is what
    # *activates* an order — the charge match + link; `has_item_detail` (from the items file) is what
    # *refines* it into per-item rows. An order missing one side is an orphan (see doc). `source_file`
    # names the uploaded file this order's *order detail* came from (an orphan-item entry carries its
    # items file's name) — for the import-detail report's "which file did this come from?".
    has_order_detail: bool = False
    has_item_detail: bool = False
    source_file: Optional[str] = None
    # Content hash of the file this order's *order detail* came from (an orphan-item entry carries its items
    # file's hash). This — not the filename — is the key the importer batches by: one card per source file,
    # so distinct order-history periods land on their own cards instead of being bundled by drop. The hash
    # rather than the name so two genuinely different files that share a name still split into two cards
    # (identical content is already deduped away before batching).
    source_file_hash: Optional[str] = None


# --------------------------------------------------------------------------------------------------
# Value parsing
# --------------------------------------------------------------------------------------------------

def parse_money(value) -> Optional[float]:
    """Parse ``"$8.99"`` / ``"9.55"`` / ``"1,234.00"`` → float. Blank, ``None``, or an unparseable
    value (e.g. a spreadsheet ``=SUBTOTAL(...)`` formula) → ``None``."""
    if value is None:
        return None
    text = str(value).strip().replace("$", "").replace(",", "")
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def parse_quantity(value) -> int:
    try:
        n = int(str(value).strip())
        return n if n > 0 else 1
    except (ValueError, TypeError):
        return 1


def parse_payments(payments: Optional[str]) -> list[PaymentLeg]:
    """Split the compound ``payments`` string into legs. Each leg may carry a card ``last4``, a
    ``date``, and an ``amount``; any of these may be absent. Segments are ``;``-separated."""
    legs: list[PaymentLeg] = []
    for segment in (payments or "").split(";"):
        seg = segment.strip()
        if not seg:
            continue
        last4_m = _LAST4_RE.search(seg)
        date_m = _DATE_RE.search(seg)
        amount_m = _AMOUNT_RE.search(seg)
        last4 = last4_m.group(1) if last4_m else None
        date = date_m.group(0) if date_m else None
        amount = parse_money(amount_m.group(1)) if amount_m else None
        # The method label is what remains once the structured parts (card last-4, date, amount) are
        # stripped out and the separators cleaned up.
        method = seg
        method = _LAST4_RE.sub("", method)
        method = _DATE_RE.sub("", method)
        method = _AMOUNT_RE.sub("", method)
        method = method.replace(":", " ").strip()
        method = re.sub(r"\s+", " ", method).strip() or None
        is_non_cash = bool(method and any(m in method.lower() for m in _NON_CASH_MARKERS))
        legs.append(PaymentLeg(method=method, last4=last4, date=date, amount=amount, is_non_cash=is_non_cash))
    return legs


# --------------------------------------------------------------------------------------------------
# Row → structure core
# --------------------------------------------------------------------------------------------------

def _clean_key(key: str) -> str:
    # Strip a UTF-8 BOM (the AZAD files carry one on the first header) and surrounding whitespace.
    return (key or "").lstrip("﻿").strip()


def _normalize_row(row: dict) -> dict:
    return {_clean_key(k): (v if v is None else str(v)) for k, v in row.items()}


def is_footer_row(row: dict) -> bool:
    """AZAD appends a spreadsheet footer whose numeric cells are ``=SUBTOTAL(...)`` formulas and whose
    order id is blank. Skip any row with no order id or a formula in a cell."""
    order_id = (row.get("order id") or "").strip()
    if not order_id or order_id.startswith("="):
        return True
    return any(isinstance(v, str) and v.strip().startswith("=") for v in row.values())


def parse_order_rows(rows: list[dict]) -> list[AmazonOrder]:
    """Parse the *orders* export (one row per order). Items are left empty here — they arrive from the
    items export via :func:`merge`."""
    orders: list[AmazonOrder] = []
    for raw in rows:
        row = _normalize_row(raw)
        if is_footer_row(row):
            continue
        orders.append(
            AmazonOrder(
                order_id=row["order id"].strip(),
                order_date=(row.get("date") or "").strip() or None,
                total=parse_money(row.get("total")),
                tax=parse_money(row.get("tax")),
                shipping=parse_money(row.get("shipping")),
                refund=parse_money(row.get("refund")),
                recipient=(row.get("to") or "").strip() or None,
                order_url=(row.get("order url") or "").strip() or None,
                items_summary=(row.get("items") or "").strip() or None,
                payment_legs=parse_payments(row.get("payments")),
                has_order_detail=True,
            )
        )
    return orders


def parse_item_rows(rows: list[dict]) -> dict[str, list[AmazonItem]]:
    """Parse the *items* export (one row per item) into a mapping of ``order id → [AmazonItem]``."""
    by_order: dict[str, list[AmazonItem]] = {}
    for raw in rows:
        row = _normalize_row(raw)
        if is_footer_row(row):
            continue
        order_id = row["order id"].strip()
        by_order.setdefault(order_id, []).append(
            AmazonItem(
                description=(row.get("description") or "").strip(),
                price=parse_money(row.get("price")),
                category=(row.get("category") or "").strip() or None,
                asin=(row.get("ASIN") or "").strip() or None,
                quantity=parse_quantity(row.get("quantity")),
                item_url=(row.get("item url") or "").strip() or None,
                order_date=(row.get("order date") or "").strip() or None,
            )
        )
    return by_order


@dataclass
class OrderDisposition:
    """How an order's cash resolves — the input to the order engine (see doc). ``kind`` is ``'cash'`` (a
    real charge to match + exclude) or ``'non_cash'`` (points-/gift-funded — recorded excluded, not
    counted). ``charge_amount`` is the gross charge to find in the ledger; ``net_cash`` (gross minus any
    refund) is the order transaction's amount."""

    kind: str
    net_cash: float
    charge_amount: Optional[float]
    match_last4: Optional[str]
    match_date: Optional[str]
    # The paying instrument's network label (the leg's method, e.g. "Riverstone") — with
    # `match_last4` it identifies the instrument for the funding-source → account map (see doc).
    match_network: Optional[str] = None
    # A card the payments string *names* but gives no dollar amount for (non-cash orders only —
    # "Riverstone ending in 5093; Rewards Points;", the 2024+ points-order shape). The export
    # hides the card/points split, so classification lands non-cash; the importer probes the ledger
    # for a unique full-total charge on this card and upgrades the order to cash when one exists
    # (see the router's bare-card probe).
    bare_card_last4: Optional[str] = None
    bare_card_network: Optional[str] = None


def classify_order(order: AmazonOrder) -> OrderDisposition:
    """Apply the settled decision table to one order. An order is *cash* if its payment legs carry a
    positive dollar total (a card charge, or a bare off-card amount); it is *non-cash* if every leg
    is a non-cash instrument or a bare card mention with no amount (points / gift-card balance — the
    export never discloses their dollar figure), or if its cash legs sum to $0.00 (a free/promo order —
    no cash moved, so there is no charge to find). A non-cash disposition still carries any bare card
    mention (``bare_card_*``) so the importer's ledger probe can settle the undisclosed split. A refund
    reduces the net cash."""
    cash_legs = [leg for leg in order.payment_legs if leg.amount is not None and not leg.is_non_cash]
    # Round the summed legs to cents: summing floats manufactures sub-cent drift (0.1 + 0.2 =
    # 0.30000000000000004) that would otherwise fail the cent-level match against the cleanly-parsed
    # ledger charge. This — not the source data, which is 2-decimal — is why the amount is rounded.
    charge_amount = round(sum(leg.amount for leg in cash_legs), 2)
    if not cash_legs or charge_amount <= 0:
        bare = next((leg for leg in order.payment_legs
                     if leg.amount is None and not leg.is_non_cash and (leg.last4 or leg.method)), None)
        return OrderDisposition(kind="non_cash", net_cash=0.0, charge_amount=None,
                                match_last4=None, match_date=None,
                                bare_card_last4=bare.last4 if bare else None,
                                bare_card_network=bare.method if bare else None)
    refund = order.refund or 0.0
    net_cash = round(max(0.0, charge_amount - refund), 2)
    primary = next((leg for leg in cash_legs if leg.last4), cash_legs[0])
    return OrderDisposition(
        kind="cash",
        net_cash=net_cash,
        charge_amount=charge_amount,
        match_last4=primary.last4,
        match_date=primary.date or order.order_date,
        match_network=primary.method,
    )


def merge(
    orders: list[AmazonOrder],
    items_by_order: dict[str, list[AmazonItem]],
) -> list[AmazonOrder]:
    """Join parsed orders with parsed items on ``order id``. Orders present only in the items export
    (no charge/payment data yet) surface as orders with ``has_order_detail=False``; orders present only
    in the orders export surface with ``has_item_detail=False``. This is what makes the two files
    order-independent — each side fills in what it carries, keyed on ``order id``."""
    by_id: dict[str, AmazonOrder] = {}
    for order in orders:
        by_id[order.order_id] = order
    for order_id, items in items_by_order.items():
        order = by_id.get(order_id)
        if order is None:
            # Items with no matching order — carry the items file's name (so a discarded row is traceable)
            # and the items file's order date (the only date such an orphan has).
            order = AmazonOrder(
                order_id=order_id,
                order_date=next((i.order_date for i in items if i.order_date), None),
                source_file=next((i.source_file for i in items if i.source_file), None),
                source_file_hash=next((i.source_file_hash for i in items if i.source_file_hash), None),
            )
            by_id[order_id] = order
        order.items = items
        order.has_item_detail = bool(items)
    return list(by_id.values())


# --------------------------------------------------------------------------------------------------
# Thin source front-end: text → (kind, rows)
# --------------------------------------------------------------------------------------------------

# Header signatures that identify which export a file is. The items export is distinguished by its
# per-item columns (ASIN / description / price); the orders export by its charge columns (payments /
# total). A future combined or pasted source is just another front-end producing the same rows.
_ITEMS_MARKERS = {"asin", "description", "price"}
_ORDERS_MARKERS = {"payments", "total"}


def sniff_kind(headers: list[str]) -> Optional[str]:
    """Classify an export by its header row: ``'orders'``, ``'items'``, or ``None`` if unrecognized."""
    cols = {_clean_key(h).lower() for h in headers}
    if _ITEMS_MARKERS.issubset(cols):
        return "items"
    if _ORDERS_MARKERS.issubset(cols):
        return "orders"
    return None


def read_export(text: str) -> tuple[Optional[str], list[dict]]:
    """The thin front-end: decode CSV text into ``(kind, rows)`` where ``kind`` is ``'orders'`` or
    ``'items'`` (or ``None`` if the header matches neither). Rows are raw dicts; the core parses them."""
    reader = csv.DictReader(io.StringIO(text))
    headers = [_clean_key(h) for h in (reader.fieldnames or [])]
    kind = sniff_kind(headers)
    rows = [dict(r) for r in reader]
    return kind, rows


# The inverse of the router's `_order_evidence` item lines. That formatter is the only place an order's
# per-item list price is retained — it renders each item as `Label (×2, list $12.34, ASIN)` inside an
# `extra_text_fields` entry headed "Item" — so a consumer that needs the numbers back has to read them
# out of that text. Keeping the reader here, beside the price semantics it depends on, is what makes the
# coupling visible from both ends: a change to the formatter's shape breaks this, and the round-trip test
# is what catches it.
_ITEM_LIST_PRICE_RE = re.compile(r"list \$([0-9]+(?:\.[0-9]{1,2})?)")
_ITEM_QUANTITY_RE = re.compile(r"×([0-9]+)")


def parse_item_evidence(evidence: dict) -> list[dict]:
    """Recover an order's per-item detail from a transaction's stored import evidence.

    Returns one dict per item — ``{"description", "price", "quantity", "extended_price"}`` — with
    ``price`` None where the export gave none (a digital or promotional line often has no list price).
    An order that was imported from the orders file alone carries no "Item" entries at all and yields an
    empty list.

    ``price`` is the **unit** price, not the line total. Verified against real exports: among single-line
    orders with quantity > 1, the transaction amount repeatedly equals ``price × quantity`` exactly and
    never falls below it, which is only true of a per-unit figure. ``extended_price`` is that product —
    the figure a caller weighting items against each other wants, since weighting by the unit price alone
    silently under-counts a line the user bought several of.

    The prices are **list prices**, not what was paid: they exclude tax and shipping and predate any
    promo, so they do not sum to the transaction's amount and must never be used as ledger figures. Their
    one legitimate use is as *relative weights* — see ``txn_splits.proportional_allocation``.
    """
    items: list[dict] = []
    for field_entry in (evidence or {}).get("extra_text_fields") or []:
        if field_entry.get("header") != "Item":
            continue
        value = str(field_entry.get("value") or "")
        price_match = _ITEM_LIST_PRICE_RE.search(value)
        quantity_match = _ITEM_QUANTITY_RE.search(value)
        # The label is everything before the trailing parenthesized detail the formatter appended.
        label = value
        if "(" in value and value.rstrip().endswith(")"):
            label = value[: value.rfind("(")].strip()
        price = float(price_match.group(1)) if price_match else None
        quantity = int(quantity_match.group(1)) if quantity_match else 1
        items.append({
            "description": label or "item",
            "price": price,
            "quantity": quantity,
            "extended_price": None if price is None else round(price * quantity, 2),
        })
    return items
