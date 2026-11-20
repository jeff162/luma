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

from bisect import bisect_right
from datetime import date
from typing import Callable, Optional

PROVIDER_SOURCE = "provider"
# Entered by hand, for an account nothing reports a balance for, or to correct one. A connection's next
# report is a later date and so becomes the anchor; the entry stays as a figure to reconcile against.
MANUAL_SOURCE = "manual"


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


def record_manual_balance(conn, account_id: str, as_of_date: str, balance: float) -> None:
    """Store a balance entered by hand, as the household's position on `as_of_date`, replacing an earlier
    entry for the same day."""
    conn.execute(
        """
        INSERT INTO account_balance (account_id, as_of_date, source, balance, available, recorded_at)
        VALUES (?, ?, ?, ?, NULL, datetime('now'))
        ON CONFLICT (account_id, as_of_date, source) DO UPDATE SET
            balance = excluded.balance, recorded_at = excluded.recorded_at
        """,
        (account_id, as_of_date, MANUAL_SOURCE, round(float(balance), 2)),
    )


def delete_manual_balance(conn, account_id: str, as_of_date: str) -> bool:
    """Remove a balance entered by hand. A provider's figure is not removable: its next sync restates it."""
    return conn.execute(
        "DELETE FROM account_balance WHERE account_id = ? AND as_of_date = ? AND source = ?",
        (account_id, as_of_date, MANUAL_SOURCE),
    ).rowcount > 0


# How old an account's latest stated balance may be before it is shown as stale, by where it came from. A
# connected account restates its balance on every sync, so a week without one means its feed has stopped; a
# balance entered by hand is typically copied from a monthly statement, so it is stale once a statement is
# missed.
STALE_AFTER_DAYS = {PROVIDER_SOURCE: 7, MANUAL_SOURCE: 35}

# How close together two members of a group must report for both to be live feeds.
LIVE_FEED_WINDOW_DAYS = 7


def current_balances(conn, today: Optional[date] = None, root_id: Optional[str] = None) -> dict:
    """Each account group's balance today, keyed by group root, or only `root_id`'s group when given.

    A group has one balance, anchored on the latest balance any member stated (the latest-recorded among
    those on the same day) and carried forward through the group's posted, live rows dated after it. The
    anchor is taken as that day's closing balance, so a row on the anchor's own date is already in it. A
    pending row is left out, as no source's stated balance counts one. A group with no stated balance is
    absent.

    `also_reporting` names the other members whose own latest balance falls within `LIVE_FEED_WINDOW_DAYS` of
    the anchor's: two live feeds into one group, where only one can be the group's balance."""
    today = today or date.today()
    scope = "WHERE COALESCE(a.parent_account_id, a.id) = ?" if root_id else ""
    scope_params = (root_id,) if root_id else ()
    anchors = {
        row["root_id"]: row for row in conn.execute(
            f"""
            SELECT COALESCE(a.parent_account_id, a.id) AS root_id, b.account_id, b.as_of_date, b.source,
                   b.balance, b.available, MAX(b.as_of_date || ' ' || b.recorded_at) AS latest
            FROM account_balance b
            JOIN account a ON a.id = b.account_id
            {scope}
            GROUP BY root_id
            """, scope_params)
    }
    member_latest = conn.execute(
        f"""
        SELECT COALESCE(a.parent_account_id, a.id) AS root_id, b.account_id, MAX(b.as_of_date) AS as_of_date
        FROM account_balance b
        JOIN account a ON a.id = b.account_id
        {scope}
        GROUP BY b.account_id
        """, scope_params).fetchall()
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
            "stated": anchor["balance"],
            "available": anchor["available"],
            "as_of_date": anchor["as_of_date"],
            "source": anchor["source"],
            "account_id": anchor["account_id"],
            "stale_after_days": STALE_AFTER_DAYS[anchor["source"]],
            "stale": (today - as_of).days > STALE_AFTER_DAYS[anchor["source"]],
            "also_reporting": sorted(
                m["account_id"] for m in member_latest
                if m["root_id"] == root_id and m["account_id"] != anchor["account_id"]
                and (as_of - date.fromisoformat(m["as_of_date"])).days <= LIVE_FEED_WINDOW_DAYS),
        }
    return result


def _group_ledger(conn, root_id: str) -> list:
    """The group's live, posted rows, oldest first, in the order the ledger lists them by date: by date,
    then by id. The id order within a day is arbitrary but fixed, and it is the order the list shows, so a
    running balance reads as cumulative down a list sorted by date."""
    return conn.execute(
        """
        SELECT t.id, t.date, t.amount
        FROM txn t
        JOIN account a ON a.id = t.account_id
        WHERE COALESCE(a.parent_account_id, a.id) = ? AND t.trashed_at IS NULL AND t.is_pending = 0
        ORDER BY t.date, t.id
        """, (root_id,)).fetchall()


def running_balances(conn, root_id: str, txn_ids) -> dict:
    """The group's balance just after each of `txn_ids`, `{txn_id: balance}`.

    Anchored on the group's balance today (`current_balances`), so every figure agrees with the Accounts
    page; earlier stated balances are checked against it rather than restarting it (`balance_checks`). A
    pending row, or a group with no stated balance, has none."""
    wanted = set(txn_ids)
    anchor = current_balances(conn, root_id=root_id).get(root_id)
    if not anchor or not wanted:
        return {}
    ledger = _group_ledger(conn, root_id)
    # The balance before the first row: today's balance with every row's movement undone.
    opening = anchor["amount"] + sum(row["amount"] for row in ledger)
    result, moved = {}, 0.0
    for row in ledger:
        moved += row["amount"]
        if row["id"] in wanted:
            result[row["id"]] = round(opening - moved, 2)
    return result


def balance_checks(conn, root_id: str) -> list:
    """Where the group's stated balances and its transactions disagree, newest first.

    Each pair of consecutive stated balances (by date, then when recorded) is a check: the transactions
    dated after the earlier one, up to and including the later one's date, should account for the change
    between them. A pair that differs by a cent or more is returned with both figures and `flag_txn_id`,
    the latest row in that span, where a list can mark it. Comparing neighbours rather than each figure to
    the latest one puts a missing or extra transaction in the one span it belongs to, instead of every
    figure before it."""
    stated = conn.execute(
        """
        SELECT b.account_id, b.as_of_date, b.source, b.balance
        FROM account_balance b
        JOIN account a ON a.id = b.account_id
        WHERE COALESCE(a.parent_account_id, a.id) = ?
        ORDER BY b.as_of_date, b.recorded_at
        """, (root_id,)).fetchall()
    if len(stated) < 2:
        return []
    ledger = _group_ledger(conn, root_id)
    dates = [row["date"] for row in ledger]
    moved_through = [0.0]
    for row in ledger:
        moved_through.append(moved_through[-1] + row["amount"])

    def through(day):
        # How many rows are dated on or before `day`, and how much they moved.
        index = bisect_right(dates, day)
        return index, moved_through[index]

    checks = []
    for earlier, later in zip(stated, stated[1:]):
        start, moved_before = through(earlier["as_of_date"])
        end, moved_by = through(later["as_of_date"])
        stated_change = round(later["balance"] - earlier["balance"], 2)
        ledger_change = round(moved_before - moved_by, 2)
        gap = round(stated_change - ledger_change, 2)
        if abs(gap) < 0.01:
            continue
        checks.append({
            "from_date": earlier["as_of_date"], "from_source": earlier["source"],
            "from_account_id": earlier["account_id"], "from_balance": earlier["balance"],
            "to_date": later["as_of_date"], "to_source": later["source"],
            "to_account_id": later["account_id"], "to_balance": later["balance"],
            "stated_change": stated_change, "ledger_change": ledger_change, "gap": gap,
            "flag_txn_id": ledger[end - 1]["id"] if end > start else None,
        })
    checks.reverse()
    return checks


def manual_balances(conn, account_id: str) -> list:
    """The balances entered by hand for one account, newest first."""
    return [dict(row) for row in conn.execute(
        "SELECT as_of_date, balance FROM account_balance WHERE account_id = ? AND source = ? "
        "ORDER BY as_of_date DESC", (account_id, MANUAL_SOURCE))]
