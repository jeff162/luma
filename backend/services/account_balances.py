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

from datetime import date
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


# How old an account's latest stated balance may be before it is shown as stale, and how close together two
# members of a group must report for both to be live feeds. A connected account restates its balance on every
# sync, so a week without one means its feed has stopped.
STALE_AFTER_DAYS = 7


def current_balances(conn, today: Optional[date] = None) -> dict:
    """Each account group's balance today, keyed by group root.

    A group has one balance, anchored on the latest balance any member stated (the latest-recorded among
    those on the same day) and carried forward through the group's posted, live rows dated after it. The
    anchor is taken as that day's closing balance, so a row on the anchor's own date is already in it. A
    pending row is left out, as no source's stated balance counts one. A group with no stated balance is
    absent.

    `also_reporting` names the other members whose own latest balance falls within `STALE_AFTER_DAYS` of
    the anchor's: two live feeds into one group, where only one can be the group's balance."""
    today = today or date.today()
    anchors = {
        row["root_id"]: row for row in conn.execute(
            """
            SELECT COALESCE(a.parent_account_id, a.id) AS root_id, b.account_id, b.as_of_date, b.source,
                   b.balance, b.available, MAX(b.as_of_date || ' ' || b.recorded_at) AS latest
            FROM account_balance b
            JOIN account a ON a.id = b.account_id
            GROUP BY root_id
            """)
    }
    member_latest = conn.execute(
        """
        SELECT COALESCE(a.parent_account_id, a.id) AS root_id, b.account_id, MAX(b.as_of_date) AS as_of_date
        FROM account_balance b
        JOIN account a ON a.id = b.account_id
        GROUP BY b.account_id
        """).fetchall()
    result = {}
    for root_id, anchor in anchors.items():
        as_of = date.fromisoformat(anchor["as_of_date"])
        later = conn.execute(
            """
            SELECT COALESCE(SUM(t.amount), 0)
            FROM txn t
            JOIN account a ON a.id = t.account_id
            WHERE COALESCE(a.parent_account_id, a.id) = ? AND t.date > ?
              AND t.trashed_at IS NULL AND t.is_pending = 0
            """, (root_id, anchor["as_of_date"])).fetchone()[0]
        result[root_id] = {
            # A transaction's amount is positive for money out, so it lowers the position.
            "amount": round(anchor["balance"] - later, 2),
            "available": anchor["available"],
            "as_of_date": anchor["as_of_date"],
            "source": anchor["source"],
            "account_id": anchor["account_id"],
            "stale": (today - as_of).days > STALE_AFTER_DAYS,
            "also_reporting": sorted(
                m["account_id"] for m in member_latest
                if m["root_id"] == root_id and m["account_id"] != anchor["account_id"]
                and (as_of - date.fromisoformat(m["as_of_date"])).days <= STALE_AFTER_DAYS),
        }
    return result
