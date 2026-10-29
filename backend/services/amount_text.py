# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Reading a number out of the text a file wrote for it.

A file writes its amounts in one of two conventions, and the same characters mean different numbers in
each: `1.234` is one and a quarter with a decimal point and twelve hundred with a decimal comma. Nothing
in the cell says which, so the convention is a property of the *source*, stated once per data source
(`csv_import_profile.decimal_separator`) and inferred from a sample file as a suggestion. It is not the
ledger's currency: a ledger in one currency can receive files written either way.

The parse is strict. A cell is accepted only in a form that is a well-formed number in the stated
convention — thousands groups of exactly three digits, one decimal mark — and anything else raises.
Discarding separators and hoping is what turned `1.234,56` into `1.23456`: a wrong number stored
without a word, where a refused row is reported and fixed by picking the other convention.

Around the number, a currency symbol (any of Unicode's), whitespace, a leading sign and accounting
parentheses are accepted. A `DR`/`CR` suffix is the caller's to strip, because it names a direction and
only the caller knows what direction means.
"""

from __future__ import annotations

import re
import unicodedata
from typing import Literal, get_args

DecimalSeparator = Literal["point", "comma"]
DECIMAL_POINT, DECIMAL_COMMA = DECIMAL_SEPARATORS = get_args(DecimalSeparator)

# The digits of an unsigned number, by convention: an integer part (plain, or grouped in threes) and an
# optional fractional part. Either part may be absent but not both, which the digit check enforces.
_NUMBER_BY_SEPARATOR = {
    DECIMAL_POINT: (re.compile(r"(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d*)?"), ",", "."),
    DECIMAL_COMMA: (re.compile(r"(?:\d{1,3}(?:\.\d{3})+|\d+)?(?:,\d*)?"), ".", ","),
}

_SIGNED = re.compile(r"(?P<sign>[+\-−]?)(?P<body>[\d.,]+)|\((?P<paren>[\d.,]+)\)")


def amount_text_parts(text: str, decimal_separator: str) -> tuple[str, str]:
    """`(sign, digits)` for the number `text` writes in the given convention: the sign is `-`, `+` or empty,
    and the digits are ungrouped with a `.` decimal mark, keeping as many decimals as were written (`12,5`
    in the comma convention is `("", "12.5")`). Raises `ValueError` for anything that is not a number.

    For a caller that needs what was typed and not only its value, such as the ledger's search box, which
    reads `77.4` as a range of cents that `77.40` is not."""
    try:
        number, group, decimal = _NUMBER_BY_SEPARATOR[decimal_separator]
    except KeyError:
        raise ValueError(f"unknown decimal separator {decimal_separator!r}") from None
    compact = "".join(
        ch for ch in str(text) if not ch.isspace() and unicodedata.category(ch) != "Sc"
    )
    match = _SIGNED.fullmatch(compact)
    if not match:
        raise ValueError(f"not an amount: {text!r}")
    body = match.group("body") or match.group("paren")
    if not number.fullmatch(body) or not any(ch.isdigit() for ch in body):
        raise ValueError(f"not an amount: {text!r}")
    digits = body.replace(group, "").replace(decimal, ".")
    if match.group("paren") is not None or match.group("sign") in ("-", "−"):
        return "-", digits
    return match.group("sign"), digits


def parse_amount_text(text: str, decimal_separator: str) -> float:
    """The signed number `text` writes in the given convention. Raises `ValueError` for anything that is
    not one, including a blank cell."""
    sign, digits = amount_text_parts(text, decimal_separator)
    value = float(digits)
    return -value if sign == "-" else value
