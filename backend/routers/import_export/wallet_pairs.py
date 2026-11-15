# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""The wallet reconciliation's HTTP surface: the report (for the whole ledger, or one import's rows) and
the decisions the user makes in it. The pairing and every rule it follows live in
`services/wallet_pairs.py`; this module only carries requests to it.

Every decision that changes what is available to pair runs the pass again before answering, so a row the
decision just made unambiguous is paired then and there rather than at the next import. The report itself
stays a read-only GET."""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.db.database import get_db
from backend.services import wallet_pairs

router = APIRouter()


@router.get("/wallet-pairs/report")
async def wallet_pair_report_endpoint(batch_id: Optional[str] = None):
    """The review: matched pairs, rows with several candidates, rows with none, and bank or card rows
    naming a wallet that nothing accounts for. `batch_id` scopes it to one import's wallet rows."""
    with get_db() as conn:
        if batch_id and not conn.execute("SELECT 1 FROM import_batch WHERE id = ?", (batch_id,)).fetchone():
            raise HTTPException(status_code=404, detail="Unknown batch")
        return wallet_pairs.wallet_pair_report(conn, batch_id)


@router.get("/wallet-pairs/candidates/{wallet_txn_id}")
async def wallet_pair_candidates_endpoint(wallet_txn_id: str):
    """What the manual picker offers for one wallet row, nearest first."""
    with get_db() as conn:
        return wallet_pairs.picker_candidates(conn, wallet_txn_id)


class PairRequest(BaseModel):
    wallet_txn_id: str
    counterpart_txn_id: str


@router.post("/wallet-pairs/pair")
async def wallet_pair_endpoint(body: PairRequest):
    with get_db() as conn:
        try:
            link_id = wallet_pairs.pair_rows(conn, body.wallet_txn_id, body.counterpart_txn_id)
        except wallet_pairs.PairingError as e:
            raise HTTPException(status_code=409, detail=str(e))
        return {"link_id": link_id, "also_paired": wallet_pairs.pair_after_decision(conn)}


class UnpairRequest(BaseModel):
    link_ids: list[str]


@router.post("/wallet-pairs/unpair")
async def wallet_unpair_endpoint(body: UnpairRequest):
    """Undo pairings; each pair is remembered as declined so it is not made again."""
    with get_db() as conn:
        unpaired = wallet_pairs.unpair(conn, body.link_ids)
        return {"unpaired": unpaired, "also_paired": wallet_pairs.pair_after_decision(conn)}


class DeclineRequest(BaseModel):
    wallet_txn_id: str
    counterpart_txn_ids: list[str]


@router.post("/wallet-pairs/decline")
async def wallet_decline_endpoint(body: DeclineRequest):
    """"None of these": no offered candidate is this wallet row's counterpart."""
    with get_db() as conn:
        declined = wallet_pairs.decline(conn, body.wallet_txn_id, body.counterpart_txn_ids)
        return {"declined": declined, "also_paired": wallet_pairs.pair_after_decision(conn)}


class ReviewedRequest(BaseModel):
    txn_ids: list[str]
    reviewed: bool = True


@router.post("/wallet-pairs/mark-reviewed")
async def wallet_mark_reviewed_endpoint(body: ReviewedRequest):
    """Acknowledge rows with nothing to pair, or take the acknowledgement back. No pass follows: a row
    being acknowledged changes nothing about what could pair with what."""
    with get_db() as conn:
        return {"updated": wallet_pairs.set_reviewed(conn, body.txn_ids, reviewed=body.reviewed)}
