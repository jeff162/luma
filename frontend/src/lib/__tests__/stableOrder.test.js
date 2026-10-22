import { describe, it, expect } from 'vitest'
import { stableOrder } from '../useStableOrder.js'

const getId = item => item.id
const compare = (a, b) => a.rank - b.rank
const ids = list => list.map(getId)

describe('stableOrder', () => {
  it('sorts afresh when there is no earlier order', () => {
    const items = [{ id: 'a', rank: 2 }, { id: 'b', rank: 1 }]
    expect(ids(stableOrder(null, items, { getId, compare }))).toEqual(['b', 'a'])
  })

  it('keeps a row in place when what it sorts by changes, drops gone rows and appends new ones sorted', () => {
    const items = [{ id: 'a', rank: 0 }, { id: 'c', rank: 9 }, { id: 'e', rank: 5 }, { id: 'd', rank: 4 }]
    expect(ids(stableOrder(['b', 'c', 'a'], items, { getId, compare }))).toEqual(['c', 'a', 'd', 'e'])
  })

  it('keeps a listed row that stopped matching the filter, but lists only matching new rows', () => {
    const include = item => item.match
    const items = [{ id: 'a', rank: 1, match: false }, { id: 'b', rank: 2, match: true }, { id: 'c', rank: 3, match: false }]
    expect(ids(stableOrder(['a'], items, { getId, compare, include }))).toEqual(['a', 'b'])
    expect(ids(stableOrder(null, items, { getId, compare, include }))).toEqual(['b'])
  })
})
