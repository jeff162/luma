/*
 * The arrangement is saved and read back across owner filters, devices and account changes, so its rules
 * have to keep the saved list drawable: one type per section, no empty sections, and every account placed
 * exactly once wherever it was left.
 */

import { describe, it, expect } from 'vitest'
import {
  accountDropAt, arrangedAccountsOfType, balanceTableCopy, defaultArrangement, moveAccount, moveSection, resolveArrangement,
  sectionDropAt, setSectionCollapsed, setSectionNote,
} from '../balanceArrangement.js'

const A = { account_id: 1, name: 'Everyday', type: 'depository' }
const B = { account_id: 2, name: 'Joint', type: 'depository' }
const C = { account_id: 3, name: 'Rainy day', type: 'depository' }
const V = { account_id: 4, name: 'Visa', type: 'credit' }
const M = { account_id: 5, name: 'Mastercard', type: 'credit' }
const S = { account_id: 6, name: 'High yield', type: 'savings' }

function sec(id, type, accounts, extra = {}) {
  return { id, type, note: '', accounts, collapsed: false, ...extra }
}

// Ids in the order a test expects them, so a split's two new sections can be named.
function ids(...values) {
  let next = 0
  return () => values[next++]
}

const shape = arrangement => arrangement.map(s => [s.id, s.type, s.accounts])

describe('resolveArrangement', () => {
  it('with nothing saved, is one section per type in the type order, accounts as sent', () => {
    const { arrangement, sections } = resolveArrangement(null, [S, V, A, M, B])
    expect(shape(arrangement)).toEqual([
      ['depository', 'depository', [1, 2]],
      ['credit', 'credit', [4, 5]],
      ['savings', 'savings', [6]],
    ])
    expect(arrangement).toEqual(defaultArrangement([S, V, A, M, B]))
    expect(sections.map(s => [s.label, s.accounts.map(a => a.name)])).toEqual([
      ['Checking', ['Everyday', 'Joint']],
      ['Credit cards', ['Visa', 'Mastercard']],
      ['Savings', ['High yield']],
    ])
  })

  it('keeps the place of an account the owner filters leave out, and draws no section they empty', () => {
    const saved = [sec('top', 'depository', [1, 2], { collapsed: true, note: 'Daily' }), sec('cards', 'credit', [4]), sec('rest', 'depository', [3])]
    const { arrangement, sections } = resolveArrangement(saved, [A, C])
    expect(arrangement).toEqual(saved)
    expect(sections.map(s => [s.id, s.note, s.collapsed, s.accounts.map(a => a.account_id)])).toEqual([
      ['top', 'Daily', true, [1]],
      ['rest', '', false, [3]],
    ])
  })

  it('drops the place of an account that no longer exists, and the section it empties', () => {
    // 2 is filtered out but exists; 7 and 8 are gone.
    const saved = [sec('top', 'depository', [1, 2, 7]), sec('gone', 'credit', [8]), sec('cards', 'credit', [4])]
    expect(shape(resolveArrangement(saved, [A, V], [1, 2, 4, 9]).arrangement)).toEqual([
      ['top', 'depository', [1, 2]],
      ['cards', 'credit', [4]],
    ])
  })

  it('puts a new account at the end of the last section of its type', () => {
    const saved = [sec('top', 'depository', [1]), sec('cards', 'credit', [4]), sec('rest', 'depository', [2])]
    expect(shape(resolveArrangement(saved, [A, B, C, V]).arrangement)).toEqual([
      ['top', 'depository', [1]],
      ['cards', 'credit', [4]],
      ['rest', 'depository', [2, 3]],
    ])
  })

  it('puts a new account of a type with no section in a new section at the end', () => {
    const saved = [sec('cards', 'credit', [4]), sec('top', 'depository', [1])]
    expect(shape(resolveArrangement(saved, [A, V, S]).arrangement)).toEqual([
      ['cards', 'credit', [4]],
      ['top', 'depository', [1]],
      ['savings', 'savings', [6]],
    ])
  })

  it('moves an account whose type changed out of its section, and removes the section it empties', () => {
    const saved = [sec('top', 'depository', [1, 7]), sec('odd', 'depository', [8]), sec('cards', 'credit', [4])]
    const retyped = [A, V, { account_id: 7, name: 'Now a card', type: 'credit' }, { account_id: 8, name: 'Now savings', type: 'savings' }]
    expect(shape(resolveArrangement(saved, retyped).arrangement)).toEqual([
      ['top', 'depository', [1]],
      ['cards', 'credit', [4, 7]],
      ['savings', 'savings', [8]],
    ])
  })

  it('reads an unusable saved value as nothing saved, and holds each account once', () => {
    expect(resolveArrangement({ sections: [] }, [A]).arrangement).toEqual(defaultArrangement([A]))
    const saved = [sec('one', 'depository', [1, 2]), sec('one', 'depository', [3]), null, sec('two', 'depository', [2, 3])]
    expect(shape(resolveArrangement(saved, [A, B, C]).arrangement)).toEqual([
      ['one', 'depository', [1, 2]],
      ['two', 'depository', [3]],
    ])
  })
})

describe('moveAccount', () => {
  const base = [sec('top', 'depository', [1, 2], { note: 'Daily', collapsed: true }), sec('cards', 'credit', [4, 5]), sec('rest', 'depository', [3])]

  it('dropped among its own type\'s rows, joins that section at that place', () => {
    expect(shape(moveAccount(base, 3, { section: 'top', after: 1 }))).toEqual([
      ['top', 'depository', [1, 3, 2]],
      ['cards', 'credit', [4, 5]],
    ])
    expect(shape(moveAccount(base, 3, { section: 'top', before: 1 }))[0]).toEqual(['top', 'depository', [3, 1, 2]])
  })

  it('dropped past the end of its own type\'s section, joins its end', () => {
    expect(shape(moveAccount(base, 1, { section: 'rest' }))).toEqual([
      ['top', 'depository', [2]],
      ['cards', 'credit', [4, 5]],
      ['rest', 'depository', [3, 1]],
    ])
  })

  it('dropped between sections, starts a new open section of its type there', () => {
    const moved = moveAccount(base, 2, { after: 'cards' }, ids('new'))
    expect(shape(moved)).toEqual([
      ['top', 'depository', [1]],
      ['cards', 'credit', [4, 5]],
      ['new', 'depository', [2]],
      ['rest', 'depository', [3]],
    ])
    expect(moved[2]).toEqual(sec('new', 'depository', [2]))
    // Above the first section.
    expect(shape(moveAccount(base, 4, { before: 'top' }, ids('first')))[0]).toEqual(['first', 'credit', [4]])
  })

  it('dropped among another type\'s rows, splits that section around a section of its own', () => {
    const moved = moveAccount(base, 5, { section: 'top', after: 1 }, ids('mine', 'lower'))
    expect(moved).toEqual([
      sec('top', 'depository', [1], { note: 'Daily', collapsed: true }),
      sec('mine', 'credit', [5]),
      sec('lower', 'depository', [2]),
      sec('cards', 'credit', [4]),
      sec('rest', 'depository', [3]),
    ])
  })

  it('keeps another type\'s section whole when dropped at either end of it', () => {
    const atTop = moveAccount(base, 1, { section: 'cards', before: 4 }, ids('mine'))
    expect(shape(atTop)).toEqual([
      ['top', 'depository', [2]],
      ['mine', 'depository', [1]],
      ['cards', 'credit', [4, 5]],
      ['rest', 'depository', [3]],
    ])
    expect(shape(moveAccount(base, 4, { section: 'top', after: 2 }, ids('mine')))).toEqual([
      ['top', 'depository', [1, 2]],
      ['mine', 'credit', [4]],
      ['cards', 'credit', [5]],
      ['rest', 'depository', [3]],
    ])
  })

  it('removes a section left with no accounts', () => {
    expect(shape(moveAccount(base, 3, { section: 'top' }))).toEqual([
      ['top', 'depository', [1, 2, 3]],
      ['cards', 'credit', [4, 5]],
    ])
  })

  it('leaves an account alone in its section where it is when dropped just above or below it', () => {
    expect(moveAccount(base, 3, { after: 'cards' }, ids('new'))).toBe(base)
    expect(moveAccount(base, 3, { after: 'rest' }, ids('new'))).toBe(base)
    // At the end of the section above it: nothing to split, so the same place.
    const lone = [sec('top', 'depository', [1]), sec('cards', 'credit', [4], { note: 'Kept' })]
    expect(moveAccount(lone, 4, { section: 'top', after: 1 }, ids('new'))).toBe(lone)
    expect(shape(moveAccount(base, 3, { before: 'top' }, ids('new')))[0]).toEqual(['new', 'depository', [3]])
  })

  it('places a drop beside the shown rows, so an account not shown keeps its place', () => {
    // Account 2 is filtered out; the drop line falls between 1 and 9, both shown.
    const arranged = [sec('top', 'depository', [1, 2, 9]), sec('rest', 'depository', [3])]
    expect(shape(moveAccount(arranged, 3, { section: 'top', after: 1, before: 9 }))[0]).toEqual(['top', 'depository', [1, 3, 2, 9]])
    expect(shape(moveAccount(arranged, 3, { section: 'top', before: 9 }))[0]).toEqual(['top', 'depository', [1, 2, 3, 9]])
  })

  it('leaves the arrangement alone for a drop onto the account itself or an unknown one', () => {
    expect(moveAccount(base, 1, { section: 'top', after: 1 })).toBe(base)
    expect(moveAccount(base, 99, { section: 'top' })).toBe(base)
    expect(moveAccount(base, 1, { section: 'gone' })).toBe(base)
  })
})

describe('moveSection', () => {
  const base = [sec('top', 'depository', [1]), sec('cards', 'credit', [4]), sec('rest', 'depository', [3])]

  it('moves a section between two others, keeping it whole', () => {
    expect(moveSection(base, 'rest', { after: 'top' }).map(s => s.id)).toEqual(['top', 'rest', 'cards'])
    expect(moveSection(base, 'top', { before: 'rest' }).map(s => s.id)).toEqual(['cards', 'top', 'rest'])
    expect(moveSection(base, 'top', { after: 'top' })).toBe(base)
  })

  it('never merges two sections of one type that end up side by side', () => {
    expect(shape(moveSection(base, 'cards', { after: 'rest' }))).toEqual([
      ['top', 'depository', [1]],
      ['rest', 'depository', [3]],
      ['cards', 'credit', [4]],
    ])
  })
})

it('collapses or annotates one section by its id, leaving the others', () => {
  const base = [sec('top', 'depository', [1]), sec('rest', 'depository', [3])]
  expect(setSectionCollapsed(base, 'rest', true).map(s => s.collapsed)).toEqual([false, true])
  expect(setSectionNote(base, 'top', '  Joint ').map(s => s.note)).toEqual(['Joint', ''])
})

describe('drop placement', () => {
  // Two sections of 20px rows: a heading, then its accounts, 10px apart between sections.
  const layout = [
    { id: 'top', type: 'depository', top: 0, headingBottom: 20, bottom: 60, rows: [{ id: 1, top: 20, bottom: 40 }, { id: 2, top: 40, bottom: 60 }] },
    { id: 'cards', type: 'credit', top: 70, headingBottom: 90, bottom: 110, rows: [{ id: 4, top: 90, bottom: 110 }] },
  ]

  it('starts a new section above the first', () => {
    expect(accountDropAt(layout, 5, 'depository')).toMatchObject({ drop: { before: 'top' }, indented: false, newSection: true })
  })

  it('lands between the two rows nearest the pointer', () => {
    expect(accountDropAt(layout, 25, 'depository')).toMatchObject({ drop: { section: 'top', after: undefined, before: 1 }, line: 20 })
    expect(accountDropAt(layout, 45, 'depository')).toMatchObject({ drop: { section: 'top', after: 1, before: 2 }, line: 40, newSection: false })
  })

  it('joins a section\'s end until half a row past it, then lands between sections', () => {
    expect(accountDropAt(layout, 69, 'depository')).toMatchObject({ drop: { section: 'top', after: 2 }, indented: true })
    // Half a row is 10px; the next heading's middle is at 80.
    expect(accountDropAt(layout, 75, 'depository')).toMatchObject({ drop: { after: 'top' }, indented: false, newSection: true })
    expect(accountDropAt(layout, 125, 'depository')).toMatchObject({ drop: { after: 'cards' }, newSection: true })
  })

  it('marks a drop among another type\'s rows as starting a section', () => {
    expect(accountDropAt(layout, 45, 'credit')).toMatchObject({ drop: { section: 'top', after: 1, before: 2 }, newSection: true })
  })

  it('drops a section only between sections', () => {
    expect(sectionDropAt(layout, 50).drop).toEqual({ before: 'cards' })
    expect(sectionDropAt(layout, 10).drop).toEqual({ before: 'top' })
    expect(sectionDropAt(layout, 100).drop).toEqual({ after: 'cards' })
  })
})

it('drills into a split type in the arranged order', () => {
  const { sections } = resolveArrangement([sec('top', 'depository', [2]), sec('cards', 'credit', [4]), sec('rest', 'depository', [3, 1])], [A, B, C, V])
  expect(arrangedAccountsOfType(sections, 'depository').map(a => a.account_id)).toEqual([2, 3, 1])
})

it('copies one row per account with signed balances, no change and no subtotals, collapsed sections included', () => {
  const sections = [
    { label: 'Checking', note: 'Joint', collapsed: true, accounts: [{ ...A, balance: 1200.5 }] },
    { label: 'Credit cards', note: '', collapsed: false, accounts: [{ ...V, balance: -1839.99 }, { ...M, balance: null }] },
  ]
  const columns = [{ label: 'Balance', of: a => a.balance }, { label: 'Change', change: true, of: () => 5 }]
  expect(balanceTableCopy(sections, columns).text.split('\n')).toEqual([
    'Type,Account,Balance',
    '"Checking · Joint",Everyday,"$1,200.50"',
    '"Credit cards",Visa,"-$1,839.99"',
    '"Credit cards",Mastercard,',
  ])
})
