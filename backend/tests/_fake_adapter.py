"""
A stand-in provider adapter for tests that drive `run_sync` without a real aggregator.

It subclasses the real `ProviderAdapter` deliberately. The sync loop reads an adapter's capability
declarations (`has_cursor`, `max_history_days`, …) to decide how deep to fetch and whether a backfill is
finished, so a fake that merely duck-types the two methods a test happens to call goes stale the moment
the contract grows — silently, as an AttributeError swallowed by the loop's per-connection error handler.
Inheriting means a new declaration arrives here with its real default.

`FakeCursorAdapter` models a **cursor** provider (Plaid's shape), since that is what every test using it
is standing in for. A range-pull provider needs no fake: the base class ships that path as its default.
"""

from backend.services.ledger_currency import DEFAULT_LEDGER_CURRENCY
from backend.services.providers.base import ProviderAdapter
from backend.services.source_capabilities import KEEP_ZERO_AMOUNT

# Plaid's terminal `transactions_update_status`, the value its adapter maps to backfill_complete.
DONE = "HISTORICAL_UPDATE_COMPLETE"


class FakeCursorAdapter(ProviderAdapter):
    """Serves scripted `fetch_transactions_sync` pages in order across calls, recording the cursor and
    depth each call was made with. A page is a dict with any of
    added/modified/removed/has_more/update_status/next_cursor; missing keys default to an empty,
    terminal page."""

    provider = "plaid"
    has_cursor = True
    max_history_days = 730
    # Stated because the base class deliberately supplies no default, and matching Plaid keeps this fake
    # standing in for the provider it names. A test needing the other policy overrides it per instance.
    zero_amount_rows = KEEP_ZERO_AMOUNT

    def __init__(self, pages=None, accounts=None):
        self._pages = list(pages or [])
        self._accounts = accounts or []
        self.calls = []
        self._idx = 0

    def fetch_transactions_sync(self, app_config, credential, *, cursor=None, days_requested=730,
                                account_targets=None, ledger_currency=DEFAULT_LEDGER_CURRENCY,
                                request_budget=None, continuing=False, budget_checkpoint=None):
        self.calls.append({"cursor": cursor, "days_requested": days_requested,
                           "account_targets": account_targets, "ledger_currency": ledger_currency,
                           "request_budget": request_budget, "continuing": continuing})
        page = self._pages[self._idx] if self._idx < len(self._pages) else {}
        self._idx += 1
        status = page.get("update_status", DONE)
        return {
            "added":         page.get("added", []),
            "modified":      page.get("modified", []),
            "removed":       page.get("removed", []),
            "next_cursor":   page.get("next_cursor", f"cur-{self._idx}"),
            "has_more":      page.get("has_more", False),
            "update_status": status,
            "backfill_complete": page.get("backfill_complete", status == DONE),
            "resume_later":  page.get("resume_later", False),
            # None, as a cursor provider reports: it maintains one window across the whole item, so the
            # caller's requested depth is the accurate claim and there is nothing per-account to correct.
            "account_coverage": page.get("account_coverage"),
            "warnings":      page.get("warnings", []),
            "unsupported_currency": page.get("unsupported_currency", {}),
            # Included only when a page scripts it, so the default shape is an adapter that predates the
            # field — which the sync loop must tolerate, since the contract's default lives in the base
            # class and an override is free not to copy it.
            **({"advisories": page["advisories"]} if "advisories" in page else {}),
            # Same reasoning, and doubly so here: a cursor provider genuinely has no window to name, so
            # absent is this fake's *correct* answer and a page scripts the key only to model an adapter
            # that does pull ranges.
            **({"requested_windows": page["requested_windows"]} if "requested_windows" in page else {}),
        }

    def connect(self, app_config, payload):
        raise NotImplementedError("tests using this fake seed connections directly")

    def fetch_accounts(self, app_config, credential):
        return self._accounts

    def fetch_transactions(self, app_config, credential, start_date=None, end_date=None):
        raise NotImplementedError("this fake models a cursor provider; use fetch_transactions_sync")

    def capture_fields(self):
        return []

    def remove(self, app_config, credential):
        pass
