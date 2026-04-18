// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

// Canonical account type list shared across the import mapping screen, the accounts page,
// and any other surface that needs to present or store account types.
//
// - value: the stored database value; depository is the Plaid-originated term for checking
//   accounts and remains the internal default fallback for backward compatibility.
// - label: full descriptive label for contexts with space (accounts page type selector).
// - shortLabel: compact label for narrow dropdowns (import mapping account rows).
export const ACCOUNT_TYPES = [
  { value: 'credit',     label: 'Credit card', shortLabel: 'Credit'    },
  { value: 'depository', label: 'Checking',    shortLabel: 'Checking'  },
  { value: 'p2p',        label: 'P2P',         shortLabel: 'P2P'       },
  { value: 'investment', label: 'Investment',  shortLabel: 'Invest.'   },
  { value: 'savings',    label: 'Savings',     shortLabel: 'Savings'   },
  { value: 'loan',       label: 'Loan',        shortLabel: 'Loan'      },
  { value: 'other',      label: 'Other',       shortLabel: 'Other'     },
]

// Map from stored value to full label, for display-only contexts.
export const ACCOUNT_TYPE_LABEL = Object.fromEntries(ACCOUNT_TYPES.map(t => [t.value, t.label]))
