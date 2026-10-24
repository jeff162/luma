# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
The provider-adapter interface: the seam every data-source aggregator plugs into.

A connection is provider-agnostic — the vault wraps one opaque per-connection credential, the DB stores
a `provider` discriminator, and the routers/sync path speak only the normalized dicts below. Each
concrete adapter (Plaid and SimpleFIN today) hides its SDK and secret *shape* behind these
four operations and normalizes to provider-neutral field names, so callers never branch on provider.

Every operation takes `app_config` — the resolved app-level credential ({client_id, secret, env})
the aggregator needs to authenticate the Luma app itself, obtained via `providers.config.resolve_app_config`
(vaulted DB, or the `.env` bootstrap). It is passed in per call rather than read from the environment,
so app credentials live under the vault. A provider that has no app-level credential at all
sets `requires_app_config = False` and receives `{}` — see the capability declarations on the class.

Normalized contracts (plain dicts, provider-neutral keys):

- `connect(app_config, payload) -> {"external_id": str, "credential": str, "institution": str | None}`
      The one authorization entry point, whatever shape the provider's handshake takes. `payload` is
      whatever the connect UI collected, described per adapter by `connect_spec`: a Link-style provider
      gets `{"public_token": …}` from its widget, a token-style provider gets `{"setup_token": …}` from a
      paste field. `external_id` is the provider's stable connection handle; `credential` is the opaque
      secret the vault encrypts. Everything downstream of this call is provider-agnostic, which is why
      the caller is one shared routine (`routers/providers.py::establish_connection`) rather than one
      per provider.
- `create_link_token(app_config, user_id) -> str`
      Link-style providers only: an opaque token the frontend widget consumes to start authorization.
      Providers whose connect step is a form or a pasted token leave it unimplemented.
- `fetch_accounts(app_config, credential)
        -> [ {"external_account_id", "name", "official_name", "type", "subtype", "mask", "currency"} ]`
      These are the provider's *offered* accounts, not local ones: connecting records them as
      `connection_account` rows awaiting a mapping decision (see `services/connection_mapping.py`),
      and only the mapping step creates or adopts local `account` rows. `official_name` is the bank's
      formal name where the provider supplies one, kept so the mapping UI can still identify a
      provider account after it has been mapped onto a locally-renamed account. `currency` is the
      account's denomination where the provider reports one — see `services/ledger_currency.py` for why
      the app needs it and what it does when the answer is not the ledger's.
- `fetch_transactions(app_config, credential, start_date=None, end_date=None)
        -> [ {"external_transaction_id", "external_account_id", "amount", "merchant_name",
              "raw_name", "date", "is_pending", …optional capture fields} ]`
      `date` is an ISO string — when the charge was made wherever the provider says, else when it
      posted; `amount` keeps the provider's sign convention (downstream categorization
      is written against it); `external_account_id` joins to `account.external_account_id`.

Optional capture fields, all provider-neutral and all absent-tolerant, declared per adapter by
`capture_fields()`:

- `posted_date` — when the charge posted, as against `date` (when it was made); absent while pending.
  The single most valuable one for duplicate detection: two sources for the same charge commonly report
  *different* ones of these, which is what made real duplicates look like near-misses on date.
- `provider_description`, `counterparties` — identity beyond the descriptor string, which each source
  truncates differently.
- `check_number` — folded into the merchant as `Check #<n>` on insert, matching the CSV convention, so
  the check discriminator can tell two same-amount checks apart.
- `location` — enrichment only; the one field that defaults off.

Everything except `posted_date` (a first-class `txn` column) is written into the row's
`import_evidence_json` in the same shape a CSV import uses, so the dedupe text matcher and the origin
hover pick them up with no per-source special-casing.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import date, timedelta

from backend.services.ledger_currency import DEFAULT_LEDGER_CURRENCY
from backend.services.source_capabilities import CurrencyScope, ZeroAmountPolicy

# The ledger's currency is **not** defined here, and no adapter may assume one. It is a user setting
# (`services/ledger_currency.py`) and reaches an adapter the same way `account_targets` does: passed down
# per call, because the caller owns the database and therefore owns every fact stored in it.
#
# What adapters do with it: an account the provider states is denominated in something else must have its
# transactions **dropped** rather than imported at face value — `txn.amount` is a bare number with no
# denomination beside it, so two denominations held together are indistinguishable and both join every
# total. The adapter must also say *which* account and *which* currency it dropped for, so the omission is
# attributable instead of looking like an account with no activity. That is `unsupported_currency` (see
# `fetch_transactions_sync`); the sync layer decides who hears about it, because only it knows which
# provider accounts the user actually mapped.
#
# `DEFAULT_LEDGER_CURRENCY` is imported only as the fallback for a caller that passes nothing. Comparing
# against it *anywhere else* would make the user's setting decorative — and would treat a
# consistently-AUD ledger as the error case, which is the bug the parameter was introduced to fix.


class ProviderCredentialRejected(Exception):
    """The stored credential is no longer accepted by the provider — the user must reconnect.

    Distinguished from every other sync failure because it is the only one where **retrying cannot
    help** and there is a specific thing for the user to do. A revoked or expired credential otherwise
    presents exactly like a network blip: the failure count climbs and the card says "sync failed",
    which is true and useless. For SimpleFIN this matters more than for a provider with a revocation
    API, because revoking at the Bridge is the *only* way a user can revoke at all — so this exception
    is the sole signal the app ever gets that they did.
    """


class ProviderAdapter(ABC):
    """One aggregator, behind the normalized interface. `provider` is the DB discriminator string.

    The class attributes below are **capability declarations**: the facts about a provider that the
    routers and the sync loop would otherwise have to learn by branching on `provider`. They exist
    because the seam was originally shaped around Plaid — a Link-style provider with an app-level
    credential and a cursor API — and every one of those turned out to be a Plaid trait rather than a
    universal one.
    """

    provider: str

    # False for a provider that has no app-level credential at all (SimpleFIN). Callers then pass `{}`
    # instead of treating "no app config" as "not configured yet", and the provider counts as configured
    # once it has a connection, since there is nothing to configure ahead of one.
    requires_app_config: bool = True

    # How the frontend should collect the connect payload. None = a Link-style widget the adapter mints a
    # token for; otherwise {"style": "token", "label", "help_url", "placeholder"}, rendered generically so
    # the UI never branches on provider name.
    connect_spec: dict | None = None

    # What one connect action actually adds, as a noun for the connect button ("+ Connect Institution").
    # It differs by provider in kind, not just in wording: Plaid's widget authorizes ONE institution, so
    # the button can name it, while a SimpleFIN setup token claims a bridge that may span several banks
    # and no noun describes it — those adapters leave this None and the button reads "+ Connect".
    # Deliberately not "Account": that word means a ledger account everywhere else in the app.
    connect_noun: str | None = None

    # The provider's own cap on how far back history goes, when it publishes one (Plaid's ~24 months).
    # None means unbounded as far as the API is concerned — the adapter's own fetch decides where to stop.
    max_history_days: int | None = None

    # Whether the provider has a change feed. False means every pull is a date range, so a routine sync has
    # to choose a look-back window instead of asking "what changed since the checkpoint".
    has_cursor: bool = False

    # Whether `remove()` actually invalidates the credential at the provider. False means disconnecting
    # deletes only Luma's copy and the credential stays live until the user revokes it at the provider —
    # which the disconnect confirmation has to say, because it is the difference between "this can no
    # longer read my bank" and "this still can, and I have one more thing to do".
    revokes_on_disconnect: bool = True

    # Whether the provider can issue a replacement credential for an existing connection, invalidating the
    # old one, **without the user authorizing again** (`reissue_credential`). This is what lets a response
    # to an exposed database retire the copied credentials while every connection keeps syncing. False
    # means the only way to retire a copied credential is to revoke it and link again.
    reissues_credential: bool = False

    # Whether re-authorizing the same source comes back with the SAME `external_id`.
    #
    # True where the provider issues the handle (Plaid's `item_id`), so a re-link upserts onto the existing
    # connection row and is a clean credential refresh. False where the handle is *derived from the
    # credential* — SimpleFIN hashes the access URL, because the URL is the credential and so cannot also
    # be the public handle — and a new credential therefore yields a new handle. A re-link there would
    # insert a **second** connection row and strand the first, taking its per-account coverage, cursor and
    # sync history with it. (The account mappings survive regardless: `record_provider_accounts` and sync
    # both key on `account.external_account_id`, which is unique and durable.)
    #
    # The caller uses this to ask *which existing connection a re-link replaces* — and to ask it **before**
    # the provider call, because a claim or exchange is single-use: there is no authorizing again to try a
    # different answer, so the question cannot wait until the handle is known.
    #
    # **This is a claim about the app's own re-authorization path, not just about the provider.** Plaid's
    # `item_id` is stable only across an *update-mode* Link session; a plain Link session mints a new Item
    # and a new handle, so declaring True while offering no update-mode path would be false in exactly the
    # case the flag exists for. A provider declaring True must implement `create_link_token`'s
    # `access_token` argument, or an equivalent re-authorize-in-place step.
    stable_external_id: bool = True

    # Whether this provider's $0 transactions are kept or refused. **Deliberately has no default**: the
    # answer turns on what a $0 row means coming from this particular provider, which does not generalize
    # from one to the next, so a new adapter must state it rather than inherit a guess. The rule for
    # deciding, and what goes wrong either way, is in `services/source_capabilities.py`.
    zero_amount_rows: ZeroAmountPolicy

    # Whether this provider states a currency per account or per transaction, which decides whether a
    # currency mismatch drops an account or a handful of rows — and so what the user is told. **No default**,
    # like `zero_amount_rows`: it follows from the provider's protocol. See `services/source_capabilities.py`.
    currency_scope: CurrencyScope

    # How far back a *routine* (non-backfill) sync reaches on a provider with no cursor. Deliberately not
    # applied to a cursor provider: for Plaid `days_requested` sets the window the item *maintains*, so
    # sending a small number on a routine sync would discard history rather than merely fetch less of it.
    routine_lookback_days: int = 30

    @abstractmethod
    def connect(self, app_config: dict, payload: dict) -> dict: ...

    def create_link_token(self, app_config: dict, user_id: str = "local-user",
                          access_token: str | None = None) -> str:
        """Link-style providers only — see the module docstring.

        `access_token` asks for an **update-mode** token: re-authorize the Item this credential already
        names, rather than authorizing a new one. That is what `stable_external_id = True` depends on —
        without it, "reconnect" means "connect again", which mints a new handle and strands the old
        connection. A provider offering no such mode must declare `stable_external_id = False`.
        """
        raise NotImplementedError(f"{self.provider} has no Link-style connect flow")

    @abstractmethod
    def fetch_accounts(self, app_config: dict, credential: str) -> list[dict]: ...

    @abstractmethod
    def fetch_transactions(
        self, app_config: dict, credential: str, start_date: date | None = None, end_date: date | None = None
    ) -> list[dict]: ...

    def fetch_transactions_sync(
        self, app_config: dict, credential: str, cursor: str | None = None, days_requested: int = 730,
        account_targets: list[dict] | None = None, ledger_currency: str = DEFAULT_LEDGER_CURRENCY,
        request_budget: dict | None = None, continuing: bool = False,
        budget_checkpoint=None, pending_since: str | None = None,
    ) -> dict:
        """One pull's worth of change, plus the state the sync loop needs to decide what happens next:

            {added:[txn…], modified:[txn…], removed:[external_transaction_id…], next_cursor, has_more,
             update_status, backfill_complete, resume_later, account_coverage, warnings, advisories,
             unsupported_currency, requested_windows, complete_listings}

        Each `added` / `modified` transaction dict is the same shape as `fetch_transactions` returns, plus
        `pending_external_transaction_id`: when a posted transaction supersedes a pending one, this holds the
        prior pending row's `external_transaction_id` (Plaid's `pending_transaction_id`), so the sync can
        convert that row in place rather than trash-and-re-add. `removed` is a list of `external_transaction_id`.

        Three separate questions travel here, and collapsing any two of them is a bug:

        - `update_status` + `has_more` — *is there more to deliver right now?* The provider's readiness
          signal (for Plaid, `transactions_update_status`: NOT_READY / INITIAL_UPDATE_COMPLETE /
          HISTORICAL_UPDATE_COMPLETE) plus the paging flag. This is what makes a client poll again shortly.
        - `backfill_complete` — *has this connection's history been fetched to its end?* For a cursor
          provider this coincides with the terminal status, which is why the two were once the same field.
          For a provider that walks history in windows it does not: a walk can stop with history still
          outstanding.
        - `resume_later` — *should the outstanding history be picked up on a future sync rather than by
          polling now?* True when the adapter stopped for a reason more polling cannot fix — a metered
          provider that has spent its request budget for the day. The caller must then stop polling (the
          provider just declined to serve us) while still recording the backfill as unfinished, so a later
          sync resumes it. Marking such a connection complete strands the un-fetched history permanently
          behind a short routine look-back.

        `next_cursor` is an **opaque provider resume token**, not necessarily a cursor: a provider with no
        change feed stores whatever checkpoint its own resume needs (see the SimpleFIN adapter). `cursor=None`
        starts an initial pull; `days_requested` bounds how far back to fetch.

        `request_budget` is the other half of that state, kept deliberately apart from it: an **opaque,
        mutable** record of what this connection has already spent against a metered provider's limits, which
        the adapter updates *in place* as it spends. Two properties make it its own parameter rather than a
        field of the resume token.

        - **It is mutable because a failed pull still spent what it spent.** A return value describes a call
          that finished; a request that has already left the machine counts whether or not the call it
          belonged to ever returns. Only an argument the adapter writes through can carry that fact back out
          of an exception, and a metered adapter whose spending is forgotten on failure will overrun the
          limit exactly when a user is retrying a broken connection hardest.
        - **It is separate because the two have opposite persistence rules.** A resume token is a claim about
          data held, so it must roll back with the rows a failed pull never inserted. Spending must not roll
          back at all. Sharing one field would force one rule on both, and each one's correct rule is the
          other's bug.

        Callers persist it across syncs and must write it back on **every** exit path, success or raise.
        Adapters for providers with no published limits ignore it entirely.

        `budget_checkpoint` is how a metered adapter gets its spending recorded **before** the request that
        spends it. The adapter calls it immediately after debiting `request_budget` and before issuing the
        corresponding request; the caller's implementation persists the record and commits. It is a callback
        rather than a return value for the same reason `request_budget` is mutable — the fact has to become
        durable *during* the call, not after it.

        The ordering is not a detail, and it is not symmetric. Debiting after the request means a crash in
        between loses the record of a request that **was** made: the count runs low, and a low count leads
        to over-spending a limit whose penalty may be the provider cutting the connection off. Debiting
        first means a crash forfeits an allowance that was never used — recoverable, and for a refilling
        allowance it heals on its own. Adapters must therefore checkpoint first and request second, and
        callers must make the checkpoint durable rather than buffering it.

        `continuing` is False on the first call of a pull and True on every `has_more` page after it. It
        exists because "a new pull started" and "another page of the pull already running" are otherwise
        indistinguishable from inside the adapter, and some work belongs to the *pull* rather than to the
        page — the SimpleFIN adapter opens a pull by fetching its recent window once, so that the ledger
        stays current while a long walk fills in history behind it, and repeating that per page would spend
        a metered request on the same window over and over. Only the caller can tell the two apart, since
        only it knows whether it is draining or starting.

        `warnings` is a list of user-displayable strings for problems that did **not** fail the pull — one
        institution needing re-authentication while the others on the same credential returned data, an
        account the provider could not read this time. They are reported rather than only logged because
        the pull *succeeds*: nothing else would ever tell the user that part of their data quietly stopped
        arriving, and a partial failure that looks like a success is the one failure mode a sync cannot
        self-correct. A pull that fails outright raises instead.

        `advisories` is the other half of that split: `[{"message": str, "count": int, "context": str|None}]`
        for things the provider said about **our own request** rather than about the user's bank — a date
        range wider than it recommends, a deprecated parameter. Nothing a user can act on, so these never
        reach the connection card (a note about our request shape sitting beside "your bank needs
        re-authentication" teaches people to ignore both), but they belong in the sync log, which is where a
        change in a provider's limits becomes visible without periodically probing for one.

        `count` and `context` answer different questions and neither replaces the other. A windowed history
        walk provokes the same advisory on every request, so `count` ("24 times") says whether one request
        was special or the whole pull was — a plain list would either repeat the message 24 times or lose
        that. `context` names **one concrete request** that drew it (the first), because the message alone
        cannot say which, and that is the first thing anyone reading the log wants. They stay separate
        fields on purpose: folding the request into the message would make every window its own entry and
        destroy the aggregation.

        `ledger_currency` is the currency this ledger's amounts are in — a **user setting**, passed down
        for the same reason `account_targets` is: the caller owns the database, so it owns every fact
        stored there. An adapter must never assume a currency of its own. The question is whether an
        account matches *this* ledger, not whether it is dollars: a consistently-AUD ledger is entirely
        correct, and treating it as the error case is the bug this parameter exists to prevent.

        `unsupported_currency` is `{external_account_id: currency}` for accounts whose transactions this
        pull **discarded** as not matching it. It is reported as data rather than folded into `warnings`
        because the adapter cannot judge who should hear it: an unmapped account's rows are dropped by the
        sync anyway, so warning about those would be noise on a card, while a *mapped* account silently
        receiving nothing is precisely the thing a user must be told. Only the sync layer knows which is
        which, so the adapter states the fact and lets it decide.

        **`account_targets` / `account_coverage` are how history is fetched and reported, and both are per
        account.** The caller owns the database, so it decides what is needed and passes
        `[{external_account_id, from_date}]` — "this account still wants data back to here". The adapter
        fetches and answers with what it actually got:
        `{external_account_id: {"reached": iso_date, "complete": bool}}`, where `complete` means *this
        account has no older data*, a different claim from "we stopped here" (which is what `reached` says).

        Both are optional and default to the pre-existing behaviour: `account_targets=None` means the
        provider's ordinary delta, and omitting `account_coverage` leaves the caller to record coverage from
        the depth it requested — correct for a cursor provider, whose maintained window really is the
        requested one.

        `requested_windows` is `[{"start": iso_date, "end": iso_date}]` — the date ranges this call actually
        asked the provider for, in the order asked. Purely diagnostic: it exists because a walking, budgeted
        adapter can make many requests inside one call and stop partway, so neither the rows returned nor
        the resume checkpoint can reconstruct what was looked at. Optional, and empty for a cursor provider,
        which asks for "everything since this token" and has no window to name.

        `complete_listings` is `[{"external_account_id", "start", "end"}]`: accounts and inclusive ISO date
        ranges for which this page's `added` holds **every** transaction the provider has, pending ones
        included. It is how a provider with no way to report a removal still gets a superseded or cancelled
        pending row retired: a held pending row dated inside a listed range and absent from `added` is gone
        at the provider (`services/pending_supersession.py`). A listing is a strong claim, so an account the
        response omitted, discarded, or reported a problem for is never listed. Optional; a cursor provider,
        which reports removals itself, omits it.

        `pending_since` is the date of the oldest pending row the caller holds for this connection, or None.
        An adapter that reports `complete_listings` may reach back to it so a charge left pending longer
        than its routine overlap is still listed. Others ignore it.

        Reporting per account rather than per connection is not tidiness. One figure applied to every
        account over-claims the moment a pull covers some of them and not others, and an overstated coverage
        claim makes duplicate detection **reject genuine transactions** that fall in a range nothing ever
        fetched (`docs/data-model.md` → "coverage has two shapes"). The dangerous direction is always the
        optimistic one.

        The default below is the **range pull** every non-cursor provider rides: fetch a window and present it
        as one complete page. `removed` is unavoidably empty on that path — the provider has no way to report a
        deletion, which is NOT the same as it confirming that nothing was deleted, so no caller may read the
        empty list as evidence. It is safe to re-fetch an overlapping window because the sync's insert is
        idempotent on `external_transaction_id`."""
        end = date.today()
        start = end - timedelta(days=days_requested)
        return {
            "added":         self.fetch_transactions(app_config, credential, start_date=start, end_date=end),
            "modified":      [],
            "removed":       [],
            "next_cursor":   cursor,
            "has_more":      False,
            "update_status": None,
            "backfill_complete": True,
            "resume_later": False,
            # One window, fetched for whatever the provider offers — so every targeted account reached
            # exactly the window's start. Nothing here can conclude an account's history has *ended*, so
            # `complete` is False: a plain range pull returns what the range holds and says no more.
            "account_coverage": {
                t["external_account_id"]: {"reached": start.isoformat(), "complete": False}
                for t in (account_targets or [])
            },
            "warnings": [],
            "advisories": [],
            # An adapter that cannot report an account's denomination cannot know it dropped anything for
            # it, so the default is silence rather than a claim that everything was in the ledger's currency.
            "unsupported_currency": {},
            "requested_windows": [{"start": start.isoformat(), "end": end.isoformat()}],
        }

    def capture_fields(self) -> list[dict]:
        """What this provider can capture per transaction, for the connection's field picker:
        `[{key, label, locked, default_on}]`.

        `locked` marks a field the app always captures and the user cannot turn off — either because
        duplicate detection depends on it (`posted_date`, the descriptor, the check number) or
        because it costs nothing and identifies the merchant (`counterparties`). Everything else is
        the user's call. Adapters declare their own set, so a provider that cannot supply a field
        simply omits it rather than showing a control that does nothing.
        """
        return []

    def request_allowance(self, request_budget: dict) -> dict | None:
        """What a metered provider's allowance holds right now, read from the spend record the caller keeps
        (`request_budget` above), for the connection card. Shape:

            {capacity: int, refill_per_hour: float, pools: {pool key: requests left}}

        `pools` is whatever the adapter meters separately (one shared bucket, one per account, or both); an
        absent pool is a full one. None for a provider with no metering."""
        return None

    def reissue_credential(self, app_config: dict, credential: str) -> str:
        """Exchange `credential` for a new one naming the same connection, invalidating the old one at the
        provider, and return the new one. Only for adapters declaring `reissues_credential = True`. Raises on
        failure; the caller must store the returned value at once, since the old one is already dead."""
        raise NotImplementedError(f"{self.provider} cannot reissue a credential")

    @abstractmethod
    def remove(self, app_config: dict, credential: str) -> None:
        """Revoke the connection at the provider so its credential is invalidated everywhere (the in-app
        disconnect). Raises on failure so the caller can keep the local connection and let the user retry."""
