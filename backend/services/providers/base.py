# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
The provider-adapter interface: the seam every data-source aggregator plugs into.

A connection is provider-agnostic — the vault wraps one opaque per-connection credential, the DB stores
a `provider` discriminator, and the routers/sync path speak only the normalized dicts below. Each
concrete adapter (Plaid first; Teller, SimpleFIN later) hides its SDK and secret *shape* behind these
four operations and normalizes to provider-neutral field names, so callers never branch on provider.

Normalized contracts (plain dicts, provider-neutral keys):

- `create_link_token(user_id) -> str`
      An opaque token the frontend Link/enroll flow consumes to start authorization.
- `exchange(public_token) -> {"external_id": str, "credential": str}`
      Turns the short-lived public token from Link into the durable per-connection secret. `external_id`
      is the provider's stable connection handle (Plaid's item_id); `credential` is the opaque secret the
      vault encrypts (Plaid's access_token).
- `fetch_accounts(credential) -> [ {"external_account_id", "name", "type", "subtype", "mask"} ]`
- `fetch_transactions(credential, start_date=None, end_date=None)
        -> [ {"external_transaction_id", "external_account_id", "amount", "merchant_name",
              "raw_name", "date", "is_pending"} ]`
      `date` is an ISO string; `amount` keeps the provider's sign convention (downstream categorization
      is written against it); `external_account_id` joins to `account.plaid_account_id`.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import date


class ProviderAdapter(ABC):
    """One aggregator, behind the normalized interface. `provider` is the DB discriminator string."""

    provider: str

    @abstractmethod
    def create_link_token(self, user_id: str = "local-user") -> str: ...

    @abstractmethod
    def exchange(self, public_token: str) -> dict: ...

    @abstractmethod
    def fetch_accounts(self, credential: str) -> list[dict]: ...

    @abstractmethod
    def fetch_transactions(
        self, credential: str, start_date: date | None = None, end_date: date | None = None
    ) -> list[dict]: ...
