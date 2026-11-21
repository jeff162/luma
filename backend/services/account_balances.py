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

# The two days a row can be placed on. A source's stated balance counts rows by when they posted, so
# today's balance and the checks against stated balances use `posted`; a running balance follows whichever
# the list is ordered by, or it would not read as a running total down the list. A row whose source gave
# one date has it as both.
BALANCE_DAY_SQL = {"date": "t.date", "posted": "COALESCE(t.posted_date, t.date)"}

# Within one day, credits before debits, as banks generally post them, then by id so the order is fixed.
# The list's date sorts tie-break the same way (`routers/transactions.py`), so the running balance reads
# as cumulative down the rows.
IN_DAY_ORDER_SQL = "CASE WHEN t.amount < 0 THEN 0 ELSE 1 END"

PROVIDER_SOURCE = "provider"
# Entered by hand, for an account nothing reports a balance for, or to correct one. A connection's next
# report is a later date and so becomes the anchor; the entry stays as a figure to reconcile against.
MANUAL_SOURCE = "manual"
# Read from a balance column in an imported file. Each carries the batch it came from and goes when that
# batch is undone; it is not removable on its own, since one figure from a file is no more wrong than the
# rest of it.
IMPORT_SOURCE = "import"

# Which side of zero each type's balance belongs on: money held, money owed, or about none for a wallet or
# marketplace, which money passes through. The same judgement colours a balance on the Accounts page
# (`NORMAL_BALANCE_SIDE` in `frontend/src/lib/accountTypes.js`); keep the two in step.
NORMAL_BALANCE_SIDE = {
    "depository": "held", "savings": "held", "investment": "held",
    "credit": "owed", "loan": "owed",
    "paypal": "zero", "p2p": "zero", "amazon": "zero",
}


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


# How far a row's balance may differ from what its neighbour's and its amount make it before the two are
# taken to disagree: rounding to the cent, and no more.
_BALANCE_MATCH_TOLERANCE = 0.005
# The share of neighbouring rows that must agree on one reading of a file's balance column before it is
# trusted. Not all of them: a fee a bank applies without a row of its own breaks one pair, and refusing a
# whole file's balances for it would lose every other day.
_BALANCE_AGREEMENT = 0.9


def balances_from_column(rows: list, account_type: Optional[str]) -> tuple[dict, Optional[str]]:
    """The closing balance of each date, as the household's position, from one account's rows of a file
    that states a balance after each row. `rows` are `(date, amount, balance)` in the file's order, with
    `amount` as stored (positive is money out) and `balance` as the file wrote it, or None where its cell
    could not be read. Returns `({date: balance}, None)`, or `({}, reason)` when the column does not read
    as a running balance.

    A file may list its rows oldest first or newest first, and may state a card's balance as what is owed.
    Both are read from the file itself: between neighbouring rows the balance changes by the later row's
    amount, and which row is later and which way the change goes say the order and the sign together. The
    account's type decides the sign only when no two neighbouring rows have balances to compare."""
    readings = []
    for newest_first in (False, True):
        for owed in (False, True):
            agree = compared = 0
            for earlier, later in zip(rows, rows[1:]):
                if newest_first:
                    earlier, later = later, earlier
                if earlier[2] is None or later[2] is None:
                    continue
                compared += 1
                change = later[2] - earlier[2]
                # A position falls by money out; a balance owed rises by it.
                expected = later[1] if owed else -later[1]
                agree += abs(change - expected) <= _BALANCE_MATCH_TOLERANCE
            readings.append((agree, compared, newest_first, owed))
    dates = [row[0] for row in rows]
    by_dates = None if dates[0] == dates[-1] else dates[0] > dates[-1]
    compared = readings[0][1]
    if compared:
        candidates = [r for r in readings if by_dates is None or r[2] == by_dates]
        agree, _, newest_first, owed = max(candidates, key=lambda r: r[0])
        if agree < compared * _BALANCE_AGREEMENT:
            return {}, "the balance column does not follow the amounts"
    else:
        newest_first = bool(by_dates)
        owed = NORMAL_BALANCE_SIDE.get(account_type or "") == "owed"
    closing = {}
    for day, _amount, balance in (reversed(rows) if newest_first else rows):
        # The day's last row in time is its closing; a later row on the same day replaces an earlier one,
        # and an unreadable cell there leaves the day without one rather than taking an earlier row's.
        closing[day] = balance
    return {
        day: round(-balance if owed else balance, 2)
        for day, balance in closing.items() if balance is not None
    }, None


def record_imported_balances(conn, batch_id: str, balances: dict) -> int:
    """Store the closing balances an imported file stated, keyed `{(account_id, date): balance}`, against the
    batch that brought them. A later file stating the same date restates it, as a provider does."""
    conn.executemany(
        """
        INSERT INTO account_balance
            (account_id, as_of_date, source, balance, available, recorded_at, import_batch_id)
        VALUES (?, ?, ?, ?, NULL, datetime('now'), ?)
        ON CONFLICT (account_id, as_of_date, source) DO UPDATE SET
            balance = excluded.balance, recorded_at = excluded.recorded_at,
            import_batch_id = excluded.import_batch_id
        """,
        [(account_id, day, IMPORT_SOURCE, balance, batch_id) for (account_id, day), balance in balances.items()],
    )
    return len(balances)


def delete_manual_balance(conn, account_id: str, as_of_date: str) -> bool:
    """Remove a balance entered by hand. A provider's figure is not removable: its next sync restates it."""
    return conn.execute(
        "DELETE FROM account_balance WHERE account_id = ? AND as_of_date = ? AND source = ?",
        (account_id, as_of_date, MANUAL_SOURCE),
    ).rowcount > 0


# How old an account's latest stated balance may be before it is shown as stale, by where it came from. A
# connected account restates its balance on every sync, so a week without one means its feed has stopped; a
# balance entered by hand or imported from a file is typically from a monthly statement, so it is stale once
# a statement is missed.
STALE_AFTER_DAYS = {PROVIDER_SOURCE: 7, MANUAL_SOURCE: 35, IMPORT_SOURCE: 35}

# How close together two members of a group must report for both to be live feeds.
LIVE_FEED_WINDOW_DAYS = 7


def current_balances(conn, today: Optional[date] = None, root_id: Optional[str] = None) -> dict:
    """Each account group's balance today, keyed by group root, or only `root_id`'s group when given.

    A group has one balance, anchored on the latest balance any member stated (the latest-recorded among
    those on the same day) and carried forward through the group's posted, live rows that posted after it.
    The anchor is taken as that day's closing balance, so a row posted on the anchor's own date is already
    in it. A pending row is left out, as no source's stated balance counts one. A group with no stated
    balance is absent.

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
            f"""
            SELECT COALESCE(SUM(t.amount), 0)
            FROM txn t
            JOIN account a ON a.id = t.account_id
            WHERE COALESCE(a.parent_account_id, a.id) = ? AND {BALANCE_DAY_SQL["posted"]} > ?
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


def _group_ledger(conn, root_id: str, basis: str) -> list:
    """The group's live, posted rows, oldest first, placed by `basis` (`BALANCE_DAY_SQL`) and ordered within
    a day by `IN_DAY_ORDER_SQL`. `day` is the date each row is placed on."""
    return conn.execute(
        f"""
        SELECT t.id, {BALANCE_DAY_SQL[basis]} AS day, t.amount
        FROM txn t
        JOIN account a ON a.id = t.account_id
        WHERE COALESCE(a.parent_account_id, a.id) = ? AND t.trashed_at IS NULL AND t.is_pending = 0
        ORDER BY day, {IN_DAY_ORDER_SQL}, t.id
        """, (root_id,)).fetchall()


def running_balances(conn, root_id: str, txn_ids, basis: str = "date") -> dict:
    """The group's balance just after each of `txn_ids`, `{txn_id: balance}`, counting rows in `basis`
    order (`BALANCE_DAY_SQL`), the date the list is ordered by.

    Anchored on the group's balance today (`current_balances`), so every figure agrees with the Accounts
    page; earlier stated balances are checked against it rather than restarting it (`balance_checks`). A
    pending row, or a group with no stated balance, has none."""
    wanted = set(txn_ids)
    anchor = current_balances(conn, root_id=root_id).get(root_id)
    if not anchor or not wanted:
        return {}
    ledger = _group_ledger(conn, root_id, basis)
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
    posted after the earlier one, up to and including the later one's date, should account for the change
    between them, counted by posting date because that is what a source's balance counts. A pair that
    differs by a cent or more is returned with both figures and `flag_txn_id`, the latest row in that span,
    where a list can mark it. Comparing neighbours rather than each figure to the latest one puts a missing
    or extra transaction in the one span it belongs to, instead of every figure before it."""
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
    ledger = _group_ledger(conn, root_id, "posted")
    dates = [row["day"] for row in ledger]
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
