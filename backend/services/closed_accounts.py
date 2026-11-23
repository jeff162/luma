# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Closed accounts (`docs/data-model.md` → *Closing an account*).

`account.closed_on` is the last day the account was open: nothing should be dated after it. Any account can be
closed. Closing a group's root closes the group, members and all; closing a member retires that one account,
as a replaced card is, while the group goes on. Closing changes no row. It is a claim about what should arrive
later, and two things test the ledger against it:

- **A transaction dated after the close** (its own account's, or its group's if that came first) is imported
  like any other and counted here, which raises a Task
  that opens the `after-close` transaction attribute. Derived from the dates rather than recorded at arrival,
  so closing with a date the ledger already contradicts reports that at once: either the date or those rows
  are wrong.
- **A balance left on a closed group** is flagged on its row (`closed_balance_flag`), since a closed account
  holds nothing and a remainder usually means the final payment or transfer is missing. A closed member is not
  flagged: a group has one balance, and a replaced card's balance usually moves to its successor with no
  transaction to show for it. The user may say it
  does not matter; the dismissal names the close date, so closing again on another date asks again.
"""

from typing import Optional

from backend.services.signal_dismissals import dismissed_keys
from backend.services.transaction_attributes import AFTER_CLOSE_KEY, ATTRIBUTES_BY_KEY
from backend.services.transaction_facets import owner_membership

# The accounts closed themselves or in a closed group, so a scan of `txn` starts from its account index. With
# nothing closed it selects nothing, which is the usual case and keeps the Tasks poll from reading the ledger.
_CLOSED_ACCOUNTS_SQL = (
    "(SELECT a.id FROM account a LEFT JOIN account p ON p.id = a.parent_account_id "
    " WHERE a.closed_on IS NOT NULL OR p.closed_on IS NOT NULL)"
)


def after_close_count(conn, lens: Optional[list[str]] = None) -> int:
    """Live transactions dated after their account closed, over the lens owners' rows when given."""
    clauses = ["t.trashed_at IS NULL", f"t.account_id IN {_CLOSED_ACCOUNTS_SQL}",
               ATTRIBUTES_BY_KEY[AFTER_CLOSE_KEY].sql]
    params: list = []
    member = owner_membership(lens or [])
    if member:
        clauses.append(member[0])
        params.extend(member[1])
    return conn.execute(f"SELECT COUNT(*) FROM txn t WHERE {' AND '.join(clauses)}", params).fetchone()[0]


def close_dates(conn) -> dict[str, str]:
    """`{account_id: date}` for every account closed itself or through its group: the earlier of the two
    dates, the last day it could have a row on time."""
    return dict(conn.execute(
        "SELECT a.id, COALESCE(MIN(a.closed_on, p.closed_on), a.closed_on, p.closed_on) "
        "FROM account a LEFT JOIN account p ON p.id = a.parent_account_id "
        "WHERE a.closed_on IS NOT NULL OR p.closed_on IS NOT NULL").fetchall())


def closed_on_by_root(conn) -> dict[str, str]:
    """`{root_id: closed_on}` for every closed group."""
    return dict(conn.execute(
        "SELECT id, closed_on FROM account WHERE parent_account_id IS NULL AND closed_on IS NOT NULL").fetchall())


# The dismissal store's kind and key prefix for the flag (`services/signal_dismissals.py`).
CLOSED_BALANCE_KIND = "closed_balance"


def closed_balance_key(root_id: str, closed_on: str) -> str:
    return f"{CLOSED_BALANCE_KIND}:{root_id}:{closed_on}"


def closed_balance_flag(root_id: str, closed_on: Optional[str], balance: Optional[dict],
                        dismissed: set) -> Optional[dict]:
    """The balance a closed group still holds by the ledger, or None when it is open, holds nothing, has no
    known balance, or the flag was dismissed for this close date. `balance` is `current_balances`' entry."""
    if not closed_on or not balance or abs(balance["amount"]) < 0.005:
        return None
    if closed_balance_key(root_id, closed_on) in dismissed:
        return None
    return {"amount": balance["amount"], "closed_on": closed_on}


def closed_balance_flags(conn, balances: dict) -> dict[str, dict]:
    """`{root_id: flag}` for every closed group whose flag shows, given `current_balances`' result."""
    closed = closed_on_by_root(conn)
    if not closed:
        return {}
    dismissed = dismissed_keys(conn)
    flags = {root_id: closed_balance_flag(root_id, closed_on, balances.get(root_id), dismissed)
             for root_id, closed_on in closed.items()}
    return {root_id: flag for root_id, flag in flags.items() if flag}
