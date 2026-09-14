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
from backend.services.ledger_currency import DEFAULT_LEDGER_CURRENCY, currency_matches
from backend.services.providers.base import ProviderAdapter
from backend.services.source_capabilities import KEEP_ZERO_AMOUNT

# Plaid's `transactions_update_status` values that mean the historical backfill will not advance further.
# UNKNOWN and a missing status count as terminal so a status Plaid cannot determine never traps the client
# in an endless poll. This vocabulary is Plaid's own, which is why it lives with the adapter rather than in
# the sync loop — every other provider reports readiness differently, or not at all.
_TERMINAL_UPDATE_STATUSES = frozenset({
    "HISTORICAL_UPDATE_COMPLETE",
    "TRANSACTIONS_UPDATE_STATUS_UNKNOWN",
    None,
})


class PlaidAdapter(ProviderAdapter):
    provider = "plaid"

    # Link-style: the frontend opens Plaid's widget against a minted link token, so there is no payload
    # form to describe. Plaid caps transaction history at ~24 months, which is what "all history" means here.
    connect_spec = None
    # Link authorizes exactly one institution per connect, so the button can name what it adds.
    connect_noun = "Institution"
    max_history_days = 730
    has_cursor = True
    # Kept: Plaid revises a transaction in place, so a $0 pending row is what the settled amount lands
    # on — through `modified`, or through `pending_transaction_id` when the posted row gets a new id.
    zero_amount_rows = KEEP_ZERO_AMOUNT

    def create_link_token(self, app_config: dict, user_id: str = "local-user",
                          access_token: str | None = None) -> str:
        return plaid_service.create_link_token(app_config, user_id, access_token)

    def connect(self, app_config: dict, payload: dict) -> dict:
        # Link hands back a short-lived public_token; the institution name comes from Link's metadata on
        # the client side rather than from Plaid here, so it rides the payload.
        result = self.exchange(app_config, payload["public_token"])
        return {**result, "institution": payload.get("institution_name")}

    def exchange(self, app_config: dict, public_token: str) -> dict:
        result = plaid_service.exchange_public_token(app_config, public_token)
        return {"external_id": result["item_id"], "credential": result["access_token"]}

    def fetch_accounts(self, app_config: dict, credential: str) -> list[dict]:
        return [
            {
                "external_account_id": a["plaid_account_id"],
                "name":                a["name"],
                "official_name":       a["official_name"],
                "type":                a["type"],
                "subtype":             a["subtype"],
                "mask":                a["mask"],
                # Recorded so the mapping step can warn before an account whose transactions will be
                # discarded is given a destination — the same contract SimpleFIN's adapter answers.
                "currency":            a.get("currency"),
            }
            for a in plaid_service.fetch_accounts(app_config, credential)
        ]

    # What Plaid can capture per transaction. `authorized_date`, the descriptor, the counterparties and
    # the check number are locked on: duplicate detection reads all four, so letting them be turned off
    # would silently degrade matching. Location is enrichment and defaults off.
    CAPTURE_FIELDS = [
        {"key": "authorized_date",      "label": "Transaction date (as well as posted date)", "locked": True,  "default_on": True},
        {"key": "provider_description", "label": "Original description",                      "locked": True,  "default_on": True},
        {"key": "counterparties",       "label": "Merchant and counterparties",               "locked": True,  "default_on": True},
        {"key": "check_number",         "label": "Check number",                              "locked": True,  "default_on": True},
        {"key": "location",             "label": "Location",                                  "locked": False, "default_on": False},
    ]

    def capture_fields(self) -> list[dict]:
        return [dict(f) for f in self.CAPTURE_FIELDS]

    @staticmethod
    def _normalize_txn(t: dict) -> dict:
        return {
            "external_transaction_id": t["plaid_transaction_id"],
            "external_account_id":     t["plaid_account_id"],
            "amount":                  t["amount"],
            "merchant_name":           t["merchant_name"],
            "raw_name":                t["raw_name"],
            "date":                    t["date"],
            "authorized_date":         t.get("authorized_date"),
            "is_pending":              t["is_pending"],
            "counterparties":          t.get("counterparties") or [],
            "check_number":            t.get("check_number"),
            "location":                t.get("location"),
            # Carried through so the sync path can judge the row rather than inferring from its account.
            "currency":                t.get("currency"),
        }

    def fetch_transactions(
        self, app_config: dict, credential: str, start_date: date | None = None, end_date: date | None = None
    ) -> list[dict]:
        return [
            self._normalize_txn(t)
            for t in plaid_service.fetch_transactions(app_config, credential, start_date=start_date, end_date=end_date)
        ]

    def fetch_transactions_sync(
        self, app_config: dict, credential: str, cursor: str | None = None, days_requested: int = 730,
        account_targets: list[dict] | None = None, ledger_currency: str = DEFAULT_LEDGER_CURRENCY,
        request_budget: dict | None = None, continuing: bool = False,
        budget_checkpoint=None,
    ) -> dict:
        # `request_budget` is ignored: Plaid publishes no per-request allowance to spend down, so there is
        # nothing for this adapter to meter and nothing to record between syncs, and so nothing for
        # `budget_checkpoint` to make durable. `continuing` likewise: a cursor names its own resume point,
        # so every page of a pull is the same call shape as the first.
        #
        # `account_targets` is ignored: a cursor is a checkpoint in a change feed, not a date range, so
        # there is no way to ask this API for one account's history. Plaid reaches it by raising
        # `days_requested`, which backfills every account on the item through the same cursor.
        result = plaid_service.fetch_transactions_sync(app_config, credential, cursor=cursor, days_requested=days_requested)

        def _normalize(t: dict) -> dict:
            return {
                **self._normalize_txn(t),
                # The prior pending row's provider id when this posted txn supersedes it (see base.py).
                "pending_external_transaction_id": t["pending_transaction_id"],
            }

        # Rows denominated in something other than the ledger's currency are dropped before they can be
        # stored as bare numbers (see base.py / services/ledger_currency.py). Judged **per transaction**
        # rather than per account, which is the stricter reading and the one Plaid's data supports: it
        # states a currency on every row, so the number in `amount` can be judged on its own terms rather
        # than on an assumption about the account it belongs to.
        dropped: dict[str, str] = {}

        def _keep(t: dict) -> bool:
            if currency_matches(ledger_currency, t.get("currency")):
                return True
            dropped[t["external_account_id"]] = str(t.get("currency"))
            return False

        added    = [t for t in (_normalize(t) for t in result["added"]) if _keep(t)]
        modified = [t for t in (_normalize(t) for t in result["modified"]) if _keep(t)]

        # For a cursor provider "stop polling" and "history is complete" are the same fact, so
        # backfill_complete restates the terminal-status check the sync loop already applied. It is
        # reported explicitly anyway: the two questions diverge for a range-pull provider, and a caller
        # that has to remember which providers conflate them would get it wrong.
        status = result["update_status"]
        return {
            "added":         added,
            "modified":      modified,
            # Left unfiltered: these are bare ids, and removing a row that was never stored is already a
            # no-op. Filtering them would mean guessing at a currency the payload does not carry.
            "removed":       result["removed"],  # already provider transaction ids
            "next_cursor":   result["next_cursor"],
            "has_more":      result["has_more"],
            "update_status": status,
            "backfill_complete": status in _TERMINAL_UPDATE_STATUSES,
            # Plaid streams its backfill: an unfinished one is finished by polling, never by waiting a day.
            "resume_later": False,
            # Omitted: Plaid maintains exactly the window `days_requested` asked for, and does so for every
            # account on the item alike, so the caller's own requested depth is the accurate claim and there
            # is nothing per-account to correct.
            "account_coverage": None,
            # A Plaid item is one institution, so there is no "some of it worked" state to report: an
            # item needing re-authentication fails the call outright rather than returning partial data.
            "warnings": [],
            # Accounts this page discarded rows for. Unlike SimpleFIN's, this reflects only what actually
            # came through the cursor — but the sync layer's warning is driven by the stored
            # `provider_currency` anyway, precisely so it does not depend on what a given page contained.
            "unsupported_currency": dropped,
        }

    def remove(self, app_config: dict, credential: str) -> None:
        plaid_service.remove_item(app_config, credential)
