# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Multi-payment purchases — the API over the purchase link.

Thin by design: every rule about what may be grouped with what lives in `services/purchase_links.py`,
and this module turns HTTP into those calls. Its one real job is turning a broken invariant into a 400
carrying the reason in the user's own terms, because each of them is something the dialog can show and
the user can act on — a payment already in another purchase, a selection of one, a row in the trash.

**A purchase is its own noun, not a sub-resource of a transaction.** It outlives any one of its
payments (removing one leaves the purchase standing) and is edited as a whole, so it is addressed by
its own id. The single transaction-scoped read — "what purchase is this row part of?" — hangs off the
transaction, where the detail panel asks it from.
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.db.database import get_db
from backend.services.purchase_links import (
    PurchaseLinkError,
    add_payments,
    create_purchase,
    delete_purchase,
    get_purchase,
    remove_payment,
    update_purchase,
)

router = APIRouter()


class PurchaseCreate(BaseModel):
    txn_ids: list[str]
    label: Optional[str] = None
    reference: Optional[str] = None
    # Signed, in the ledger's convention (positive is money out) like every other amount the API
    # carries. The client derives the sign from the payments it is linking; see the service docstring.
    expected_total: Optional[float] = None


class PurchaseUpdate(BaseModel):
    label: Optional[str] = None
    reference: Optional[str] = None
    expected_total: Optional[float] = None


class PurchaseMembers(BaseModel):
    txn_ids: list[str]


def _guard(call):
    try:
        return call()
    except PurchaseLinkError as err:
        raise HTTPException(status_code=400, detail=str(err))


@router.post("")
def create(body: PurchaseCreate):
    with get_db() as conn:
        return _guard(lambda: create_purchase(
            conn, body.txn_ids,
            label=body.label, reference=body.reference, expected_total=body.expected_total,
        ))


@router.get("/{link_id}")
def read(link_id: str):
    with get_db() as conn:
        try:
            return get_purchase(conn, link_id)
        except PurchaseLinkError:
            raise HTTPException(status_code=404, detail="No such purchase.")


@router.patch("/{link_id}")
def update(link_id: str, body: PurchaseUpdate):
    with get_db() as conn:
        return _guard(lambda: update_purchase(
            conn, link_id,
            label=body.label, reference=body.reference, expected_total=body.expected_total,
        ))


@router.post("/{link_id}/payments")
def add(link_id: str, body: PurchaseMembers):
    with get_db() as conn:
        return _guard(lambda: add_payments(conn, link_id, body.txn_ids))


@router.delete("/{link_id}/payments/{txn_id}")
def remove(link_id: str, txn_id: str):
    """Detach one payment. The purchase comes back as it now stands, or `purchase: null` when dropping
    that payment left too few for it to be a purchase and the grouping went with it — which the caller
    needs to know, since it is the difference between refreshing a panel and closing it."""
    with get_db() as conn:
        purchase = _guard(lambda: remove_payment(conn, link_id, txn_id))
        return {"purchase": purchase}


@router.delete("/{link_id}")
def unlink(link_id: str):
    with get_db() as conn:
        _guard(lambda: delete_purchase(conn, link_id))
        return {"ok": True}
