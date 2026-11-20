# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Account balances: what a source stated an account held on a date.

Only stated balances are stored. A balance on any other date is the ledger's to derive, by working from
the nearest stated one through the transactions in between, so nothing stored has to be kept in step with
later edits to the ledger (`docs/data-model.md` → *Account balances*).

**`balance` is the household's position**: positive for money held, negative for money owed. Each source
converts its own convention on the way in, so derivation and totals never ask what kind of account a
number came from. A transaction's `amount` is positive for money out, so it lowers the position on every
account type alike.

**One row per account, date and source.** A source restating a date overwrites its earlier figure for that
date, since a provider re-reports the same day's balance on every sync.
"""

from typing import Callable, Optional

PROVIDER_SOURCE = "provider"


def record_provider_balances(conn, balances: Optional[dict],
                             account_for: Callable[[str], Optional[dict]]) -> int:
    """Store the balances a pull reported, keyed `{external_account_id: {balance, available, as_of}}` as the
    adapter contract states (`ProviderAdapter.fetch_transactions_sync`). A provider account with no local
    account (unmapped, or set to Skip) has nowhere to record one and is passed over. Returns how many were
    recorded."""
    recorded = 0
    for external_account_id, reported in (balances or {}).items():
        account = account_for(external_account_id)
        if account is None or reported.get("balance") is None or not reported.get("as_of"):
            continue
        conn.execute(
            """
            INSERT INTO account_balance (account_id, as_of_date, source, balance, available, recorded_at)
            VALUES (?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT (account_id, as_of_date, source) DO UPDATE SET
                balance = excluded.balance, available = excluded.available, recorded_at = excluded.recorded_at
            """,
            (account["id"], reported["as_of"], PROVIDER_SOURCE, float(reported["balance"]),
             None if reported.get("available") is None else float(reported["available"])),
        )
        recorded += 1
    return recorded
