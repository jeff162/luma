// Resolving a CSV account-column value to an existing account drives the import account-mapping UI.
// The core invariant (collaboration-notes.md → Decision-Making Principles): suggest only when there's
// exactly one strong match, otherwise leave it to the user — never silently guess. These pin the judgment-heavy
// parts: the masked-suffix stem normalizer, the single-vs-ambiguous match rule, the generic-token
// guard that stops "Savings (...4455)" matching every savings account, and the snapshot builder that
// flattens the mapping UI into the persisted account_map / skip_accounts / account_new payload.

import { describe, it, expect } from 'vitest'
import {
  guessNewAccountTypeFromName,
  findExactAccountNameMatch,
  getAccountOptionLabel,
  normalizeAccountMatchStem,
  extractAccountMask,
  findAccountMatchCandidates,
  findLikelyAccountMatch,
  selectableAccountOptions,
  buildAccountImportStateSnapshot,
  sourceAccountMapToEntries,
  entriesToSourceAccountMap,
  accountMappingProblem,
  newMappedAccountsFromEntries,
} from '../importAccountMatching.js'

const acc = name => ({ name })

describe('normalizeAccountMatchStem', () => {
  it('strips masked-suffix noise down to the identifying stem', () => {
    expect(normalizeAccountMatchStem('Checking (...1234)')).toBe('checking')
    expect(normalizeAccountMatchStem('Visa ****5678')).toBe('visa')
    expect(normalizeAccountMatchStem('Rewards Card x1234')).toBe('rewards card')
  })

  it('strips the dot-led mask a data connection labels its accounts with', () => {
    // `provider_account_label` renders "{provider name} ···{mask}", and that string reaches this same
    // matcher. Before this it stemmed to "riverstone summit cash 5093" and matched nothing.
    expect(normalizeAccountMatchStem('Riverstone Summit Cash ···5093')).toBe('riverstone summit cash')
    expect(normalizeAccountMatchStem('CREDIT CARD ···4103')).toBe('credit card')
    expect(normalizeAccountMatchStem('Checking•••1111')).toBe('checking')
    expect(normalizeAccountMatchStem('Savings …4455')).toBe('savings')
  })

  it('leaves a number that is part of the name alone', () => {
    // The suffix has to be mask-shaped. "Account 2" is a name, not a masked account.
    expect(normalizeAccountMatchStem('Riverstone ··· Summit Cash')).toBe('riverstone summit cash')
    expect(normalizeAccountMatchStem('401k')).toBe('401k')
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

describe('findAccountMatchCandidates', () => {
  // The set behind the suggestion. `findLikelyAccountMatch` collapses this to one-or-nothing for the
  // one-click chip; the mapping row renders the whole thing, because "is this any of these?" is a
  // perfectly answerable question when the chip's "is it *that* one?" is not.
  it('returns every rival where the single-match rule returns nothing', () => {
    const accounts = [acc('Eastern Checking'), acc('Eastern Checking')]
    expect(findLikelyAccountMatch(accounts, 'Eastern Checking (...1234)')).toBeNull()
    expect(findAccountMatchCandidates(accounts, 'Eastern Checking (...1234)')).toHaveLength(2)
  })

  it('agrees with the single-match rule when there is exactly one', () => {
    const accounts = [acc('Eastern Checking'), acc('Western Savings')]
    expect(findAccountMatchCandidates(accounts, 'Eastern Checking (...1234)')).toEqual([accounts[0]])
    expect(findLikelyAccountMatch(accounts, 'Eastern Checking (...1234)')).toBe(accounts[0])
  })

  it('lists a closed account as possible but never offers it in one click', () => {
    const accounts = [{ ...acc('Eastern Checking'), closed_on: '2026-03-31' }, acc('Western Savings')]
    expect(findAccountMatchCandidates(accounts, 'Eastern Checking (...1234)')).toEqual([accounts[0]])
    expect(findLikelyAccountMatch(accounts, 'Eastern Checking (...1234)')).toBeNull()
  })

  it('still yields nothing where there was nothing to suggest', () => {
    // An exact match is a mapping to be MADE, not a resemblance to rule out; and the generic-token
    // guard has to hold for the list too, or every savings account becomes something to assert about.
    expect(findAccountMatchCandidates([acc('Checking')], 'Checking')).toEqual([])
    expect(findAccountMatchCandidates([acc('Acme Savings')], 'Savings (...4455)')).toEqual([])
    expect(findAccountMatchCandidates([acc('Eastern Checking')], '')).toEqual([])
  })

  it('collapses a merge group to one candidate rather than offering parent and child', () => {
    // Same reason the single-match rule collapses first: a merged child usually carries its parent's
    // name, so counting both would put two entries in the list that are one account.
    const accounts = [
      { id: 'root-cash', name: 'Harborline Cash' },
      { id: 'child-cash', name: 'Harborline Cash', parent_account_id: 'root-cash' },
    ]
    expect(findAccountMatchCandidates(accounts, 'Harborline Cash (5093)').map(a => a.id)).toEqual(['root-cash'])
  })
})

describe('extractAccountMask', () => {
  it('reads back exactly the suffixes the stem normalizer strips', () => {
    expect(extractAccountMask('Checking (...1234)')).toBe('1234')
    expect(extractAccountMask('Visa ****5678')).toBe('5678')
    expect(extractAccountMask('Rewards Card x1234')).toBe('1234')
    expect(extractAccountMask('Riverstone Summit Cash ···5093')).toBe('5093')
    expect(extractAccountMask('Savings …4455')).toBe('4455')
  })

  it('finds no mask where the digits are part of the name', () => {
    // The same restraint the normalizer shows, for the same reason: "401k" is a name and "Checking2"
    // is a name. Reading either as a mask would make every account sharing that digit a possible match.
    expect(extractAccountMask('401k')).toBe('')
    expect(extractAccountMask('Harborline Checking2')).toBe('')
    expect(extractAccountMask('Everyday Account')).toBe('')
  })
})

describe('a shared mask is possible, but never one-click', () => {
  // The gap this closes, in the shape that exposed it: a second data source delivering the same real
  // account under a name the matcher cannot connect ("Harborline Checking" vs "Harborline Checking2"), agreeing
  // only on the masked digits. The name rule never proposed it, so declining the *name* match asserted
  // nothing about it, and every transaction the two shared came back as a cross-account flag.
  const BY_MASK = [
    { id: 'a-name', name: 'Harborline Checking', mask: '6120' },
    { id: 'a-mask', name: 'Harborline Checking2', mask: '6120' },
    { id: 'a-other', name: 'Harborline Saving', mask: '7204' },
  ]

  it('offers both the name match and the mask-only match', () => {
    expect(findAccountMatchCandidates(BY_MASK, 'Harborline Checking ···6120').map(a => a.id))
      .toEqual(['a-name', 'a-mask'])
  })

  it('retires the one-click chip once a second possibility is known', () => {
    // The name evidence did not get weaker — but a chip claiming "this is that one" cannot stand while
    // the row is simultaneously showing something else it might be.
    expect(findLikelyAccountMatch(BY_MASK, 'Harborline Checking ···6120')).toBeNull()
  })

  it('never offers one-click on mask evidence alone', () => {
    // Four digits shared between unrelated real accounts is ordinary. Worth a row in an opened list,
    // never worth a press that maps the account.
    const accounts = [{ id: 'a-mask', name: 'Something Unrelated', mask: '6120' }]
    expect(findAccountMatchCandidates(accounts, 'Harborline Checking ···6120').map(a => a.id)).toEqual(['a-mask'])
    expect(findLikelyAccountMatch(accounts, 'Harborline Checking ···6120')).toBeNull()
  })

  it('keeps the one-click chip when the name match is the only possibility', () => {
    // The widening must not cost the common case its one-click path.
    const accounts = [{ id: 'a-name', name: 'Harborline Checking', mask: '6120' }]
    expect(findLikelyAccountMatch(accounts, 'Harborline Checking ···6120')?.id).toBe('a-name')
  })

  it('lists an account only once when it matches on both name and mask', () => {
    const accounts = [{ id: 'a-name', name: 'Harborline Checking', mask: '6120' }, { id: 'a-x', name: 'Zzz' }]
    expect(findAccountMatchCandidates(accounts, 'Harborline Checking ···6120').map(a => a.id)).toEqual(['a-name'])
  })

  it('stays silent when the value already names an account exactly', () => {
    // An exact name match is a mapping to be made. Hoisting mask look-alikes next to it would turn a
    // settled question back into an open one.
    const accounts = [{ id: 'a', name: 'Harborline Checking', mask: '6120' }, { id: 'b', name: 'Other', mask: '6120' }]
    expect(findAccountMatchCandidates(accounts, 'Harborline Checking')).toEqual([])
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

  it('suggests the account a connection label plainly names', () => {
    // The case from the connection mapping step: the bank calls it "Riverstone Summit Cash ···5093" and the
    // user already has "Riverstone Summit Cash". Both mask forms have to reduce to the same stem for this to
    // land, which is the whole point of normalizing before comparing.
    const accounts = [acc('Riverstone Summit Cash'), acc('Northgate Voyager')]
    expect(findLikelyAccountMatch(accounts, 'Riverstone Summit Cash ···5093')).toBe(accounts[0])
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
    // "Savings (...4455)" stems to just the generic word "savings"; surfacing every savings
    // account on that signal is exactly what the generic-token guard prevents.
    const accounts = [acc('Eastern Savings'), acc('Western Savings')]
    expect(findLikelyAccountMatch(accounts, 'Savings (...4455)')).toBeNull()
  })

  it('declines when a non-generic subset is ambiguous across accounts', () => {
    const accounts = [acc('Acme Brokerage'), acc('Acme Trust')]
    expect(findLikelyAccountMatch(accounts, 'Acme')).toBeNull()
  })
})

describe('findLikelyAccountMatch across merged accounts', () => {
  // Where this matcher fails *silently*: a suppressed suggestion raises nothing, it just leaves a row
  // looking as though Luma holds no such account. Merging is what provokes it — the child keeps the
  // name it was created with, which is usually the name its new parent already has, so before
  // candidates were collapsed onto their group roots every account that had ever been grouped counted
  // as two rivals and the ambiguity guard threw both away.

  it('suggests the group root when a merged child shares its name', () => {
    const accounts = [
      { id: 'root-cash', name: 'Harborline Cash Card', mask: '5093' },
      { id: 'child-cash', name: 'Harborline Cash Card', parent_account_id: 'root-cash' },
    ]
    expect(findLikelyAccountMatch(accounts, 'Harborline Cash (5093)')?.id).toBe('root-cash')
  })

  it('suggests the root when only the merged child carries a matching name', () => {
    // Children stay candidates on the way in. Grouping does not oblige the root to keep a name any
    // data source would recognize — an umbrella account named for the group holds children named for
    // the real cards — so the child is what matches and the root is what the mapping points at.
    const accounts = [
      { id: 'root-umbrella', name: 'Legacy Card' },
      { id: 'child-rewards', name: 'Riverstone Rewards', parent_account_id: 'root-umbrella' },
    ]
    expect(findLikelyAccountMatch(accounts, 'Riverstone Rewards ···4103')?.id).toBe('root-umbrella')
  })

  it('still declines when candidates belong to different groups', () => {
    const accounts = [
      { id: 'root-first', name: 'Riverstone Checking', mask: '7204' },
      { id: 'child-first', name: 'Riverstone Checking', parent_account_id: 'root-first' },
      { id: 'root-second', name: 'Riverstone Checking', mask: '2222' },
    ]
    expect(findLikelyAccountMatch(accounts, 'Riverstone Checking (1111)')).toBeNull()
  })

  it('survives a parent chain that points at itself', () => {
    // Corrupt data must not hang the render the suggestion is computed during.
    const accounts = [{ id: 'loop', name: 'Riverstone Rewards', parent_account_id: 'loop' }]
    expect(findLikelyAccountMatch(accounts, 'Riverstone Rewards ···4103')?.id).toBe('loop')
  })
})

describe('selectableAccountOptions', () => {
  // A mapping picker offers roots, because merging never moves the mappings pointing at an account:
  // omit the child a mapping is on and the picker renders a live decision as an empty control, invite
  // the "fix", and silently re-point the source. Offer every child instead and the list doubles with
  // entries indistinguishable from their own parents.
  const ROOT_A = { id: 'root-a', name: 'Rewards Card' }
  const ROOT_B = { id: 'root-b', name: 'Northgate Voyager' }
  const CHILD = { id: 'child', name: 'CREDIT CARD', mask: '4102', parent_account_id: 'root-a' }
  const OTHER_CHILD = { id: 'child-2', name: 'CREDIT CARD', mask: '4103', parent_account_id: 'root-b' }
  const ALL = [ROOT_A, ROOT_B, CHILD, OTHER_CHILD]

  it('offers roots only when nothing is selected', () => {
    expect(selectableAccountOptions(ALL).map(a => a.id)).toEqual(['root-a', 'root-b'])
    expect(selectableAccountOptions(ALL, '').map(a => a.id)).toEqual(['root-a', 'root-b'])
  })

  it('offers roots only when the selection is already a root', () => {
    expect(selectableAccountOptions(ALL, 'root-b').map(a => a.id)).toEqual(['root-a', 'root-b'])
  })

  it('carries the selected merged child, and only that one', () => {
    // The reported bug in one assertion: without this the stored id matches no option.
    expect(selectableAccountOptions(ALL, 'child').map(a => a.id)).toEqual(['root-a', 'root-b', 'child'])
  })

  it('does not invent an option for an id that is not an account at all', () => {
    // A mapping pointing at a deleted account must not add a blank row to the list.
    expect(selectableAccountOptions(ALL, 'gone').map(a => a.id)).toEqual(['root-a', 'root-b'])
  })

  it('tolerates an absent list', () => {
    expect(selectableAccountOptions(null, 'child')).toEqual([])
  })

  it('still offers a closed account, after the open ones and marked', () => {
    // Older statements of a closed account still belong on it.
    const closed = { ...ROOT_A, closed_on: '2026-03-31' }
    const options = selectableAccountOptions([closed, ROOT_B, CHILD])
    expect(options.map(a => a.id)).toEqual(['root-b', 'root-a'])
    expect(getAccountOptionLabel(options[1])).toBe('Rewards Card (closed)')
  })
})

describe('getAccountOptionLabel', () => {
  // Account pickers list merged children (a mapping made before a merge still points at one), and a
  // child routinely carries the same name as the group it was merged into. Without the group suffix
  // the list shows two identical options and the user cannot tell which one a mapping is on.
  const parent = { id: 'p', name: 'PayPal', display_name: 'PayPal' }
  const child = { id: 'c', name: 'PayPal', parent_account_id: 'p' }
  const byId = new Map([['p', parent]])

  it('leaves a root account as its plain name and mask', () => {
    expect(getAccountOptionLabel({ name: 'Riverstone Summit Cash', mask: '5093' })).toBe('Riverstone Summit Cash ···5093')
  })

  it('names the group a merged child sits in', () => {
    expect(getAccountOptionLabel(child, byId)).toBe('PayPal — in PayPal')
  })

  it('falls back to the bare name when the group is not in the list', () => {
    // A partial list must still render something selectable rather than a dangling "— in".
    expect(getAccountOptionLabel(child, new Map())).toBe('PayPal')
    expect(getAccountOptionLabel(child)).toBe('PayPal')
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
      'CSV-C': { createNew: true, newName: '  New Checking  ', newType: 'depository' },
      'CSV-D': { createNew: true, newName: '' }, // no name → contributes nothing
    })
    expect(snapshot.account_map).toEqual({ 'CSV-A': 'acc1' })
    expect(snapshot.skip_accounts).toEqual(['CSV-B'])
    expect(snapshot.account_new).toEqual({ 'CSV-C': { name: 'New Checking', type: 'depository' } })
  })

  it('carries no compare-target bucket at all', () => {
    // The compare-only mapping choice was removed, so the snapshot key it fed is gone with it.
    // Grouping isn't here either — it lives on the created account (`parent_account_id`), which is
    // durable, so a resumed draft recovers it from the account rather than from a snapshot.
    const snapshot = buildAccountImportStateSnapshot({
      'CSV-A': { createNew: true, newName: 'New Checking', groupWithAccountId: 'acc9' },
    })
    expect(snapshot).not.toHaveProperty('account_duplicate_compare')
    expect(Object.keys(snapshot).sort()).toEqual(['account_map', 'account_new', 'skip_accounts'])
  })

  it('returns a blank snapshot for empty/missing input', () => {
    expect(buildAccountImportStateSnapshot(undefined)).toEqual({ account_map: {}, skip_accounts: [], account_new: {} })
  })
})

describe('a data source\'s saved account map in the editor', () => {
  const accounts = [{ id: 'a1', name: 'Everyday Checking' }, { id: 'a2', name: 'Harborline Card' }]
  const saved = {
    account_assignments: { 'CHK': 'a1', 'Old Card': 'gone' },
    account_skips: ['Brokerage', 'Annex'],
    account_new: { 'NEW-1': { name: 'Tidewater Savings', type: 'savings' } },
  }

  it('writes back exactly what it read when nothing changes', () => {
    // An assignment to a removed account and a pending new account are both carried, not resolved:
    // opening the editor and saving must not restate the map.
    const roundTrip = entriesToSourceAccountMap(sourceAccountMapToEntries(saved, accounts))
    expect(roundTrip).toEqual({ ...saved, account_skips: ['Annex', 'Brokerage'] })
  })

  it('reads a pending new account as the account once one of that name exists', () => {
    const entries = sourceAccountMapToEntries(
      { account_new: { 'CARD': { name: 'Harborline Card', type: 'credit' } } },
      accounts,
    )
    expect(entriesToSourceAccountMap(entries)).toEqual({ account_assignments: { CARD: 'a2' } })
  })

  it('writes a re-pointed, skipped or forgotten value', () => {
    const entries = sourceAccountMapToEntries(saved, accounts)
    entries.CHK = { ...entries.CHK, accountId: 'a2' }
    entries['NEW-1'] = { ...entries['NEW-1'], skip: true }
    delete entries['Old Card']
    delete entries.Brokerage
    delete entries.Annex
    expect(entriesToSourceAccountMap(entries)).toEqual({
      account_assignments: { CHK: 'a2' },
      account_skips: ['NEW-1'],
    })
  })
})

describe('accountMappingProblem', () => {
  const accounts = [{ id: 'a1', name: 'Everyday Checking' }]

  it('accepts a skip, an existing account, or a complete new account', () => {
    expect(accountMappingProblem({ skip: true }, accounts)).toBeNull()
    expect(accountMappingProblem({ accountId: 'a1' }, accounts)).toBeNull()
    expect(accountMappingProblem({ createNew: true, newName: 'Tidewater', newType: 'savings' }, accounts)).toBeNull()
  })

  it('names what a row still lacks', () => {
    expect(accountMappingProblem(undefined, accounts)).toBe('unmapped')
    expect(accountMappingProblem({ accountId: '', missingAccountId: 'gone' }, accounts)).toBe('unmapped')
    expect(accountMappingProblem({ createNew: true, newName: ' ', newType: 'savings' }, accounts)).toBe('new_name')
    expect(accountMappingProblem({ createNew: true, newName: 'Tidewater', newType: '' }, accounts)).toBe('new_type')
    expect(accountMappingProblem({ createNew: true, newName: 'everyday checking', newType: 'depository' }, accounts))
      .toBe('new_name_taken')
  })
})

describe('newMappedAccountsFromEntries', () => {
  it('sends each unskipped new account with what the chooser decided about it', () => {
    expect(newMappedAccountsFromEntries({
      SAV: { createNew: true, newName: ' Tidewater ', newType: 'savings', groupWithAccountId: 'a1' },
      CARD: { createNew: true, newName: 'Corner Card', newType: 'credit', distinctFromAccountIds: ['a2'] },
      OLD: { createNew: true, newName: 'Old', newType: 'credit', skip: true },
      CHK: { accountId: 'a1' },
    })).toEqual([
      { csv_value: 'SAV', name: 'Tidewater', type: 'savings', group_with_account_id: 'a1' },
      { csv_value: 'CARD', name: 'Corner Card', type: 'credit', distinct_from_account_ids: ['a2'] },
    ])
  })
})
