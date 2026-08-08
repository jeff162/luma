# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
The ledger's currency setting — read on every app boot, written from Settings.

See `services/ledger_currency.py` for what the setting means and why it is tenant state. The only real
decision made *here* is the guard on changing it: nothing about the stored data changes, so the change
is instant and perfectly reversible, but it silently relabels every historical amount. That is exactly
the shape that warrants a confirmation rather than a prohibition — the app cannot tell a correction from
a mistake, and the user can.
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.db.database import get_db
from backend.services.ledger_currency import (
    COMMON_CURRENCIES,
    InvalidCurrencyCode,
    get_ledger_currency,
    is_default,
    normalize_currency_code,
    set_ledger_currency,
)

router = APIRouter()


class CurrencyRequest(BaseModel):
    code: str
    # The client's acknowledgement that it showed the relabelling warning and the user accepted it.
    # Required only when the ledger already holds transactions; see `_state` for why the count is the
    # trigger rather than, say, whether the value is currently the default.
    confirm: bool = False


def _transaction_count(conn) -> int:
    row = conn.execute("SELECT COUNT(*) AS n FROM txn WHERE trashed_at IS NULL").fetchone()
    return int(row["n"] or 0)


def _state(conn) -> dict:
    """What the setting is, and whether changing it needs confirming.

    `requires_confirmation` is derived from the ledger having rows rather than from the setting having
    been chosen before, because the risk is about *data*, not about the setting's history: an empty
    ledger has nothing to relabel, so the first-run case (which is when most people will set this) stays
    a single click. `transaction_count` travels with it so the dialog can say how many amounts are
    affected — a number does more to convey the scope than any wording would.
    """
    count = _transaction_count(conn)
    return {
        "code": get_ledger_currency(conn),
        "is_default": is_default(conn),
        "transaction_count": count,
        "requires_confirmation": count > 0,
        "common": [{"code": code, "label": label} for code, label in COMMON_CURRENCIES],
    }


@router.get("")
def get_currency():
    with get_db() as conn:
        return _state(conn)


@router.put("")
def set_currency(body: CurrencyRequest):
    with get_db() as conn:
        current = get_ledger_currency(conn)
        try:
            # Normalized before the no-op check so that re-saving the same currency in different case is
            # recognized as unchanged rather than demanding a confirmation for nothing.
            requested = normalize_currency_code(body.code)
        except InvalidCurrencyCode as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        if requested != current and _transaction_count(conn) > 0 and not body.confirm:
            # 409 rather than 400: the request is well-formed and the client is expected to retry it
            # verbatim with `confirm` once the user has agreed. The payload carries what the dialog needs
            # to say, so the client does not have to fetch state it was just told about.
            raise HTTPException(status_code=409, detail={
                "code": "currency_change_needs_confirmation",
                "message": (
                    f"This ledger holds {_transaction_count(conn)} transactions recorded as {current}. "
                    f"Switching to {requested} relabels every one of them — no amount is converted. "
                    f"Switching back restores {current} just as completely."
                ),
                "from": current,
                "to": requested,
                "transaction_count": _transaction_count(conn),
            })
        set_ledger_currency(conn, requested)
        return _state(conn)
