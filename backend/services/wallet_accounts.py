# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Which accounts are wallets, and the text that finds a wallet's other side on a bank or card.

A wallet (a PayPal account, a person-to-person app) holds the real transaction and draws on a bank or card
to fund it, or cashes out to one. What crosses shows up on that other account under the wallet's name, and
`services/wallet_pairs.py` pairs the two so the money counts once. Being a wallet is what the account
*type* says (`paypal` or `p2p`), never a separate switch: a second answer to "what is this account" could
only disagree with the first.

The type does not name the service, so each wallet carries its **match text**
(`account.wallet_match_text`): the words a bank or card row contains when it is this wallet's other side.
NULL means never set, and is filled from what the account already says the moment it becomes a wallet
(`fill_wallet_match_text`). An empty string is the user saying this wallet has nothing to find, and is
kept. It is read from the account a row's account is merged into when that one has a value, the way type
is read."""

from __future__ import annotations

import sqlite3
from typing import Iterable, Optional

from backend.services.money_movement import PAYPAL_ACCOUNT_TYPE, PAYPAL_MATCH_TEXT

WALLET_ACCOUNT_TYPES = (PAYPAL_ACCOUNT_TYPE, "p2p")

# Shorter text would match inside unrelated descriptors and pair rows by coincidence of amount.
MIN_MATCH_TEXT_LENGTH = 3


class MatchTextError(ValueError):
    pass


def wallet_account_clause(alias: str, parent_alias: str) -> str:
    """A row's account is a wallet when it, or the account it is merged into, has a wallet type — a merged
    child keeps its rows under its own id."""
    types = ", ".join(f"'{t}'" for t in WALLET_ACCOUNT_TYPES)
    return (f"(COALESCE({alias}.type, '') IN ({types}) "
            f"OR COALESCE({parent_alias}.type, '') IN ({types}))")


def match_text_sql(alias: str, parent_alias: str) -> str:
    """The match text that applies to an account's rows: its group root's when that is set, else its own."""
    return f"COALESCE({parent_alias}.wallet_match_text, {alias}.wallet_match_text)"


def clean_match_text(value: Optional[str]) -> str:
    """The text as stored: trimmed, and either empty or long enough to be distinctive."""
    text = " ".join(str(value or "").split())
    if text and len(text) < MIN_MATCH_TEXT_LENGTH:
        raise MatchTextError(f"Match text needs at least {MIN_MATCH_TEXT_LENGTH} characters, or none.")
    return text


def match_text_after_retype(conn: sqlite3.Connection, account_id: str, new_type: str) -> None:
    """Bring an account's match text in line with a type it has just been given. Becoming a PayPal account
    says which service it is, so it takes PayPal's text whatever it held; any other type keeps what the
    account has, and a wallet that never had text is filled."""
    if new_type == PAYPAL_ACCOUNT_TYPE:
        conn.execute("UPDATE account SET wallet_match_text = ? WHERE id = ?", (PAYPAL_MATCH_TEXT, account_id))
    else:
        fill_wallet_match_text(conn, [account_id])


def fill_wallet_match_text(conn: sqlite3.Connection, account_ids: Optional[Iterable[str]] = None) -> int:
    """Give each wallet account that has never had match text the text it starts with: PayPal's for a
    PayPal account, else its name, else the institution it came from. The name comes first because a
    provider's institution label tends to carry a suffix ("<service> - Personal") that no bank descriptor
    repeats. Every account when `account_ids` is None. Returns the number filled."""
    types = ", ".join("?" for _ in WALLET_ACCOUNT_TYPES)
    sql = f"""UPDATE account
              SET    wallet_match_text = CASE WHEN type = ? THEN ?
                                              ELSE COALESCE(NULLIF(TRIM(name), ''), TRIM(institution)) END
              WHERE  wallet_match_text IS NULL AND type IN ({types})"""
    params: list = [PAYPAL_ACCOUNT_TYPE, PAYPAL_MATCH_TEXT, *WALLET_ACCOUNT_TYPES]
    if account_ids is not None:
        ids = [i for i in account_ids if i]
        if not ids:
            return 0
        sql += f" AND id IN ({', '.join('?' for _ in ids)})"
        params.extend(ids)
    return conn.execute(sql, params).rowcount
