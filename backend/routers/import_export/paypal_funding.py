# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""The PayPal reconciliation's HTTP surface: the report (for the whole ledger, or one import's rows) and
the decisions the user makes in it. The pairing and every rule it follows live in
`services/paypal_funding.py`; this module only carries requests to it."""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.db.database import get_db
from backend.services import paypal_funding

router = APIRouter()


@router.get("/paypal-funding/report")
async def paypal_funding_report_endpoint(batch_id: Optional[str] = None):
    """The review: matched pairs, rows with several candidates, rows with none, and PayPal-looking bank or
    card rows nothing accounts for. `batch_id` scopes it to one import's PayPal rows."""
    with get_db() as conn:
        if batch_id and not conn.execute("SELECT 1 FROM import_batch WHERE id = ?", (batch_id,)).fetchone():
            raise HTTPException(status_code=404, detail="Unknown batch")
        return paypal_funding.paypal_funding_report(conn, batch_id)


@router.get("/paypal-funding/candidates/{paypal_txn_id}")
async def paypal_funding_candidates_endpoint(paypal_txn_id: str):
    """What the manual picker offers for one PayPal row, nearest first."""
    with get_db() as conn:
        return paypal_funding.picker_candidates(conn, paypal_txn_id)


class PairRequest(BaseModel):
    paypal_txn_id: str
    counterpart_txn_id: str


@router.post("/paypal-funding/pair")
async def paypal_funding_pair_endpoint(body: PairRequest):
    with get_db() as conn:
        try:
            link_id = paypal_funding.pair_rows(conn, body.paypal_txn_id, body.counterpart_txn_id)
        except paypal_funding.PairingError as e:
            raise HTTPException(status_code=409, detail=str(e))
        return {"link_id": link_id}


class UnpairRequest(BaseModel):
    link_ids: list[str]


@router.post("/paypal-funding/unpair")
async def paypal_funding_unpair_endpoint(body: UnpairRequest):
    """Undo pairings; each pair is remembered as declined so it is not made again."""
    with get_db() as conn:
        return {"unpaired": paypal_funding.unpair(conn, body.link_ids)}


class DeclineRequest(BaseModel):
    paypal_txn_id: str
    counterpart_txn_ids: list[str]


@router.post("/paypal-funding/decline")
async def paypal_funding_decline_endpoint(body: DeclineRequest):
    """"None of these": no offered candidate is this PayPal row's counterpart."""
    with get_db() as conn:
        return {"declined": paypal_funding.decline(conn, body.paypal_txn_id, body.counterpart_txn_ids)}


class ReviewedRequest(BaseModel):
    txn_ids: list[str]
    reviewed: bool = True


@router.post("/paypal-funding/mark-reviewed")
async def paypal_funding_mark_reviewed_endpoint(body: ReviewedRequest):
    """Acknowledge rows with nothing to pair, or take the acknowledgement back."""
    with get_db() as conn:
        return {"updated": paypal_funding.set_reviewed(conn, body.txn_ids, reviewed=body.reviewed)}
