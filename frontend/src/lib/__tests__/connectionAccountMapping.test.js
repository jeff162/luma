/**
 * The connection mapping grid's state ↔ mode translation.
 *
 * The dialog asks the CSV grid's question — "which account?", with the relationship as a refinement —
 * while the backend stores one of five named modes. That translation is the only real logic in the
 * component, and it has to round-trip: reopening the dialog and saving without touching anything must
 * produce the mapping already in force. If it didn't, adjusting one account would quietly restate the
 * others, and since a mapping change triggers a duplicate re-scan, a spurious restatement is not free.
 */

import { describe, it, expect } from 'vitest'
import {
  entryFromProviderAccount,
  entryToMapping,
} from '../connectionAccountMapping.js'

const ACCOUNTS = [
  { id: 'acct-csv', name: 'Northgate Voyager', type: 'credit', mask: '4103' },
  { id: 'acct-new', name: 'Riverstone Summit Cash', type: 'credit', mask: '5093' },
]

// The bank's own label for an account the user already holds — the shape `provider_account_label`
// produces, and the case the suggestion exists for.
const providerAccount = (over = {}) => ({
  external_account_id: 'ext-1',
  source_label: 'Northgate Voyager ···4103',
  provider_name: 'Northgate Voyager',
  provider_type: 'credit',
  account_name: null,
  account_id: null,
  mapping_mode: null,
  target_account_id: null,
  ...over,
})

const roundTrip = pa => entryToMapping(entryFromProviderAccount(pa, ACCOUNTS))

describe('stored mapping → row state → stored mapping', () => {
  it('round-trips an existing-account mapping', () => {
    expect(roundTrip(providerAccount({
      mapping_mode: 'existing', account_id: 'acct-csv', target_account_id: 'acct-csv',
    }))).toEqual({ mode: 'existing', target_account_id: 'acct-csv' })
  })

  it('round-trips a grouped mapping, keeping the parent', () => {
    const out = roundTrip(providerAccount({
      mapping_mode: 'group', account_id: 'acct-new', target_account_id: 'acct-csv',
    }))
    expect(out.mode).toBe('group')
    expect(out.target_account_id).toBe('acct-csv')
  })

  it('reads a stored compare mapping as undecided rather than reinterpreting it', () => {
    // The mode was removed and no database is believed to hold one, but if a row did, the honest
    // handling is to show it as a decision waiting to be made — silently converting it to `group` or
    // `existing` would change what the ladder may conclude without the user having said anything.
    const pa = providerAccount({
      mapping_mode: 'compare', account_id: 'acct-new', target_account_id: 'acct-csv',
    })
    expect(roundTrip(pa)).toBeNull()
    expect(entryFromProviderAccount(pa, ACCOUNTS).suggestion?.id).toBe('acct-csv')
  })

  it('round-trips a plain new account with no relationship', () => {
    const out = roundTrip(providerAccount({ mapping_mode: 'new', account_id: 'acct-new' }))
    expect(out.mode).toBe('new')
    expect(out.target_account_id).toBeNull()
  })

  it('round-trips skip', () => {
    expect(roundTrip(providerAccount({ mapping_mode: 'skip' })))
      .toEqual({ mode: 'skip', target_account_id: null })
  })
})

describe('the undecided state is preserved, not defaulted', () => {
  it('an unmapped account produces no mapping at all', () => {
    // Not 'new'. An account nobody has ruled on must be left alone — defaulting it into existence is
    // exactly the behavior the mapping step was added to remove.
    expect(roundTrip(providerAccount())).toBeNull()
  })

  it('an unmapped account gets a suggestion offered, but not applied', () => {
    const entry = entryFromProviderAccount(providerAccount(), ACCOUNTS)
    expect(entry.suggestion?.id).toBe('acct-csv')
    expect(entry.accountId).toBe('')
    expect(entry.createNew).toBe(false)
    expect(entryToMapping(entry)).toBeNull()
  })

  it('an already-decided account is not re-suggested', () => {
    // The chip is a prompt to decide. Once decided, re-offering it would invite undoing a choice by
    // reflex on every reopen.
    const entry = entryFromProviderAccount(
      providerAccount({ mapping_mode: 'existing', account_id: 'acct-csv' }), ACCOUNTS,
    )
    expect(entry.suggestion).toBeNull()
  })
})

describe('grouping wins over a bare new account', () => {
  it('group takes precedence when a parent is set', () => {
    expect(entryToMapping({
      createNew: true, newName: 'X', groupWithAccountId: 'acct-csv',
    }).mode).toBe('group')
  })

  it('a compare target is not a mode any more', () => {
    // The compare-only choice was removed: it asserted two accounts were the same physical account
    // while deliberately keeping them apart, which nothing else in the app can express. A leftover
    // field from a stale draft must fall through to a plain new account, never resurrect the mode.
    expect(entryToMapping({
      createNew: true, newName: 'X', duplicateCompareTargetAccountId: 'acct-csv',
    }).mode).toBe('new')
  })

  it('skip beats every other field', () => {
    // The checkbox clears the rest on toggle, but the derivation must not depend on that having
    // happened — a stale field left behind must never turn a skip into an import.
    expect(entryToMapping({
      skip: true, accountId: 'acct-csv', createNew: true, groupWithAccountId: 'acct-csv',
    })).toEqual({ mode: 'skip', target_account_id: null })
  })
})

describe('what a created account carries', () => {
  it('sends the name and type for an account it is creating', () => {
    const out = entryToMapping({ createNew: true, newName: 'Riverstone Summit Cash', newType: 'credit' })
    expect(out).toMatchObject({ mode: 'new', name: 'Riverstone Summit Cash', type: 'credit' })
  })

  it('sends a null type rather than an empty string when none was chosen', () => {
    expect(entryToMapping({ createNew: true, newName: 'X', newType: '' }).type).toBeNull()
  })

  it('sends no name or type when adopting an existing account', () => {
    // The account already has a name the user may have set deliberately; a mapping must not rename it.
    const out = entryToMapping({ accountId: 'acct-csv', newName: 'CREDIT CARD', newType: 'credit' })
    expect(out).toEqual({ mode: 'existing', target_account_id: 'acct-csv' })
  })
})

describe('a mapping whose account has since been merged into a group', () => {
  // The reported failure: mapping a provider account onto a local one and later merging that account
  // into a group left the connection card claiming "No accounts imported yet" and the dialog drawing a
  // live mapping as "— Select —". The mapping was never lost; the surfaces were handed a root-only
  // account list, so the child the mapping points at was missing from both. These pin the two halves.

  const MERGED_CHILD = { id: 'acct-child', name: 'CREDIT CARD', type: 'credit', mask: '4102',
                         display_name: 'Rewards Card', parent_account_id: 'acct-parent' }
  const GROUP_ROOT = { id: 'acct-parent', name: 'Rewards Card', type: 'credit',
                       display_name: 'Rewards Card' }
  const WITH_CHILDREN = [...ACCOUNTS, MERGED_CHILD, GROUP_ROOT]

  const mergedMapping = providerAccount({
    external_account_id: 'ext-4102', source_label: 'CREDIT CARD ···4102',
    mapping_mode: 'existing', account_id: 'acct-child', target_account_id: 'acct-child',
  })

  it('still round-trips when the picker can list the child', () => {
    expect(entryToMapping(entryFromProviderAccount(mergedMapping, WITH_CHILDREN)))
      .toEqual({ mode: 'existing', target_account_id: 'acct-child' })
  })

  it('keeps the account id even when the list omits the child, so a blind save cannot clear it', () => {
    // The translation must not depend on the child being present. `selectableAccountOptions` puts it
    // back for the picker, but this layer holding the id regardless is the second line of defence:
    // it is what kept an untouched save from silently re-pointing the mapping while the select was
    // rendering "— Select —".
    const entry = entryFromProviderAccount(mergedMapping, ACCOUNTS)
    expect(entry.accountId).toBe('acct-child')
    expect(entryToMapping(entry)).toEqual({ mode: 'existing', target_account_id: 'acct-child' })
  })

  it('is not treated as undecided, so no suggestion is offered over it', () => {
    expect(entryFromProviderAccount(mergedMapping, WITH_CHILDREN).suggestion).toBeNull()
  })
})

describe('reopening a mapping that already created its account', () => {
  it('remembers the account so the row can show it instead of an inert name editor', () => {
    const entry = entryFromProviderAccount(providerAccount({
      mapping_mode: 'group', account_id: 'acct-new', target_account_id: 'acct-csv',
      account_name: 'Riverstone Summit Cash',
    }), ACCOUNTS)
    expect(entry.materializedAccountId).toBe('acct-new')
    expect(entry.createNew).toBe(true)
  })

  it('has nothing to remember for an account never created', () => {
    expect(entryFromProviderAccount(providerAccount(), ACCOUNTS).materializedAccountId).toBe('')
  })
})
