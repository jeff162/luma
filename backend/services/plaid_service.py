# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Boundary between Plaid's Python models and the app's plain-dict contracts.

This service is intentionally thin, but it centralizes the normalization choices
the database and routers rely on: stable field names, string dates, and full
pagination before control returns to the caller.
"""

from datetime import date, timedelta

import plaid
from plaid.api import plaid_api
from plaid.model.link_token_create_request import LinkTokenCreateRequest
from plaid.model.link_token_create_request_user import LinkTokenCreateRequestUser
from plaid.model.item_public_token_exchange_request import ItemPublicTokenExchangeRequest
from plaid.model.item_remove_request import ItemRemoveRequest
from plaid.model.transactions_get_request import TransactionsGetRequest
from plaid.model.transactions_get_request_options import TransactionsGetRequestOptions
from plaid.model.transactions_sync_request import TransactionsSyncRequest
from plaid.model.transactions_sync_request_options import TransactionsSyncRequestOptions
from plaid.model.accounts_get_request import AccountsGetRequest
from plaid.model.products import Products
from plaid.model.country_code import CountryCode

from backend.runtime_config import app_name


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
            "Plaid is not configured. Add your Plaid client ID and secret on the data provider's "
            "Configure card (Accounts → Connections)."
        )
    configuration = plaid.Configuration(
        host=_ENV_MAP.get(env, plaid.Environment.Sandbox),
        api_key={"clientId": client_id, "secret": secret},
    )
    return plaid_api.PlaidApi(plaid.ApiClient(configuration))


def create_link_token(app_config: dict, user_id: str = "local-user", access_token: str | None = None) -> str:
    """Mint the short-lived token Link opens with.

    **`access_token` selects update mode**, which re-authorizes an *existing* Item rather than creating a
    new one. The distinction is the whole difference between repairing a connection and replacing it: a
    plain Link session mints a fresh Item with a fresh `item_id` and fresh per-account ids, so
    reconnecting a bank that way strands the old connection and everything keyed to it. Update mode keeps
    the Item, so the credential Luma already holds simply starts working again.

    `products` is omitted in update mode — Plaid rejects the pair, because the Item's products were fixed
    when it was created and this call is not creating one.
    """
    client = _get_client(app_config)
    fields = {
        "client_name": app_name(),
        "country_codes": [CountryCode("US")],
        "language": "en",
        "user": LinkTokenCreateRequestUser(client_user_id=user_id),
    }
    if access_token:
        fields["access_token"] = access_token
    else:
        fields["products"] = [Products("transactions")]
    response = client.link_token_create(LinkTokenCreateRequest(**fields))
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
            # The bank's formal name for the account ("Northgate Voyager Unlimited") vs. `name`, which is
            # often a generic product label. Surfaced in the mapping UI so a provider account is
            # identifiable when the local account has been renamed.
            "official_name":    a.get("official_name"),
            "type":             str(a["type"]),
            "subtype":          str(a["subtype"]) if a.get("subtype") else None,
            "mask":             a.get("mask"),
            "currency":         _currency_code(a.get("balances") or {}),
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

    return [_normalize_txn(t) for t in all_txns]


def _currency_code(source: dict) -> str | None:
    """The denomination Plaid reports, from whichever of its two fields carries one.

    Plaid splits this in a way worth preserving rather than collapsing: `iso_currency_code` holds a real
    ISO-4217 code, and `unofficial_currency_code` holds everything outside that list — crypto, and
    currencies Plaid does not officially support. Both are returned here as a plain string because the
    ledger's question is only ever "does this match", and an unofficial code can never match an ISO one,
    which is the correct answer for it.

    None when Plaid states neither, which it can. That reads as "not stated" downstream and therefore as
    a match — the same rule every other adapter follows, since refusing an account over an absent field
    would discard real data on a reporting gap.
    """
    for key in ("iso_currency_code", "unofficial_currency_code"):
        code = str(source.get(key) or "").strip()
        if code:
            return code
    return None


def _iso_date(value) -> str | None:
    if value is None:
        return None
    return value.isoformat() if hasattr(value, "isoformat") else str(value)


def _check_number(t: dict) -> str | None:
    """The check number, when Plaid says this is a check. It has no field of its own — it arrives in
    `payment_meta.reference_number`, which only means "check number" when `transaction_code` says so;
    under other transaction codes the same field carries unrelated references."""
    if str(t.get("transaction_code") or "").strip().lower() != "check":
        return None
    reference = str(((t.get("payment_meta") or {}).get("reference_number")) or "").strip()
    return reference or None


def _counterparty_names(t: dict) -> list[str]:
    """Plaid's resolved counterparties (merchant, payment processor, …) by name — a far more stable
    identity than the descriptor string, which every source truncates differently."""
    names: list[str] = []
    for c in (t.get("counterparties") or []):
        name = str((c or {}).get("name") or "").strip()
        if name and name not in names:
            names.append(name)
    return names


def _location_text(t: dict) -> str | None:
    """The transaction's place, flattened to one line. Enrichment rather than a matching signal, so
    it is the one optional capture that defaults off."""
    loc = t.get("location") or {}
    parts = [str(loc.get(k) or "").strip() for k in ("address", "city", "region", "postal_code")]
    joined = ", ".join(p for p in parts if p)
    return joined or None


def _normalize_txn(t: dict) -> dict:
    """Plaid transaction dict → the app's stable field names. Shared by the date-range and cursor paths."""
    return {
        "plaid_transaction_id": t["transaction_id"],
        "plaid_account_id":     t["account_id"],
        # Keep Plaid's amount sign convention intact here; downstream categorization
        # and reporting logic is written against that imported representation.
        "amount":               float(t["amount"]),
        "merchant_name":        t.get("merchant_name"),
        "raw_name":             t.get("name"),
        "date":                 _iso_date(t["date"]),
        # When the charge was AUTHORIZED, as opposed to `date`, which is when it posted. Two sources for
        # the same charge routinely disagree by several days because each reports a different one of these
        # — the gap that made genuine cross-source duplicates read as near-misses on date. Absent when the
        # provider can't supply it.
        "authorized_date":      _iso_date(t.get("authorized_date")),
        "is_pending":           t.get("pending", False),
        # When a pending transaction posts, Plaid emits the posted transaction (new id) with this set to the
        # prior pending transaction's id, so the sync can convert the pending row in place instead of
        # trashing it and re-adding. NULL for transactions that were never pending.
        "pending_transaction_id": t.get("pending_transaction_id"),
        "counterparties":       _counterparty_names(t),
        "check_number":         _check_number(t),
        "location":             _location_text(t),
        # Per transaction, not only per account. Plaid states it on both, and the row's own is what governs
        # the number in `amount` — an account whose currency changed, or a row Plaid reports in something
        # other than its account's denomination, is judged on what it actually says.
        "currency":             _currency_code(t),
    }


def fetch_transactions_sync(
    app_config: dict,
    access_token: str,
    cursor: str | None = None,
    days_requested: int = 730,
) -> dict:
    """One page of Plaid's cursor-based `/transactions/sync`. Returns the normalized changes for this page
    plus the paging/backfill state, so the caller manages the cursor loop and the readiness poll:

      {added:[…], modified:[…], removed:[txn_id…], next_cursor, has_more, update_status}

    `update_status` is Plaid's `transactions_update_status` — the same signal the transactions webhook
    carries (NOT_READY / INITIAL_UPDATE_COMPLETE / HISTORICAL_UPDATE_COMPLETE), so a caller can tell when
    the historical backfill is done **without** a webhook endpoint. `cursor=None` starts an initial pull;
    `days_requested` (1–730) bounds how far back Plaid fetches — the user's history-window choice.
    """
    client = _get_client(app_config)
    kwargs = dict(
        access_token=access_token,
        count=500,
        options=TransactionsSyncRequestOptions(days_requested=max(1, min(int(days_requested or 730), 730))),
    )
    if cursor:
        kwargs["cursor"] = cursor
    response = client.transactions_sync(TransactionsSyncRequest(**kwargs)).to_dict()
    return {
        "added":       [_normalize_txn(t) for t in response.get("added", [])],
        "modified":    [_normalize_txn(t) for t in response.get("modified", [])],
        "removed":     [t["transaction_id"] for t in response.get("removed", [])],
        "next_cursor": response.get("next_cursor"),
        "has_more":    bool(response.get("has_more")),
        "update_status": response.get("transactions_update_status"),
    }
