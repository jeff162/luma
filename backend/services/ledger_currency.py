# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
The one currency this ledger's amounts are in.

The constraint the app actually has is **one currency at a time**, not any particular one. `txn.amount`
is a bare number with no denomination stored beside it, so two denominations held together are
indistinguishable and both join every total, budget and report — and there is nothing to convert *from*
and no rate source to convert *with*. A ledger that is consistently in one currency is entirely correct
whatever that currency is; only *mixing* breaks.

That distinction is the whole reason this module exists. The check it replaces compared against a
hardcoded `"USD"`, which asks the wrong question: it treats an Australian user's consistently-AUD
accounts as the error case, when nothing about them is wrong. The right question is whether an incoming
account matches **this ledger's** currency, and that has to be something the user can state.

Two futures start here and cost very different amounts. This module is the cheap one — a setting, and
its symbol on the frontend, with no change to how a single row is stored. *Multi-currency* (holding two
at once) is the expensive one: a per-row currency column, a rate source with historical rates, and a
decision about what a total spanning currencies means. The first is not a down payment on the second,
and shipping it does not commit to it.

**Where the value lives.** `import_workflow_state`, the tenant-wide shared store — not `ui_preference`.
`docs/data-model.md`'s dividing line settles it: `ui_preference` is for things that may legitimately
differ per person, and the currency the ledger is denominated in is not one of them. Everyone in a
workspace is reading the same numbers, and a restore into a different preference profile would orphan a
per-user copy. Being tenant state, it also rides backups, so a restored ledger keeps its denomination.
"""

from __future__ import annotations

from backend.db.database import get_tenant_workflow_state, set_tenant_workflow_state

STATE_KEY = "ledger_currency"

# What a ledger is denominated in until someone says otherwise. A default is unavoidable — the first
# transaction can arrive before anyone visits Settings — and USD is the app's historical assumption, so
# choosing it changes nothing for existing installs. It is a *default*, not a privileged currency: no
# code outside this module may compare against it, or the setting becomes decorative.
DEFAULT_LEDGER_CURRENCY = "USD"

# Offered in the picker. Deliberately **not** a whitelist — `normalize_currency_code` accepts any
# well-formed ISO-4217 code — because a fixed list is a promise to maintain it, and the first user
# outside it would be blocked by an omission rather than by a real limitation. This is a shortlist for
# convenience, and being absent from it costs a user nothing.
COMMON_CURRENCIES = (
    ("USD", "US dollar"),
    ("AUD", "Australian dollar"),
    ("CAD", "Canadian dollar"),
    ("EUR", "Euro"),
    ("GBP", "Pound sterling"),
    ("NZD", "New Zealand dollar"),
    ("CHF", "Swiss franc"),
    ("JPY", "Japanese yen"),
    ("INR", "Indian rupee"),
    ("SGD", "Singapore dollar"),
    ("ZAR", "South African rand"),
    ("MXN", "Mexican peso"),
    ("BRL", "Brazilian real"),
    ("SEK", "Swedish krona"),
    ("NOK", "Norwegian krone"),
    ("DKK", "Danish krone"),
    ("PLN", "Polish złoty"),
    ("HKD", "Hong Kong dollar"),
)


class InvalidCurrencyCode(ValueError):
    """The supplied string is not a usable ISO-4217 currency code."""


def normalize_currency_code(code: str) -> str:
    """An ISO-4217 code in the one form everything else compares against: three letters, uppercase.

    Validated by *shape* rather than against a list of real codes. A list would have to be maintained,
    and its failure mode is rejecting a legitimate currency because nobody updated it — whereas the cost
    of accepting a well-formed code that is not a real currency is that the user sees their own typo
    echoed back in the picker, which is self-correcting.
    """
    normalized = str(code or "").strip().upper()
    if len(normalized) != 3 or not normalized.isalpha() or not normalized.isascii():
        raise InvalidCurrencyCode("A currency code is three letters, like USD or AUD.")
    return normalized


def get_ledger_currency(conn) -> str:
    """This ledger's currency. Falls back to the default for an unset, malformed, or empty value, so a
    corrupted state row degrades to the app's historical behaviour rather than failing every read."""
    state = get_tenant_workflow_state(conn, STATE_KEY)
    try:
        return normalize_currency_code(state.get("code")) if isinstance(state, dict) else DEFAULT_LEDGER_CURRENCY
    except InvalidCurrencyCode:
        return DEFAULT_LEDGER_CURRENCY


def set_ledger_currency(conn, code: str) -> str:
    """Record the ledger's currency. Returns the normalized code actually stored.

    **Nothing about the stored data changes** — no amount is converted, rescaled, or rewritten. That is
    what makes the change cheap, and also what makes it dangerous enough to confirm at the UI layer: a
    ledger of real dollars set to AUD is now a ledger of nominal Australian dollars, with every
    historical figure silently relabelled. It is equally cheap to reverse, which is why a confirmation
    is the right guard rather than a prohibition.
    """
    normalized = normalize_currency_code(code)
    set_tenant_workflow_state(conn, STATE_KEY, {"code": normalized})
    return normalized


def is_default(conn) -> bool:
    """Whether the currency is still the unset default, as against USD having been chosen deliberately.
    They behave identically; the distinction is only so the UI can say which one it is showing."""
    state = get_tenant_workflow_state(conn, STATE_KEY)
    return not (isinstance(state, dict) and state.get("code"))


def currency_matches(ledger_currency: str, provider_currency: str | None) -> bool:
    """Whether an account denominated in `provider_currency` may contribute rows to this ledger.

    A provider that reports **no** currency matches. The field is optional in more than one protocol, so
    absence means "not stated" rather than "not ours", and rejecting an account over a missing field
    would discard real data on a formatting gap. Only a *stated* mismatch is unambiguous — which is also
    the only case a user can act on.
    """
    stated = str(provider_currency or "").strip()
    if not stated:
        return True
    return stated.upper() == str(ledger_currency or DEFAULT_LEDGER_CURRENCY).upper()
