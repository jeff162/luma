# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Reimbursable expenses — the API over the reimbursement link.

Thin by design, like the purchase router: every rule about what may be grouped, what a residual is, and
where it may land lives in `services/reimbursements.py`, and this module turns HTTP into those calls.
Its one real job is turning a broken invariant into a 400 carrying the reason in the user's own terms —
a transaction with nothing in the holding group, a reimbursement that is already square, a residual
aimed at a category that cannot receive it. Each is something the screen can show and the user can act
on rather than an internal inconsistency.

**A reimbursement is its own noun.** It outlives any one of its transactions and is settled as a whole,
so it is addressed by its own id. Two reads deliberately hang elsewhere: "what reimbursement is this row
part of?" belongs to the transaction the detail panel is showing, and the outstanding report is a
listing rather than an instance, so it sits at the collection root.

**Roles are never accepted from the client.** Which member is an expense and which is a repayment
follows the sign of its claim, so a payload carrying a role would be a second truth able to disagree
with the ledger.

**A claim's amount is optional and usually omitted.** Left out it takes whatever of that row is still
unclaimed, which is the whole answer for an ordinary expense with one receivable portion. It is stated
only where a row is divided between reimbursements — two friends' portions of one charge, or an ATM
deposit repaying two debts — which is the case that made portions rather than rows the unit.
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.db.database import get_db
from backend.services.reimbursements import (
    ReimbursementError,
    add_claims,
    create_reimbursement,
    delete_reimbursement,
    get_reimbursement,
    outstanding,
    remove_transaction,
    complete,
    reopen,
    update_reimbursement,
)

router = APIRouter()


class ClaimIn(BaseModel):
    txn_id: str
    # Omitted claims whatever of the row is still unclaimed. See the module docstring.
    amount: Optional[float] = None
    # Display provenance copied from the split part the user picked ("Dave's ticket"). Never read for
    # arithmetic — the amount is what is authoritative.
    label: Optional[str] = None


class ReimbursementCreate(BaseModel):
    claims: list[ClaimIn]
    counterparty: Optional[str] = None


class ReimbursementUpdate(BaseModel):
    counterparty: Optional[str] = None


class ReimbursementMembers(BaseModel):
    claims: list[ClaimIn]


class CompleteRequest(BaseModel):
    # Where a residual goes — normally the category the original expense belonged to. Omitted when there
    # is nothing left over, which is the repaid-in-full case and needs no decision at all.
    category_id: Optional[str] = None
    # Which member carries it. Optional, because the sign already decides the *role* and there is
    # usually only one candidate; required by the service once a role has more than one, since nothing
    # in the ledger can say which expense fell short.
    target_txn_id: Optional[str] = None


def _guard(call):
    try:
        return call()
    except ReimbursementError as err:
        raise HTTPException(status_code=400, detail=str(err))


@router.get("/outstanding")
def read_outstanding():
    """Everything currently sitting in the holding group: the linked reimbursements, the loose rows that
    belong to none yet, and the total — which equals the group's own balance."""
    with get_db() as conn:
        return outstanding(conn)


@router.post("")
def create(body: ReimbursementCreate):
    with get_db() as conn:
        return _guard(lambda: create_reimbursement(
            conn,
            [claim.model_dump() for claim in body.claims],
            counterparty=body.counterparty,
        ))


@router.get("/{link_id}")
def read(link_id: str):
    with get_db() as conn:
        try:
            return get_reimbursement(conn, link_id)
        except ReimbursementError:
            raise HTTPException(status_code=404, detail="No such reimbursement.")


@router.patch("/{link_id}")
def update(link_id: str, body: ReimbursementUpdate):
    with get_db() as conn:
        return _guard(lambda: update_reimbursement(
            conn, link_id, counterparty=body.counterparty,
        ))


@router.post("/{link_id}/transactions")
def add(link_id: str, body: ReimbursementMembers):
    with get_db() as conn:
        return _guard(lambda: add_claims(
            conn, link_id, [claim.model_dump() for claim in body.claims],
        ))


@router.delete("/{link_id}/transactions/{txn_id}")
def remove(link_id: str, txn_id: str):
    """Detach one transaction. The reimbursement comes back as it now stands, or `reimbursement: null`
    when that was the last one and the grouping went with it — the difference between refreshing a panel
    and closing it."""
    with get_db() as conn:
        reimbursement = _guard(lambda: remove_transaction(conn, link_id, txn_id))
        return {"reimbursement": reimbursement}


@router.post("/{link_id}/complete")
def complete_reimbursement(link_id: str, body: CompleteRequest):
    """Finish a reimbursement — moving whatever is left over into a real category, if anything is."""
    with get_db() as conn:
        return _guard(lambda: complete(
            conn, link_id, category_id=body.category_id, target_txn_id=body.target_txn_id,
        ))


@router.delete("/{link_id}/complete")
def reopen_reimbursement(link_id: str):
    """Reopen it, restoring any allocations and claims completing it moved."""
    with get_db() as conn:
        return _guard(lambda: reopen(conn, link_id))


@router.delete("/{link_id}")
def unlink(link_id: str):
    with get_db() as conn:
        _guard(lambda: delete_reimbursement(conn, link_id))
        return {"ok": True}
