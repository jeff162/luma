# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Boundary between Plaid's Python models and the app's plain-dict contracts.

This service is intentionally thin, but it centralizes the normalization choices
the database and routers rely on: stable field names, string dates, and full
pagination before control returns to the caller.
"""

import uuid
from datetime import date, timedelta

import plaid
from plaid.api import plaid_api
from plaid.model.link_token_create_request import LinkTokenCreateRequest
from plaid.model.link_token_create_request_user import LinkTokenCreateRequestUser
from plaid.model.item_public_token_exchange_request import ItemPublicTokenExchangeRequest
from plaid.model.item_remove_request import ItemRemoveRequest
from plaid.model.transactions_get_request import TransactionsGetRequest
from plaid.model.transactions_get_request_options import TransactionsGetRequestOptions
from plaid.model.accounts_get_request import AccountsGetRequest
from plaid.model.products import Products
from plaid.model.country_code import CountryCode

from backend.runtime_config import APP_NAME


_ENV_MAP = {
    "sandbox":    plaid.Environment.Sandbox,
    "production": plaid.Environment.Production,
}


def _get_client(app_config: dict):
    """Build a Plaid client from the resolved app credential ({client_id, secret, env}).

    The credential now comes from the vaulted DB (or the `.env` bootstrap) via
    `providers.config.resolve_app_config` and is passed in per call — never read from the environment
    here — so a client is built from whatever creds the caller resolved, not a process-wide singleton.
    """
    client_id = (app_config or {}).get("client_id", "")
    secret    = (app_config or {}).get("secret", "")
    env       = (app_config or {}).get("env", "sandbox")
    if not client_id or not secret:
        raise RuntimeError(
            "Plaid is not configured. Add your Plaid client ID and secret on the data-source "
            "Configure card (Accounts → Connections), or in your .env file."
        )
    configuration = plaid.Configuration(
        host=_ENV_MAP.get(env, plaid.Environment.Sandbox),
        api_key={"clientId": client_id, "secret": secret},
    )
    return plaid_api.PlaidApi(plaid.ApiClient(configuration))


def create_link_token(app_config: dict, user_id: str = "local-user") -> str:
    client  = _get_client(app_config)
    request = LinkTokenCreateRequest(
        products=[Products("transactions")],
        client_name=APP_NAME,
        country_codes=[CountryCode("US")],
        language="en",
        user=LinkTokenCreateRequestUser(client_user_id=user_id),
    )
    response = client.link_token_create(request)
    return response.to_dict()["link_token"]


def exchange_public_token(app_config: dict, public_token: str) -> dict:
    client   = _get_client(app_config)
    request  = ItemPublicTokenExchangeRequest(public_token=public_token)
    response = client.item_public_token_exchange(request).to_dict()
    return {
        "access_token": response["access_token"],
        "item_id":      response["item_id"],
    }


def remove_item(app_config: dict, access_token: str) -> None:
    """Revoke a Plaid item, invalidating its access_token provider-side (`/item/remove`). After this the
    token is dead everywhere — including any stolen copy — which is the point of an in-app disconnect."""
    client = _get_client(app_config)
    client.item_remove(ItemRemoveRequest(access_token=access_token))


def fetch_accounts(app_config: dict, access_token: str) -> list[dict]:
    client   = _get_client(app_config)
    request  = AccountsGetRequest(access_token=access_token)
    response = client.accounts_get(request).to_dict()
    accounts = []
    for a in response["accounts"]:
        accounts.append({
            "plaid_account_id": a["account_id"],
            "name":             a["name"],
            "type":             str(a["type"]),
            "subtype":          str(a["subtype"]) if a.get("subtype") else None,
            "mask":             a.get("mask"),
        })
    return accounts


def fetch_transactions(
    app_config: dict,
    access_token: str,
    start_date: date | None = None,
    end_date:   date | None = None,
) -> list[dict]:
    client = _get_client(app_config)
    if end_date   is None: end_date   = date.today()
    if start_date is None: start_date = end_date - timedelta(days=30)

    all_txns = []
    offset   = 0

    while True:
        # Plaid paginates transaction history; service callers expect a complete logical
        # slice for the requested window, not a page cursor they have to manage.
        request = TransactionsGetRequest(
            access_token=access_token,
            start_date=start_date,
            end_date=end_date,
            options=TransactionsGetRequestOptions(offset=offset, count=500),
        )
        response  = client.transactions_get(request).to_dict()
        txns      = response["transactions"]
        all_txns.extend(txns)
        if len(all_txns) >= response["total_transactions"]:
            break
        offset += len(txns)

    result = []
    for t in all_txns:
        txn_date = t["date"]
        result.append({
            "plaid_transaction_id": t["transaction_id"],
            "plaid_account_id":     t["account_id"],
            # Keep Plaid's amount sign convention intact here; downstream categorization
            # and reporting logic is written against that imported representation.
            "amount":               float(t["amount"]),
            "merchant_name":        t.get("merchant_name"),
            "raw_name":             t.get("name"),
            "date":                 txn_date.isoformat() if hasattr(txn_date, "isoformat") else str(txn_date),
            "is_pending":           t.get("pending", False),
        })
    return result
