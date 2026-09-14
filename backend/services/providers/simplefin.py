# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
The SimpleFIN adapter — a read-only aggregation protocol with none of Plaid's shape.

SimpleFIN differs from the provider the connection seam was first built around on every axis that
matters, and the interesting design here is what falls out of those differences rather than the field
mapping:

**No app-level credential.** Nothing identifies Luma to the Bridge; the per-connection access URL is the
whole credential. `requires_app_config = False` is what stops "no app config" from reading as "setup not
finished yet" throughout the routers.

**No sandbox.** Every access URL is live bank data — there is no environment switch at which a credential
stops being fake, because none of them ever were. This used to shape the vault gate (connect time here,
the Production switch for a provider with a sandbox, with the Bridge's demo token exempted); it no longer
does, since every vault passphrase must now clear the same floor before any connection is configured.
What survives the change is the reason the distinction was worth drawing at all: a first connection here
is already live bank access, so nothing about this provider is ever safe to treat as a rehearsal.

**No cursor, and no way to ask how far back history goes.** The protocol has no change feed and no
coverage-start field, so a backfill is a *walk*: request fixed-size windows (`WINDOW_DAYS`) backward until
they come back empty. Nothing in the response says when to stop, which is why the walk requires two
consecutive empty windows rather than one — a single quiet quarter on a low-activity card is not evidence
that history ended.

**A published request budget** — 24 requests, replenished through the day, with token disablement as the
penalty. It is a *refilling allowance* rather than a daily quota, and it is not one allowance but many: the
Bridge grants an unfiltered `/accounts` call and each `?account=` call their own (confirmed with SimpleFIN,
2026-08). Both facts shape this adapter — see `REQUEST_BUDGET_CAPACITY` for the bucket and
`FILTERED_WALK_MAX_ACCOUNTS` for which allowance a walk draws on. When one runs out the walk records where
it got to and reports `resume_later`, so the sync stops rather than pushing the token toward disablement,
and a later sync continues from the same checkpoint.

**Spending is not part of the resume checkpoint**, and the two are stored apart on purpose. A checkpoint
says *what data is held*, so it must roll back with the rows a failed pull never inserted; spend says *what
was asked of the provider*, which no failure can take back. Sharing one column would force one persistence
rule on both, and the safe rule for each is the other's bug. So the budget travels as a mutable dict the
caller owns and writes whether the pull succeeds or raises (`connection.provider_request_budget`).

**No revocation.** There is no call that invalidates an access URL, so `remove()` deletes Luma's copy and
nothing more; only the user, at the Bridge, can actually revoke one. The disconnect confirmation has to
say so — see `docs/security-model.md` -> "Revocation, in both directions": a provider with no revocation
call is a supported case, but one the user has to be told about, since the remedy is theirs to carry out.

Because there is no cursor to store, the connection's `transactions_cursor` column carries this adapter's
own JSON checkpoint instead. That column was always defined as an opaque provider resume token; a
provider with no change feed simply resumes from something other than a cursor.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone

from backend.app_logging import log_warning
from backend.services.ledger_currency import DEFAULT_LEDGER_CURRENCY, currency_matches
from backend.services.providers.base import ProviderAdapter, ProviderCredentialRejected
from backend.services.source_capabilities import CURRENCY_PER_ACCOUNT, REJECT_ZERO_AMOUNT

# The stride of a history walk, and the widest single date-range query made.
#
# Set from what the live server says rather than from the documentation, because only one of the two is
# enforced. What it says has changed, and the change matters:
#
#   2026-08-07  "exceeds recommended range of 45 days. In the future, this may be capped."
#   2026-08-08  "[gen.api] Requested date range exceeds limit of 90 days and was capped."
#
# So the limit is now the published 90, and it is no longer advisory — an over-wide request is **silently
# truncated**. That is the dangerous shape: the walk would advance its frontier by the window it *asked
# for* while the server returned less, recording coverage over days nothing fetched. Staying at 45 keeps a
# wide margin under the cap and cannot trip it; raising it toward 90 would need the response's own range
# checked against the request before any coverage is recorded, which nothing does today.
#
# Note also that the request is a range of *instants*. Only the window carrying a pull's newest bound runs
# its end to the close of that day (see `_fetch_window`); every older one ends at midnight, where the next
# window forward already picks the day up. So a walk's older windows are exactly N days on the wire rather
# than N plus a further 23:59:59 — which is what used to make every one of them trip the 45-day advisory
# above. The newest window still carries that extra day and still trips it, once per pull that reaches
# today. Narrowing *that one window* by a day is the remaining lever if the advisory ever becomes a cap;
# it is deliberately not spent yet, since the enforced limit is 90 and the message is still advice.
WINDOW_DAYS = 45

# A routine top-up re-asks for a few days it already has. The Bridge's own developer guidance recommends
# the overlap: a transaction can post with a date earlier than the moment it becomes visible, so a window
# that started exactly where the last one ended would miss it. Re-fetching is free of consequence because
# the sync's insert is idempotent on the provider transaction id.
INCREMENTAL_OVERLAP_DAYS = 5

# The allowance, modelled as a token bucket rather than a per-day counter.
#
# The Bridge publishes "24 requests or fewer per day … quotas are replenished throughout the day", which is
# a bucket that refills, not a quota that resets. The distinction is not academic: a counter keyed to a
# calendar day hands out a full allowance the moment the date rolls over, so a walk that spent everything
# late one day could spend it all again minutes later against a bucket that had refilled by one. That
# pairing is not exotic — it is what a deep backfill does as it resumes day after day, which is the case
# `resume_later` exists to produce.
#
# Capacity is held below the published 24 so the calls that never pass through here — account discovery,
# reconnecting — cannot be starved by a walk that spent everything. At the window size above, one full
# bucket reaches roughly 2.7 years back, comfortably past what the Bridge's upstreams actually hold.
REQUEST_BUDGET_CAPACITY = 22

# Tokens returned per hour. **Inferred** from the published 24/day, not stated by the provider, so it is
# deliberately the conservative reading: crediting more slowly than the server does costs at worst a request
# that could have been made, while crediting faster spends one the server has not granted — and the penalty
# for overrunning is a disabled token, which for this provider cannot be re-issued without the user
# re-linking at the Bridge.
REQUEST_BUDGET_REFILL_PER_HOUR = 1.0

# The pool an unfiltered request draws on. Every other pool is keyed by provider account id, which cannot
# collide with this because account ids reaching the budget are namespaced (`simplefin:…`).
_SHARED_POOL = "shared"

# How many accounts may still be walking before the walk stops filtering per account.
#
# **The rule reads the size of the walking set and nothing else** — not whether this is a first backfill or
# a top-up, not how much history is left. Worth stating plainly because the wording here used to imply
# otherwise, and a small credential makes the difference visible: three accounts is *at* the threshold, so
# a first connect there filters per account throughout its backfill, which reads as a surprise to anyone
# who took "not for a first backfill" as the rule rather than as a remark about how large N usually is on
# one.
#
# The two ways to advance N accounts by one window cost the same *depth* but draw on different allowances:
# one unfiltered request advances all N and costs one shared token, while N filtered requests advance the
# same N and cost one token from each account's own pool. Filtering therefore buys no extra reach — every
# pool is the same size — it moves the cost off the shared pool, which is also what the routine top-up and
# account discovery spend from.
#
# So the trade is round trips against the shared pool, and the threshold is where it stops being worth
# making: a few accounts catching up filter, and pay N calls per window to leave the shared allowance for
# the top-ups that keep the ledger current. Above that, N filtered requests per window is an N-fold
# increase in round trips for the same depth, and on a large credential that is most of what a first
# connect would spend its time doing — so a wide walking set shares the window instead.
FILTERED_WALK_MAX_ACCOUNTS = 3

# Windows fetched before the walk hands control back to the caller as a page (`has_more`).
#
# One, because the cost of a page boundary is a database commit (~a millisecond) and the thing it bounds is
# a provider request (~a second): paying 0.1% to make every fetched window durable the moment it arrives is
# not a close call. What it buys is threefold — a crash or a bank hanging up mid-walk costs one window
# rather than everything fetched so far; the write transaction is released between every request, so the
# rest of the app keeps working during a sync; and per-account reach is recorded continuously, which is
# what a progress display reads.
#
# Nothing here needs to remember where it was: the walk was already built to resume from each account's
# recorded reach, so a page boundary is just a resume point that happens immediately.
WINDOWS_PER_PAGE = 1

# Consecutive empty windows that end the backward walk. One is not enough: an account with no activity for
# a quarter would report exactly the same thing as an account whose history has run out, and stopping
# there would silently truncate the backfill.
EMPTY_WINDOWS_END_HISTORY = 2

# Markers on `update_status` when the pull stopped short of the end of history. Carried for diagnostics
# and display; the machine-readable signal for both is `resume_later`.
#
# The two are kept apart because they are opposite failures wearing the same outcome. `BUDGET_PAUSED` is
# *this* client declining to ask — the local bucket is empty, nothing was refused, and the remedy is to
# wait for it to refill. `RATE_LIMITED` is the server refusing a request we were willing to make, which
# means the local accounting disagrees with the server's, and the remedy is to find out why. Collapsing
# them left the log unable to distinguish "working as designed" from "our model of the limit is wrong" —
# and the penalty for the latter, on this provider, is a disabled token the user cannot re-issue without
# re-linking at the Bridge.
BUDGET_PAUSED = "BUDGET_PAUSED"
RATE_LIMITED = "RATE_LIMITED"

_HTTP_TIMEOUT_SECONDS = 60
_ACCOUNT_ID_PREFIX = "simplefin:"

# Sent on every request. Naming the client is not politeness — the CDN fronting the Bridge rejects
# urllib's default agent outright (see `_http`), so an anonymous request never reaches SimpleFIN at all.
_USER_AGENT = "Luma (+https://github.com/jeff162/luma)"

# The only servers this adapter sends a request to. A setup token is a base64 URL the user pastes, and the
# access URL it is exchanged for comes back from whatever answered the claim, so without a fixed list either
# one could aim the server's own request anywhere — an address on the private network, or a host that echoes
# its reply back through an error message. SimpleFIN Bridge is one service run by SimpleFIN rather than a
# family of compatible servers: `bridge` serves real accounts and `beta-bridge` the demo token its setup page
# hands out. If SimpleFIN moves or adds a host, it is added here; a different server speaking the protocol
# would be a different product, and gets its own entry if one ever needs supporting.
SIMPLEFIN_BRIDGE_HOSTS = ("bridge.simplefin.org", "beta-bridge.simplefin.org")


def _is_bridge_address(url: str) -> bool:
    parts = urllib.parse.urlsplit((url or "").strip())
    try:
        port = parts.port
    except ValueError:
        return False
    return (
        parts.scheme.lower() == "https"
        and (parts.hostname or "").lower() in SIMPLEFIN_BRIDGE_HOSTS
        and port in (None, 443)
    )


class _RefuseRedirects(urllib.request.HTTPRedirectHandler):
    """Report a redirect as the HTTP error it is, instead of following it.

    Following one sends the request, `Authorization` header included, to wherever the redirect names — an
    address the host list never saw. The Bridge has no reason to redirect an API call, so a redirect surfaces
    as a failure carrying its status.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_open = urllib.request.build_opener(_RefuseRedirects).open

# Ceilings on provider-supplied text before it is stored or shown. The Bridge's messages are meant for
# display and are short, but nothing in the protocol *bounds* them, and everything here ends up in a DB
# column and on a connection card. React escapes the content, so the risk is not injection but volume: an
# unbounded string from a broken or hostile server would push a card off the screen and fill
# `last_sync_error` / `last_sync_warnings` indefinitely. Clipping at the boundary means every consumer
# inherits the bound without having to remember it.
_MAX_MESSAGE_CHARS = 300
_MAX_MESSAGES = 10


def _clip(text: str) -> str:
    text = " ".join(str(text or "").split())     # collapse newlines too: these land in one-line UI slots
    return text if len(text) <= _MAX_MESSAGE_CHARS else text[:_MAX_MESSAGE_CHARS - 1].rstrip() + "…"


# The **second** limit this provider enforces, and the one the request budget says nothing about.
#
# The published 24/day allowance bounds how many requests are made; the CDN in front of the Bridge bounds
# how *fast*. Bursting a walk's windows back-to-back — around twenty requests in two or three seconds,
# comfortably inside the daily allowance — is answered with `429 error code: 1015`, Cloudflare's rate
# limiter, the same layer that rejects unnamed user agents (see `_http`).
#
# Paced process-wide rather than per connection, because the limiter keys on the caller, not on which
# access URL it happens to be using: two connections syncing at once are one client to it.
#
# One second rather than something tighter because the choice is nearly free. The daily budget already
# caps a walk at `REQUEST_BUDGET_CAPACITY` requests, so halving the interval saves about eleven seconds a
# day, while guessing too fast costs a wasted burst against a limit whose exact threshold is not published.
#
# **Not yet confirmed against the live Bridge** (chosen 2026-08-16, after a burst of ~20 requests in two or
# three seconds was refused). The threshold is unpublished, so this is an estimate on the safe side of one
# observation. If a 429 shows up again despite the pacing, the next move is a backoff on refusal — remember
# the moment and widen the interval for a while — rather than a smaller constant chosen by guesswork.
_MIN_REQUEST_INTERVAL_SECONDS = 1.0
_pace_lock = threading.Lock()
_last_request_at = 0.0


def _pace_request() -> None:
    """Hold off until `_MIN_REQUEST_INTERVAL_SECONDS` has passed since the previous request.

    A minimum *interval* rather than a fixed sleep, so time already spent on the network and on processing
    the last response counts toward it — a request that took 800ms waits 200ms, not a further second.
    The lock is held across the wait on purpose: that is what makes the spacing hold when two connections
    sync concurrently, which is exactly when a per-caller limiter is most likely to fire."""
    global _last_request_at
    with _pace_lock:
        wait = _MIN_REQUEST_INTERVAL_SECONDS - (time.monotonic() - _last_request_at)
        if wait > 0:
            time.sleep(wait)
        _last_request_at = time.monotonic()


class SimpleFinError(RuntimeError):
    """A SimpleFIN call failed, carrying a message fit to show the user. The Bridge returns institution
    level problems as text meant for display (an expired bank login, an account needing re-auth), so those
    are surfaced verbatim rather than replaced with a generic failure.

    `status` carries the HTTP status when the failure was one, so a caller can act on the codes that mean
    something specific (403 on a data call = the access URL is no longer accepted) without re-parsing the
    message text."""

    def __init__(self, message: str, *, status: int | None = None):
        super().__init__(message)
        self.status = status


class SimpleFinRateLimited(SimpleFinError):
    """The CDN in front of the Bridge is refusing requests for now (HTTP 429).

    Its own class because it is the one failure that is neither the user's to fix nor a reason to stop: the
    walk is resumable, so the right response is to record what arrived, pause, and come back — not to mark
    the connection broken. Distinguished from running out of the *daily* allowance, which blocks one account
    while its siblings carry on; this blocks the caller entirely, for a while."""


def _split_access_url(access_url: str) -> tuple[str, str, str]:
    """An access URL carries its credentials inline (`https://user:pass@host/path`). They are lifted into
    an Authorization header instead of being left in the request line, so the secret does not end up in a
    redirect target or anything that logs a URL."""
    parts = urllib.parse.urlsplit(access_url.strip())
    username = urllib.parse.unquote(parts.username or "")
    password = urllib.parse.unquote(parts.password or "")
    host = parts.hostname or ""
    if parts.port:
        host = f"{host}:{parts.port}"
    base = urllib.parse.urlunsplit((parts.scheme, host, parts.path.rstrip("/"), "", ""))
    return base, username, password


def _basic_auth_header(username: str, password: str) -> str:
    raw = f"{username}:{password}".encode()
    return "Basic " + base64.b64encode(raw).decode("ascii")


def _http(url: str, *, method: str = "GET", headers: dict | None = None) -> bytes:
    if not _is_bridge_address(url):
        # Checked here as well as by the callers, because every request passes through this function: a
        # future call that forgets its own check still cannot reach another host. The callers check first
        # only so they can say something more useful.
        raise SimpleFinError("That address is not SimpleFIN Bridge, so no request was sent.")
    request = urllib.request.Request(url, method=method, headers=headers or {})
    # Identify the client explicitly. urllib's default (`Python-urllib/x.y`) is blocked outright by the
    # CDN in front of the SimpleFIN Bridge, which answers 403 `error code: 1010` — a browser-signature
    # ban, with nothing in it to suggest the User-Agent is the problem. Any named agent passes.
    request.add_header("User-Agent", _USER_AGENT)
    # Every call the adapter makes passes through here, which is the only place that can hold the whole
    # client to one request per interval — the limiter this protects against counts requests, not walks.
    _pace_request()
    try:
        with _open(request, timeout=_HTTP_TIMEOUT_SECONDS) as response:
            return response.read()
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read().decode("utf-8", "replace").strip()
        except Exception:
            pass
        # The status alone does not identify the cause, so it is reported rather than interpreted. A 403
        # here once asserted "this setup token was already claimed" — plausible, and wrong for a CDN block,
        # which sends the same status. A confidently incorrect message is worse than a vague one: it sends
        # the reader off to fix something that was never broken. What a 403 *means* depends on which call
        # made it, so both readings are the callers' to add (`connect` and `_get_accounts`), and `status`
        # is carried so neither has to recognize it by parsing this string.
        # 429 is the one status worth interpreting here rather than leaving to the callers, because every
        # caller wants the same thing from it and none of them wants a failure: it is the CDN saying "too
        # fast", not the Bridge saying anything about the data or the credential. `_pace_request` above
        # exists to prevent it; this is what happens when the pacing is still not conservative enough.
        if exc.code == 429:
            raise SimpleFinRateLimited(
                _clip("SimpleFIN is rate-limiting requests; the sync will continue on a later run."),
                status=exc.code,
            ) from exc
        raise SimpleFinError(
            _clip(f"SimpleFIN returned {exc.code}{f': {detail}' if detail else ''}."), status=exc.code,
        ) from exc
    except urllib.error.URLError as exc:
        raise SimpleFinError(_clip(f"Could not reach SimpleFIN: {exc.reason}")) from exc


# Message codes that describe a *bank*, not our request — the ones a user can act on (re-authenticate,
# check the institution). Matched on the prefix the protocol namespaces them with.
_USER_ACTIONABLE_CODE_PREFIXES = ("con.", "act.", "gen.auth")


def _problem_messages(payload: dict) -> tuple[list[str], list[str]]:
    """Problems reported in the body of an otherwise-200 response, split by **who can act on them**.

    Returns `(user_actionable, advisory)`. The current protocol sends `errlist` entries as objects
    (`{code, msg, conn_id}`); older servers send an `errors` list of plain strings. Both are read, since
    which one a server speaks is not something a working connection should depend on.

    The split exists because these arrive on one channel but have two audiences. A bank needing
    re-authentication is the user's to fix and belongs on their connection card. A note that the requested
    date range exceeds what the server recommends is about *our own request shape* — nothing the user can
    do, and putting it beside "your bank needs attention" trains them to ignore both. It goes to the log,
    which is also how a change in the server's limits becomes visible without periodically probing for it.

    An entry with no code cannot be classified, so it is treated as user-actionable: showing something
    harmless is recoverable, silently swallowing a real bank failure is not.
    """
    actionable, advisory = [], []
    for problem in (payload.get("errlist") or payload.get("errors") or []):
        if isinstance(problem, dict):
            code = str(problem.get("code") or "").strip()
            text = str(problem.get("msg") or code or "").strip()
        else:
            code, text = "", str(problem).strip()
        if not text:
            continue
        if code and not code.startswith(_USER_ACTIONABLE_CODE_PREFIXES):
            advisory.append(_clip(f"[{code}] {text}"))
        else:
            actionable.append(_clip(text))
    # Bounded in count as well as length: one problem per bank is the shape these arrive in, and a list
    # long enough to need scrolling is a malfunction rather than something to render faithfully.
    return actionable[:_MAX_MESSAGES], advisory[:_MAX_MESSAGES]


def _merge_advisories(store: dict, entries: list[dict]) -> None:
    """Fold one request's advisories into a pull's running set, keyed on the message.

    Keyed on the message alone because that is what makes the aggregation useful: a remark about our
    request shape repeats on every window of a walk, and one entry saying "×22" is the diagnostic, where
    22 near-identical entries are noise. The *first* context is kept rather than the last or all of them —
    it names a concrete request to go look at, which is what a reader wants, and it does not grow with the
    walk. The count then says whether that one window was special or the whole pull was."""
    for entry in entries:
        message = entry.get("message")
        if not message:
            continue
        slot = store.get(message)
        if slot is None:
            store[message] = {"message": message, "count": 1, "context": entry.get("context")}
        else:
            slot["count"] += 1


def _check_payload(payload: dict, *, context: str) -> tuple[list[str], list[dict]]:
    """One access URL can cover several institutions, so a problem is rarely total: a bank needing
    re-authentication reports an error while every other bank on the same URL still returns its accounts.
    Failing the whole call there would let one stale login block every other account from ever syncing.

    So an error *alongside* usable data is returned as a **warning** and the data kept; only an error with
    nothing to show for it is raised. Returning rather than merely logging matters: the pull succeeds, so
    without surfacing it nothing would ever tell the user that one of their banks quietly stopped
    delivering — a partial failure wearing the appearance of a clean sync.

    Returns `(actionable, advisory)`. Both are logged as they always were — the console stays a sink, it
    just stopped being the *only* one. Advisories are now returned too rather than swallowed here: they
    still never reach the connection card, but the sync log is where they belong, since a user who cannot
    read the server's console otherwise has no way to see that a provider changed its limits.

    Each advisory carries the `context` of the request that drew it (`{"message", "context"}`). The message
    alone is what the caller aggregates on — an advisory about our request shape repeats identically across
    a walk's every window, and collapsing those to one entry with a count is the whole point — but the
    message alone also cannot say *which* request provoked it, which is the first thing anyone reading the
    log wants. Folding the window into the message instead would make each window its own entry and undo
    the aggregation, so the two travel separately."""
    actionable, advisory = _problem_messages(payload)
    if advisory:
        log_warning(f"[simplefin] {context}: {'; '.join(advisory)}")
    advisory_entries = [{"message": m, "context": context} for m in advisory]
    if not actionable:
        return [], advisory_entries
    if payload.get("accounts"):
        log_warning(f"[simplefin] {context}: {'; '.join(actionable)}")
        return actionable, advisory_entries
    raise SimpleFinError(_clip("; ".join(actionable)))


def _epoch_to_iso_date(value) -> str | None:
    """A protocol timestamp as an ISO date, or None where the field carries no date at all.

    **Zero is not midnight on 1 January 1970, it is "no such instant exists yet".** `posted` is required on
    every transaction, so a server with nothing to put there sends 0 rather than omitting the field — which
    is precisely what a *pending* charge looks like, since it has not posted. Converting that literally
    fails silently and completely: `int(0)` raises nothing, so the row enters the ledger dated 1970-01-01,
    sorts before every other transaction, falls outside every report period, and names the sync's period
    card "January 1970". Anything non-positive is therefore read as absent, leaving the caller to decide
    what an undated row should do — which is the only place that knows.
    """
    try:
        epoch = int(value)
    except (TypeError, ValueError):
        return None
    if epoch <= 0:
        return None
    try:
        return datetime.fromtimestamp(epoch, tz=timezone.utc).date().isoformat()
    except (OSError, OverflowError, ValueError):
        return None


def _utc_today() -> date:
    """The provider's day, in UTC rather than the server's local time.

    Every window bound this adapter sends is a UTC instant, so the day a walk starts from has to be the
    provider's too. A machine running behind UTC that used its own date would ask for a window ending
    yesterday and then record coverage through today."""
    return datetime.now(timezone.utc).date()


def _utcnow_epoch() -> float:
    """The instant the request budget is measured against, as a Unix timestamp.

    Seconds rather than an ISO string because this value is only ever subtracted from another one: an
    epoch needs no parsing back, carries no timezone to lose across a round trip through JSON, and cannot
    be misread as a wall-clock date by something comparing budget records."""
    return datetime.now(timezone.utc).timestamp()


# ---- the request budget --------------------------------------------------
#
# One token bucket per allowance the Bridge grants, all inside the record the caller persists:
#
#     {"pools": {"shared": {"tokens": float, "as_of": epoch_seconds}, "<account id>": {…}, …}}
#
# Tokens are fractional on purpose. Crediting whole hours and re-stamping `as_of` to now would throw the
# remainder away on every call, so a connection synced every 50 minutes would refill at zero — the bug a
# floor-and-reset refill invites, and one that only shows up under exactly the usage this exists to serve.


def _refill(pool: dict, now: float) -> dict:
    """Bring one pool up to date. A pool with no `as_of` is new and starts full."""
    as_of = pool.get("as_of")
    # A clock that moved backwards credits nothing rather than paying out a negative interval, and `as_of`
    # still advances — so once the clock is corrected, refilling resumes from now instead of settling up for
    # a gap nothing actually waited through. Capacity bounds it in every case, which is the real guarantee.
    elapsed_hours = max(0.0, (now - float(as_of)) / 3600) if as_of is not None else 0.0
    pool["tokens"] = min(
        float(REQUEST_BUDGET_CAPACITY),
        float(pool.get("tokens", REQUEST_BUDGET_CAPACITY)) + elapsed_hours * REQUEST_BUDGET_REFILL_PER_HOUR,
    )
    pool["as_of"] = now
    return pool


def _take_request(budget: dict, key: str, now: float, checkpoint=None) -> bool:
    """Spend one request from `key`'s allowance, returning whether there was one to spend.

    `checkpoint` makes the spend durable *before* the caller issues the request it paid for, which is the
    only ordering that is safe here. Recording afterwards loses the request on a crash in between, and a
    lost request means the count reads low — which leads to over-spending a limit whose penalty is a
    disabled token this provider cannot re-issue without the user re-linking at the Bridge. Recording
    first can only forfeit an allowance that went unused, and this one refills, so that error heals."""
    pool = _refill(budget.setdefault("pools", {}).setdefault(key, {}), now)
    if pool["tokens"] < 1:
        return False
    pool["tokens"] -= 1
    if checkpoint is not None:
        checkpoint()
    return True


def _allowance_snapshot(budget: dict, now: float) -> dict:
    """What the allowance looks like at the end of a pull, in the neutral shape the page contract defines.

    This is the one piece of a metered pull that no other record keeps. The buckets live in
    `connection.provider_request_budget`, which the *next* sync overwrites, so a log row that omits them can
    say a pull paused and never how close it was to the limit, which bucket ran dry, or when it could
    resume. That is the difference between a record of what happened and a record someone can diagnose
    from — and for a resource that empties and refills, the level is the whole story.

    Reported after `_prune_full_pools`, so an absent pool means a full one rather than an unknown one; the
    capacity and refill rate travel alongside so a reader never has to know this module's constants to
    interpret the numbers. Called once per page, and the caller keeps the last, which is the state the pull
    actually left behind.
    """
    return {
        "capacity": REQUEST_BUDGET_CAPACITY,
        "refill_per_hour": REQUEST_BUDGET_REFILL_PER_HOUR,
        # Rounded because these are fractional token counts whose precision is meaningless to a reader and
        # whose full float repr would dominate the row.
        "pools": {
            key: round(_refill(dict(pool), now)["tokens"], 2)
            for key, pool in (budget.get("pools") or {}).items()
        },
    }


def _prune_full_pools(budget: dict) -> None:
    """Drop pools that have refilled completely.

    A full pool and a pool that never existed grant exactly the same thing, so forgetting one loses nothing
    — and without this the record would keep a permanent entry for every account ever walked, growing with
    the connection's history rather than with what it currently owes."""
    pools = budget.get("pools") or {}
    for key in [k for k, p in pools.items() if p.get("tokens", 0) >= REQUEST_BUDGET_CAPACITY]:
        del pools[key]


def _adopt_legacy_budget(budget: dict, state: dict, today: date, now: float) -> None:
    """Carry a pre-bucket checkpoint's spend into the bucket, once.

    The allowance used to live in the resume token as a counter keyed to a UTC calendar date. Ignoring that
    on the first sync after the change would grant a full bucket on top of one already spent the same day —
    the very over-spend the bucket exists to prevent, arriving exactly once, at the upgrade. Cheap
    insurance: the penalty it guards against is a disabled token, which this provider cannot re-issue
    without the user re-linking at the Bridge."""
    used = state.pop("requests_used", None)
    spent_on = state.pop("budget_date", None)
    if budget.get("pools") or used is None or spent_on != today.isoformat():
        return
    budget.setdefault("pools", {})[_SHARED_POOL] = {
        "tokens": max(0.0, float(REQUEST_BUDGET_CAPACITY) - float(used)), "as_of": now,
    }


def _account_currency(account: dict) -> str:
    """The account's denomination, as a label fit to show.

    SimpleFIN's `currency` is either an ISO-4217 code or a **URL** identifying a custom currency —
    reward points, a scrip, a token — which is the protocol's way of saying "this is not money in any
    sense the ISO list covers". Both are returned as-is except that a URL is shortened to its last path
    segment: the full URL is an identifier, not a name, and it would be the longest thing on the row.
    """
    raw = str(account.get("currency") or "").strip()
    if raw.lower().startswith(("http://", "https://")):
        return urllib.parse.urlsplit(raw).path.rstrip("/").rsplit("/", 1)[-1] or raw
    return raw


def _is_ledger_currency(account: dict, ledger_currency: str) -> bool:
    """Whether this account's transactions may enter the ledger at face value.

    Judged against the ledger's *configured* currency, never a currency this adapter picked. An earlier
    version compared with a hardcoded `"USD"`, which asks the wrong question — an Australian user's
    consistently-AUD accounts are not an error, and that check would have discarded every one of their
    transactions. The rule is single-currency, and a stated mismatch is what breaks it.

    An account reporting **no** currency matches: the protocol makes the field optional, so absence means
    "not stated", and refusing an account because its bank omitted a field would discard real data over a
    formatting gap.
    """
    return currency_matches(ledger_currency, account.get("currency"))


def _strip_prefix(external_account_id: str) -> str:
    """Luma namespaces provider account ids (`simplefin:<id>`) so they cannot collide across providers;
    the provider only knows its own half, so anything sent back to it has to be un-namespaced."""
    return external_account_id[len(_ACCOUNT_ID_PREFIX):] \
        if external_account_id.startswith(_ACCOUNT_ID_PREFIX) else external_account_id


def _to_amount(value) -> float:
    """SimpleFIN signs amounts negative-for-money-out; Luma's convention is the opposite, so every amount
    inverts here. Doing it in the adapter is the point of the seam — nothing downstream should know which
    provider a row came from in order to read its sign."""
    return -float(value)


class SimpleFinAdapter(ProviderAdapter):
    provider = "simplefin"

    requires_app_config = False
    has_cursor = False
    revokes_on_disconnect = False     # no revocation call exists; only the user, at the Bridge, can revoke
    # The handle is derived from the credential (see `connect`), so a fresh access URL is a fresh handle:
    # a re-link has to be told which connection it replaces, or it lands as a second one.
    stable_external_id = False
    max_history_days = None           # the Bridge publishes no history cap; the walk finds the end itself
    routine_lookback_days = 30
    # Rejected: the Bridge publishes no change feed and no pending pointer, so nothing can ever revise a
    # row already held — a settling charge arrives under a *new* id as its own row, leaving the $0 one
    # stranded (duplicate detection cannot pair them; the amounts differ). Same dead weight as a CSV's.
    zero_amount_rows = REJECT_ZERO_AMOUNT
    # The protocol states a currency on the account, never on a transaction, so a mismatch drops the account.
    currency_scope = CURRENCY_PER_ACCOUNT
    connect_spec = {
        "style": "token",
        "label": "Setup token",
        "help_url": "https://bridge.simplefin.org/simplefin/create",
        "placeholder": "Paste the setup token from SimpleFIN Bridge",
        # Long, opaque, and single-use, so it is worth saying up front that a fresh one is needed per try.
        "hint": "A setup token can only be used once. Generate a new one if this connection fails.",
    }

    # ---- connect ---------------------------------------------------------

    @staticmethod
    def _claim_url(setup_token: str) -> str:
        token = (setup_token or "").strip()
        if not token:
            raise SimpleFinError("Paste the setup token from SimpleFIN Bridge.")
        try:
            # The token is base64 of the claim URL. Padding is restored because Bridge tokens are commonly
            # copied without it, and a paste that lost the trailing '=' is a user error worth absorbing.
            decoded = base64.b64decode(token + "=" * (-len(token) % 4)).decode("utf-8").strip()
        except (binascii.Error, UnicodeDecodeError, ValueError) as exc:
            raise SimpleFinError("That does not look like a SimpleFIN setup token.") from exc
        if not decoded.lower().startswith("https://"):
            raise SimpleFinError("That does not look like a SimpleFIN setup token.")
        if not _is_bridge_address(decoded):
            raise SimpleFinError("That setup token is not from SimpleFIN Bridge, so it was not used.")
        return decoded

    def connect(self, app_config: dict, payload: dict) -> dict:
        claim_url = self._claim_url(payload.get("setup_token", ""))
        try:
            access_url = _http(claim_url, method="POST").decode("utf-8").strip()
        except SimpleFinError as exc:
            # A setup token is single-use, so the ordinary reason a claim fails is that it has *already
            # been claimed* — and the app cannot tell whether the claimer was the user, on a previous
            # attempt, or someone who intercepted the token. The protocol's own guidance is to state the
            # second possibility, because only the user can act on it and only at the Bridge: a token that
            # leaked has already been exchanged for live, unrevokable read access to their accounts.
            #
            # This deliberately leads with the security reading rather than "generate a new one", which is
            # the reassuring interpretation of identical evidence. Every claim failure carries it, not just
            # a 403: the status distinguishes causes we cannot distinguish anyway (a CDN block answers 403
            # too), and being told to check a token that was in fact fine costs a moment, while not being
            # told about one that leaked costs the account.
            raise SimpleFinError(
                f"{exc} A setup token can only be claimed once, so if this one was not already used here, "
                "it may have been intercepted — disable it at SimpleFIN Bridge and generate a new one."
            ) from exc
        if not access_url.lower().startswith("https://"):
            raise SimpleFinError("SimpleFIN did not return an access URL for that setup token.")
        if not _is_bridge_address(_split_access_url(access_url)[0]):
            raise SimpleFinError(
                "SimpleFIN returned an access address that is not SimpleFIN Bridge, so it was not saved."
            )
        return {
            # The access URL is the credential, so it cannot also be the public handle: `external_id` is
            # stored in the clear and used as the encryption AAD. A hash gives a stable identity for the
            # same URL without the URL itself ever leaving the vault.
            "external_id": "sfin_" + hashlib.sha256(access_url.encode()).hexdigest()[:32],
            "credential": access_url,
            # One access URL can span several banks, so no single institution name describes it. The
            # per-account institution is recorded on the accounts themselves.
            "institution": "SimpleFIN Bridge",
        }

    def remove(self, app_config: dict, credential: str) -> None:
        """No-op: SimpleFIN has no revocation call. Disconnecting deletes Luma's copy of the access URL and
        leaves the URL itself live until the user revokes it at the Bridge. Deliberately silent rather than
        raising — the local disconnect genuinely succeeds — with the caveat carried in the UI's confirm copy,
        which is the only place a user can act on it."""

    # ---- fetching --------------------------------------------------------

    def _get_accounts(self, credential: str, params: dict, *, context: str,
                      repeated: dict[str, list[str]] | None = None) -> tuple[dict, list[str], list[str]]:
        """`(payload, warnings, advisories)` — see `_check_payload` for the split between the two message
        lists."""
        # `repeated` carries parameters the protocol expects more than once (`account=a&account=b`), which
        # a plain dict cannot express.
        base, username, password = _split_access_url(credential)
        query = list(params.items())
        for key, values in (repeated or {}).items():
            query.extend((key, v) for v in values)
        if not _is_bridge_address(base):
            # Re-checked here and not only at connect time. The address is validated when it is claimed, but
            # this reads it back out of the vault on every call, and a stored value that somehow became
            # http://, or names another host, would put a credential on the wire to the wrong place — which
            # no later validation can undo.
            raise SimpleFinError("This connection's address is not an HTTPS SimpleFIN Bridge address; reconnect it.")
        url = f"{base}/accounts?{urllib.parse.urlencode(query)}"
        try:
            body = _http(url, headers={"Authorization": _basic_auth_header(username, password)})
        except SimpleFinError as exc:
            if exc.status == 403:
                # The access URL itself was refused. SimpleFIN has no revocation API, so a user revoking at
                # the Bridge is both the expected way to revoke *and* invisible to us until this happens —
                # this 403 is the only notice the app ever gets. Raised as the seam's own reconnect signal
                # rather than as another sync failure, because no amount of retrying will fix it and there
                # is exactly one thing the user can do about it.
                raise ProviderCredentialRejected(
                    "SimpleFIN refused this connection's access credentials. If the access was revoked at "
                    "SimpleFIN Bridge, connect again with a new setup token."
                ) from exc
            raise
        try:
            payload = json.loads(body)
        except ValueError as exc:
            raise SimpleFinError("SimpleFIN returned a response that could not be read.") from exc
        warnings, advisories = _check_payload(payload, context=context)
        return payload, warnings, advisories

    @staticmethod
    def _org_names(payload: dict) -> dict:
        """conn_id → institution name. `org_name` is the institution; `name` is the user's own label for
        the link ("My Bank - Jeff"), which identifies the *connection* rather than the bank, so it is only
        a fallback. Older servers put the same thing in an `org` object on each account instead."""
        names = {}
        for entry in payload.get("connections") or []:
            if entry.get("conn_id"):
                names[entry["conn_id"]] = entry.get("org_name") or entry.get("name") or entry.get("org_id")
        return names

    def fetch_accounts(self, app_config: dict, credential: str) -> list[dict]:
        # balances-only: the accounts list is the only thing wanted here, and asking for transactions too
        # would spend the same single request on a payload nothing reads.
        # Warnings are logged and dropped here rather than returned: `fetch_accounts` answers "what does
        # this credential offer", and its caller (connect / refresh-accounts) shows the answer immediately,
        # so a bank missing from the list is visible on the spot. The sync path has no such moment, which
        # is why it carries them through instead.
        payload, _, _ = self._get_accounts(credential, {"balances-only": 1, "version": 2},
                                           context="fetching accounts")
        org_names = self._org_names(payload)
        accounts = []
        for a in payload.get("accounts") or []:
            org = a.get("org") or {}
            institution = org.get("name") or org_names.get(a.get("conn_id")) or org.get("domain")
            accounts.append({
                # Namespaced because accounts are looked up by external id without a provider filter, so a
                # bare provider-assigned id could collide with another provider's.
                "external_account_id": _ACCOUNT_ID_PREFIX + str(a.get("id")),
                "name":                a.get("name") or "Account",
                # The bank's own name for the account is not supplied, so the institution goes here — it is
                # what tells two accounts apart on a card holding several banks.
                "official_name":       institution,
                # SimpleFIN classifies nothing: no type, no subtype, and no mask separate from the name.
                "type":                None,
                "subtype":             None,
                "mask":                None,
                # Recorded so the mapping step can warn *before* an account whose transactions will be
                # discarded is given a destination. Catching it at sync time only would mean the user maps
                # the account, runs a sync, and gets an empty account plus a warning explaining why.
                "currency":            _account_currency(a),
            })
        return accounts

    def capture_fields(self) -> list[dict]:
        # Only what SimpleFIN actually supplies. A provider that cannot report counterparties, a merchant
        # id, a check number or a location omits them rather than offering controls that would do nothing.
        return [
            {"key": "authorized_date",      "label": "Transaction date (as well as posted date)",
             "locked": True, "default_on": True},
            {"key": "provider_description", "label": "Original description",
             "locked": True, "default_on": True},
        ]

    @staticmethod
    def _normalize_txn(account_external_id: str, t: dict) -> dict:
        posted_date = _epoch_to_iso_date(t.get("posted"))
        # When the charge was made, as against when it posted — the field duplicate detection values most,
        # because two sources for one charge routinely report different ones of the two. It is also the
        # only date a pending row has, which is why it is read before the mapping rather than inside it.
        transacted_date = _epoch_to_iso_date(t.get("transacted_at"))
        return {
            # **Namespaced by account, exactly as the account id itself is namespaced by provider.** The
            # ledger treats `external_transaction_id` as globally unique (a UNIQUE column, and every sync
            # lookup queries it unscoped), which is true of Plaid's ids and is NOT something SimpleFIN
            # promises: the protocol only makes a transaction id meaningful *within* its account. The Bridge's
            # demo server derives ids from the posting instant and runs every account on one schedule, so two
            # accounts issue byte-identical ids — and the second account's rows then matched the first's on
            # that unscoped lookup and were dropped as already-held. Silent, and total: the account imported
            # nothing while the sync reported success. Prefixing here keeps the ledger's invariant true at
            # the boundary that knows it isn't, rather than weakening it for every provider.
            "external_transaction_id": f"{account_external_id}:{t.get('id')}",
            "external_account_id":     account_external_id,
            "amount":                  _to_amount(t.get("amount")),
            # Three name-ish fields, and which is which is not what their names suggest. Observed on a
            # live server: `description` is a *cleaned* short label ("Grocery store"), `memo` is the raw
            # bank descriptor ("LOCAL GROCER STORE #1133"), and `payee` is the cleaned counterparty
            # ("John's Fishin Shack"). Only `description` is guaranteed by the protocol, so the other two
            # fall back to it.
            "merchant_name":           (t.get("payee") or "").strip() or t.get("description"),
            # The raw descriptor, not the tidy one: duplicate detection's text matcher and the origin
            # hover both read this, and the store number a cleaned label drops is exactly the detail that
            # tells two similar charges apart and matches a CSV's own raw column.
            "raw_name":                (t.get("memo") or "").strip() or t.get("description"),
            # The posted date where the charge has posted, and the transaction date while it is still
            # pending. A pending row needs a real date for the same reason it is imported at all: it is
            # ledger content, showing money already committed, and every date test in the duplicate ladder
            # works within a few days of a charge's actual date — so a row dated decades away is invisible
            # to the ladder and to every report. The settled version arrives under the same id and the sync
            # re-stamps this with the true posted date then. Both absent leaves it None, which
            # `_fetch_window` drops: a row with no date anywhere has nothing to file it under.
            "date":                    posted_date or transacted_date,
            "authorized_date":         transacted_date,
            "is_pending":              bool(t.get("pending")),
        }

    def _fetch_window(self, credential: str, start: date, end: date,
                      account_ids: list[str] | None = None,
                      ledger_currency: str = DEFAULT_LEDGER_CURRENCY,
                      *, end_of_day: bool, pool: str, requested: list | None = None,
                      ) -> tuple[list[dict], list[str], list[dict], dict[str, str]]:
        """One request: transactions in one window, the non-fatal problems reported alongside them split
        into `(warnings, advisories)`, and the accounts whose rows were discarded for being in another
        currency.

        `account_ids` narrows the response to specific provider accounts. It reduces the *payload*, not the
        number of requests — a range is still a range — so it does not by itself make a deep pull cheaper.
        Its value is that catching one account up does not have to re-deliver every sibling's history.

        `end_of_day` says whether this window carries the pull's newest bound; it is keyword-only and has no
        default so a new call site has to answer the question rather than inherit an answer. `pool` is the
        allowance this request is charged against, and follows the same rule for the same reason — it is
        passed rather than inferred from `account_ids` because narrowing the payload and charging an
        account's own bucket are two independent decisions that merely happen to coincide today."""
        # The bounds are *instants*, not dates — **confirmed against the live server**, not inferred: the
        # same 30-day window requested with a midnight end and a 23:59:59 end returned 56 and 58
        # transactions respectively. The two rows in the gap are why the long bound exists at all.
        #
        # It exists for exactly one window per pull: the newest. A charge posted at 23:59 on that end date
        # is after midnight-of-that-date, so a midnight bound would leave it outside every window ever
        # asked for while coverage — recorded per date — went on claiming the day. `today` is always this
        # case for a pull that reaches it, since nothing covers the rest of today.
        #
        # Every older window ends at midnight, because the window immediately newer starts at that same
        # instant and runs forward from it — the day is covered, once. Closing those at 23:59:59 instead
        # re-fetched the boundary day in full: harmless to correctness (the insert is idempotent on the
        # provider transaction id) but not free, since it inflated every response by a day and, because the
        # bounds are instants, stretched a nominal N-day window to N days plus 23:59:59 on the wire — which
        # is what made a 45-day walk trip the server's own 45-day range advisory.
        # Recorded here because this is the one place every dated request passes through, so a window can
        # never be asked for without being reported. What it feeds is the sync log: "which days did this
        # actually go and look at" is the question a walking, budgeted adapter leaves open, and the resume
        # checkpoint alone cannot answer it — the checkpoint says where the pull *ended up*, not what it
        # asked for on the way. The two differ exactly when it matters, since a pull that stops on its
        # budget moves its frontier less far than the requests it spent would suggest.
        #
        # The pool travels with the window because a bare count of requests cannot be reconciled against
        # any one allowance: a walk narrow enough to filter charges each account's own bucket, a wide one
        # charges the shared bucket, and "21 requests" spanning both says nothing about how close either
        # came to running out. Which bucket paid is the difference between "one account is exhausted" and
        # "the whole connection is", which are different problems with different remedies.
        if requested is not None:
            requested.append({"start": start.isoformat(), "end": end.isoformat(), "pool": pool})
        end_time = datetime.max.time() if end_of_day else datetime.min.time()
        params = {
            "start-date": int(datetime.combine(start, datetime.min.time(), tzinfo=timezone.utc).timestamp()),
            "end-date":   int(datetime.combine(end, end_time, tzinfo=timezone.utc).timestamp()),
            "pending":    1,
            "version":    2,
        }
        payload, warnings, advisories = self._get_accounts(credential, params, context=(
            f"fetching {start.isoformat()}..{end.isoformat()}"
        ), repeated={"account": [_strip_prefix(a) for a in account_ids]} if account_ids else None)
        out = []
        dropped: dict[str, str] = {}
        for a in payload.get("accounts") or []:
            account_external_id = _ACCOUNT_ID_PREFIX + str(a.get("id"))
            transactions = a.get("transactions") or []
            if not _is_ledger_currency(a, ledger_currency):
                # Discarded, not converted and not imported at face value: the ledger stores a bare number
                # with no denomination beside it, so importing these would quietly add another currency's
                # amounts into every total (see `services/ledger_currency.py`). Reported by account so the silence is
                # attributable — an account that simply had no activity looks identical otherwise.
                if transactions:
                    dropped[account_external_id] = _account_currency(a)
                continue
            for t in transactions:
                row = self._normalize_txn(account_external_id, t)
                if row["date"]:
                    out.append(row)
        return out, warnings, advisories, dropped

    def fetch_transactions(
        self, app_config: dict, credential: str, start_date: date | None = None, end_date: date | None = None
    ) -> list[dict]:
        """A plain date-range pull, sliced into `WINDOW_DAYS` requests.

        This is the unbudgeted path: it spends one request per slice with no accounting, so it is meant for
        a bounded range a caller has already reasoned about. Routine syncing and backfills go through
        `fetch_transactions_sync`, which walks and meters.

        Rows in another currency are dropped here as everywhere, but not *reported*, and neither are the
        server's warnings or advisories: the signature returns a bare list with nowhere to put any of them
        (they still reach the console via `_check_payload`). That is why this is not the syncing path."""
        end = end_date or date.today()
        start = start_date or (end - timedelta(days=self.routine_lookback_days))
        rows: list[dict] = []
        window_start = start
        while window_start < end:
            window_end = min(window_start + timedelta(days=WINDOW_DAYS), end)
            # Only the last slice holds the caller's own end bound; the interior ones are each abutted by
            # the slice after them. Note this end may be a historical date rather than today — clipping it
            # to midnight would drop the very last day the caller asked for.
            rows.extend(self._fetch_window(credential, window_start, window_end,
                                           end_of_day=window_end == end)[0])  # advisories: see docstring
            window_start = window_end
        return rows

    # ---- the budgeted walk ----------------------------------------------

    @staticmethod
    def _load_state(cursor: str | None) -> dict:
        """The connection's resume checkpoint, kept in the column that holds a cursor for providers that
        have one. Anything unreadable resets to a fresh walk rather than failing the sync: the walk is
        idempotent, so re-deriving it costs requests but never correctness."""
        try:
            state = json.loads(cursor) if cursor else {}
        except (TypeError, ValueError):
            state = {}
        return state if isinstance(state, dict) else {}

    def _fetch_recent(self, credential: str, state: dict, today: date, warnings: dict,
                      advisories: dict, dropped: dict[str, str], ledger_currency: str,
                      requested: list | None = None) -> list[dict]:
        """The recent window — one request, overlapping what is already held.

        The overlap is the provider's own guidance and covers a real case: a transaction can post with a
        date earlier than the moment it becomes visible, so a window starting exactly where the last one
        ended would step over it. `through` advances only here and only after the fetch, because it is a
        claim about data actually in hand.
        """
        through = date.fromisoformat(state["through"]) if state.get("through") else today
        window_start = min(through - timedelta(days=INCREMENTAL_OVERLAP_DAYS), today)
        rows, window_warnings, window_advisories, window_dropped = self._fetch_window(
            credential, window_start, today, ledger_currency=ledger_currency,
            # The top-up is always the newest bound there is, so its end runs to the close of today —
            # otherwise every sync would miss whatever posted since midnight and never come back for it.
            # Charged to the shared bucket: the top-up is unfiltered, covering every account at once.
            end_of_day=True, pool=_SHARED_POOL, requested=requested)
        warnings.update(dict.fromkeys(window_warnings))
        _merge_advisories(advisories, window_advisories)
        dropped.update(window_dropped)
        state["through"] = today.isoformat()
        return rows

    def _walk_history(self, credential: str, budget: dict, targets: list[dict], today: date, now: float,
                      warnings: dict, advisories: dict, dropped: dict[str, str],
                      ledger_currency: str, requested: list | None = None, checkpoint=None,
                      ) -> tuple[list[dict], dict, bool, bool]:
        """Walk backward until every targeted account has reached its requested depth or run out of history.

        One loop serves every case there is — a first backfill, a deepening pull, and an account that joined
        the connection later — because they differ only in *which* accounts still want older data and how far
        back. That is what the targets say, so nothing here needs to know which situation it is in.

        **Which allowance a window is charged to** is the one decision that varies, and it turns on how many
        accounts are still walking (`FILTERED_WALK_MAX_ACCOUNTS`). A large set shares one unfiltered window
        that advances all of them for a single shared token. A small set is fetched per account instead, one
        request each against each account's own allowance, leaving the shared pool for the top-up and for
        account discovery.

        A filtered round asks for **one account per request**, never several in one call. The Bridge
        describes the separate allowance for `?account=X` in the singular, and nothing says which pool a
        request naming two accounts would be charged to — so the shape that was actually described is the
        only one used.

        Per-account rounds also drop the shared frontier: since each account is being asked for separately
        anyway, each is asked for *its own* window, and an account whose allowance runs out pauses on its
        own without stalling its siblings.
        """
        reach = {t["external_account_id"]: date.fromisoformat(t["from_date"]) for t in targets}
        streaks = {t["external_account_id"]: int(t.get("empty_streak") or 0) for t in targets}
        # Each account starts from wherever it has already reached, so one that is further along does not
        # re-fetch what it holds while a laggard catches up.
        frontier = {
            t["external_account_id"]: date.fromisoformat(t["reached"]) if t.get("reached") else today
            for t in targets
        }
        # Only accounts this call actually advanced, populated by `advance` below — never pre-seeded from
        # where they already stood. Seeding it made every target report `reached` even when the call never
        # fetched for it, which was invisible while a call always walked every account to its end but
        # becomes an over-claim the moment a page stops early: an account that was merely waiting its turn
        # would report having reached *today*, and coverage that overstates itself makes duplicate
        # detection reject genuine rows inside the range it invented. Saying nothing about an untouched
        # account is both true and what the caller wants — it writes only what it is told.
        coverage: dict[str, dict] = {}
        added: list[dict] = []
        resume_later = False
        # Set when the CDN starts refusing. Kept apart from `resume_later` because they bound different
        # things: an account out of its daily allowance stops *that account* while its siblings carry on,
        # whereas being rate-limited stops the whole client — so this one also has to suppress `has_more`,
        # or the caller would come straight back for the next page and be refused again.
        rate_limited = False
        # Windows fetched in this call, against `WINDOWS_PER_PAGE`. Reaching the limit ends the page, not
        # the walk — the difference is what `more_to_walk` below reports, and it is the difference between
        # the caller committing and coming straight back versus concluding the history is finished.
        windows_fetched = 0
        # Accounts that ran out of their own allowance mid-walk. Held apart from the stop rules because this
        # is not a conclusion about their history — they are simply done being asked *today*, and must not
        # be re-offered to the loop or it would spin on an account it can no longer fetch.
        out_of_budget: set[str] = set()

        def still_walking() -> list[str]:
            return [a for a in reach
                    if a not in out_of_budget
                    and frontier[a] > reach[a] and streaks[a] < EMPTY_WINDOWS_END_HISTORY]

        def absorb(result) -> set[str]:
            """Fold one request's answer into the pull, returning which accounts it delivered rows for."""
            rows, window_warnings, window_advisories, window_dropped = result
            warnings.update(dict.fromkeys(window_warnings))
            # Counted rather than set-deduped: a walk provokes the same advisory on every one of its ~22
            # requests, and "22 times" is the diagnostic signal — it says the whole walk was affected, not
            # one stray request. Warnings stay a plain ordered set above; they describe a bank, and how many
            # windows re-reported it says nothing about the bank.
            _merge_advisories(advisories, window_advisories)
            dropped.update(window_dropped)
            added.extend(rows)
            return {r["external_account_id"] for r in rows}

        def advance(account: str, window_start: date, delivered: set[str]) -> None:
            streaks[account] = 0 if account in delivered else streaks[account] + 1
            frontier[account] = max(window_start, reach[account])
            coverage[account] = {
                "reached": frontier[account].isoformat(),
                # Only an account whose own windows came back empty has *ended*; one that merely hit the
                # depth asked for has more behind it, and saying otherwise would stop a later, deeper
                # request from ever looking.
                "complete": streaks[account] >= EMPTY_WINDOWS_END_HISTORY,
                # Carried so a walk that pauses mid-streak resumes counting rather than starting over and
                # needing two more empty windows to reach the same conclusion.
                "empty_streak": streaks[account],
            }

        # The walk moves backward, so a window's end is normally a date something newer already covers — the
        # previous window of this run, or, for an account resuming from a stored `reached`, the window that
        # reached it (which ran from that date's midnight forward). Today is the one exception: on a fresh
        # account the first window ends there with nothing after it.
        while (active := still_walking()):
            if windows_fetched >= WINDOWS_PER_PAGE:
                break  # page full; the caller commits what this reached and comes straight back
            if len(active) <= FILTERED_WALK_MAX_ACCOUNTS:
                for account in active:
                    # Counted per *request*, not per pass: a filtered round makes one call per account, and
                    # each is its own round trip and its own token. Stopping partway through leaves some
                    # accounts advanced and others not, which needs no bookkeeping — each carries its own
                    # frontier, so the next page simply picks up whichever are still behind.
                    if windows_fetched >= WINDOWS_PER_PAGE:
                        break
                    if not _take_request(budget, account, now, checkpoint):
                        out_of_budget.add(account)
                        resume_later = True
                        continue
                    window_end = frontier[account]
                    window_start = window_end - timedelta(days=WINDOW_DAYS)
                    try:
                        delivered = absorb(self._fetch_window(
                            credential, window_start, window_end, [account], ledger_currency=ledger_currency,
                            end_of_day=window_end == today, pool=account, requested=requested,
                        ))
                    except SimpleFinRateLimited:
                        # Everything absorbed before this stands, and this account has not advanced — so
                        # the next run asks for exactly the window that was refused.
                        rate_limited = resume_later = True
                        break
                    windows_fetched += 1
                    advance(account, window_start, delivered)
                if rate_limited:
                    break
                continue
            if not _take_request(budget, _SHARED_POOL, now, checkpoint):
                # Out of allowance with history still to walk. Stopping here is what keeps the token from
                # being disabled; each account's recorded reach is what makes the rest resume rather than
                # be forgotten — no separate parking state is needed.
                #
                # **Pausing here is a choice, not the only option**, and it is worth being explicit because
                # the code no longer looks like it: every account's own allowance is sitting untouched one
                # line away. A wide walk *could* fall back to per-account requests and keep going, and since
                # the pools are independent that would roughly double the depth reachable in a day.
                #
                # It is deliberately not done. The fallback only ever engages on a *wide* walk — a narrow
                # one is already filtering — so it trades one paused sync for N requests per window across
                # every account still walking. On a first backfill N is every account on the credential,
                # which turns a pull that stops after 22 requests into one making several hundred: minutes
                # of syncing, on a user's first impression of the connection, to reach history that the
                # next sync reaches anyway. The paused walk is not losing anything but time, and time is
                # exactly what the fallback spends.
                #
                # What would change the answer: a walk that pauses and *cannot* resume promptly (a
                # connection synced rarely enough that "the next sync" is weeks away), or evidence that
                # users abandon a backfill that takes several days to finish. Neither is measurable from
                # here today. If it is revisited, note that the honest version is not "fall back when the
                # shared pool empties" but "spend the shared pool on the windows that serve the most
                # accounts, and per-account allowances on the stragglers" — the fallback framing wastes the
                # shared pool on accounts that would have been cheaper to fetch individually.
                resume_later = True
                break
            window_end = max(frontier[a] for a in active)
            window_start = window_end - timedelta(days=WINDOW_DAYS)
            try:
                delivered = absorb(self._fetch_window(
                    credential, window_start, window_end, None, ledger_currency=ledger_currency,
                    end_of_day=window_end == today, pool=_SHARED_POOL, requested=requested,
                ))
            except SimpleFinRateLimited:
                rate_limited = resume_later = True
                break
            windows_fetched += 1
            for account in active:
                if frontier[account] != window_end:
                    continue  # this account had already gone deeper; the window told it nothing new
                advance(account, window_start, delivered)
        # Whether anything is still owed data. Distinct from `resume_later`: this says "come straight back
        # for another page", that says "stop asking until the allowance refills".
        #
        # `rate_limited` is returned rather than folded into the two flags above because it is the *reason*,
        # and the reason is the half a reader needs: a refusal by the server and an empty local bucket
        # produce the same pause and call for opposite responses.
        return added, coverage, resume_later, bool(still_walking()) and not rate_limited, rate_limited

    def fetch_transactions_sync(
        self, app_config: dict, credential: str, cursor: str | None = None, days_requested: int = 730,
        account_targets: list[dict] | None = None, ledger_currency: str = DEFAULT_LEDGER_CURRENCY,
        request_budget: dict | None = None, continuing: bool = False,
        budget_checkpoint=None,
    ) -> dict:
        """Walk history for whichever accounts still want it, or top up the recent window.

        Which one happens is decided by the caller, which owns the database and therefore knows each
        account's coverage; this adapter holds no history state of its own. All that remains in its resume
        token is the newest date covered — the only genuinely provider-owned fact left, now that spending
        lives in `request_budget` instead (see the module docstring for why the two cannot share a home).

        `request_budget` is updated **in place** as each request is spent, which is the entire reason it is
        a parameter rather than part of the return value: a pull that raises partway through has still made
        every request it made, and only a mutable argument can carry that back out of an exception. Omitting
        it is honest but unmetered — a caller that keeps no record gets no throttling — so the sync path
        always passes one.
        """
        state = self._load_state(cursor)
        today = _utc_today()
        now = _utcnow_epoch()
        budget = request_budget if request_budget is not None else {}
        _adopt_legacy_budget(budget, state, today, now)
        added: list[dict] = []
        resume_later = False
        # Whether this call left history still to walk. False for a routine top-up, which has no walk.
        more_to_walk = False
        # Whether the CDN refused us partway through. Suppresses `has_more` below: the daily allowance is
        # per account, but this limit is on the client, so coming straight back is refused again.
        rate_limited = False
        # Deduplicated in order: the same bank reports the same problem in every window the walk touches,
        # and a user reading the connection card needs the distinct problems, not one per request.
        warnings: dict[str, None] = {}
        # Counted, not merely deduplicated: an advisory describes *our request*, so how many of a walk's
        # requests provoked it is the useful part. See the `advisories` note in `ProviderAdapter`.
        advisories: dict[str, dict] = {}
        coverage: dict[str, dict] = {}
        # Accounts whose rows this pull discarded for being in another currency. Accumulated across every
        # window rather than per window, since one account's denomination does not change between them.
        dropped_currency: dict[str, str] = {}
        # Every dated request this call makes, in the order made. Diagnostic only — nothing decides anything
        # from it — but it is the one record of what was actually asked for, which neither the row counts nor
        # the resume checkpoint can reconstruct.
        requested_windows: list[dict] = []

        if account_targets:
            # Where the walk will begin: the newest point any account still wants data from.
            walk_from = max(
                (date.fromisoformat(t["reached"]) if t.get("reached") else today)
                for t in account_targets
            )
            # Opens a *pull*, not a page — hence `continuing`. A walk is delivered a page at a time, so
            # from the second page onward every call looks exactly like a resuming walk (`walk_from` has
            # moved back from today by then), and guarding on `walk_from` alone bought a fresh unfiltered
            # top-up on every page: metered requests spent re-fetching one window, and rows arriving for
            # accounts the walk had deliberately filtered out. The state cannot answer this on its own —
            # "a new pull started today" and "another page of the pull already running" look identical from
            # in here — so the caller, which is the only thing that knows, says which it is.
            if walk_from < today and not continuing:
                # The walk has already moved back from today, so every window it fetches is old and no
                # *new* transaction would arrive for however many days the walk takes to finish. One
                # request on the recent window first keeps the ledger current — which is the part a user
                # actually looks at — while history fills in behind it.
                # Charged to the shared pool because it is an unfiltered window: it covers every account at
                # once, which is exactly what makes it worth one request instead of one per account.
                if _take_request(budget, _SHARED_POOL, now, budget_checkpoint):
                    try:
                        added.extend(self._fetch_recent(
                            credential, state, today, warnings, advisories, dropped_currency,
                            ledger_currency, requested_windows))
                    except SimpleFinRateLimited:
                        # Refused before the walk even started, so there is nothing to walk with either.
                        # `through` is untouched, so the next run re-asks for this same window.
                        rate_limited = resume_later = True
                else:
                    resume_later = True
            else:
                # The walk still starts at today, so its first window already covers the recent period;
                # a separate top-up would re-fetch a subset of it for nothing.
                state["through"] = today.isoformat()

            if not rate_limited:
                walk_added, coverage, walk_resume, more_to_walk, walk_rate_limited = self._walk_history(
                    credential, budget, account_targets, today, now, warnings, advisories,
                    dropped_currency, ledger_currency, requested_windows, budget_checkpoint,
                )
                added.extend(walk_added)
                resume_later = resume_later or walk_resume
                rate_limited = rate_limited or walk_rate_limited
        elif _take_request(budget, _SHARED_POOL, now, budget_checkpoint):
            try:
                added.extend(self._fetch_recent(
                    credential, state, today, warnings, advisories, dropped_currency, ledger_currency,
                    requested_windows))
            except SimpleFinRateLimited:
                rate_limited = resume_later = True
        else:
            resume_later = True
        _prune_full_pools(budget)

        # Every targeted account either reached the depth asked of it or ran out of history — which is
        # exactly what "nothing is still walking" means, so the walk's own stop condition answers this
        # rather than a second pass over the coverage it reported. It has to: coverage now describes only
        # the accounts *this page* touched, so a page that ended early says nothing about the rest, and
        # reading completeness out of it would call a paused walk finished. A pull with no targets had no
        # history to finish, so it is trivially done.
        backfill_complete = not resume_later and not more_to_walk
        # An account whose rows were discarded is claimed for nothing, whatever the walk recorded for it.
        # The caller normally keeps such an account out of the targets entirely (it reads the currency it
        # stored at connect time), but that stored value can be absent — a restore carries `connection_account`
        # rows from a backup predating the column, and the next sync runs before anything refreshes them. The
        # adapter is the one place that always knows, because it just threw the rows away. Without this, such
        # an account's windows come back empty, its streak reaches the end-of-history rule, and it records
        # both a coverage start and `history_complete` over a range where its transactions plainly exist —
        # the over-claim that makes duplicate detection reject genuine rows later.
        for external_account_id in dropped_currency:
            coverage.pop(external_account_id, None)
        return {
            "added":         added,
            "modified":      [],
            # Permanently empty: SimpleFIN has no way to report that a transaction was removed. Not the
            # same as it confirming that none were.
            "removed":       [],
            "next_cursor":   json.dumps(state),
            # A page is `WINDOWS_PER_PAGE` windows, so a walk with history left asks the caller to come
            # straight back for the next one. That is what makes each window's rows durable as they arrive
            # and releases the write lock between requests.
            #
            # `more_to_walk` **already excludes** accounts that ran out of allowance, so it means exactly
            # "there is work I can still do right now" — which is the only question this field asks.
            #
            # It must not also be gated on `resume_later`. Allowances are per account, so one exhausted
            # account sets `resume_later` while its siblings still have plenty; conjoining the two stopped
            # the whole drain on the first account to run dry, leaving a connection creeping forward one
            # window per manual sync with its shared pool almost untouched. `resume_later` answers a
            # different question — whether the *client* should poll again later — and the sync layer reads
            # it separately for exactly that.
            "has_more":      more_to_walk,
            # Which of the two stops this was, not merely that one happened — see the constants.
            "update_status": (RATE_LIMITED if rate_limited else BUDGET_PAUSED) if resume_later else None,
            # The allowance this pull left behind. Reported on every page rather than only a paused one: a
            # pull that finished comfortably and one that stopped a single request short look identical
            # without it, and which of the two happened is what says whether the next sync will complete.
            "request_allowance": _allowance_snapshot(budget, now),
            "backfill_complete": bool(backfill_complete),
            "resume_later":  resume_later,
            # Per account, and only what this pull actually reached — never what it set out to reach.
            "account_coverage": coverage,
            # The date ranges this call actually asked the server for. Optional in the page contract, and
            # meaningful only for an adapter that pulls ranges: a cursor provider asks for "everything since
            # this token" and has no window to report.
            "requested_windows": requested_windows,
            # Banks on this access URL that reported a problem while the others delivered normally.
            "warnings": list(warnings),
            # What the server said about *our* requests — a range it considers too wide, and so on. Never
            # shown on the connection card (nothing here is the user's to fix), but recorded in the sync
            # log, which is the only place a change in the provider's limits is visible without reading
            # the server console. `count` is how many of this pull's requests drew the same remark.
            "advisories": list(advisories.values()),
            # Accounts whose rows were discarded as not being in the ledger's currency. Left for the caller
            # to judge: only it knows which of these the user actually mapped, and so which are a real loss
            # rather than an account already being ignored.
            "unsupported_currency": dict(dropped_currency),
        }
