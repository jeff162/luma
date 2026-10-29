# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
How the person asking writes dates and numbers, for reading what they type.

The ledger's search box is free text resolved on the server, and `02/01/2026` or `1.234` mean different
things to different people. Each person chooses a date order and a number format; the frontend writes
everything it displays in them (`frontend/src/lib/displayFormat.js`), and these are the same two stored
preferences, read here so that what a person types is read the way the app writes to them.

Read from the store rather than sent with each request so there is one answer: the list, the CSV export
and a bulk action over "everything matching" all resolve the same filter against the same reading, and
no caller can pass a reading that disagrees with what the person chose.

An unset or unrecognized value reads as the default, month first with a decimal point, which is what the
app does for anyone who never chooses.
"""

from __future__ import annotations

import json
from dataclasses import dataclass

from fastapi import Request

from backend.services.amount_text import DECIMAL_COMMA, DECIMAL_POINT
from backend.services.preferences import get_preference_values

# The frontend's `DATE_ORDER_PREF_KEY` / `NUMBER_FORMAT_PREF_KEY`, and their values.
DATE_ORDER_PREF_KEY = "ui.format.dateOrder"
NUMBER_FORMAT_PREF_KEY = "ui.format.number"

DATE_ORDER_MDY, DATE_ORDER_DMY, DATE_ORDER_YMD = DATE_ORDERS = ("mdy", "dmy", "ymd")

# Two number formats write a decimal comma; they differ only in grouping, and a space group is whitespace,
# which the amount parser drops.
_DECIMAL_SEPARATOR_BY_NUMBER_FORMAT = {"point": DECIMAL_POINT, "comma": DECIMAL_COMMA, "space": DECIMAL_COMMA}


@dataclass(frozen=True)
class InputFormat:
    date_order: str = DATE_ORDER_MDY
    decimal_separator: str = DECIMAL_POINT


DEFAULT_INPUT_FORMAT = InputFormat()


def _stored(values: dict[str, str], key: str):
    try:
        return json.loads(values[key])
    except (KeyError, TypeError, ValueError):
        return None


def input_format_for(scope_id: str | None) -> InputFormat:
    if not scope_id:
        return DEFAULT_INPUT_FORMAT
    values = get_preference_values(scope_id, (DATE_ORDER_PREF_KEY, NUMBER_FORMAT_PREF_KEY))
    date_order = _stored(values, DATE_ORDER_PREF_KEY)
    number_format = _stored(values, NUMBER_FORMAT_PREF_KEY)
    return InputFormat(
        date_order=date_order if date_order in DATE_ORDERS else DATE_ORDER_MDY,
        decimal_separator=_DECIMAL_SEPARATOR_BY_NUMBER_FORMAT.get(number_format, DECIMAL_POINT),
    )


def caller_input_format(request: Request) -> InputFormat:
    """The reading for the identity the request resolved to, as a FastAPI dependency."""
    user = getattr(request.state, "user", None)
    return input_format_for(user["id"] if user else None)


def coerce_input_format(value) -> InputFormat:
    """`value` if it is a reading, else the default. A direct (non-HTTP) caller that omits the dependency
    passes its unresolved sentinel."""
    return value if isinstance(value, InputFormat) else DEFAULT_INPUT_FORMAT
