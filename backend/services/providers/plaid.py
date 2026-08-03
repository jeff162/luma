# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
The Plaid adapter — the first concrete `ProviderAdapter`.

It delegates the SDK details to `plaid_service` (the thin Plaid-model boundary) and translates that
module's Plaid-shaped dicts into the provider-neutral contract in `base.py`, so the routers and sync
path never see a Plaid field name. The app-level credentials (`client_id`/`secret`/`env`) still come
from the environment via `plaid_service` in this phase; moving them into the vaulted DB is phase 6b.
"""

from __future__ import annotations

from datetime import date

from backend.services import plaid_service
from backend.services.providers.base import ProviderAdapter


class PlaidAdapter(ProviderAdapter):
    provider = "plaid"

    def create_link_token(self, app_config: dict, user_id: str = "local-user") -> str:
        return plaid_service.create_link_token(app_config, user_id)

    def exchange(self, app_config: dict, public_token: str) -> dict:
        result = plaid_service.exchange_public_token(app_config, public_token)
        return {"external_id": result["item_id"], "credential": result["access_token"]}

    def fetch_accounts(self, app_config: dict, credential: str) -> list[dict]:
        return [
            {
                "external_account_id": a["plaid_account_id"],
                "name":                a["name"],
                "type":                a["type"],
                "subtype":             a["subtype"],
                "mask":                a["mask"],
            }
            for a in plaid_service.fetch_accounts(app_config, credential)
        ]

    def fetch_transactions(
        self, app_config: dict, credential: str, start_date: date | None = None, end_date: date | None = None
    ) -> list[dict]:
        return [
            {
                "external_transaction_id": t["plaid_transaction_id"],
                "external_account_id":     t["plaid_account_id"],
                "amount":                  t["amount"],
                "merchant_name":           t["merchant_name"],
                "raw_name":                t["raw_name"],
                "date":                    t["date"],
                "is_pending":              t["is_pending"],
            }
            for t in plaid_service.fetch_transactions(app_config, credential, start_date=start_date, end_date=end_date)
        ]

    def fetch_transactions_sync(
        self, app_config: dict, credential: str, cursor: str | None = None, days_requested: int = 730
    ) -> dict:
        result = plaid_service.fetch_transactions_sync(app_config, credential, cursor=cursor, days_requested=days_requested)

        def _normalize(t: dict) -> dict:
            return {
                "external_transaction_id": t["plaid_transaction_id"],
                "external_account_id":     t["plaid_account_id"],
                "amount":                  t["amount"],
                "merchant_name":           t["merchant_name"],
                "raw_name":                t["raw_name"],
                "date":                    t["date"],
                "is_pending":              t["is_pending"],
                # The prior pending row's provider id when this posted txn supersedes it (see base.py).
                "pending_external_transaction_id": t["pending_transaction_id"],
            }

        return {
            "added":         [_normalize(t) for t in result["added"]],
            "modified":      [_normalize(t) for t in result["modified"]],
            "removed":       result["removed"],  # already provider transaction ids
            "next_cursor":   result["next_cursor"],
            "has_more":      result["has_more"],
            "update_status": result["update_status"],
        }

    def remove(self, app_config: dict, credential: str) -> None:
        plaid_service.remove_item(app_config, credential)
