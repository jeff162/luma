# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Balance totals: the household's position across the account groups it counts, on a date
(`docs/data-model.md` → *Balance totals*).

A group's balance on a date is taken from the nearest balance it stated on or before that date, carried
forward through the rows posted after it. Before its first stated balance it is worked back from that one.
Each stated balance therefore counts from its own date on, and a figure entered to correct an old error
does not move the history before it. On today's date this is the same figure `current_balances` gives.

Before the group's coverage begins (its earliest stated balance or posted row) its balance is unknown,
not the flat figure working back would give, so the group is left out of that date. After the day it closed
(`account.closed_on`) it holds nothing, whatever its last figure was; a remainder is flagged on the account
instead (`services/closed_accounts.py`).
"""

from bisect import bisect_right
from datetime import date, timedelta
from itertools import accumulate
from typing import Optional

from backend.services.account_balances import BALANCE_DAY_SQL, NORMAL_BALANCE_SIDE, STALE_AFTER_DAYS
from backend.services.account_groups import group_accounts_sql
from backend.services.signal_dismissals import dismissed_keys
from backend.services.transaction_facets import OWNER_LENS_PARAM, append_facets

# Of the Dashboard's filters only the owner ones apply: the others select transactions, and a balance
# belongs to an account. Applied through the facet registry, so "unassigned" and the lens mean what they
# mean everywhere else.
OWNER_FILTER_PARAMS = ("owner_ids", "exclude_owner_ids", OWNER_LENS_PARAM)


class GroupBalances:
    """One account group's stated balances and posted rows, for its balance on any date. `count_from` is the
    first date the totals count the group from where the user set one (`account.balance_totals_from`), and
    `closed_on` the last day it was open."""

    def __init__(self, stated: list, ledger: list, count_from: Optional[str] = None,
                 closed_on: Optional[str] = None):
        # The latest recorded figure stands for each date, as it does for `current_balances`' anchor.
        by_date = {}
        for row in stated:
            by_date[row["as_of_date"]] = row
        self.stated_dates = sorted(by_date)
        self.stated = [by_date[d] for d in self.stated_dates]
        self.days = [row["day"] for row in ledger]
        self.moved = [0.0, *accumulate(row["amount"] for row in ledger)]
        starts = [d for d in (self.stated_dates[:1] + self.days[:1]) if d]
        self.count_from = count_from
        self.closed_on = closed_on
        self.coverage_start = max(min(starts), count_from or "") if self.stated else None

    def _moved_after(self, after: str, through: Optional[str]) -> float:
        """What the rows posted after `after`, through `through` (or with no end), moved."""
        end = len(self.days) if through is None else bisect_right(self.days, through)
        return self.moved[end] - self.moved[bisect_right(self.days, after)]

    def worked_back(self, anchor_date: str):
        """`(day, balance)` at the close of each posting day before `anchor_date`, worked back from the
        balance stated then, and before the first row (dated the day before it)."""
        anchor = self.stated[self.stated_dates.index(anchor_date)]["balance"]
        days = sorted({d for d in self.days if d < anchor_date}, reverse=True)
        if days:
            first_row = date.fromisoformat(days[-1]) - timedelta(days=1)
            days.append(first_row.isoformat())
        for day in days:
            yield day, anchor + self._moved_after(day, anchor_date)

    def on(self, day: str, open_ended: bool = False) -> Optional[dict]:
        """The balance at the close of `day`, with the stated balance it came from, or None before the
        group's coverage begins. `open_ended` counts every later row as well, for today's figure, so it
        agrees with `current_balances`."""
        if not self.stated or day < self.coverage_start:
            return None
        if self.closed_on and day > self.closed_on:
            return {"amount": 0.0, "as_of_date": self.closed_on, "source": "closed", "stale": False}
        index = bisect_right(self.stated_dates, day) - 1
        if index >= 0:
            anchor = self.stated[index]
            # A transaction's amount is positive for money out, so it lowers the position.
            amount = anchor["balance"] - self._moved_after(anchor["as_of_date"], None if open_ended else day)
        else:
            anchor = self.stated[0]
            amount = anchor["balance"] + self._moved_after(day, anchor["as_of_date"])
        stale_after = STALE_AFTER_DAYS[anchor["source"]]
        return {
            "amount": round(amount, 2),
            "as_of_date": anchor["as_of_date"],
            "source": anchor["source"],
            "stale": index >= 0 and (date.fromisoformat(day) - date.fromisoformat(anchor["as_of_date"])).days > stale_after,
        }


# How far onto the wrong side of zero a worked-back balance may go before it is flagged. A small overdraft
# or credit balance does happen; transactions missing from an import put the history off by far more.
HISTORY_TOLERANCE = 100.0

# The dismissal store's kind and key prefix for a flag (`services/signal_dismissals.py`).
HISTORY_FLAG_KIND = "balance_history"


def history_flag_key(root_id: str, before: str) -> str:
    """The flag's dismissal key. It names the first stated balance the history was worked back from, so a
    dismissal lapses when an earlier one is entered and the history is worked out again."""
    return f"{HISTORY_FLAG_KIND}:{root_id}:{before}"


def history_flag(balances: GroupBalances, account_type: Optional[str]) -> Optional[dict]:
    """Whether the balance worked back from the group's first stated balance goes clearly onto the wrong
    side of zero for its type, which says its transactions do not explain its history. Only the history the
    totals count is judged, so a start date set past the trouble settles it.

    Reports the worst figure with its date, and `suggested_from`: the earliest date from which the worked-back
    history stays on the right side, as far back as the transactions hold up. None when there is nothing
    wrong, or the type has no normal side."""
    side = NORMAL_BALANCE_SIDE.get(account_type or "")
    if not side or not balances.stated:
        return None
    first = balances.stated_dates[0]
    worst, suggested_from, held_up = None, first, True
    for day, amount in balances.worked_back(first):
        if balances.count_from and day < balances.count_from:
            break
        wrong = {"held": -amount, "owed": amount, "zero": abs(amount)}[side] > HISTORY_TOLERANCE
        held_up = held_up and not wrong
        if held_up:
            suggested_from = day
        if wrong and (worst is None or abs(amount) > abs(worst[1])):
            worst = (day, amount)
    if worst is None:
        return None
    return {"before": first, "date": worst[0], "amount": round(worst[1], 2), "suggested_from": suggested_from}


def connection_seam(conn, root_id: str, before: str) -> Optional[str]:
    """The last day before a connection's rows begin in a group that has earlier rows from elsewhere (a file
    imported before the account was connected), where the history is worked back across that switch.
    A balance stated on it, from that day's statement, gives the earlier history its own starting point.
    None when the group has no such switch before `before`, its first stated balance."""
    # Imported lazily: the router module imports this one's neighbours.
    from backend.routers.sync import SYNC_SOURCE_KIND
    first_synced = conn.execute(
        f"""
        SELECT MIN({BALANCE_DAY_SQL["posted"]})
        FROM txn t
        JOIN import_batch b ON b.id = t.import_batch_id
        WHERE t.account_id IN {group_accounts_sql("= ?")} AND b.source_kind = ?
          AND t.trashed_at IS NULL AND t.is_pending = 0
        """, (root_id, SYNC_SOURCE_KIND)).fetchone()[0]
    if not first_synced or first_synced > before:
        return None
    earlier = conn.execute(
        f"""
        SELECT 1 FROM txn t
        WHERE t.account_id IN {group_accounts_sql("= ?")} AND {BALANCE_DAY_SQL["posted"]} < ?
          AND t.trashed_at IS NULL AND t.is_pending = 0
        LIMIT 1
        """, (root_id, first_synced)).fetchone()
    return (date.fromisoformat(first_synced) - timedelta(days=1)).isoformat() if earlier else None


def load_group_balances(conn, root_ids: list) -> dict:
    """`{root_id: GroupBalances}` for these groups, each counted from its root's `balance_totals_from` through
    its `closed_on`."""
    if not root_ids:
        return {}
    placeholders = ",".join("?" * len(root_ids))
    stated, ledger = {}, {}
    settings = {row["id"]: row for row in conn.execute(
        f"SELECT id, balance_totals_from, closed_on FROM account WHERE id IN ({placeholders})", root_ids)}
    for row in conn.execute(
        f"""
        SELECT COALESCE(a.parent_account_id, a.id) AS root_id, b.as_of_date, b.source, b.balance
        FROM account_balance b
        JOIN account a ON a.id = b.account_id
        WHERE COALESCE(a.parent_account_id, a.id) IN ({placeholders})
        ORDER BY b.as_of_date, b.recorded_at
        """, root_ids):
        stated.setdefault(row["root_id"], []).append(row)
    # Live, posted rows by posting date, which is what a source's balance counts.
    for row in conn.execute(
        f"""
        SELECT COALESCE(a.parent_account_id, a.id) AS root_id, {BALANCE_DAY_SQL["posted"]} AS day, t.amount
        FROM txn t
        JOIN account a ON a.id = t.account_id
        WHERE t.account_id IN {group_accounts_sql(f"IN ({placeholders})")}
          AND t.trashed_at IS NULL AND t.is_pending = 0
        ORDER BY day
        """, root_ids):
        ledger.setdefault(row["root_id"], []).append(row)
    return {
        root_id: GroupBalances(stated.get(root_id, []), ledger.get(root_id, []),
                               settings[root_id]["balance_totals_from"] if root_id in settings else None,
                               settings[root_id]["closed_on"] if root_id in settings else None)
        for root_id in root_ids
    }


def _shown_flag(conn, root_id: str, balances: GroupBalances, account_type, dismissed: set) -> Optional[dict]:
    """The group's history flag with its seam, or None when it has none or it was dismissed.

    `balance_date` is the day a balance from a statement would fix the most: the seam where there is one,
    and otherwise the day before `suggested_from`, the last day the worked-back history goes wrong on."""
    flag = history_flag(balances, account_type)
    if not flag or history_flag_key(root_id, flag["before"]) in dismissed:
        return None
    seam = connection_seam(conn, root_id, flag["before"])
    balance_date = seam or (date.fromisoformat(flag["suggested_from"]) - timedelta(days=1)).isoformat()
    return {**flag, "seam": seam, "balance_date": balance_date}


def account_history_flag(conn, root_id: str) -> Optional[dict]:
    """The group's history flag, or None when it has none or it was dismissed."""
    root = conn.execute("SELECT type FROM account WHERE id = ?", (root_id,)).fetchone()
    balances = load_group_balances(conn, [root_id])[root_id]
    return _shown_flag(conn, root_id, balances, root["type"] if root else None, dismissed_keys(conn))


def balance_total_groups(conn, owner_filters: Optional[dict] = None) -> list[dict]:
    """The account groups the totals count, narrowed by the owner filters (`owner_ids`,
    `exclude_owner_ids`, `owner_lens`, as the facet registry names them), each with its balances and its
    history flag.

    A group counts unless its root is trashed, excluded from the totals, or of type `other`, whose type says
    nothing about what the account is. Owner is read from the root, as type is.

    `type_index` is the group's place among every counted group of its type, before the owner filters, so
    a colour given by it stays with the account whichever owners are shown."""
    owner_filters = {key: (owner_filters or {}).get(key) for key in OWNER_FILTER_PARAMS}
    counted = [
        "t.parent_account_id IS NULL",
        "t.trashed_at IS NULL",
        "t.exclude_from_balance_totals = 0",
        "COALESCE(t.type, 'other') != 'other'",
    ]
    every = conn.execute(
        f"""
        SELECT t.id, COALESCE(t.display_name, t.name) AS name, t.type, t.owner_id
        FROM account t
        WHERE {' AND '.join(counted)}
        ORDER BY name COLLATE NOCASE, t.id
        """).fetchall()
    type_index, seen = {}, {}
    for row in every:
        type_index[row["id"]] = seen.get(row["type"], 0)
        seen[row["type"]] = type_index[row["id"]] + 1
    # Aliased `t` because the owner membership is written against `t.owner_id`; here it is the account's.
    clauses, params = list(counted), []
    append_facets(clauses, params, owner_filters)
    shown = {row["id"] for row in conn.execute(f"SELECT t.id FROM account t WHERE {' AND '.join(clauses)}", params)}
    roots = [row for row in every if row["id"] in shown]
    balances = load_group_balances(conn, [row["id"] for row in roots])
    dismissed = dismissed_keys(conn)
    groups = []
    for row in roots:
        group = balances[row["id"]]
        groups.append({
            "account_id": row["id"], "name": row["name"], "type": row["type"], "owner_id": row["owner_id"],
            "type_index": type_index[row["id"]], "balance_totals_from": group.count_from,
            "history_flag": _shown_flag(conn, row["id"], group, row["type"], dismissed), "balances": group,
        })
    return groups


def _totals(amounts) -> dict:
    """Assets and liabilities by the sign of each group's position, which is what each source converted
    its own convention to, so no account type is asked."""
    amounts = list(amounts)
    assets = round(sum(a for a in amounts if a > 0), 2)
    liabilities = round(sum(a for a in amounts if a < 0), 2)
    return {"assets": assets, "liabilities": liabilities, "net": round(assets + liabilities, 2)}


def balance_totals_on(conn, date_start: Optional[str], date_end: Optional[str], owner_filters=None,
                      today: Optional[date] = None) -> dict:
    """The totals at the end of a period, and each group's balance then and at the period's opening.

    The end is `date_end`, or today when the period runs past it or has no end. The opening is the close
    of the day before `date_start`; an all-time period has none. A group whose coverage begins inside the
    period opens it at zero, so the change is the end's total less the opening's and the two always
    agree. That is right for an account opened in the period, and overstates the change for one whose
    records merely start late. Likewise a group closed inside the period ends it at zero, and one closed
    before the period (before its opening, or before its end where it has none) is left out, since it
    held nothing throughout."""
    today_iso = (today or date.today()).isoformat()
    end = min(date_end, today_iso) if date_end else today_iso
    open_ended = end == today_iso
    opening = (date.fromisoformat(date_start) - timedelta(days=1)).isoformat() if date_start else None
    accounts = []
    for group in balance_total_groups(conn, owner_filters):
        balances = group.pop("balances")
        if balances.closed_on and balances.closed_on < (opening or end):
            continue
        at_end = balances.on(end, open_ended)
        at_opening = balances.on(opening) if opening and at_end else None
        accounts.append({
            **group,
            "balance": at_end,
            "opening": (at_opening["amount"] if at_opening else 0.0) if opening and at_end else None,
            "has_balance": bool(balances.stated),
        })
    with_end = [a for a in accounts if a["balance"]]
    return {
        "date": end,
        "opening_date": opening,
        "totals": _totals(a["balance"]["amount"] for a in with_end),
        "change": round(sum(a["balance"]["amount"] - a["opening"] for a in with_end), 2) if opening else None,
        "accounts": accounts,
    }


def _month_ends(first: str, today: date) -> list[str]:
    """The last day of each month from `first`'s through last month, then today."""
    year, month = int(first[:4]), int(first[5:7])
    days = []
    while (year, month) < (today.year, today.month):
        next_year, next_month = (year + 1, 1) if month == 12 else (year, month + 1)
        days.append((date(next_year, next_month, 1) - timedelta(days=1)).isoformat())
        year, month = next_year, next_month
    return [*days, today.isoformat()]


def balance_totals_by_month(conn, owner_filters=None, today: Optional[date] = None) -> dict:
    """The totals at each month's end, from the month the earliest group's coverage begins through today,
    whose point is today's figure, with each group's balance at that point (`balances`, by account id;
    a group not yet covered is absent). `uncovered` counts the groups with a balance whose coverage has not
    begun yet on that date. `accounts` lists the counted groups, those that have never stated a balance
    with `has_balance` false, since no date counts them."""
    today = today or date.today()
    groups = balance_total_groups(conn, owner_filters)
    covered = [g for g in groups if g["balances"].stated]
    points = []
    if covered:
        days = _month_ends(min(g["balances"].coverage_start for g in covered), today)
        for day in days:
            open_ended = day == days[-1]
            figures = {g["account_id"]: g["balances"].on(day, open_ended) for g in covered}
            amounts = {account_id: f["amount"] for account_id, f in figures.items() if f}
            points.append({
                "month": day[:7],
                "date": day,
                **_totals(amounts.values()),
                "uncovered": len(figures) - len(amounts),
                "balances": amounts,
            })
    accounts = [
        {key: value for key, value in g.items() if key != "balances"} | {"has_balance": bool(g["balances"].stated)}
        for g in groups
    ]
    return {"points": points, "accounts": accounts}
