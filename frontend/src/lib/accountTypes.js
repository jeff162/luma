// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// Canonical account type list shared across the import mapping screen, the accounts page,
// and any other surface that needs to present or store account types.
//
// - value: the stored database value; depository is the Plaid-originated term for checking
//   accounts and remains the internal default fallback for backward compatibility.
// - label: full descriptive label for contexts with space (accounts page type selector).
// - shortLabel: compact label for narrow dropdowns (import mapping account rows).
// - kind: optional class of account.
//   `wallet` marks an account that pays from a bank or card and cashes out to one (PayPal, a payment app):
//   its rows are paired with the bank and card rows on the other side so the money counts once. The
//   backend keys on the same two types (services/wallet_accounts.py).
//   `marketplace` marks a shopping venue (Amazon, and any future AliExpress/Temu-style vendor) whose
//   purchases arrive itemized via its *own* importer, not the generic CSV mapper — so the generic importer
//   hides these types and accounts (they only make sense on their dedicated tab). The account is otherwise
//   ordinary; this `kind` is a UI convention, not a database-enforced rule.
export const ACCOUNT_TYPES = [
  { value: 'credit',     label: 'Credit card', shortLabel: 'Credit'    },
  { value: 'depository', label: 'Checking',    shortLabel: 'Checking'  },
  { value: 'p2p',        label: 'P2P',         shortLabel: 'P2P',      kind: 'wallet' },
  // PayPal is not a marketplace: PayPal Activity files are imported through
  // the generic CSV importer — recognized by header sniff — not a dedicated tab. The type exists so
  // rules (money movement, and any user rule) can be scoped to "all PayPal accounts" by account type.
  { value: 'paypal',     label: 'PayPal',      shortLabel: 'PayPal',   kind: 'wallet' },
  { value: 'amazon',     label: 'Amazon',      shortLabel: 'Amazon',   kind: 'marketplace' },
  { value: 'investment', label: 'Investment',  shortLabel: 'Invest.'   },
  { value: 'savings',    label: 'Savings',     shortLabel: 'Savings'   },
  { value: 'loan',       label: 'Loan',        shortLabel: 'Loan'      },
  { value: 'other',      label: 'Other',       shortLabel: 'Other'     },
]

// Map from stored value to full label, for display-only contexts.
export const ACCOUNT_TYPE_LABEL = Object.fromEntries(ACCOUNT_TYPES.map(t => [t.value, t.label]))

// Marketplace types (see `kind` above) and helpers for the generic CSV importer, which offers neither
// these types (for a new account) nor existing accounts of these types (for mapping) — they belong to
// their own dedicated import flow.
const MARKETPLACE_TYPE_VALUES = new Set(
  ACCOUNT_TYPES.filter(t => t.kind === 'marketplace').map(t => t.value),
)
export function isMarketplaceAccountType(value) {
  return MARKETPLACE_TYPE_VALUES.has(value)
}
export function isWalletAccountType(value) {
  return ACCOUNT_TYPES.some(t => t.value === value && t.kind === 'wallet')
}
export const GENERIC_IMPORT_ACCOUNT_TYPES = ACCOUNT_TYPES.filter(t => t.kind !== 'marketplace')

// Which side of zero an account's balance normally sits on: held (positive) for a bank or investment
// account, owed (negative) for a card or loan, and about zero for a wallet or marketplace, which money
// passes through. `other` says nothing, as with the balance totals, so it has none.
const NORMAL_BALANCE_SIDE = {
  depository: 'held', savings: 'held', investment: 'held',
  credit: 'owed', loan: 'owed',
  paypal: 'zero', p2p: 'zero', amazon: 'zero',
}

// Which side of zero a type's balance normally sits on: 'held', 'owed' or 'zero', or null for one that says
// nothing (`other`).
export function normalBalanceSide(accountType) {
  return NORMAL_BALANCE_SIDE[accountType] || null
}

// The color for a balance on the unusual side for its type, or null for one where it belongs: red below
// zero where money is normally held (an overdraft), green above it where money is normally owed (a credit
// balance) or should be near none (a wallet holding money).
export function unusualBalanceColor(accountType, amount) {
  const side = NORMAL_BALANCE_SIDE[accountType]
  const value = Math.round((Number(amount) || 0) * 100)
  if (!side || value === 0) return null
  if (value < 0) return side === 'owed' ? null : 'var(--danger)'
  return side === 'held' ? null : 'var(--success)'
}
