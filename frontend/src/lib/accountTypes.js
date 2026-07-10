// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// Canonical account type list shared across the import mapping screen, the accounts page,
// and any other surface that needs to present or store account types.
//
// - value: the stored database value; depository is the Plaid-originated term for checking
//   accounts and remains the internal default fallback for backward compatibility.
// - label: full descriptive label for contexts with space (accounts page type selector).
// - shortLabel: compact label for narrow dropdowns (import mapping account rows).
// - kind: optional class of account. `marketplace` marks a shopping venue (Amazon, and any future
//   AliExpress/Temu-style vendor) whose purchases arrive itemized via its *own* importer, not the
//   generic CSV mapper — so the generic importer hides these types and accounts (they only make sense
//   on their dedicated tab). The account is otherwise ordinary; `kind` is a UI convention, not a
//   database-enforced rule.
export const ACCOUNT_TYPES = [
  { value: 'credit',     label: 'Credit card', shortLabel: 'Credit'    },
  { value: 'depository', label: 'Checking',    shortLabel: 'Checking'  },
  { value: 'p2p',        label: 'P2P',         shortLabel: 'P2P'       },
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
export const GENERIC_IMPORT_ACCOUNT_TYPES = ACCOUNT_TYPES.filter(t => t.kind !== 'marketplace')
