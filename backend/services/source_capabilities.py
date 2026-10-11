# SPDX-FileCopyrightText: 2026 Jeffrey Orlin
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
What a *data source* — a provider connection or a file importer — declares about the rows it produces,
where the ingesting code would otherwise have to branch on which source it is holding.

This is a leaf module because the sources do not share a base class. A provider connection is a
`ProviderAdapter` subclass; CSV/PayPal is a code path in `routers/import_export/core.py`; Amazon is
another in `routers/import_export/amazon.py`. Only the adapters can carry a class attribute, so the
non-adapter sources are registered here by name and every consumer reads through one accessor. See
`docs/building-a-connector.md`.

Zero-amount rows
----------------

A source may publish a transaction with **no amount**. Such a row is worth recording only when the zero
is genuine — a finished record such as a fully gift-carded or promotional order, or a refund that nets
out. A pending placeholder is not worth recording for itself; the transaction it stands for is recorded
when it settles.

A placeholder is kept only where refusing it would *lose* that settlement: a provider that revises the
row in place, keyed on its transaction id, and ignores a revision naming a row never inserted. Wherever the
settled charge arrives as a row of its own, refusing the placeholder loses nothing, and inserting it would
leave dead weight that duplicate detection cannot pair with the settled row, the amounts differing. A
refused row is reported as a rejected row on the import/sync card rather than silently dropped.

Every source states its own policy explicitly — there is deliberately no default. The reasoning above
does not generalize from one source to the next, so a source that has not been thought about must fail
loudly rather than inherit someone else's answer.
"""

from __future__ import annotations

from typing import Literal

# "keep" — $0 rows are imported. "reject" — they are refused and reported as rejected rows.
ZeroAmountPolicy = Literal["keep", "reject"]

KEEP_ZERO_AMOUNT: ZeroAmountPolicy = "keep"
REJECT_ZERO_AMOUNT: ZeroAmountPolicy = "reject"

# The rejected-row `kind` shared by every source, so one dialog renders them all.
ZERO_AMOUNT_REJECTION_KIND = "zero_amount"
ZERO_AMOUNT_REJECTION_REASON = "Zero amount"

# Sources that are code paths rather than adapter classes. Adapters declare `zero_amount_rows` on
# themselves (`ProviderAdapter`); these have nowhere to put it.
SOURCE_CSV = "csv"
SOURCE_AMAZON = "amazon"
SOURCE_PAYPAL_STATEMENT = "paypal_statement"

_NON_ADAPTER_SOURCE_POLICY: dict[str, ZeroAmountPolicy] = {
    # The settled charge arrives in a later file as a row of its own — with a transaction-ID column as well,
    # since an id the ledger does not hold is a new row — so refusing the placeholder loses nothing. And a $0
    # line in a statement export is a pending charge or a non-transaction (a footer, a balance-forward),
    # never a genuine zero. This covers PayPal, which is this same importer under a source kind.
    SOURCE_CSV: REJECT_ZERO_AMOUNT,
    # A genuine zero: Amazon imports *orders*, and a $0 order is a finished record — fully gift-carded,
    # promotional, or a return that nets to zero — not a placeholder awaiting an amount. Reconciliation
    # depends on seeing them; a $0 order that vanished would read as an order with no charge found.
    SOURCE_AMAZON: KEEP_ZERO_AMOUNT,
    # A PayPal monthly statement is a closed month's finished record with no placeholders in it, and a $0
    # line in it moved no money — an authorization or a hold, not a purchase.
    SOURCE_PAYPAL_STATEMENT: REJECT_ZERO_AMOUNT,
}


def zero_amount_policy_for_source(source: str) -> ZeroAmountPolicy:
    """The policy for a non-adapter source. Adapters are asked directly (`adapter.zero_amount_rows`)
    rather than routed through here, so that a missing declaration surfaces as the adapter's own
    error instead of a lookup miss blamed on this table."""
    try:
        return _NON_ADAPTER_SOURCE_POLICY[source]
    except KeyError:
        raise ValueError(
            f"no zero-amount policy declared for source {source!r}; add one to "
            f"_NON_ADAPTER_SOURCE_POLICY (see docs/building-a-connector.md)"
        ) from None


# Currency scope
# --------------
#
# The ledger holds one currency (`services/ledger_currency.py`), so a row in any other is dropped rather
# than stored as a bare number. What a source *states* a currency on decides what dropping means, and so
# what the user can truthfully be told:
#
#   "account"     — the source names one currency per account (SimpleFIN). A mismatched account is
#                   dropped whole, can never fill, and is worth warning about from its recorded currency
#                   even on a pull that happened not to include it.
#   "transaction" — the source names a currency on every row (Plaid; a CSV with a currency column). Only
#                   the mismatched rows are dropped and the account keeps filling, so "this account is
#                   held in GBP" is false: one foreign charge in an otherwise dollar wallet said exactly
#                   that. The notice names the rows instead, and only on a pull that dropped some.
#
# No default, for the zero-amount reason: which one a source is follows from its protocol, not a guess.
CurrencyScope = Literal["account", "transaction"]

CURRENCY_PER_ACCOUNT: CurrencyScope = "account"
CURRENCY_PER_TRANSACTION: CurrencyScope = "transaction"

# The rejected-row `kind` for a file row stated in another currency. A file states it per row, through an
# optional mapped column, so it is refused row by row and listed on the card like a $0 row; the reason
# names the currency, which is the one thing the kind alone cannot say.
CURRENCY_REJECTION_KIND = "currency"


def rejects_zero_amount(policy: ZeroAmountPolicy) -> bool:
    """Read as a question rather than compared to a string literal at each call site, so a typo in a
    policy value cannot quietly mean "keep" at one of them."""
    if policy not in (KEEP_ZERO_AMOUNT, REJECT_ZERO_AMOUNT):
        raise ValueError(f"unknown zero-amount policy {policy!r}")
    return policy == REJECT_ZERO_AMOUNT
