# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Restate a PayPal payment made in another currency in the ledger's currency, from the conversion PayPal
recorded for it.

The ledger holds one currency and stores a bare number (`services/ledger_currency.py`), so a payment in
pounds cannot be imported as written. But where PayPal converted dollars to pay it, the export says how
many dollars left, and that is the amount the purchase cost this ledger. The payment is imported at that
amount, under its own name and Transaction ID, with the conversion kept beside it as captured detail
("20.00 GBP = 25.40 USD", under `CONVERSION_EVIDENCE_HEADER`). From then on it is an ordinary payment: the
card deposit that funded it is its leg, and the card charge that deposit drew pairs with it, exactly as for
a payment made in dollars.

**The two formats state the conversion differently.** The activity CSV records it as two rows of its
own, with the payment's timestamp: a conversion out of dollars and a conversion into pounds. Those rows are
*absorbed*: what they say is on the payment now, and imported as well they would be money moving for
nothing. The statement prints no conversion rows; the payment carries a detail line instead
("25.40 USD X 0.7874 (Exchange Rate)  20.00 GBP"), which `services/paypal_statement.py` keeps on the row.

**Only an unambiguous conversion restates a payment.** The amount in the payment's currency must equal
what was paid, the other side must be in the ledger's currency, and the payment must carry no fee, since
a fee leaves the conversion covering something other than the payment's total. In the CSV, the payment
must be the only one in its currency at that timestamp, with exactly one conversion on each side. Anything
else — a payment received in another currency and kept there, two foreign payments in the same second — is
left as written and refused for its currency, as before.
"""

from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Optional

from backend.services.amount_text import DECIMAL_POINT, amount_text_parts
from backend.services.ledger_currency import currency_matches

# The label the conversion is captured under, shown with the transaction's other imported detail.
CONVERSION_EVIDENCE_HEADER = "Currency conversion"
# Where the statement reader keeps a payment's printed conversion. Not one of the statement's columns.
STATEMENT_EXCHANGE_KEY = "Exchange"

_CONVERSION_TYPE_FRAGMENT = "currency conversion"
_STATEMENT_EXCHANGE = re.compile(
    r"^(?P<from_amount>[\d,]+\.\d{2})\s+(?P<from_currency>[A-Z]{3})\s+X\s+[\d.,]+\s+\(Exchange Rate\)"
    r"\s+(?P<to_amount>[\d,]+\.\d{2})\s+(?P<to_currency>[A-Z]{3})$"
)

# Activity CSV columns, by cleaned header. Exports have named the money columns differently over the years.
_MONEY_HEADERS = ("amount", "gross", "total", "net")
_FEE_HEADERS = ("fees", "fee")
# The column the captured conversion is worded from: the one that is what moved, fees included.
_SETTLED_HEADERS = ("total", "net", "amount", "gross")


@dataclass(frozen=True)
class FoldedRows:
    """Rows with each restatable foreign payment restated in the ledger's currency. `conversions` gives,
    by row index, the conversion to capture on a restated payment; `absorbed` are the conversion rows whose
    content it now carries, which are not to be imported. Indexes are into `rows`, which keeps every row
    of the input in place, so row numbers still match the file."""
    rows: list[dict]
    conversions: dict[int, str] = field(default_factory=dict)
    absorbed: frozenset[int] = frozenset()


def is_conversion_type(type_value: Optional[str]) -> bool:
    return _CONVERSION_TYPE_FRAGMENT in str(type_value or "").casefold()


def conversion_text(original_amount: str, original_currency: str, settled_amount: str, settled_currency: str) -> str:
    """How a conversion is captured: unsigned amounts, the original first."""
    return f"{original_amount} {original_currency} = {settled_amount} {settled_currency}"


def _clean(header) -> str:
    return str(header or "").lstrip("﻿").strip().casefold()


def _is_ledger(code: str, ledger_currency: str) -> bool:
    return bool(code) and currency_matches(ledger_currency, code)


def _parts(text, decimal_separator: str) -> Optional[tuple[str, str]]:
    try:
        return amount_text_parts(str(text or "").strip(), decimal_separator)
    except ValueError:
        return None


def _value(parts: Optional[tuple[str, str]]) -> Optional[float]:
    if parts is None:
        return None
    sign, digits = parts
    return round(-float(digits) if sign == "-" else float(digits), 2)


def _no_fee(row: dict, fee_headers: list[str], decimal_separator: str) -> bool:
    for header in fee_headers:
        text = str(row.get(header) or "").strip()
        if text and _value(_parts(text, decimal_separator)) != 0:
            return False
    return True


def fold_activity_conversions(rows: list[dict], *, ledger_currency: str, decimal_separator: str) -> FoldedRows:
    """Restate the activity CSV's foreign payments that PayPal converted ledger currency to pay, absorbing
    the two conversion rows each one carries. Rows are grouped by their timestamp, which PayPal gives the
    payment and both of its conversions alike."""
    if not rows:
        return FoldedRows(rows=rows)
    by_clean = {_clean(header): header for header in rows[0]}
    type_h, currency_h = by_clean.get("type"), by_clean.get("currency")
    money = [by_clean[h] for h in _MONEY_HEADERS if h in by_clean]
    settled = next((by_clean[h] for h in _SETTLED_HEADERS if h in by_clean), None)
    fees = [by_clean[h] for h in _FEE_HEADERS if h in by_clean]
    if not (type_h and currency_h and settled and "date" in by_clean):
        return FoldedRows(rows=rows)
    stamp = [by_clean[h] for h in ("date", "time", "timezone") if h in by_clean]

    groups: dict[tuple, list[int]] = defaultdict(list)
    for index, row in enumerate(rows):
        groups[tuple(str(row.get(h) or "").strip() for h in stamp)].append(index)

    def currency(i: int) -> str:
        return str(rows[i].get(currency_h) or "").strip()

    def amount(i: int) -> Optional[float]:
        return _value(_parts(rows[i].get(settled), decimal_separator))

    out = list(rows)
    conversions: dict[int, str] = {}
    absorbed: set[int] = set()
    for members in groups.values():
        converting = [i for i in members if is_conversion_type(rows[i].get(type_h))]
        if len(converting) < 2:
            continue
        foreign = [i for i in members if i not in converting and currency(i)
                   and not _is_ledger(currency(i), ledger_currency) and amount(i)]
        for payment in foreign:
            code, paid = currency(payment), amount(payment)
            if sum(1 for i in foreign if currency(i) == code) != 1:
                continue
            into = [i for i in converting if currency(i) == code and amount(i) == -paid]
            out_of = [i for i in converting if _is_ledger(currency(i), ledger_currency)
                      and amount(i) and (amount(i) > 0) == (paid > 0)]
            if len(into) != 1 or len(out_of) != 1:
                continue
            (source,) = out_of
            if not (_no_fee(rows[payment], fees, decimal_separator) and _no_fee(rows[source], fees, decimal_separator)):
                continue
            restated = dict(rows[payment])
            restated[currency_h] = rows[source][currency_h]
            for header in money:
                restated[header] = rows[source].get(header, "")
            out[payment] = restated
            conversions[payment] = conversion_text(
                _parts(rows[payment][settled], decimal_separator)[1], code,
                _parts(rows[source][settled], decimal_separator)[1], currency(source),
            )
            absorbed.update((into[0], source))
    return FoldedRows(rows=out, conversions=conversions, absorbed=frozenset(absorbed))


def fold_statement_conversions(rows: list[dict], *, ledger_currency: str) -> FoldedRows:
    """Restate the statement's foreign payments from the conversion each one prints under it. The rows
    returned carry only the statement's own columns."""
    out: list[dict] = []
    conversions: dict[int, str] = {}
    for index, row in enumerate(rows):
        restated = {k: v for k, v in row.items() if k != STATEMENT_EXCHANGE_KEY}
        out.append(restated)
        code = str(row.get("Currency") or "").strip()
        exchange = _STATEMENT_EXCHANGE.fullmatch(str(row.get(STATEMENT_EXCHANGE_KEY) or "").strip())
        if not exchange or not code or _is_ledger(code, ledger_currency):
            continue
        sides = {exchange.group("from_currency"): exchange.group("from_amount"),
                 exchange.group("to_currency"): exchange.group("to_amount")}
        total = _parts(row.get("Total"), DECIMAL_POINT)
        ledger_side = next((c for c in sides if _is_ledger(c, ledger_currency)), None)
        if (len(sides) != 2 or ledger_side is None or code not in sides or total is None
                or _value(_parts(sides[code], DECIMAL_POINT)) != abs(_value(total))
                or _value(_parts(row.get("Fees"), DECIMAL_POINT)) != 0):
            continue
        settled = _parts(sides[ledger_side], DECIMAL_POINT)[1]
        signed = f"-{settled}" if total[0] == "-" else settled
        restated.update({"Currency": ledger_side, "Amount": signed, "Total": signed})
        conversions[index] = conversion_text(total[1], code, settled, ledger_side)
    return FoldedRows(rows=out, conversions=conversions)
