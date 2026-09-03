// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// Pure helpers for resolving a CSV account-column value to an existing account
// during import mapping: exact-name match, the masked-suffix stem normalizer and
// token-subset fallback that power likely-match suggestions, and the snapshot
// builder that flattens the in-progress account-mapping UI state into the
// account_map / skip_accounts / account_new payload the import flow persists.
//
// A suggestion always names a group *root*, even when a merged child is what matched:
// the root is the account a picker offers and the scope dedupe and reporting already use.
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

// What a mapping picker may OFFER, given what it currently points at.
//
// Root accounts only. A merged child is not a target anyone picks deliberately — the group root lands
// rows in the same effective scope for both dedupe and reporting — and offering every child doubles the
// list with entries that read as near-duplicates of their own parents (merging rewrites a child's
// display name to its parent's, so "PayPal" merged into "PayPal" yields two identical-looking choices).
//
// The exception is the child a mapping is ALREADY on, and it is the reason this function exists rather
// than a plain root filter: merging an account never moves the mappings pointing at it, so a picker that
// listed roots alone would find no option matching the stored id and render a decision in force as an
// empty control — inviting the user to "fix" it and silently re-point the source. That child stays
// listed, labelled with its group, for exactly as long as it is selected.
export function selectableAccountOptions(accounts, selectedId = '') {
  const list = accounts || []
  const roots = list.filter(account => !account?.parent_account_id)
  if (!selectedId || roots.some(account => account?.id === selectedId)) return roots
  const selectedChild = list.find(account => account?.id === selectedId)
  return selectedChild ? [...roots, selectedChild] : roots
}

// An account's label in such a picker. Only a merged child ever needs one, and only while it is the
// selected value — but there the group suffix is load-bearing, since the child's own name is usually
// its parent's and the entry would otherwise read as a duplicate of a root already in the list.
export function getAccountOptionLabel(account, accountsById = null) {
  const base = `${account?.name || ''}${account?.mask ? ` ···${account.mask}` : ''}`
  const parentId = account?.parent_account_id
  if (!parentId) return base
  const parent = accountsById?.get?.(parentId) || null
  const parentLabel = getAccountMatchLabel(parent)
  return parentLabel ? `${base} — in ${parentLabel}` : base
}

export function normalizeAccountMatchStem(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\(\s*(?:\.\.\.)?\s*\d{2,}\s*\)\s*$/, '')
    // Dot-led mask suffixes: "Riverstone Summit Cash ···5093". This is the form a data connection's account
    // label uses (`provider_account_label`), and it reaches the same matcher a CSV value does — so
    // without this a connection account never stem-matches the account it plainly IS. The separator is
    // optional because the dots are their own boundary.
    .replace(/[\s\-_/]*[·•…]+\s*\d{2,}\s*$/, '')
    .replace(/(?:\s+|[-_/])(?:x|xx|xxx|xxxx|\*|[*]{2,}|ending|acct|account)?\s*\d{2,}\s*$/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// The masked digits a source value carries, or ''. The mirror of what `normalizeAccountMatchStem`
// *strips*: the same three suffix shapes, capturing the digits instead of discarding them.
//
// Kept in step with that function by construction — the patterns are the same ones — because a mask the
// stem normalizer removes but this one cannot see would be evidence silently thrown away, and a mask
// this one reads but the normalizer leaves in the stem would poison the name match instead.
export function extractAccountMask(value) {
  const text = String(value || '').trim()
  for (const pattern of [
    /\(\s*(?:\.\.\.)?\s*(\d{2,})\s*\)\s*$/,
    /[\s\-_/]*[·•…]+\s*(\d{2,})\s*$/,
    /(?:\s+|[-_/])(?:x|xx|xxx|xxxx|\*|[*]{2,}|ending|acct|account)?\s*(\d{2,})\s*$/i,
  ]) {
    const found = text.match(pattern)
    if (found) return found[1]
  }
  return ''
}

// Account-type words that are too generic to anchor a suggestion on their own. They're kept in
// the stem (so "eastern checking" doesn't collapse to "eastern" and match "eastern savings"),
// but a subset match whose overlapping tokens are ALL generic ("Savings (...4455)" ⊂ "xyz
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

// Raw candidates → the distinct group roots among them.
//
// Collapsing onto roots happens here, before any caller counts them, and the reason is that merging
// duplicates a name: a merged child keeps the name it was created with, which is usually the name its
// new parent already has. Counting the two as rival candidates suppressed the suggestion for every
// account that had ever been grouped — the ambiguity guard firing on a group that is, by construction,
// one account. Collapsing first also fixes what the guard let through: a lone child was suggested as
// itself, so accepting the chip pointed the source at a child the picker does not even offer
// (`selectableAccountOptions` lists roots). Both reasons apply just as much to a *list* of possibles as
// they did to a single suggestion — a row offering a child and its own parent as two things to rule out
// is the same defect wearing a different control.
//
// A child is still a candidate on the way in. Grouping does not oblige the root to carry a name that
// matches the source — a card merged under an umbrella account keeps the only name the source would
// ever recognize — so dropping children outright would lose those matches instead of resolving them.
function distinctRootsFrom(candidates, accountsById) {
  const roots = new Map()
  for (const candidate of candidates) {
    const root = effectiveAccountRoot(candidate, accountsById)
    // Keyed by id where there is one, and by the account itself where there is not: only a *child*
    // needs an id here (to find its parent), so requiring one of every candidate would collapse a
    // perfectly good root match to nothing.
    if (root) roots.set(root.id || root, root)
  }
  return [...roots.values()]
}

// The top of an account's merge group. Bounded by a visited set so a corrupt parent loop cannot hang
// the render, and stops at a missing parent rather than discarding the account.
function effectiveAccountRoot(account, accountsById) {
  let current = account
  const seen = new Set()
  while (current?.parent_account_id && !seen.has(current.id)) {
    seen.add(current.id)
    const parent = accountsById.get(current.parent_account_id)
    if (!parent) break
    current = parent
  }
  return current
}

// Every existing account this value could plausibly already be, as group roots, best stage first.
//
// Split out from `findLikelyAccountMatch` because the two questions a mapping row asks are not the same
// question, and one answer cannot serve both. **"Is this the same as *that* account?"** must be
// unambiguous to be worth a one-click accept, so rival candidates have to suppress it. **"Is this any of
// these?"** is a set question that tolerates ambiguity perfectly well — "none of them" is well defined
// over three candidates — and it is the one that matters, because answering it with *New account* is
// what records an `account_pair_distinct` assertion.
//
// Collapsing to a winner served only the first, which left the second with two failures. A tie produced
// **silence** — no suggestion, no chooser, nothing recorded — exactly when the user had the most to rule
// out. And a lone winner had the user assert distinctness from one arbitrarily-selected account while
// its equally-plausible siblings went unmentioned.
//
// Returns `[]` when the value already names an account exactly: that is a match to be *made*, not a
// resemblance to be ruled out, and the exact-match path handles it.
export function findAccountMatchCandidates(accounts, value) {
  const exactMatch = findExactAccountNameMatch(accounts, value)
  if (exactMatch) return []
  const accountsById = new Map((accounts || []).map(account => [account?.id, account]))
  const byName = findNameMatchCandidates(accounts, value, accountsById)
  const seen = new Set(byName.map(account => account?.id))
  // Same masked digits, whatever the names say. A mask is the strongest identifier a bank account has
  // short of its name, and the name is exactly what has already failed by the time this runs — two
  // institutions' exports of the same account routinely disagree about what to call it while agreeing
  // to the digit on which account it is.
  //
  // Shown, never suggested: masks are four digits, so two unrelated real accounts sharing one is
  // ordinary rather than remarkable. That is a fine reason to refuse a one-click accept (see
  // `findLikelyAccountMatch`) and a poor reason to withhold the entry from a list the user opened to
  // decide — where the cost of an extra row is a glance, and the cost of omitting it is the question
  // coming back later as a pile of flagged transactions.
  return [...byName, ...findMaskMatchCandidates(accounts, value, accountsById, seen)]
}

function findNameMatchCandidates(accounts, value, accountsById) {
  const normalized = normalizeAccountMatchStem(value)
  if (!normalized) return []
  // 1. Strong signal: stems are byte-identical after stripping the mask suffix. e.g.,
  //    "Checking (...1234)" and "Checking" both reduce to "checking". The weaker stage does not run
  //    when this one found anything — it cannot add candidates the stronger rule already rejected
  //    without diluting what "possible" means on the row.
  const stemMatches = accounts.filter(account => normalizeAccountMatchStem(getAccountRawMatchName(account)) === normalized)
  if (stemMatches.length) return distinctRootsFrom(stemMatches, accountsById)
  // 2. Fallback: token-subset match in either direction. e.g., csv ["foo", "bar"] is a subset
  //    of an existing account's ["acme", "foo", "bar"]. Require at least one non-generic token
  //    in the subset side so generics like "Savings (...0000)" don't surface every savings
  //    account on the strength of "savings" alone.
  const csvTokens = accountStemTokenSet(value)
  if (!csvTokens.size || !hasNonGenericToken(csvTokens)) return []
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
  return distinctRootsFrom(subsetCandidates, accountsById)
}

function findMaskMatchCandidates(accounts, value, accountsById, exclude) {
  const mask = extractAccountMask(value)
  if (!mask) return []
  const matches = (accounts || []).filter(account => String(account?.mask || '').trim() === mask)
  return distinctRootsFrom(matches, accountsById).filter(account => !exclude.has(account?.id))
}

// The one-click accept's answer: a single unambiguous candidate, or nothing.
//
// Two conditions, and they are different claims. The possible set must hold **exactly one** entry — a
// chip that applies a mapping in one press may only exist where there is one thing it could mean, so
// knowing of a second possibility retires the chip even though it does not retire the first. And that
// entry must be **name evidence**: a shared four-digit mask is worth showing in a list, and is nowhere
// near enough to act on in a single click, since unrelated real accounts share masks routinely.
export function findLikelyAccountMatch(accounts, value) {
  const candidates = findAccountMatchCandidates(accounts, value)
  if (candidates.length !== 1) return null
  const byName = findNameMatchCandidates(accounts, value, new Map((accounts || []).map(a => [a?.id, a])))
  return byName.length === 1 ? candidates[0] : null
}

// Grouping is not carried here: it is applied to the created account (`parent_account_id`) at import
// time and is durable on the account, so a resumed draft recovers it from the account rather than from
// a snapshot. The snapshot's former `account_duplicate_compare` key belonged to the removed
// compare-only mapping choice and is gone with it.
export function buildAccountImportStateSnapshot(accountMap) {
  const accountAssignments = {}
  const accountNew = {}
  const skipAccounts = []

  for (const [csvVal, mapping] of Object.entries(accountMap || {})) {
    if (mapping?.skip) {
      skipAccounts.push(csvVal)
    } else if (mapping?.createNew && mapping?.newName?.trim()) {
      accountNew[csvVal] = {
        name: mapping.newName.trim(),
        type: mapping.newType || '',
      }
    } else if (mapping?.accountId) {
      accountAssignments[csvVal] = mapping.accountId
    }
  }

  return {
    account_map: accountAssignments,
    skip_accounts: skipAccounts,
    account_new: accountNew,
  }
}
