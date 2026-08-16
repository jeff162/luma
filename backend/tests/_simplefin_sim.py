"""
A simulated SimpleFIN Bridge: a bank with a ledger, not a fixture that replays canned answers.

The difference is the point. A fake that maps one known window to one known blob can only confirm that
the code does what it was written to do — ask it something the author did not anticipate and it has no
answer. This one holds a set of transactions and *answers whatever it is asked*, the way a server does,
so a test can check the relationship between **what was requested** and **what was claimed**. That
relationship is where the bugs in this subsystem have actually lived: coverage recorded deeper than
anything was fetched, a watermark advanced past data nobody asked for, a budget counted against the
wrong day.

**The envelope shapes come from a real server.** `fixtures/simplefin/*.json` are verbatim captures from
the Bridge's demo account, and the simulator substitutes its own ledger into them, so the field names and
quirks under test are the ones a real server sends rather than the ones this file's author remembered —
including the three that a from-memory fake would have got wrong: `memo` is the raw bank descriptor while
`description` is a *cleaned* label, and `mcc` exists at all.

Nothing here touches the network. The captures were taken once, by hand.
"""

from __future__ import annotations

import json
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

_FIXTURES = Path(__file__).parent / "fixtures" / "simplefin"


def _load(name: str) -> dict:
    with open(_FIXTURES / f"{name}.json") as f:
        return json.load(f)


def epoch(when: str | date) -> int:
    """A date (midnight UTC) or a full `YYYY-MM-DDTHH:MM` moment, as the protocol's Unix timestamp."""
    if isinstance(when, date):
        return int(datetime.combine(when, datetime.min.time(), tzinfo=timezone.utc).timestamp())
    if "T" in when:
        return int(datetime.fromisoformat(when).replace(tzinfo=timezone.utc).timestamp())
    return int(datetime.combine(date.fromisoformat(when), datetime.min.time(),
                                tzinfo=timezone.utc).timestamp())


def iso(ts: int) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).date().isoformat()


class Txn:
    """One transaction in the simulated bank.

    `posted` and `transacted_at` are separate on purpose. Every row in the captured demo data has them
    equal, so a ledger built from that capture alone would never exercise a late-posting charge — the case
    the incremental fetch's overlap window exists for, and the one duplicate detection cares most about
    (two sources reporting different ones of the two dates is what made real duplicates look like
    near-misses on date).
    """

    def __init__(self, txn_id, account, posted, amount, description,
                 memo=None, payee=None, transacted_at=None, pending=False, mcc=None,
                 unposted=False):
        self.id = txn_id
        self.account = account
        self.posted = posted
        self.transacted_at = transacted_at or posted
        # A charge that has not posted has no posting instant, and the protocol requires the field — so the
        # server sends `posted: 0` rather than omitting it. The row still has to be *findable*, though: the
        # bank files it under the date it does have, so the instant this fixture filters on and the value it
        # puts on the wire diverge here, and only here. Without this the pending case can only be written as
        # a row with a real posting date, which is the one shape a pending row never has.
        self.unposted = unposted
        # The instant the server would filter on. Kept alongside the readable date because a transaction
        # posted at 23:30 and one posted at midnight sit on the same *date* but on opposite sides of a
        # window bound expressed as a timestamp — which is how the protocol expresses it.
        self.posted_epoch = epoch(posted)
        self.amount = amount
        self.description = description
        self.memo = memo
        self.payee = payee
        self.pending = pending
        self.mcc = mcc

    @property
    def posted_date(self) -> str:
        return iso(self.posted_epoch)

    def as_payload(self) -> dict:
        out = {
            "id": self.id,
            "posted": 0 if self.unposted else self.posted_epoch,
            "transacted_at": epoch(self.transacted_at),
            "amount": self.amount,
            "description": self.description,
        }
        for key, value in (("memo", self.memo), ("payee", self.payee), ("mcc", self.mcc)):
            if value is not None:
                out[key] = value
        if self.pending:
            out["pending"] = True
        return out


class SimpleFinSim:
    """The fake bank. Answers any window/account query from its ledger and logs every request.

    `errlist_for` lets a scenario make the server report a problem — a bank needing re-authentication, or
    an advisory about the request itself — without which the two-audience split in `_problem_messages`
    could only be tested by hand-building payloads.
    """

    def __init__(self, transactions=None, accounts=None, today="2026-08-08", errlist_for=None,
                 currencies=None):
        self.ledger: list[Txn] = list(transactions or [])
        self.accounts = list(accounts or ["Demo Checking", "Demo Savings"])
        # account id -> the `currency` the bank reports for it. Unlisted accounts keep the captured
        # envelope's value. A bank holding an account in another currency is ordinary — a travel account, a
        # foreign employer — and the ledger cannot store its amounts, so what happens to it is worth being
        # able to set up rather than assume away.
        self.currencies = dict(currencies or {})
        # Set to an exception to make the server refuse every request — how a revoked access URL presents,
        # since SimpleFIN has no revocation API and nothing announces the revocation in advance.
        self.refuse_with: Exception | None = None
        # How many requests succeed before `refuse_with` starts firing. A bank that fails from the very
        # first request and one that fails partway through a walk are different tests: only the second
        # leaves a *partial* pull behind, with requests already spent and rows already fetched, which is
        # what anything claiming to survive a failure has to survive.
        self.refuse_after: int | None = None
        self._today = date.fromisoformat(today)
        # Midday, so `advance_hours` can move in either direction within a day without rolling the date by
        # accident — the scenarios choose windows by date and meter the budget by instant, and a helper that
        # quietly changed the date while claiming to move hours would make the two disagree.
        self._time_of_day = time(12, 0)
        self.errlist_for = errlist_for or (lambda params: [])
        self.requests: list[dict] = []
        self._envelope = _load("accounts_balances_only")
        self._account_shape = {
            a["id"]: {k: v for k, v in a.items() if k != "transactions"}
            for a in _load("accounts_balances_only")["accounts"]
        }

    # ---- the clock the test owns ---------------------------------------

    @property
    def today(self) -> date:
        return self._today

    @property
    def now(self) -> datetime:
        """The wall-clock instant the simulated day currently sits at.

        Owned here rather than in the harness that drives it, because the request budget is metered against
        instants while windows are chosen by date, and the two must agree. When the test's clock and the
        request log disagreed about what "now" was, an allowance could be asserted against a moment nothing
        was actually requested at."""
        return datetime.combine(self._today, self._time_of_day, tzinfo=timezone.utc)

    def advance_days(self, n: int) -> None:
        self._today = self._today + timedelta(days=n)

    def advance_hours(self, n: int) -> None:
        """Move within a day, which is the only way to reach the case a refilling allowance exists for:
        coming back part-way through, when some but not all of what was spent has been returned."""
        moved = self.now + timedelta(hours=n)
        self._today, self._time_of_day = moved.date(), moved.time()

    def set_today(self, day: str) -> None:
        self._today = date.fromisoformat(day)

    def post(self, account, posted, *, amount="-42.00", transacted_at=None, description="Grocery store",
             memo="LOCAL GROCER STORE #1133", payee="Grocery store", pending=False):
        """New activity at the bank, after the connection already exists.

        A ledger fixed at construction quietly tests only half of what a sync does. Real banks keep
        posting, and the failure mode that needs it is specific: a pull that advances a watermark without
        fetching the period it now claims leaves a gap, and a gap is invisible unless something was
        actually posted into it. Without this method the whole class of "silently skipped window" bugs
        passes every scenario.
        """
        txn = Txn(txn_id=f"late-{len(self.ledger)}", account=account, posted=posted,
                  transacted_at=transacted_at or posted, amount=amount, description=description,
                  memo=memo, payee=payee, pending=pending)
        self.ledger.append(txn)
        return txn

    # ---- transport ------------------------------------------------------

    def __call__(self, url, *, method="GET", headers=None):
        """Stands in for `simplefin._http`."""
        if self.refuse_with is not None and (self.refuse_after is None
                                             or len(self.requests) >= self.refuse_after):
            raise self.refuse_with
        params = {k: v for k, v in parse_qs(urlsplit(url).query).items()}
        wanted = params.get("account")
        # Filtered on the timestamps the protocol actually sends, not on date strings. The difference only
        # shows for a transaction posted partway through a day: comparing dates would quietly include one
        # that a real server, comparing instants, would place outside the window.
        start_ts = int(params["start-date"][0]) if "start-date" in params else None
        end_ts = int(params["end-date"][0]) if "end-date" in params else None
        start = iso(start_ts) if start_ts is not None else None
        end = iso(end_ts) if end_ts is not None else None
        balances_only = params.get("balances-only", ["0"])[0] == "1"
        self.requests.append({
            # Recorded namespaced, the way the ledger stores them. The provider knows only its own half of
            # the id (`Demo Savings`); Luma prefixes it so ids cannot collide across providers. Keeping the
            # log in the ledger's vocabulary is what lets an invariant compare "what was asked for" against
            # "what was claimed" without every rule having to know about the prefix.
            "start": start, "end": end,
            "accounts": None if wanted is None else [f"simplefin:{a}" for a in wanted],
            "balances_only": balances_only, "on": self._today.isoformat(),
            "at": self.now.timestamp(),
        })

        accounts = []
        for account_id in self.accounts:
            if wanted is not None and account_id not in wanted:
                continue
            shape = dict(self._account_shape.get(account_id) or self._account_shape["Demo Checking"])
            shape["id"] = account_id
            if account_id in self.currencies:
                shape["currency"] = self.currencies[account_id]
            shape["transactions"] = [] if balances_only else [
                t.as_payload() for t in self.ledger
                if t.account == account_id and start_ts <= t.posted_epoch <= end_ts
            ]
            accounts.append(shape)
        return json.dumps({
            "errlist": self.errlist_for(params),
            "connections": self._envelope["connections"],
            "accounts": accounts,
        }).encode()

    # ---- what a test asks it afterwards --------------------------------

    @property
    def windows(self) -> list[tuple[str, str]]:
        """Every dated window requested, in order. `balances-only` calls have no window."""
        return [(r["start"], r["end"]) for r in self.requests if r["start"]]

    def earliest_requested(self, account_id: str) -> str | None:
        """The oldest date any request could have returned this account's transactions from — the floor a
        coverage claim for it must not go below."""
        starts = [r["start"] for r in self.requests
                  if r["start"] and (r["accounts"] is None or account_id in r["accounts"])]
        return min(starts) if starts else None

    def latest_requested(self, account_id: str) -> str | None:
        ends = [r["end"] for r in self.requests
                if r["end"] and (r["accounts"] is None or account_id in r["accounts"])]
        return max(ends) if ends else None

    def requests_on(self, day: str) -> int:
        return sum(1 for r in self.requests if r["on"] == day)

    def requests_by_pool(self, test=None) -> dict[str, list[float]]:
        """When each request was made, grouped by the allowance the Bridge would charge it to.

        An unfiltered call and a `?account=X` call draw on separate allowances, so a log that did not
        separate them could only assert a total — which is satisfied by a walk that drains one pool
        completely while another sits untouched.

        A request naming **several** accounts is failed outright rather than attributed. The separate
        allowance was described in the singular, and nothing says whether a two-account request costs one
        token from each pool, one from either, or one from the shared one. Guessing here would bless a
        request shape whose real cost is unknown, so the fixture refuses to have an opinion and the code is
        held to sending only the shape that was actually described.
        """
        pools: dict[str, list[float]] = {}
        for r in self.requests:
            named = r["accounts"]
            if named is not None and len(named) > 1 and test is not None:
                test.fail(
                    f"a request named {len(named)} accounts at once ({named}); which allowance the Bridge "
                    f"charges that to is undocumented, so it must be sent one account at a time"
                )
            key = "shared" if named is None else named[0]
            pools.setdefault(key, []).append(r["at"])
        return pools

    def expected_ids(self, account_id: str, since: str, until: str) -> set[str]:
        """The transaction ids this bank holds for an account in a range — what a ledger claiming to cover
        that range must contain. Takes the namespaced id, as the rest of this class's queries do.

        Returned in the form the *ledger* stores, `"<namespaced account>:<bank's id>"`, because a SimpleFIN
        transaction id is only unique within its account and the adapter namespaces it on the way in (see
        `_normalize_txn`). Comparing bare ids here would have made this invariant blind to precisely the bug
        that motivates the namespacing: two accounts issuing the same ids, the second silently importing
        nothing.

        A $0 transaction is excluded, because the ledger is *right* not to hold it: this provider declares
        `zero_amount_rows = "reject"`, so such a row is refused on purpose and reported as a rejected row
        rather than lost. The exclusion is stated here, from the fixture's own knowledge of the amount it
        published, rather than by importing the policy — an invariant that resolved the question the same
        way the code does would agree with the code about a row it wrongly dropped. Note what stays
        covered: a non-zero row going missing still fails, which is the silent-skip bug this exists for.
        """
        bare = account_id.split(":", 1)[-1]
        return {f"{account_id}:{t.id}" for t in self.ledger
                if t.account == bare and since <= t.posted_date <= until
                and float(t.amount) != 0}


def build_ledger(accounts=("Demo Checking", "Demo Savings"), start="2024-01-01", end="2026-08-08"):
    """A ledger spread over a couple of years, deliberately uneven.

    Three properties matter more than volume, and none of them appear in the captured demo data:

    - **A quiet stretch narrower than two windows**, so it produces at most one empty window and the walk
      must look *past* it. The width is the whole point: a gap wider than two windows is indistinguishable
      from the end of history and legitimately stops the walk, so a fixture built that way tests the
      opposite of what it claims to. (Learned the hard way — the first version of this ledger had a
      3.5-month gap and quietly asserted that a walk stops at a gap.)
    - **Late-posting rows**, where `transacted_at` precedes `posted` by more than the incremental overlap
      in some cases and less in others. This is what the overlap window exists for, and what makes two
      sources disagree about a transaction's date.
    - **Different depths per account**, so a pull that treats every account alike is visibly wrong.
    """
    ledger = []
    n = 0
    day = date.fromisoformat(start)
    last = date.fromisoformat(end)
    while day <= last:
        # A quiet stretch in the first account's history, deliberately under two windows wide (see above).
        quiet = date(2025, 3, 1) <= day <= date(2025, 4, 20)
        for account in accounts:
            if quiet and account == accounts[0]:
                continue
            # The second account only starts partway through, so the two are at genuinely different depths.
            if account != accounts[0] and day < date.fromisoformat("2025-01-01"):
                continue
            n += 1
            # Every seventh row posts later than it was transacted: a few inside the overlap window, a few
            # well outside it, so both the caught and the missed case are represented.
            lag = 0 if n % 7 else (3 if n % 14 else 12)
            posted = day + timedelta(days=lag)
            if posted > last:
                continue
            ledger.append(Txn(
                txn_id=f"sfin-{n}",
                account=account,
                posted=posted.isoformat(),
                transacted_at=day.isoformat(),
                amount=f"-{10 + (n % 90)}.{n % 100:02d}",
                description="Grocery store" if n % 2 else "Fishing bait",
                memo="LOCAL GROCER STORE #1133" if n % 2 else "JOHNS FISHIN SHACK BAIT",
                payee="Grocery store" if n % 2 else "John's Fishin Shack",
                mcc="5411" if n % 2 else "5812",
            ))
        day += timedelta(days=6)
    return ledger + _deliberate_patterns(accounts, end)


# Window stride the deliberate boundary rows are placed against. Kept as a literal rather than imported
# from the adapter on purpose: importing it would make these rows follow a changed window size, and then a
# change to that constant could never be caught by them.
_WALK_STRIDE_DAYS = 45


def _deliberate_patterns(accounts, end):
    """Named rows, each placed to probe one thing the regular activity above cannot reach.

    Kept separate and individually labelled so a failure points at a *property* rather than at row 137 of
    a generated series, and so this list reads as the argument for why the fixture is shaped the way it is.
    The regular activity establishes normal; these are the awkward cases.
    """
    primary, secondary = accounts[0], accounts[1]
    last = date.fromisoformat(end)
    rows = []

    def at(days_back, hhmm=None):
        d = last - timedelta(days=days_back)
        return f"{d.isoformat()}T{hhmm}" if hhmm else d.isoformat()

    # Exactly on a window boundary. Backward windows share an endpoint, so a boundary row is offered to
    # two adjacent requests — proving the insert stays idempotent — and would vanish entirely if either
    # bound became exclusive. The classic off-by-one has nothing else sitting on it.
    for k in (1, 2, 3):
        rows.append(Txn(f"boundary-{k}", primary, at(_WALK_STRIDE_DAYS * k), "-31.00",
                        "Boundary charge", memo="BOUNDARY CHARGE", payee="Boundary"))

    # Posted late in the UTC day. A window bound is an instant, not a date, so these sit on the same
    # calendar day as a boundary yet on the far side of the bound — the case a midnight-only fixture
    # cannot express and a date-string comparison silently gets wrong.
    rows.append(Txn("latenight-1", primary, at(_WALK_STRIDE_DAYS, "23:30"), "-17.75",
                    "Late night charge", memo="LATE NIGHT CHARGE", payee="Late Night"))
    rows.append(Txn("latenight-2", primary, at(0, "23:59"), "-18.25",
                    "Late night charge", memo="LATE NIGHT CHARGE", payee="Late Night"))
    rows.append(Txn("earlymorning-1", primary, at(_WALK_STRIDE_DAYS, "00:01"), "-19.50",
                    "Early charge", memo="EARLY CHARGE", payee="Early"))

    # Money *in*. Every generated row above is negative, so a stray absolute value or a flipped sign in an
    # aggregate path would go unnoticed; refunds and income are ordinary and must survive inversion.
    rows.append(Txn("refund-1", primary, at(10), "48.20", "Refund",
                    memo="MERCHANT REFUND", payee="Grocery store"))
    rows.append(Txn("payroll-1", primary, at(14), "2400.00", "Payroll",
                    memo="ACME CORP PAYROLL", payee="Acme Corp"))
    # Neither in nor out: an authorization published before it carries an amount. SimpleFIN declares
    # `zero_amount_rows = "reject"` (nothing here can ever revise a held row into its settled amount), so
    # this row must be refused and reported as a rejected row — not imported, and not silently dropped.
    # It is the fixture for that policy end to end; deleting it as pointless would take the coverage with
    # it. `expected_ids` knows to exclude it, which is what keeps the completeness invariant honest.
    rows.append(Txn("zero-1", primary, at(12), "0.00", "Card authorization",
                    memo="AUTH HOLD", payee="Fuel Stop"))

    # Pending, and the same charge once it posts under a *different* id — which is how a provider with no
    # pending-to-posted pointer expresses it. Nothing else in the fixture makes a sync see the same real
    # world event twice under two identities. The pending half carries `posted: 0` because that is what a
    # real pending row carries; giving it a posting date instead made every test here agree that dates
    # always arrive, and the one date that does not arrive is the whole difficulty of a pending row.
    rows.append(Txn("pending-1", primary, at(2), "-64.10", "Pending charge",
                    memo="PENDING CHARGE", payee="Hardware Store", pending=True, unposted=True))
    rows.append(Txn("posted-of-pending-1", primary, at(1), "-64.10", "Pending charge",
                    memo="PENDING CHARGE", payee="Hardware Store"))

    # Two genuinely distinct charges, same account, same day, same amount — the pair duplicate detection
    # must NOT collapse. The generated series never produces one, so the ladder's hardest case is
    # otherwise absent entirely.
    for i in (1, 2):
        rows.append(Txn(f"twin-{i}", primary, at(20), "-9.99", "Coffee",
                        memo="CORNER COFFEE", payee="Corner Coffee"))

    # The same amount on the same day across two accounts — the shape the real demo data has (both
    # accounts see the same merchants on the same days) and the one a cross-account rule has to judge.
    rows.append(Txn("crossacct-a", primary, at(25), "-52.40", "Utilities",
                    memo="CITY UTILITIES", payee="City Utilities"))
    rows.append(Txn("crossacct-b", secondary, at(25), "-52.40", "Utilities",
                    memo="CITY UTILITIES", payee="City Utilities"))

    # A monthly charge, identical merchant and amount — the recurring pattern the real demo data suggests,
    # and the one that reaches the recurring-detection pass that runs after every sync.
    for k in range(18):
        rows.append(Txn(f"recurring-{k}", primary, at(30 * k + 3), "-14.99", "Streaming",
                        memo="STREAMFLIX MONTHLY", payee="Streamflix"))

    # A sparse account: roughly one charge every five months, so single empty windows recur. This is the
    # dangerous direction for the two-empty-window stop — if the window widens or the rule tightens, a real
    # history is truncated silently, and no other account here is quiet enough to notice.
    for k in range(6):
        rows.append(Txn(f"sparse-{k}", "Demo Sparse", at(150 * k + 5), "-120.00", "Annual fee",
                        memo="SAFE DEPOSIT BOX FEE", payee="Bank Fees"))

    return rows
