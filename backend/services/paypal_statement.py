# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Read a PayPal monthly account statement (the PDF PayPal publishes for each month) into rows.

A statement is the easy way to get PayPal history: one PDF per month, or a zip of them, where the
activity download has to be requested and waited for. It lists the same transactions as the activity
CSV, with the same Transaction IDs, so its rows import through the same PayPal data source as the CSV's
and meet them in duplicate detection. What it lacks is the CSV's item title, time and status; what it
adds is each funding deposit's **Ref ID** — the Transaction ID of the payment it paid for — and the bank
account a bank-funded payment drew on.

**Only the first of the document's two statements is read.** The PDF holds a "PayPal account" statement
of all activity and then a "PayPal Balance account" statement, which repeats the rows that touched the
balance; reading both would import those twice.

**It is read from the text layer, by column.** `pypdf`'s layout mode keeps the printed columns in place,
so each transaction starts on a line carrying a date, a description, a currency and three amounts, and
the lines under it continue it: the rest of a date or description that wrapped, the funding detail
(indented further than the description, or carrying an amount), and last its `ID:` and `Ref ID:` lines.
A payment PayPal converted currency to pay prints the conversion among that detail, and it is kept on the
row (`services/paypal_conversions.py` restates the payment from it).
A transaction that does not end in an `ID:` line means the layout was not what this reader expects, and
the statement is refused whole rather than imported in part.

**The rows use the activity CSV's column names wherever the two mean the same thing** (Date, Name, Type,
Currency, Amount, Fees, Total, Transaction ID), so a statement row and a CSV row describe a payment the
same way. The description is split into Type and Name at its first colon, which is how the CSV has them
("Mobile Payment: Robin Vale" is the Type "Mobile Payment" and the Name "Robin Vale"); a type with no
name — a funding deposit — has an empty Name, as in the CSV.
"""

from __future__ import annotations

import hashlib
import io
import json
import re
from dataclasses import dataclass
from datetime import datetime
from typing import Optional

from pypdf import PdfReader

from backend.services.paypal_conversions import STATEMENT_EXCHANGE_KEY

STATEMENT_HEADERS = [
    "Date", "Type", "Name", "Currency", "Amount", "Fees", "Total", "Transaction ID", "Ref ID", "Bank account",
]

_AMOUNT = r"-?[\d,]+\.\d{2}"
_TRANSACTION_START = re.compile(
    rf"^(?P<indent>\s*)(?P<date>\d{{2}}/\d{{2}}/\d{{1,4}})\s{{2,}}(?P<description>\S.*?)\s{{2,}}"
    rf"(?P<currency>[A-Z]{{3}})\s{{2,}}(?P<amount>{_AMOUNT})\s{{2,}}(?P<fees>{_AMOUNT})\s{{2,}}(?P<total>{_AMOUNT})\s*$"
)
_FULL_DATE = re.compile(r"\d{2}/\d{2}/\d{4}")
_HAS_AMOUNT = re.compile(rf"(?<![\w.]){_AMOUNT}(?![\w.])")
_TRAILING_AMOUNT = re.compile(rf"\s+{_AMOUNT}(\s+[A-Z]{{3}})?\s*$")
_CURRENCY_ONLY = re.compile(r"[A-Z]{3}")
_ENDS_IN_CURRENCY = re.compile(r"\s[A-Z]{3}$")
_PERIOD = re.compile(r"([A-Z][a-z]+ \d{1,2}, \d{4})\s*-\s*([A-Z][a-z]+ \d{1,2}, \d{4})")
_EMAIL = re.compile(r"\S+@\S+")
_PAGE_NUMBER = re.compile(r"Page\s+\d+")


class StatementError(ValueError):
    """A PayPal statement this reader cannot read reliably."""


@dataclass(frozen=True)
class Statement:
    paypal_account_id: str
    holder: str
    period_start: str   # ISO dates
    period_end: str
    rows: list[dict]    # keyed by STATEMENT_HEADERS, plus a payment's printed conversion (STATEMENT_EXCHANGE_KEY)

    @property
    def content_hash(self) -> str:
        """What recognizes a statement imported before. Over what was read rather than the file's bytes,
        so the same month downloaded again — a new file, with the same content — is still recognized. Only
        the statement's columns count, so reading more of a row later does not make a month imported
        before look new."""
        rows = [{header: row[header] for header in STATEMENT_HEADERS} for row in self.rows]
        payload = json.dumps([self.paypal_account_id, self.period_start, self.period_end, rows], sort_keys=True)
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def is_pdf(data: bytes) -> bool:
    return data[:5] == b"%PDF-"


def read_statement(data: bytes) -> Optional[Statement]:
    """The statement a PDF holds, or None when the PDF is not a PayPal account statement."""
    try:
        reader = PdfReader(io.BytesIO(data))
        pages = [page.extract_text(extraction_mode="layout") or "" for page in reader.pages]
    # Deliberately broad: pypdf raises a wide and version-dependent range on malformed files.
    except Exception as e:
        raise StatementError("The PDF could not be read.") from e
    return parse_statement_pages(pages)


def parse_statement_pages(pages: list[str]) -> Optional[Statement]:
    """The statement in the layout text of a PDF's pages, or None when it is not a PayPal statement."""
    lines = [line.rstrip() for page in pages for line in page.splitlines()]
    stripped = [line.strip() for line in lines]
    if "ACCOUNT STATEMENTS" not in stripped or "PAYPAL ACCOUNT" not in stripped:
        return None
    if not any("PayPal Account ID" in line for line in lines):
        return None

    paypal_account_id, holder, period_start, period_end = _read_header(lines)
    start = stripped.index("PAYPAL ACCOUNT")
    end = stripped.index("PAYPAL BALANCE ACCOUNT") if "PAYPAL BALANCE ACCOUNT" in stripped[start:] else len(lines)
    rows = _read_activity(lines[start:end])
    return Statement(paypal_account_id, holder, period_start, period_end, rows)


def _read_header(lines: list[str]) -> tuple[str, str, str, str]:
    """The statement's PayPal Account ID, the holder's name, and the period it covers."""
    stripped = [line.strip() for line in lines]
    holder_at = stripped.index("ACCOUNT STATEMENTS") + 1
    holder = next((line for line in stripped[holder_at:] if line), "")

    labels_at = next(i for i, line in enumerate(lines) if "PayPal Account ID" in line)
    column = lines[labels_at].index("PayPal Account ID")
    left, right = [], []
    for line in lines[labels_at + 1:]:
        if not line.strip():
            if left or right:
                break
            continue
        left.append(line[:column].strip())
        right.append(line[column:].strip())
    period = _PERIOD.search(" ".join(part for part in left if part))
    if not period:
        raise StatementError("The statement period could not be read.")
    account = " ".join(part for part in right if part)
    email = _EMAIL.search(account)
    paypal_account_id = email.group(0) if email else account
    if not paypal_account_id:
        raise StatementError("The statement's PayPal Account ID could not be read.")
    return paypal_account_id, holder, _iso(period.group(1)), _iso(period.group(2))


def _iso(printed: str) -> str:
    """A printed period date as ISO. The month is spelled out or abbreviated ("May 1", "Apr 1")."""
    for fmt in ("%B %d, %Y", "%b %d, %Y"):
        try:
            return datetime.strptime(printed.replace("Sept ", "Sep "), fmt).date().isoformat()
        except ValueError:
            continue
    raise StatementError("The statement period could not be read.")


def _read_activity(lines: list[str]) -> list[dict]:
    """The transactions under the section's ACCOUNT ACTIVITY heading, in the order printed."""
    rows: list[dict] = []
    current: Optional[dict] = None
    for line in lines:
        start = _TRANSACTION_START.match(line)
        if start:
            if current is not None:
                _finish(current, rows)
            description_at = start.start("description")
            current = {
                "column": description_at, "date": start.group("date"),
                "description": [start.group("description").strip()], "bank": [], "detail": False,
                "currency": start.group("currency"), "amount": start.group("amount"),
                "fees": start.group("fees"), "total": start.group("total"),
                "id": None, "ref": None, "closed": False, "exchange": [],
            }
            continue
        if current is None or current["closed"] or not line.strip():
            continue
        column = current["column"]
        margin, rest = line[:column].strip(), line[column:]
        if margin:
            # Text left of the description column is either the rest of a wrapped date or not part of
            # the transaction at all (page furniture, a footnote).
            if margin.isdigit() and not _FULL_DATE.fullmatch(current["date"]):
                current["date"] += margin
            else:
                continue
        text = rest.strip()
        if not text or _PAGE_NUMBER.fullmatch(text):
            continue
        if text.startswith("Ref ID:"):
            current["ref"] = text[len("Ref ID:"):].strip()
            current["closed"] = True
            continue
        if text.startswith("ID:"):
            current["id"] = text[len("ID:"):].strip()
            continue
        if current["id"] is not None:
            # Anything after the ID line other than its Ref ID ends the transaction.
            current["closed"] = True
            continue
        indented = len(rest) - len(rest.lstrip()) > 0
        if indented and "(Exchange Rate)" in text:
            # The conversion PayPal made to pay it, its last currency often wrapped to the next line.
            current["exchange"] = [text]
            current["detail"] = True
        elif (len(current["exchange"]) == 1 and _CURRENCY_ONLY.fullmatch(text)
              and not _ENDS_IN_CURRENCY.search(current["exchange"][0])):
            current["exchange"].append(text)
            current["detail"] = True
        elif indented:
            current["bank"].append(_TRAILING_AMOUNT.sub("", text).strip())
            current["detail"] = True
        elif _CURRENCY_ONLY.fullmatch(text) or text.startswith("PayPal Balance") or _HAS_AMOUNT.search(text):
            current["detail"] = True
        elif not current["detail"]:
            current["description"].append(text)
    if current is not None:
        _finish(current, rows)
    return rows


def _finish(current: dict, rows: list[dict]) -> None:
    if not current["id"] or not _FULL_DATE.fullmatch(current["date"]):
        raise StatementError("A transaction in the statement could not be read.")
    description = " ".join(current["description"])
    kind, _, name = description.partition(":")
    row = {
        "Date": current["date"],
        "Type": kind.strip(),
        "Name": name.strip(),
        "Currency": current["currency"],
        "Amount": current["amount"],
        "Fees": current["fees"],
        "Total": current["total"],
        "Transaction ID": current["id"],
        "Ref ID": current["ref"] or "",
        "Bank account": " ".join(part for part in current["bank"] if part),
    }
    if current["exchange"]:
        row[STATEMENT_EXCHANGE_KEY] = " ".join(" ".join(current["exchange"]).split())
    rows.append(row)
