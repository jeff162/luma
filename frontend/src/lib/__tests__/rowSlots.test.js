import { describe, it, expect } from 'vitest'
import { placeRows, pagesCovering, firstMissingPage, loadedRows, leadingRows, applyToLoaded } from '../rowSlots.js'

const rows = (from, count) => Array.from({ length: count }, (_, i) => ({ id: `t${from + i}` }))

describe('rowSlots', () => {
  it('places a page at its offset in a list sized to the total, leaving the rest unloaded', () => {
    const slots = placeRows([], 10, 6, rows(6, 3))

    expect(slots).toHaveLength(10)
    expect(slots.slice(6, 9).map(r => r.id)).toEqual(['t6', 't7', 't8'])
    expect(slots.filter(r => r === undefined)).toHaveLength(7)
  })

  it('keeps loaded rows when a later page lands, and trims to a smaller total', () => {
    const first = placeRows([], 10, 0, rows(0, 3))
    const both = placeRows(first, 8, 6, rows(6, 3))

    expect(both).toHaveLength(8)
    expect(both[0].id).toBe('t0')
    expect(both[7].id).toBe('t7')
  })

  it('finds the first page in a range that is not fully loaded', () => {
    const slots = placeRows([], 25, 0, rows(0, 10))

    expect(firstMissingPage(slots, 0, 9, 10)).toBeNull()
    expect(firstMissingPage(slots, 5, 14, 10)).toBe(1)
    // A range past either end is clamped to the list.
    expect(firstMissingPage(slots, -50, 3, 10)).toBeNull()
    expect(firstMissingPage(slots, 18, 400, 10)).toBe(1)
    expect(pagesCovering(18, 400, 25, 10)).toEqual([1, 2])
  })

  it('treats a short last page as loaded once its rows are in', () => {
    const slots = placeRows([], 25, 20, rows(20, 5))

    expect(firstMissingPage(slots, 20, 24, 10)).toBeNull()
  })

  it('answers the leading rows only when every one of them is loaded', () => {
    const partial = placeRows(placeRows([], 30, 0, rows(0, 10)), 30, 20, rows(20, 10))

    expect(leadingRows(partial, 10).map(r => r.id)).toEqual(rows(0, 10).map(r => r.id))
    expect(leadingRows(partial, 30)).toBeNull()
  })

  it('applies a patch written against the loaded rows to their slots', () => {
    const slots = placeRows([], 5, 0, rows(0, 2))
    const next = applyToLoaded(slots, prev => prev.map(r => (r.id === 't1' ? { ...r, notes: 'x' } : r)), r => r.id)

    expect(next[1]).toEqual({ id: 't1', notes: 'x' })
    expect(next.slice(2)).toEqual([undefined, undefined, undefined])
    expect(loadedRows(next).map(r => r.id)).toEqual(['t0', 't1'])
  })

  it('closes a dropped row up so later slots keep the server offsets', () => {
    const slots = placeRows(placeRows([], 6, 0, rows(0, 2)), 6, 4, rows(4, 2))
    const next = applyToLoaded(slots, prev => prev.filter(r => r.id !== 't0'), r => r.id)

    expect(next).toHaveLength(5)
    // The server now returns t4 at offset 3, and that is where the list holds it.
    expect(next[3].id).toBe('t4')
  })

  it('puts a prepended row before the first loaded row', () => {
    const slots = placeRows([], 4, 0, rows(0, 2))
    const next = applyToLoaded(slots, prev => [{ id: 'new' }, ...prev], r => r.id)

    expect(next.map(r => r?.id)).toEqual(['new', 't0', 't1', undefined, undefined])
  })

  it('places a row already listed elsewhere as an empty loaded slot, so it is neither repeated nor refetched', () => {
    const first = placeRows([], 6, 0, rows(0, 3), r => r.id)
    // The ledger moved t2 between the two fetches, so the second page brings it back.
    const both = placeRows(first, 6, 3, [{ id: 't2' }, { id: 't4' }, { id: 't5' }], r => r.id)

    expect(both[3]).toBeNull()
    expect(loadedRows(both).map(r => r.id)).toEqual(['t0', 't1', 't2', 't4', 't5'])
    expect(firstMissingPage(both, 0, 5, 3)).toBeNull()
  })
})
