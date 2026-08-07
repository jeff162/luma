// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// Pure state translation for the connection account-mapping grid — the counterpart to
// `importExport/importAccountMatching.js`, and separated from the dialog for the same reason: the
// translation is where a bug would silently change a user's mapping, so it should be testable without
// rendering anything.
//
// The grid asks the CSV import's question ("which account?", with grouping as a refinement), while the
// backend stores one of four named modes (`new`/`existing`/`group`/`skip`). These two functions are
// that translation, and they must **round-trip**: reopening the dialog and saving
// without touching anything has to reproduce the mapping already in force. Otherwise adjusting one
// account would quietly restate the others — and since a mapping change triggers a duplicate re-scan,
// a spurious restatement is not free.

import { findLikelyAccountMatch, guessNewAccountTypeFromName } from './importExport/importAccountMatching.js'

// The row state is the CSV grid's, field for field, so the two stay comparable and the eventual shared
// extraction is mechanical (see docs/shared-components.md → watchlist). The backend's mapping mode is
// *derived* from this at save time rather than being what the user picks.
export function defaultConnectionMapEntry(sourceLabel) {
  return {
    accountId: '',
    createNew: false,
    newName: sourceLabel,
    newType: '',
    groupWithAccountId: '',
    skip: false,
    // The account this mapping has ALREADY produced, if it has run before. Nothing the CSV grid needs
    // — a file's mapping is applied once — but a connection's is revisited, and a name/type editor for
    // an account that already exists would offer edits the mapping call ignores.
    materializedAccountId: '',
    suggestion: null,
  }
}

// Row state → the mode the backend stores. `null` means undecided, which is a real state: an account
// nobody has ruled on is left alone rather than defaulted into existence.
export function entryToMapping(entry) {
  if (!entry) return null
  // Checked first and unconditionally: the checkbox clears the other fields on toggle, but the
  // derivation must not depend on that having happened. A stale field must never turn a skip into an
  // import.
  if (entry.skip) return { mode: 'skip', target_account_id: null }
  if (entry.createNew) {
    const shared = { name: entry.newName, type: entry.newType || null }
    if (entry.groupWithAccountId) {
      return { mode: 'group', target_account_id: entry.groupWithAccountId, ...shared }
    }
    return { mode: 'new', target_account_id: null, ...shared }
  }
  // No name/type: the account already exists with a name the user may have set deliberately, and a
  // mapping must not rename it.
  if (entry.accountId) return { mode: 'existing', target_account_id: entry.accountId }
  return null
}

// The stored mapping → row state, so reopening shows the decision that is in force rather than a blank
// form. 'group' comes back as a create-new row because that is what it is; the account it already
// created is remembered so the row can show it instead of an inert name editor.
export function entryFromProviderAccount(pa, selectableAccounts) {
  const entry = defaultConnectionMapEntry(pa.source_label)
  entry.newName = pa.account_name || pa.provider_name || pa.source_label
  entry.newType = pa.provider_type || guessNewAccountTypeFromName(pa.source_label) || ''
  entry.materializedAccountId = pa.account_id || ''
  switch (pa.mapping_mode) {
    case 'existing':
      entry.accountId = pa.account_id || pa.target_account_id || ''
      break
    case 'group':
      entry.createNew = true
      entry.groupWithAccountId = pa.target_account_id || ''
      break
    case 'new':
      entry.createNew = true
      break
    case 'skip':
      entry.skip = true
      break
    default:
      // Undecided: offer the suggestion as a one-click chip, never silently apply it. A decided
      // account is deliberately not re-suggested — the chip is a prompt to decide, and re-offering it
      // would invite undoing a choice by reflex on every reopen.
      entry.suggestion = findLikelyAccountMatch(selectableAccounts, pa.source_label)
  }
  return entry
}
