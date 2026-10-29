// A saved filter is applied long after it was saved, so its contract is about the gap: a preset period
// moves with the calendar, a chip shows what it names today, and a chip whose target is gone stays (marked)
// rather than silently widening the filter. Whether the filters in force *are* a saved filter decides the
// highlight and whether Save is offered, so chip order and stale labels must not change the answer.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const lists = vi.hoisted(() => ({ accounts: [], categories: [], tags: [] }))
vi.mock('../api.js', () => ({
  api: {
    getAccounts: () => Promise.resolve(lists.accounts),
    getCategories: () => Promise.resolve(lists.categories),
    getTags: () => Promise.resolve(lists.tags),
    getOwners: () => Promise.resolve([]),
    getFilterAttributes: () => Promise.resolve([]),
  },
}))

import { reconcileSelections, savedFilterContent, savedFilterDate, savedFilterMatches } from '../savedFilters.js'

const checking = { type: 'account', id: 'a1', label: 'Checking', mode: 'include' }
const groceries = { type: 'category', id: 'c1', label: 'Groceries', mode: 'exclude' }

describe('savedFilterDate', () => {
  it('works a preset out again from the day it is applied', () => {
    const saved = { start: '2025-01-01', end: '2025-06-30', preset: 'Year to date' }
    expect(savedFilterDate(saved, new Date(2026, 9, 29)))
      .toEqual({ start: '2026-01-01', end: '2026-10-29', preset: 'Year to date' })
  })

  it('keeps a custom range, all time and an unset date as they were', () => {
    expect(savedFilterDate({ start: '2025-03-01', end: '2025-03-31', preset: null }))
      .toEqual({ start: '2025-03-01', end: '2025-03-31', preset: null })
    expect(savedFilterDate({ start: null, end: null, preset: 'All time' }))
      .toEqual({ start: null, end: null, preset: 'All time' })
    expect(savedFilterDate(null)).toBeNull()
  })
})

describe('savedFilterMatches', () => {
  const saved = {
    date: { start: '2025-01-01', end: '2025-06-30', preset: 'Year to date' },
    selections: [checking, groceries],
    amount: { side: 'debit', low: null, high: null },
  }

  it('matches the same filters in any chip order, with today\'s range and current labels', () => {
    const current = {
      date: { start: '2026-01-01', end: '2026-10-29', preset: 'Year to date' },
      selections: [{ ...groceries, label: 'Food' }, checking],
      amount: { side: 'debit', low: null, lowOp: '>=', high: null, highOp: '<=' },
    }
    expect(savedFilterMatches(saved, current)).toBe(true)
  })

  it('does not match once any part differs', () => {
    const current = { date: saved.date, selections: [checking, groceries], amount: saved.amount }
    expect(savedFilterMatches(saved, { ...current, date: { ...saved.date, preset: 'Last year' } })).toBe(false)
    expect(savedFilterMatches(saved, { ...current, date: null })).toBe(false)
    expect(savedFilterMatches(saved, { ...current, selections: [checking, { ...groceries, mode: 'include' }] })).toBe(false)
    expect(savedFilterMatches(saved, { ...current, selections: [checking] })).toBe(false)
    expect(savedFilterMatches(saved, { ...current, amount: null })).toBe(false)
  })

  it('tells a custom range from a preset covering the same days', () => {
    const custom = { ...saved, date: { start: '2026-01-01', end: '2026-10-29', preset: null } }
    const current = { date: { start: '2026-01-01', end: '2026-10-29', preset: 'Year to date' }, selections: saved.selections, amount: saved.amount }
    expect(savedFilterMatches(custom, current)).toBe(false)
  })
})

describe('savedFilterContent', () => {
  it('does not save the missing marker', () => {
    const content = savedFilterContent({ date: null, selections: [{ ...checking, missing: true }], amount: null })
    expect(content.selections).toEqual([checking])
  })
})

describe('reconcileSelections', () => {
  beforeEach(() => {
    lists.accounts = [{ id: 'a1', name: 'Everyday Checking', mask: '1234' }]
    lists.categories = [{ id: 'g1', name: 'Food', parent_id: null }]
    lists.tags = []
  })

  it('shows current names, marks what is gone, and leaves synthetic and payee chips alone', async () => {
    const untagged = { type: 'tag', id: '__untagged__', label: 'Untagged', mode: 'include' }
    const payee = { type: 'payee', id: 'payee:Coffee', label: 'Coffee', mode: 'include' }
    const result = await reconcileSelections([checking, groceries, untagged, payee])
    expect(result).toEqual([
      { type: 'account', id: 'a1', label: 'Everyday Checking ···1234', mode: 'include' },
      { ...groceries, missing: true },
      untagged,
      payee,
    ])
  })
})
