# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Multi-payment purchases — several transactions that are one purchase.

A deposit and a final payment (or a three-instalment plan) are two or three real movements of money
that together buy one thing. The ledger records each correctly and has no way to say they belong
together, so "what did the deck actually cost" is a figure the user has to reassemble from memory, and
a deposit on its own reads as a mysterious partial amount.

This is the third client of the ``txn_link`` primitive (``services/txn_links.py``), after Amazon order
itemization and wallet funding-leg suppression, and it is the **cheapest** of the three: those two exist
to stop money counting twice, so each recategorizes a leg into an excluded bucket and stashes the prior
for reversal. Here both payments are genuinely spent money on genuinely different dates. Nothing is
excluded, restated or netted — the link is *pure association*, exactly what the primitive is by
default, so grouping a purchase can never change a total that was already right.

What it buys: a purchase total, an ordinal for each payment ("1 of 2"), and a place for an expected
total to sit so an unfinished purchase is visible as one.

Invariants, enforced here rather than by the schema (no SQLite constraint reaches across the two
tables to express them):

- **A transaction belongs to at most one purchase.** Not a query convenience: a payment covering two
  invoices would be counted whole into both purchases' totals, so admitting it would make the one
  figure this feature exists to produce wrong. Dividing *one* payment is the other axis — that is what
  ``txn_splits`` is for — and the refusal says so.
- **Two payments minimum.** One payment is not a multi-payment purchase; it would render a marker
  saying "1 of 1" and mean nothing. Removing a payment that would leave fewer than two therefore
  deletes the whole link rather than leaving a degenerate one behind.
- **Every member carries the same role** (``payment``). Which one is the deposit is already told by the
  dates, and a role saying it again is a second truth that can drift from the first.

Totals are computed over **live** members only — a trashed payment is money that is not in the ledger,
so counting it would overstate the purchase — while the trashed rows stay visible in the panel, because
the trash is the reversible stage and a payment silently vanishing from a purchase is worse than one
shown as removed.

``expected_total`` is stored **signed, in the ledger's convention** (``amount > 0`` is money out), like
every other amount the API carries. The human-facing conversion — a person types a magnitude — happens
at the UI boundary, where the payments being linked are on screen to take the sign from and the derived
figure is shown back before it is saved.
"""

from __future__ import annotations

import sqlite3
from typing import Iterable, Optional, Sequence

from backend.json_utils import safe_json_dict
from backend.services.txn_links import (
    add_member,
    create_link,
    delete_link,
    get_link,
    remove_member,
    set_metadata,
)

# The `txn_link.kind` this feature owns, and the single role its members carry.
PURCHASE_LINK_KIND = "purchase"
PAYMENT_ROLE = "payment"

# Fewer than this is not a multi-payment purchase. See the module docstring.
MIN_PAYMENTS = 2

# A name for the purchase, not a description of it — long enough for "Kitchen counters — Riverstone"
# and short enough that the row marker's tooltip stays one line.
MAX_LABEL_LENGTH = 120
# An invoice / order number. Bounded for the same reason, and because a reference this long is not one.
MAX_REFERENCE_LENGTH = 80


class PurchaseLinkError(ValueError):
    """A requested change would break one of the invariants above. Carries a user-facing message."""


def _clean_text(value: Optional[str], limit: int) -> Optional[str]:
    text = (value or "").strip()
    return text[:limit] if text else None


def _round_money(value) -> Optional[float]:
    if value is None:
        return None
    try:
        return round(float(value), 2)
    except (TypeError, ValueError):
        raise PurchaseLinkError("The expected total must be an amount.")


def _metadata(label: Optional[str], expected_total: Optional[float]) -> dict:
    data: dict = {}
    if label is not None:
        data["label"] = label
    if expected_total is not None:
        data["expected_total"] = expected_total
    return data


def _member_rows(conn: sqlite3.Connection, link_id: str) -> list[dict]:
    """The link's payments, oldest first, each with what a list row needs to render it.

    Ordered by date (then id, so the order is stable rather than merely usually-stable) because that
    ordering *is* the deposit-then-balance sequence the ordinal reports.
    """
    rows = conn.execute(
        """
        SELECT t.id AS txn_id, t.date, t.amount, t.trashed_at,
               COALESCE(NULLIF(t.display_name, ''), NULLIF(t.merchant_name, ''), NULLIF(t.raw_name, ''), '') AS payee,
               COALESCE(a.display_name, a.name, '') AS account_name
        FROM   txn_link_member m
        JOIN   txn t   ON t.id = m.txn_id
        LEFT   JOIN account a ON a.id = t.account_id
        WHERE  m.link_id = ?
        ORDER  BY t.date, t.id
        """,
        (link_id,),
    ).fetchall()
    return [
        {
            "txn_id": row["txn_id"],
            "date": row["date"],
            "amount": row["amount"],
            "payee": row["payee"],
            "account_name": row["account_name"],
            "trashed": row["trashed_at"] is not None,
        }
        for row in rows
    ]


def _summarize(link: dict, payments: Sequence[dict]) -> dict:
    """The purchase as every read path returns it: its identity, its payments, and the three figures.

    `unaccounted` is `expected_total - linked_total` and is deliberately named for what it *is* rather
    than "remaining": the gap may be a payment not made yet, or one made and not linked, and the ledger
    cannot tell which. It is None when no expected total was stated, since there is then nothing to be
    short of.
    """
    metadata = link.get("metadata") or {}
    live = [payment for payment in payments if not payment["trashed"]]
    linked_total = round(sum(payment["amount"] for payment in live), 2)
    expected_total = metadata.get("expected_total")
    return {
        "id": link["id"],
        "label": metadata.get("label"),
        "reference": link.get("external_ref"),
        "expected_total": expected_total,
        "linked_total": linked_total,
        "unaccounted": round(expected_total - linked_total, 2) if expected_total is not None else None,
        "payment_count": len(live),
        "created_at": link.get("created_at"),
        "payments": list(payments),
    }


def _load(conn: sqlite3.Connection, link_id: str) -> dict:
    link = get_link(conn, link_id)
    if not link or link["kind"] != PURCHASE_LINK_KIND:
        raise PurchaseLinkError("No such purchase.")
    return _summarize(link, _member_rows(conn, link_id))


def _existing_purchase_ids(conn: sqlite3.Connection, txn_ids: Sequence[str]) -> dict[str, str]:
    """Which of these transactions are already in a purchase, and which one."""
    if not txn_ids:
        return {}
    placeholders = ",".join("?" for _ in txn_ids)
    rows = conn.execute(
        f"""SELECT m.txn_id, m.link_id
            FROM   txn_link_member m
            JOIN   txn_link l ON l.id = m.link_id
            WHERE  l.kind = ? AND m.txn_id IN ({placeholders})""",
        [PURCHASE_LINK_KIND, *txn_ids],
    ).fetchall()
    return {row["txn_id"]: row["link_id"] for row in rows}


def _normalize_ids(txn_ids: Iterable[str]) -> list[str]:
    """De-duplicate while keeping the caller's order — a repeated id is a selection artifact, not a
    request to link the same payment twice."""
    seen: set[str] = set()
    ordered: list[str] = []
    for txn_id in txn_ids or []:
        if txn_id and txn_id not in seen:
            seen.add(txn_id)
            ordered.append(txn_id)
    return ordered


def _require_linkable(conn: sqlite3.Connection, txn_ids: Sequence[str], *, allowed_link_id: Optional[str] = None) -> None:
    """Every id names a live transaction that is free to join this purchase, or the reason it is not.

    A trashed row is refused at the join rather than silently accepted: it contributes nothing to the
    total, so linking it would produce a purchase whose figures do not move when a payment is added.
    (A payment trashed *after* it was linked is a different case and is kept — see the module docstring.)
    """
    if not txn_ids:
        raise PurchaseLinkError("Select the payments that make up this purchase.")
    placeholders = ",".join("?" for _ in txn_ids)
    found = {
        row["id"]: row["trashed_at"]
        for row in conn.execute(
            f"SELECT id, trashed_at FROM txn WHERE id IN ({placeholders})", list(txn_ids)
        )
    }
    missing = [txn_id for txn_id in txn_ids if txn_id not in found]
    if missing:
        raise PurchaseLinkError("One of the selected transactions no longer exists.")
    if any(found[txn_id] is not None for txn_id in txn_ids):
        raise PurchaseLinkError("A transaction in the trash cannot be added to a purchase.")

    taken = _existing_purchase_ids(conn, txn_ids)
    conflicting = {
        link_id for link_id in taken.values() if allowed_link_id is None or link_id != allowed_link_id
    }
    if conflicting:
        raise PurchaseLinkError(
            "A payment can only belong to one purchase. Remove it from the purchase it is in first — "
            "or, if one payment covered more than one purchase, split it across categories instead."
        )


def create_purchase(
    conn: sqlite3.Connection,
    txn_ids: Iterable[str],
    *,
    label: Optional[str] = None,
    reference: Optional[str] = None,
    expected_total: Optional[float] = None,
) -> dict:
    """Group these transactions as one purchase. Never touches the transactions themselves."""
    ids = _normalize_ids(txn_ids)
    if len(ids) < MIN_PAYMENTS:
        raise PurchaseLinkError(
            f"A purchase needs at least {MIN_PAYMENTS} payments. Select the other one as well."
        )
    _require_linkable(conn, ids)
    link_id = create_link(
        conn,
        PURCHASE_LINK_KIND,
        [(txn_id, PAYMENT_ROLE) for txn_id in ids],
        external_ref=_clean_text(reference, MAX_REFERENCE_LENGTH),
        metadata=_metadata(_clean_text(label, MAX_LABEL_LENGTH), _round_money(expected_total)),
    )
    return _load(conn, link_id)


def get_purchase(conn: sqlite3.Connection, link_id: str) -> dict:
    return _load(conn, link_id)


def purchase_for_txn(conn: sqlite3.Connection, txn_id: str) -> Optional[dict]:
    """The purchase this transaction is a payment of, or None. The detail panel's read."""
    row = conn.execute(
        """SELECT m.link_id
           FROM   txn_link_member m
           JOIN   txn_link l ON l.id = m.link_id
           WHERE  m.txn_id = ? AND l.kind = ?""",
        (txn_id, PURCHASE_LINK_KIND),
    ).fetchone()
    return _load(conn, row["link_id"]) if row else None


def update_purchase(
    conn: sqlite3.Connection,
    link_id: str,
    *,
    label: Optional[str] = None,
    reference: Optional[str] = None,
    expected_total: Optional[float] = None,
) -> dict:
    """Rewrite the purchase's own fields. All three are replaced with what is passed, so clearing one is
    sending it empty — a partial update would leave no way to remove an expected total that was wrong."""
    existing = _load(conn, link_id)
    conn.execute(
        "UPDATE txn_link SET external_ref = ? WHERE id = ?",
        (_clean_text(reference, MAX_REFERENCE_LENGTH), link_id),
    )
    set_metadata(
        conn,
        link_id,
        _metadata(_clean_text(label, MAX_LABEL_LENGTH), _round_money(expected_total)),
    )
    return _load(conn, existing["id"])


def add_payments(conn: sqlite3.Connection, link_id: str, txn_ids: Iterable[str]) -> dict:
    """Add payments to an existing purchase — the "a third instalment turned up" path."""
    purchase = _load(conn, link_id)
    ids = _normalize_ids(txn_ids)
    _require_linkable(conn, ids, allowed_link_id=purchase["id"])
    for txn_id in ids:
        add_member(conn, purchase["id"], txn_id, PAYMENT_ROLE)
    return _load(conn, purchase["id"])


def remove_payment(conn: sqlite3.Connection, link_id: str, txn_id: str) -> Optional[dict]:
    """Detach one payment. Returns the purchase as it now stands, or None when removing that payment
    left too few to be a purchase and the whole link was dropped with it."""
    purchase = _load(conn, link_id)
    if txn_id not in {payment["txn_id"] for payment in purchase["payments"]}:
        raise PurchaseLinkError("That payment is not part of this purchase.")
    if len(purchase["payments"]) - 1 < MIN_PAYMENTS:
        delete_link(conn, purchase["id"])
        return None
    remove_member(conn, purchase["id"], txn_id)
    return _load(conn, purchase["id"])


def delete_purchase(conn: sqlite3.Connection, link_id: str) -> None:
    """Ungroup the purchase. The payments stay exactly as they were — the link never changed them."""
    _load(conn, link_id)
    delete_link(conn, link_id)


def purchase_map_for(conn: sqlite3.Connection, txn_ids) -> dict[str, dict]:
    """Per transaction, the purchase it belongs to as the ledger row needs it — the label, this
    payment's ordinal, and the purchase's figures.

    Resolved for the whole page in two indexed queries rather than one per row, the same call
    ``split_parts`` and ``documents`` already made. The row deliberately gets the *summary* and not the
    payment list: unlike the paperclip, this marker only explains the row rather than acting on it, so
    "Payment 1 of 2 · Kitchen counters" is the whole of what it needs and shipping every sibling
    payment on every linked row would be paying for a surface that does not exist.
    """
    ids = [txn_id for txn_id in txn_ids if txn_id]
    if not ids:
        return {}
    placeholders = ",".join("?" for _ in ids)
    link_ids = [
        row["link_id"]
        for row in conn.execute(
            f"""SELECT DISTINCT m.link_id
                FROM   txn_link_member m
                JOIN   txn_link l ON l.id = m.link_id
                WHERE  l.kind = ? AND m.txn_id IN ({placeholders})""",
            [PURCHASE_LINK_KIND, *ids],
        )
    ]
    if not link_ids:
        return {}

    link_placeholders = ",".join("?" for _ in link_ids)
    members: dict[str, list[dict]] = {}
    meta: dict[str, dict] = {}
    for row in conn.execute(
        f"""SELECT l.id AS link_id, l.metadata_json, m.txn_id, t.amount, t.trashed_at
            FROM   txn_link l
            JOIN   txn_link_member m ON m.link_id = l.id
            JOIN   txn t ON t.id = m.txn_id
            WHERE  l.id IN ({link_placeholders})
            ORDER  BY t.date, t.id""",
        link_ids,
    ):
        meta.setdefault(row["link_id"], safe_json_dict(row["metadata_json"]))
        members.setdefault(row["link_id"], []).append(
            {"txn_id": row["txn_id"], "amount": row["amount"], "trashed": row["trashed_at"] is not None}
        )

    wanted = set(ids)
    mapped: dict[str, dict] = {}
    for link_id, rows in members.items():
        live = [row for row in rows if not row["trashed"]]
        linked_total = round(sum(row["amount"] for row in live), 2)
        expected_total = meta.get(link_id, {}).get("expected_total")
        ordinals = {row["txn_id"]: index + 1 for index, row in enumerate(live)}
        for row in rows:
            if row["txn_id"] not in wanted:
                continue
            mapped[row["txn_id"]] = {
                "id": link_id,
                "label": meta.get(link_id, {}).get("label"),
                # A trashed payment has no ordinal — it is not one of the N the purchase is made of.
                "position": ordinals.get(row["txn_id"]),
                "payment_count": len(live),
                "linked_total": linked_total,
                "expected_total": expected_total,
            }
    return mapped
