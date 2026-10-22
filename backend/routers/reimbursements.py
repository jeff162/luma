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
    DEFAULT_REMINDER_DAYS,
    MAX_REMINDER_DAYS,
    ReimbursementError,
    add_claims,
    create_reimbursement,
    default_reminder_days,
    delete_reimbursement,
    due_reminders,
    get_reimbursement,
    move_claim,
    outstanding,
    remove_transaction,
    complete,
    reopen,
    set_default_reminder_days,
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
    # A new record follows the household default unless it is given a date or switched off, so the
    # third state `ReimbursementUpdate` carries is not needed here.
    remind_on: Optional[str] = None
    clear_reminder: bool = False


class ReimbursementUpdate(BaseModel):
    counterparty: Optional[str] = None
    # The reminder has three states, so it takes three fields rather than one nullable date: a date of
    # its own, switched off (`clear_reminder`), or back to following the household default
    # (`follow_default_reminder`). See `services.reimbursements.update_reimbursement` for why "off" and
    # "follow the default" must not collapse into one empty value.
    remind_on: Optional[str] = None
    clear_reminder: bool = False
    follow_default_reminder: bool = False


class ReminderSettings(BaseModel):
    # 0 disables the default, which is not a dead end: a record can still be given a date of its own.
    reminder_days: int


class ReimbursementMembers(BaseModel):
    claims: list[ClaimIn]


class ClaimMove(BaseModel):
    """Re-attach a portion another reimbursement is holding. The amount is not accepted: what moves is
    the claim as it stands, so restating it would be a second truth able to disagree with the record it
    is being taken from."""
    txn_id: str
    from_link_id: str


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


@router.get("/settings")
def read_settings():
    """The household's default reminder gap. Ledger-level rather than per-user — one ledger has one
    answer, and the reminders are shown to everyone whoever's accounts they are on."""
    with get_db() as conn:
        return _settings_payload(default_reminder_days(conn))


@router.put("/settings")
def write_settings(body: ReminderSettings):
    with get_db() as conn:
        return _settings_payload(_guard(lambda: set_default_reminder_days(conn, body.reminder_days)))


def _settings_payload(days: int) -> dict:
    # The bounds ride along so the control can state them rather than discovering them by rejection.
    return {
        "reminder_days": days,
        "default_reminder_days": DEFAULT_REMINDER_DAYS,
        "max_reminder_days": MAX_REMINDER_DAYS,
    }


@router.get("/due")
def read_due():
    """Receivables that have gone quiet longer than they should have, grouped by whose they are. Backs
    the Tasks signal; exposed here so the report can say the same thing without a second definition."""
    with get_db() as conn:
        return due_reminders(conn)


@router.post("")
def create(body: ReimbursementCreate):
    with get_db() as conn:
        return _guard(lambda: create_reimbursement(
            conn,
            [claim.model_dump() for claim in body.claims],
            counterparty=body.counterparty,
            remind_on=body.remind_on,
            clear_reminder=body.clear_reminder,
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
            conn, link_id,
            counterparty=body.counterparty,
            remind_on=body.remind_on,
            clear_reminder=body.clear_reminder,
            follow_default_reminder=body.follow_default_reminder,
        ))


@router.post("/{link_id}/transactions")
def add(link_id: str, body: ReimbursementMembers):
    with get_db() as conn:
        return _guard(lambda: add_claims(
            conn, link_id, [claim.model_dump() for claim in body.claims],
        ))


@router.post("/{link_id}/transactions/move")
def move(link_id: str, body: ClaimMove):
    """Move a portion here from the reimbursement currently holding it — the fix for a row attached to
    the wrong record, which the ordinary picker cannot offer because it lists unclaimed money only."""
    with get_db() as conn:
        return _guard(lambda: move_claim(conn, link_id, body.txn_id, body.from_link_id))


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
