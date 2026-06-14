// Resolving a CSV account-column value to an existing account drives the import account-mapping UI.
// The core invariant (collaboration-notes "Import / Export"): suggest only when there's exactly one
// strong match, otherwise leave it to the user — never silently guess. These pin the judgment-heavy
// parts: the masked-suffix stem normalizer, the single-vs-ambiguous match rule, the generic-token
// guard that stops "Savings (...7304)" matching every savings account, and the snapshot builder that
// flattens the mapping UI into the persisted account_map / skip_accounts / account_new payload.

import { describe, it, expect } from 'vitest'
import {
  guessNewAccountTypeFromName,
  findExactAccountNameMatch,
  normalizeAccountMatchStem,
  findLikelyAccountMatch,
  buildAccountImportStateSnapshot,
} from '../importAccountMatching.js'

const acc = name => ({ name })

describe('normalizeAccountMatchStem', () => {
  it('strips masked-suffix noise down to the identifying stem', () => {
    expect(normalizeAccountMatchStem('Checking (...1234)')).toBe('checking')
    expect(normalizeAccountMatchStem('Visa ****5678')).toBe('visa')
    expect(normalizeAccountMatchStem('Rewards Card x1234')).toBe('rewards card')
  })
})

describe('findExactAccountNameMatch', () => {
  it('matches on raw name case-insensitively after trimming ends, ignoring display_name', () => {
    // Only ends are trimmed + lowercased here (no internal-whitespace collapse — that's the stem
    // normalizer's job); matching is against raw `name`, never the display_name.
    const accounts = [{ name: 'Primary Checking', display_name: 'Joint' }]
    expect(findExactAccountNameMatch(accounts, '  primary checking ')).toBe(accounts[0])
    expect(findExactAccountNameMatch(accounts, 'Joint')).toBeNull()
  })
})

describe('findLikelyAccountMatch', () => {
  it('suppresses a suggestion when the value already exactly matches an account', () => {
    // An exact match is handled directly, so there is nothing to *suggest*.
    expect(findLikelyAccountMatch([acc('Checking')], 'Checking')).toBeNull()
  })

  it('suggests the lone account whose stem matches after stripping the mask suffix', () => {
    const accounts = [acc('Checking')]
    expect(findLikelyAccountMatch(accounts, 'Checking (...1234)')).toBe(accounts[0])
  })

  it('declines when two accounts share the same stem (ambiguous)', () => {
    const accounts = [acc('Checking (...1)'), acc('Checking (...2)')]
    expect(findLikelyAccountMatch(accounts, 'Checking')).toBeNull()
  })

  it('suggests via a non-generic token subset when exactly one account contains it', () => {
    const accounts = [acc('Rewards Card x1234'), acc('Travel Card x5678')]
    expect(findLikelyAccountMatch(accounts, 'Rewards')).toBe(accounts[0])
  })

  it('refuses to match on a generic account-type token alone', () => {
    // "Savings (...7304)" stems to just the generic word "savings"; surfacing every savings
    // account on that signal is exactly what the generic-token guard prevents.
    const accounts = [acc('Eastern Savings'), acc('Western Savings')]
    expect(findLikelyAccountMatch(accounts, 'Savings (...7304)')).toBeNull()
  })

  it('declines when a non-generic subset is ambiguous across accounts', () => {
    const accounts = [acc('Acme Brokerage'), acc('Acme Trust')]
    expect(findLikelyAccountMatch(accounts, 'Acme')).toBeNull()
  })
})

describe('guessNewAccountTypeFromName', () => {
  it('infers an account type from name keywords, blank when unknown', () => {
    expect(guessNewAccountTypeFromName('My Credit Card')).toBe('credit')
    expect(guessNewAccountTypeFromName('Primary Checking')).toBe('depository')
    expect(guessNewAccountTypeFromName('Emergency Savings')).toBe('savings')
    expect(guessNewAccountTypeFromName('paypal')).toBe('p2p')
    expect(guessNewAccountTypeFromName('Brokerage')).toBe('investment')
    expect(guessNewAccountTypeFromName('Mystery')).toBe('')
  })
})

describe('buildAccountImportStateSnapshot', () => {
  it('routes each mapping into the right payload bucket', () => {
    const snapshot = buildAccountImportStateSnapshot({
      'CSV-A': { accountId: 'acc1' },
      'CSV-B': { skip: true },
      'CSV-C': { createNew: true, newName: '  New Checking  ', newType: 'depository', duplicateCompareTargetAccountId: 'acc9' },
      'CSV-D': { createNew: true, newName: '' }, // no name → contributes nothing
    })
    expect(snapshot.account_map).toEqual({ 'CSV-A': 'acc1' })
    expect(snapshot.skip_accounts).toEqual(['CSV-B'])
    expect(snapshot.account_new).toEqual({ 'CSV-C': { name: 'New Checking', type: 'depository' } })
    expect(snapshot.account_duplicate_compare).toEqual({ 'CSV-C': 'acc9' })
  })

  it('omits account_duplicate_compare entirely when no compare target was set', () => {
    const snapshot = buildAccountImportStateSnapshot({ 'CSV-A': { accountId: 'acc1' } })
    expect(snapshot).not.toHaveProperty('account_duplicate_compare')
  })

  it('returns a blank snapshot for empty/missing input', () => {
    expect(buildAccountImportStateSnapshot(undefined)).toEqual({ account_map: {}, skip_accounts: [], account_new: {} })
  })
})
