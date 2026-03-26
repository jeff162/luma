"""
Plaid API service.
Handles link token creation, access token exchange, and transaction fetching.
"""

import os
import uuid
from datetime import date, timedelta

from dotenv import load_dotenv
load_dotenv()

import plaid
from plaid.api import plaid_api
from plaid.model.link_token_create_request import LinkTokenCreateRequest
from plaid.model.link_token_create_request_user import LinkTokenCreateRequestUser
from plaid.model.item_public_token_exchange_request import ItemPublicTokenExchangeRequest
from plaid.model.transactions_get_request import TransactionsGetRequest
from plaid.model.transactions_get_request_options import TransactionsGetRequestOptions
from plaid.model.accounts_get_request import AccountsGetRequest
from plaid.model.products import Products
from plaid.model.country_code import CountryCode


_ENV_MAP = {
    "sandbox":    plaid.Environment.Sandbox,
    "production": plaid.Environment.Production,
}

_client = None


def _get_client():
    """Lazily initialize the Plaid client so missing env vars don't crash at import time."""
    global _client
    if _client is None:
        client_id = os.environ.get("PLAID_CLIENT_ID", "")
        secret    = os.environ.get("PLAID_SECRET", "")
        env       = os.environ.get("PLAID_ENV", "sandbox")
        if not client_id or not secret:
            raise RuntimeError(
                "PLAID_CLIENT_ID and PLAID_SECRET must be set in your .env file. "
                "Copy .env.example to .env and fill in your credentials from "
                "https://dashboard.plaid.com"
            )
        configuration = plaid.Configuration(
            host=_ENV_MAP.get(env, plaid.Environment.Sandbox),
            api_key={"clientId": client_id, "secret": secret},
        )
        _client = plaid_api.PlaidApi(plaid.ApiClient(configuration))
    return _client


def create_link_token(user_id: str = "local-user") -> str:
    client  = _get_client()
    request = LinkTokenCreateRequest(
        products=[Products("transactions")],
        client_name="FinTrack",
        country_codes=[CountryCode("US")],
        language="en",
        user=LinkTokenCreateRequestUser(client_user_id=user_id),
    )
    response = client.link_token_create(request)
    return response.to_dict()["link_token"]


def exchange_public_token(public_token: str) -> dict:
    client   = _get_client()
    request  = ItemPublicTokenExchangeRequest(public_token=public_token)
    response = client.item_public_token_exchange(request).to_dict()
    return {
        "access_token": response["access_token"],
        "item_id":      response["item_id"],
    }


def fetch_accounts(access_token: str) -> list[dict]:
    client   = _get_client()
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
    access_token: str,
    start_date: date | None = None,
    end_date:   date | None = None,
) -> list[dict]:
    client = _get_client()
    if end_date   is None: end_date   = date.today()
    if start_date is None: start_date = end_date - timedelta(days=30)

    all_txns = []
    offset   = 0

    while True:
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
            "amount":               float(t["amount"]),
            "merchant_name":        t.get("merchant_name"),
            "raw_name":             t.get("name"),
            "date":                 txn_date.isoformat() if hasattr(txn_date, "isoformat") else str(txn_date),
            "is_pending":           t.get("pending", False),
        })
    return result
