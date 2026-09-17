// The saved column layout every transaction table outside the Transactions ledger reads.
//
// What is pinned here is that a saved layout is *read for what it says* rather than having to match the
// current column set exactly. The strict version rejected any layout whose key set differed by one, so
// adding the `tags` column made every stored layout unreadable — and since the table commits the columns
// it renders, a resize was discarded the moment it was saved. On screen that read as the divider snapping
// back to the default width at the start of the next drag.

import { describe, it, expect } from 'vitest'
import {
  buildTransactionTableDefaultColumnConfig,
  normalizeTransactionTableColumnConfig,
} from '../transactionTablePreferences.js'

const keysOf = columns => (columns || []).map(column => column.key)

describe('normalizeTransactionTableColumnConfig', () => {
  it('keeps a resized width the table committed, tags column and all', () => {
    const saved = [
      { key: 'date', width: 96 }, { key: 'merchant', width: 180 }, { key: 'category', width: 150 },
      { key: 'account', width: 140 }, { key: 'tags', width: 96 }, { key: 'amount', width: 108 },
    ]
    const normalized = normalizeTransactionTableColumnConfig(saved)
    expect(normalized).toEqual(saved)
  })

  it('keeps a reordered layout in the order it was saved', () => {
    const saved = [
      { key: 'merchant', width: 260 }, { key: 'date', width: 96 }, { key: 'amount', width: 108 },
      { key: 'category', width: 150 }, { key: 'account', width: 140 }, { key: 'tags', width: 96 },
    ]
    expect(keysOf(normalizeTransactionTableColumnConfig(saved))).toEqual(keysOf(saved))
  })

  it('fills in a column the saved layout predates, at its canonical position', () => {
    // A layout stored before `tags` existed: the missing column joins its neighbours rather than being
    // stranded past Amount, and the widths around it survive.
    const saved = [
      { key: 'date', width: 96 }, { key: 'merchant', width: 180 }, { key: 'category', width: 150 },
      { key: 'account', width: 140 }, { key: 'amount', width: 108 },
    ]
    const normalized = normalizeTransactionTableColumnConfig(saved)
    expect(keysOf(normalized)).toEqual(['date', 'merchant', 'category', 'account', 'tags', 'amount'])
    expect(normalized.find(column => column.key === 'merchant').width).toBe(180)
  })

  it('drops a column this surface does not show, and keeps the rest', () => {
    // A category-scoped panel hides the category column; a layout carrying one must still be readable.
    // Account is absent from the saved layout and shown here, so it is filled in beside its neighbours.
    const saved = [
      { key: 'date', width: 96 }, { key: 'merchant', width: 180 }, { key: 'category', width: 150 },
      { key: 'tags', width: 96 }, { key: 'amount', width: 108 },
    ]
    const normalized = normalizeTransactionTableColumnConfig(saved, { showCategory: false })
    expect(keysOf(normalized)).toEqual(['date', 'merchant', 'account', 'tags', 'amount'])
    expect(normalized.find(column => column.key === 'merchant').width).toBe(180)
  })

  it('falls back to defaults for a layout with nothing usable in it', () => {
    expect(normalizeTransactionTableColumnConfig(null)).toBeNull()
    expect(normalizeTransactionTableColumnConfig([{ key: 'nonsense', width: 120 }])).toBeNull()
  })

  it('keeps one entry per column when a stored layout repeats one', () => {
    // A duplicate key would render two columns onto one grid track.
    const saved = [
      { key: 'merchant', width: 180 }, { key: 'merchant', width: 300 }, { key: 'date', width: 96 },
    ]
    const normalized = normalizeTransactionTableColumnConfig(saved)
    expect(normalized.filter(column => column.key === 'merchant')).toEqual([{ key: 'merchant', width: 180 }])
  })

  it('replaces an unusable width with the column default rather than dropping the column', () => {
    const normalized = normalizeTransactionTableColumnConfig([{ key: 'merchant', width: 'wide' }])
    expect(normalized.find(column => column.key === 'merchant').width)
      .toBe(buildTransactionTableDefaultColumnConfig().find(column => column.key === 'merchant').width)
  })
})
