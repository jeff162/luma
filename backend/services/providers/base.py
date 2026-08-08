# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
The provider-adapter interface: the seam every data-source aggregator plugs into.

A connection is provider-agnostic — the vault wraps one opaque per-connection credential, the DB stores
a `provider` discriminator, and the routers/sync path speak only the normalized dicts below. Each
concrete adapter (Plaid first; Teller, SimpleFIN later) hides its SDK and secret *shape* behind these
four operations and normalizes to provider-neutral field names, so callers never branch on provider.

Every operation takes `app_config` — the resolved app-level credential ({client_id, secret, env})
the aggregator needs to authenticate the Luma app itself, obtained via `providers.config.resolve_app_config`
(vaulted DB, or the `.env` bootstrap). It is passed in per call rather than read from the environment,
so app credentials live under the vault (phase 6b). A provider that has no app-level credential at all
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
      `date` is an ISO string; `amount` keeps the provider's sign convention (downstream categorization
      is written against it); `external_account_id` joins to `account.external_account_id`.

Optional capture fields, all provider-neutral and all absent-tolerant, declared per adapter by
`capture_fields()`:

- `authorized_date` — when the charge was authorized, as against `date` (when it posted). The single
  most valuable one for duplicate detection: two sources for the same charge commonly report
  *different* ones of these, which is what made real duplicates look like near-misses on date.
- `provider_description`, `counterparties`, `merchant_entity_id` — identity beyond the descriptor
  string, which each source truncates differently.
- `check_number` — folded into the merchant as `Check #<n>` on insert, matching the CSV convention, so
  the check discriminator can tell two same-amount checks apart.
- `location` — enrichment only; the one field that defaults off.

Everything except `authorized_date` (a first-class `txn` column) is written into the row's
`import_evidence_json` in the same shape a CSV import uses, so the dedupe text matcher and the origin
hover pick them up with no per-source special-casing.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import date, timedelta

from backend.services.ledger_currency import DEFAULT_LEDGER_CURRENCY

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

    # How far back a *routine* (non-backfill) sync reaches on a provider with no cursor. Deliberately not
    # applied to a cursor provider: for Plaid `days_requested` sets the window the item *maintains*, so
    # sending a small number on a routine sync would discard history rather than merely fetch less of it.
    routine_lookback_days: int = 30

    @abstractmethod
    def connect(self, app_config: dict, payload: dict) -> dict: ...

    def create_link_token(self, app_config: dict, user_id: str = "local-user") -> str:
        """Link-style providers only — see the module docstring."""
        raise NotImplementedError(f"{self.provider} has no Link-style connect flow")

    def connect_requires_production_vault(self, payload: dict) -> bool:
        """Whether this particular connect attempt must be behind a Production-strength vault passphrase.

        False for a provider with a sandbox: its strength gate belongs on the switch to Production, where
        the credentials stop being fake. A provider with no test mode has no such moment — its first
        connection is already live bank access — so it answers True and the gate moves to connect time.
        Taking `payload` lets an adapter exempt a known test credential from its own otherwise-live rule.
        """
        return False

    @abstractmethod
    def fetch_accounts(self, app_config: dict, credential: str) -> list[dict]: ...

    @abstractmethod
    def fetch_transactions(
        self, app_config: dict, credential: str, start_date: date | None = None, end_date: date | None = None
    ) -> list[dict]: ...

    def fetch_transactions_sync(
        self, app_config: dict, credential: str, cursor: str | None = None, days_requested: int = 730,
        account_targets: list[dict] | None = None, ledger_currency: str = DEFAULT_LEDGER_CURRENCY,
    ) -> dict:
        """One pull's worth of change, plus the state the sync loop needs to decide what happens next:

            {added:[txn…], modified:[txn…], removed:[external_transaction_id…], next_cursor, has_more,
             update_status, backfill_complete, resume_later, account_coverage, warnings,
             unsupported_currency}

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

        `warnings` is a list of user-displayable strings for problems that did **not** fail the pull — one
        institution needing re-authentication while the others on the same credential returned data, an
        account the provider could not read this time. They are reported rather than only logged because
        the pull *succeeds*: nothing else would ever tell the user that part of their data quietly stopped
        arriving, and a partial failure that looks like a success is the one failure mode a sync cannot
        self-correct. A pull that fails outright raises instead.

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
            # An adapter that cannot report an account's denomination cannot know it dropped anything for
            # it, so the default is silence rather than a claim that everything was in the ledger's currency.
            "unsupported_currency": {},
        }

    def capture_fields(self) -> list[dict]:
        """What this provider can capture per transaction, for the connection's field picker:
        `[{key, label, locked, default_on}]`.

        `locked` marks a field the app always captures and the user cannot turn off — either because
        duplicate detection depends on it (`authorized_date`, the descriptor, the check number) or
        because it costs nothing and identifies the merchant (`counterparties`). Everything else is
        the user's call. Adapters declare their own set, so a provider that cannot supply a field
        simply omits it rather than showing a control that does nothing.
        """
        return []

    @abstractmethod
    def remove(self, app_config: dict, credential: str) -> None:
        """Revoke the connection at the provider so its credential is invalidated everywhere (the in-app
        disconnect). Raises on failure so the caller can keep the local connection and let the user retry."""
