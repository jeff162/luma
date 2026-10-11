# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
The "flag new transactions for review" setting — read and written from Settings.

See `services/review_flagging.py` for what it governs. Like every other data route it checks no role:
it changes how this ledger's rows arrive, which is ordinary data work.
"""

from fastapi import APIRouter
from pydantic import BaseModel

from backend.db.database import get_db
from backend.services.review_flagging import flag_new_transactions, set_flag_new_transactions

router = APIRouter()


class ReviewFlaggingRequest(BaseModel):
    enabled: bool


@router.get("")
def get_review_flagging():
    with get_db() as conn:
        return {"enabled": flag_new_transactions(conn)}


@router.put("")
def set_review_flagging(body: ReviewFlaggingRequest):
    with get_db() as conn:
        return {"enabled": set_flag_new_transactions(conn, body.enabled)}
