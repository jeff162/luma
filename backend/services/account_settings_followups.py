# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Bring stored results up to date after an account's settings change.

Some results are worked out once, when a row arrives, from the settings of the account it lands on, and
then stored: a rule category (rules can be scoped by owner and account type) and a PayPal pairing (which
reads account type and owner). A later edit to those settings leaves them stale, and no ingest will revisit
the rows. Every write that changes an account's type or owner calls `settle_account_change` once it has
committed, and every stored result that reads those settings is brought up to date here — so a new one is
added in this one place rather than at each settings write. A result worked out when read (account groups,
the owner lens) needs nothing here.

**PayPal pairing runs first**, so a pairing the change releases has its row's category restored before the
rules see it, and a pairing the change makes has its bank row excluded before the rules would recategorize
it (the rules leave a row a feature excluded alone).

**The rules re-apply as "Run categorization" does** (`recategorize_all`, retaining): a hand-set category, a
hand-typed name and a tag added or removed by hand are kept, and a rule category nothing matches any more
is kept too, so an owner flipped away and back loses nothing.

Each step is best-effort and in its own connection: the settings change has already committed and stands,
so a failure is logged rather than reported as the change failing.
"""

from __future__ import annotations

from typing import Iterable

from backend.app_logging import log_error
from backend.db.database import get_db
from backend.services.categorizer import recategorize_all
from backend.services.paypal_funding import pair_paypal_funding
from backend.services.recurring_detection import owe_full_recurring_scan, settle_owed_rescans


def settle_account_change(account_ids: Iterable[str]) -> None:
    """Re-derive what the settings of `account_ids` decide, after the change to them has committed."""
    ids = sorted({i for i in account_ids if i})
    if not ids:
        return
    try:
        with get_db() as conn:
            pair_paypal_funding(conn)
    except Exception as e:
        log_error(f"[account-change] PayPal pairing failed: {e}", exc_info=e)
    try:
        with get_db() as conn:
            placeholders = ",".join("?" * len(ids))
            txn_ids = [r["id"] for r in conn.execute(
                f"""SELECT t.id FROM txn t JOIN account a ON a.id = t.account_id
                    WHERE  a.id IN ({placeholders}) OR a.parent_account_id IN ({placeholders})""",
                (*ids, *ids),
            )]
            # A re-applied rule can rename a row as well as recategorize it, and a rename moves a row between
            # payee groups, which a scoped rescan does not re-derive — so, like "Run categorization", a
            # change owes the full scan.
            if recategorize_all(conn, txn_ids=txn_ids):
                owe_full_recurring_scan(conn)
    except Exception as e:
        log_error(f"[account-change] re-applying rules failed: {e}", exc_info=e)
    settle_owed_rescans()
