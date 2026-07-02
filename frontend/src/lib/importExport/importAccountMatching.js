// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// Pure helpers for resolving a CSV account-column value to an existing account
// during import mapping: exact-name match, the masked-suffix stem normalizer and
// token-subset fallback that power likely-match suggestions, and the snapshot
// builder that flattens the in-progress account-mapping UI state into the
// account_map / skip_accounts / account_new payload the import flow persists.
//
// Matching deliberately uses an account's raw `name` (the data-source identifier),
// not `display_name`: display_name is overwritten to the parent's when an account
// is grouped on the Accounts page, and import mapping must stay aligned with what
// the data source calls the account regardless of how the user has organized them.

export function guessNewAccountTypeFromName(name) {
  const normalized = String(name || '').trim().toLowerCase()
  if (!normalized) return ''
  if (normalized === 'paypal' || normalized === 'venmo') return 'p2p'
  if (normalized.includes('credit') || normalized.includes('card')) return 'credit'
  if (normalized.includes('checking')) return 'depository'
  if (normalized.includes('savings')) return 'savings'
  if (normalized.includes('brokerage')) return 'investment'
  return ''
}

export function findExactAccountNameMatch(accounts, value) {
  const normalized = String(value || '').trim().toLowerCase()
  if (!normalized) return null
  return accounts.find(account => String(account?.name || '').trim().toLowerCase() === normalized) || null
}

export function getAccountMatchLabel(account) {
  return String(account?.display_name || account?.name || '').trim()
}

export function normalizeAccountMatchStem(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\(\s*(?:\.\.\.)?\s*\d{2,}\s*\)\s*$/, '')
    .replace(/(?:\s+|[-_/])(?:x|xx|xxx|xxxx|\*|[*]{2,}|ending|acct|account)?\s*\d{2,}\s*$/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Account-type words that are too generic to anchor a suggestion on their own. They're kept in
// the stem (so "eastern checking" doesn't collapse to "eastern" and match "eastern savings"),
// but a subset match whose overlapping tokens are ALL generic ("Savings (...7304)" ⊂ "xyz
// savings") is rejected — there's no real signal beyond the account category.
const GENERIC_ACCOUNT_TOKENS = new Set([
  'checking', 'savings', 'cash', 'account', 'card',
])

function accountStemTokenSet(value) {
  const normalized = normalizeAccountMatchStem(value)
  if (!normalized) return new Set()
  return new Set(normalized.split(' ').filter(Boolean))
}

function isTokenSubset(maybeSubset, superset) {
  for (const token of maybeSubset) {
    if (!superset.has(token)) return false
  }
  return true
}

function hasNonGenericToken(tokens) {
  for (const token of tokens) {
    if (!GENERIC_ACCOUNT_TOKENS.has(token)) return true
  }
  return false
}

function getAccountRawMatchName(account) {
  return String(account?.name || '').trim()
}

export function findLikelyAccountMatch(accounts, value) {
  const exactMatch = findExactAccountNameMatch(accounts, value)
  if (exactMatch) return null
  const normalized = normalizeAccountMatchStem(value)
  if (!normalized) return null
  // 1. Strong signal: stems are byte-identical after stripping the mask suffix. e.g.,
  //    "Checking (...1234)" and "Checking" both reduce to "checking" — exactly one such match
  //    is a high-confidence suggestion.
  const stemMatches = accounts.filter(account => normalizeAccountMatchStem(getAccountRawMatchName(account)) === normalized)
  if (stemMatches.length === 1) return stemMatches[0]
  if (stemMatches.length > 1) return null
  // 2. Fallback: token-subset match in either direction. e.g., csv ["foo", "bar"] is a subset
  //    of an existing account's ["acme", "foo", "bar"]. Require at least one non-generic token
  //    in the subset side so generics like "Savings (...0000)" don't surface every savings
  //    account on the strength of "savings" alone.
  const csvTokens = accountStemTokenSet(value)
  if (!csvTokens.size || !hasNonGenericToken(csvTokens)) return null
  const subsetCandidates = []
  for (const account of accounts) {
    const accountTokens = accountStemTokenSet(getAccountRawMatchName(account))
    if (!accountTokens.size) continue
    const subset = isTokenSubset(csvTokens, accountTokens) ? csvTokens
                 : isTokenSubset(accountTokens, csvTokens) ? accountTokens
                 : null
    if (!subset || !hasNonGenericToken(subset)) continue
    subsetCandidates.push(account)
  }
  return subsetCandidates.length === 1 ? subsetCandidates[0] : null
}

export function buildAccountImportStateSnapshot(accountMap) {
  const accountAssignments = {}
  const accountNew = {}
  const accountDuplicateCompare = {}
  const skipAccounts = []

  for (const [csvVal, mapping] of Object.entries(accountMap || {})) {
    if (mapping?.skip) {
      skipAccounts.push(csvVal)
    } else if (mapping?.createNew && mapping?.newName?.trim()) {
      accountNew[csvVal] = {
        name: mapping.newName.trim(),
        type: mapping.newType || '',
      }
      if (mapping?.duplicateCompareTargetAccountId) {
        accountDuplicateCompare[csvVal] = mapping.duplicateCompareTargetAccountId
      }
    } else if (mapping?.accountId) {
      accountAssignments[csvVal] = mapping.accountId
    }
  }

  const snapshot = {
    account_map: accountAssignments,
    skip_accounts: skipAccounts,
    account_new: accountNew,
  }
  if (Object.keys(accountDuplicateCompare).length > 0) {
    snapshot.account_duplicate_compare = accountDuplicateCompare
  }
  return snapshot
}
