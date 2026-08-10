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

**No sandbox.** Every access URL is live bank data, so there is no later moment at which to demand a
strong vault passphrase — the Production gate moves to connect time. The Bridge's published demo token is
the one exemption, since it serves fabricated accounts.

**No cursor, and no way to ask how far back history goes.** The protocol has no change feed and no
coverage-start field, so a backfill is a *walk*: request fixed-size windows (`WINDOW_DAYS`) backward until
they come back empty. Nothing in the response says when to stop, which is why the walk requires two
consecutive empty windows rather than one — a single quiet quarter on a low-activity card is not evidence
that history ended.

**A published request budget** — 24 requests/day, with token disablement as the penalty. That is far more
than a walk normally needs (24 windows reaches back about three years, and one request covers every account
on the URL), so the budget is a guard against the runaway case, not a schedule. When it does run out the walk
records where it got to and reports `resume_later`, so the sync stops rather than pushing the token toward
disablement, and a later sync continues from the same checkpoint.

**No revocation.** There is no call that invalidates an access URL, so `remove()` deletes Luma's copy and
nothing more; only the user, at the Bridge, can actually revoke one. The disconnect confirmation has to
say so — see `docs/backlog/security-and-deployment-model.md`, whose custody model is conditioned on
provider credentials being revocable in-app and is explicitly not, for this one.

Because there is no cursor to store, the connection's `transactions_cursor` column carries this adapter's
own JSON checkpoint instead. That column was always defined as an opaque provider resume token; a
provider with no change feed simply resumes from something other than a cursor.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone

from backend.app_logging import log_warning
from backend.services.ledger_currency import DEFAULT_LEDGER_CURRENCY, currency_matches
from backend.services.providers.base import ProviderAdapter, ProviderCredentialRejected
from backend.services.source_capabilities import REJECT_ZERO_AMOUNT

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

# Of the 24 requests/day the Bridge publishes, the ones a transaction walk may spend. The remainder is
# left for the operations a user runs alongside it — refreshing accounts, reconnecting — so a deep walk
# cannot leave the connection unusable for the rest of the day. At the window size above this reaches
# roughly 2.7 years back in a single day, comfortably past what the Bridge's upstreams actually hold.
DAILY_REQUEST_BUDGET = 22

# Consecutive empty windows that end the backward walk. One is not enough: an account with no activity for
# a quarter would report exactly the same thing as an account whose history has run out, and stopping
# there would silently truncate the backfill.
EMPTY_WINDOWS_END_HISTORY = 2

# Marker on `update_status` when the walk stopped on its request budget rather than at the end of history.
# Carried for diagnostics and display; the machine-readable signal is `resume_later`.
BUDGET_PAUSED = "BUDGET_PAUSED"

# The Bridge's published demo token claims fabricated accounts. Recognized so the Production-strength vault
# gate — correct for a provider whose every real credential is live bank access — does not also stand
# between a developer and the one credential that is not.
_DEMO_CLAIM_MARKER = "/claim/DEMO-"

_HTTP_TIMEOUT_SECONDS = 60
_ACCOUNT_ID_PREFIX = "simplefin:"

# Sent on every request. Naming the client is not politeness — the CDN fronting the Bridge rejects
# urllib's default agent outright (see `_http`), so an anonymous request never reaches SimpleFIN at all.
_USER_AGENT = "Luma (+https://github.com/jeff162/luma)"

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
    request = urllib.request.Request(url, method=method, headers=headers or {})
    # Identify the client explicitly. urllib's default (`Python-urllib/x.y`) is blocked outright by the
    # CDN in front of the SimpleFIN Bridge, which answers 403 `error code: 1010` — a browser-signature
    # ban, with nothing in it to suggest the User-Agent is the problem. Any named agent passes.
    request.add_header("User-Agent", _USER_AGENT)
    try:
        with urllib.request.urlopen(request, timeout=_HTTP_TIMEOUT_SECONDS) as response:
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
    request shape repeats on every window of a walk, and one entry saying "×24" is the diagnostic, where
    24 near-identical entries are noise. The *first* context is kept rather than the last or all of them —
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
    try:
        return datetime.fromtimestamp(int(value), tz=timezone.utc).date().isoformat()
    except (TypeError, ValueError, OSError, OverflowError):
        return None


def _utc_today() -> date:
    """The day the request budget is counted against, in UTC rather than the server's local time.

    The distinction matters because overrunning the limit is the one error with a punitive outcome — the
    provider disables the token — and a counter that resets on local midnight gives a machine running
    behind UTC a second allowance partway through the provider's day."""
    return datetime.now(timezone.utc).date()


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
    max_history_days = None           # the Bridge publishes no history cap; the walk finds the end itself
    routine_lookback_days = 30
    # Rejected: the Bridge publishes no change feed and no pending pointer, so nothing can ever revise a
    # row already held — a settling charge arrives under a *new* id as its own row, leaving the $0 one
    # stranded (duplicate detection cannot pair them; the amounts differ). Same dead weight as a CSV's.
    zero_amount_rows = REJECT_ZERO_AMOUNT
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
        return decoded

    def connect_requires_production_vault(self, payload: dict) -> bool:
        try:
            claim_url = self._claim_url(payload.get("setup_token", ""))
        except SimpleFinError:
            # An unusable token is rejected by `connect` with a message about the token. Demanding a
            # stronger passphrase first would answer a question the user did not get wrong.
            return False
        return _DEMO_CLAIM_MARKER.lower() not in claim_url.lower()

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
        if not base.lower().startswith("https://"):
            # Re-checked here and not only at connect time. The scheme is validated when the access URL is
            # claimed, but this reads it back out of the vault on every call, and the protocol's rule is
            # about the *request*: a stored value that somehow became http:// would put a credential on
            # the wire in the clear, which no later validation can undo.
            raise SimpleFinError("This connection's SimpleFIN address is not HTTPS; reconnect it.")
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
            "date":                    _epoch_to_iso_date(t.get("posted")),
            # When the charge was made, as against when it posted — the field duplicate detection values
            # most, because two sources for one charge routinely report different ones of the two.
            "authorized_date":         _epoch_to_iso_date(t.get("transacted_at")),
            "is_pending":              bool(t.get("pending")),
        }

    def _fetch_window(self, credential: str, start: date, end: date,
                      account_ids: list[str] | None = None,
                      ledger_currency: str = DEFAULT_LEDGER_CURRENCY,
                      *, end_of_day: bool,
                      ) -> tuple[list[dict], list[str], list[dict], dict[str, str]]:
        """One request: transactions in one window, the non-fatal problems reported alongside them split
        into `(warnings, advisories)`, and the accounts whose rows were discarded for being in another
        currency.

        `account_ids` narrows the response to specific provider accounts. It reduces the *payload*, not the
        number of requests — a range is still a range — so it does not by itself make a deep pull cheaper.
        Its value is that catching one account up does not have to re-deliver every sibling's history.

        `end_of_day` says whether this window carries the pull's newest bound; it is keyword-only and has no
        default so a new call site has to answer the question rather than inherit an answer."""
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

    @staticmethod
    def _spend(state: dict, today: date) -> bool:
        """Take one request from today's allowance, returning whether there was one to take. The counter
        resets by date, so an exhausted walk becomes runnable again the next day without anything having
        to schedule it."""
        if state.get("budget_date") != today.isoformat():
            state["budget_date"] = today.isoformat()
            state["requests_used"] = 0
        if state.get("requests_used", 0) >= DAILY_REQUEST_BUDGET:
            return False
        state["requests_used"] = state.get("requests_used", 0) + 1
        return True

    def _fetch_recent(self, credential: str, state: dict, today: date, warnings: dict,
                      advisories: dict, dropped: dict[str, str], ledger_currency: str) -> list[dict]:
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
            end_of_day=True)
        warnings.update(dict.fromkeys(window_warnings))
        _merge_advisories(advisories, window_advisories)
        dropped.update(window_dropped)
        state["through"] = today.isoformat()
        return rows

    def _walk_history(self, credential: str, state: dict, targets: list[dict], today: date,
                      warnings: dict, advisories: dict, dropped: dict[str, str],
                      ledger_currency: str) -> tuple[list[dict], dict, bool]:
        """Walk backward until every targeted account has reached its requested depth or run out of history.

        One loop serves every case there is — a first backfill, a deepening pull, and an account that joined
        the connection later — because they differ only in *which* accounts still want older data and how far
        back. That is what the targets say, so nothing here needs to know which situation it is in.

        The window is shared: a request is bounded by a date range, not by an account, so one window advances
        every account that still wants that period at once. Filtering is therefore applied **only** when a
        single account is still walking, where it saves bandwidth (and, if per-account requests draw on a
        separate quota, spares the main one). Filtering a plural set would multiply requests without
        fetching anything more.
        """
        reach = {t["external_account_id"]: date.fromisoformat(t["from_date"]) for t in targets}
        streaks = {t["external_account_id"]: int(t.get("empty_streak") or 0) for t in targets}
        # Each account starts from wherever it has already reached, so one that is further along does not
        # re-fetch what it holds while a laggard catches up.
        frontier = {
            t["external_account_id"]: date.fromisoformat(t["reached"]) if t.get("reached") else today
            for t in targets
        }
        coverage = {
            a: {"reached": frontier[a].isoformat(), "complete": False, "empty_streak": streaks[a]}
            for a in reach
        }
        added: list[dict] = []
        resume_later = False

        def still_walking() -> list[str]:
            return [a for a in reach
                    if frontier[a] > reach[a] and streaks[a] < EMPTY_WINDOWS_END_HISTORY]

        while (active := still_walking()):
            if not self._spend(state, today):
                # Out of allowance with history still to walk. Stopping here is what keeps the token from
                # being disabled; each account's recorded reach is what makes the rest resume rather than
                # be forgotten — no separate parking state is needed.
                resume_later = True
                break
            window_end = max(frontier[a] for a in active)
            window_start = window_end - timedelta(days=WINDOW_DAYS)
            rows, window_warnings, window_advisories, window_dropped = self._fetch_window(
                credential, window_start, window_end, active if len(active) == 1 else None,
                ledger_currency=ledger_currency,
                # The walk moves backward, so its end is normally a date something newer already covers —
                # the previous window of this run, or, for an account resuming from a stored `reached`, the
                # window that reached it (which ran from that date's midnight forward). Today is the one
                # exception: on a fresh account the first window ends there with nothing after it.
                end_of_day=window_end == today,
            )
            warnings.update(dict.fromkeys(window_warnings))
            # Counted rather than set-deduped: a walk provokes the same advisory on every one of its ~24
            # requests, and "24 times" is the diagnostic signal — it says the whole walk was affected, not
            # one stray request. Warnings stay a plain ordered set above; they describe a bank, and how many
            # windows re-reported it says nothing about the bank.
            _merge_advisories(advisories, window_advisories)
            dropped.update(window_dropped)
            added.extend(rows)

            delivered = {r["external_account_id"] for r in rows}
            for account in active:
                if frontier[account] != window_end:
                    continue  # this account had already gone deeper; the window told it nothing new
                streaks[account] = 0 if account in delivered else streaks[account] + 1
                frontier[account] = max(window_start, reach[account])
                coverage[account] = {
                    "reached": frontier[account].isoformat(),
                    # Only an account whose own windows came back empty has *ended*; one that merely hit
                    # the depth asked for has more behind it, and saying otherwise would stop a later,
                    # deeper request from ever looking.
                    "complete": streaks[account] >= EMPTY_WINDOWS_END_HISTORY,
                    # Carried so a walk that pauses mid-streak resumes counting rather than starting over
                    # and needing two more empty windows to reach the same conclusion.
                    "empty_streak": streaks[account],
                }
        return added, coverage, resume_later

    def fetch_transactions_sync(
        self, app_config: dict, credential: str, cursor: str | None = None, days_requested: int = 730,
        account_targets: list[dict] | None = None, ledger_currency: str = DEFAULT_LEDGER_CURRENCY,
    ) -> dict:
        """Walk history for whichever accounts still want it, or top up the recent window.

        Which one happens is decided by the caller, which owns the database and therefore knows each
        account's coverage; this adapter holds no history state of its own. What remains in its resume token
        is the request-budget ledger and the newest date covered — the only genuinely provider-owned facts.
        """
        state = self._load_state(cursor)
        today = _utc_today()
        added: list[dict] = []
        resume_later = False
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

        if account_targets:
            # Where the walk will begin: the newest point any account still wants data from.
            walk_from = max(
                (date.fromisoformat(t["reached"]) if t.get("reached") else today)
                for t in account_targets
            )
            if walk_from < today:
                # The walk has already moved back from today, so every window it fetches is old and no
                # *new* transaction would arrive for however many days the walk takes to finish. One
                # request on the recent window first keeps the ledger current — which is the part a user
                # actually looks at — while history fills in behind it.
                if self._spend(state, today):
                    added.extend(self._fetch_recent(
                        credential, state, today, warnings, advisories, dropped_currency,
                        ledger_currency))
                else:
                    resume_later = True
            else:
                # The walk still starts at today, so its first window already covers the recent period;
                # a separate top-up would re-fetch a subset of it for nothing.
                state["through"] = today.isoformat()

            walk_added, coverage, walk_resume = self._walk_history(
                credential, state, account_targets, today, warnings, advisories, dropped_currency,
                ledger_currency,
            )
            added.extend(walk_added)
            resume_later = resume_later or walk_resume
        elif self._spend(state, today):
            added.extend(self._fetch_recent(
                credential, state, today, warnings, advisories, dropped_currency, ledger_currency))
        else:
            resume_later = True

        # Every targeted account either reached the depth asked of it or ran out of history. A pull with no
        # targets had no history to finish, so it is trivially done.
        backfill_complete = not resume_later and all(
            c["complete"] or c["reached"] <= t["from_date"]
            for t, c in ((t, coverage[t["external_account_id"]]) for t in (account_targets or []))
        )
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
            # The walk drains its whole allowance inside this one call, so there is never a second page for
            # the caller to ask for — pausing is reported through `resume_later`, not by paging.
            "has_more":      False,
            "update_status": BUDGET_PAUSED if resume_later else None,
            "backfill_complete": bool(backfill_complete),
            "resume_later":  resume_later,
            # Per account, and only what this pull actually reached — never what it set out to reach.
            "account_coverage": coverage,
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
