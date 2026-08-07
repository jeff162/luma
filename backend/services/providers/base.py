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
so app credentials live under the vault (phase 6b).

Normalized contracts (plain dicts, provider-neutral keys):

- `create_link_token(app_config, user_id) -> str`
      An opaque token the frontend Link/enroll flow consumes to start authorization.
- `exchange(app_config, public_token) -> {"external_id": str, "credential": str}`
      Turns the short-lived public token from Link into the durable per-connection secret. `external_id`
      is the provider's stable connection handle (Plaid's item_id); `credential` is the opaque secret the
      vault encrypts (Plaid's access_token).
- `fetch_accounts(app_config, credential)
        -> [ {"external_account_id", "name", "official_name", "type", "subtype", "mask"} ]`
      These are the provider's *offered* accounts, not local ones: connecting records them as
      `connection_account` rows awaiting a mapping decision (see `services/connection_mapping.py`),
      and only the mapping step creates or adopts local `account` rows. `official_name` is the bank's
      formal name where the provider supplies one, kept so the mapping UI can still identify a
      provider account after it has been mapped onto a locally-renamed account.
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
from datetime import date


class ProviderAdapter(ABC):
    """One aggregator, behind the normalized interface. `provider` is the DB discriminator string."""

    provider: str

    @abstractmethod
    def create_link_token(self, app_config: dict, user_id: str = "local-user") -> str: ...

    @abstractmethod
    def exchange(self, app_config: dict, public_token: str) -> dict: ...

    @abstractmethod
    def fetch_accounts(self, app_config: dict, credential: str) -> list[dict]: ...

    @abstractmethod
    def fetch_transactions(
        self, app_config: dict, credential: str, start_date: date | None = None, end_date: date | None = None
    ) -> list[dict]: ...

    def fetch_transactions_sync(
        self, app_config: dict, credential: str, cursor: str | None = None, days_requested: int = 730
    ) -> dict:
        """Cursor-based incremental pull — one page of changes plus paging/backfill state:

            {added:[txn…], modified:[txn…], removed:[external_transaction_id…], next_cursor, has_more,
             update_status}

        Each `added` / `modified` transaction dict is the same shape as `fetch_transactions` returns, plus
        `pending_external_transaction_id`: when a posted transaction supersedes a pending one, this holds the
        prior pending row's `external_transaction_id` (Plaid's `pending_transaction_id`), so the sync can
        convert that row in place rather than trash-and-re-add. `removed` is a list of `external_transaction_id`.

        `update_status` is the provider's transaction-readiness signal (for Plaid, `transactions_update_status`:
        NOT_READY / INITIAL_UPDATE_COMPLETE / HISTORICAL_UPDATE_COMPLETE), letting the sync loop tell when the
        historical backfill is complete without a webhook. `cursor=None` starts an initial pull; `days_requested`
        bounds how far back to fetch. Optional: adapters whose provider has no cursor API leave this unimplemented
        and the caller falls back to `fetch_transactions`."""
        raise NotImplementedError(f"{self.provider} has no cursor-based sync")

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
