// The ledger's saved layout outlives every change to its columns, so a layout saved by an older build
// has to keep its order and widths, and showing a hidden column has to put it back where it was.

import { describe, it, expect } from 'vitest'
import {
  defaultLedgerColumns, normalizeLedgerColumns, visibleLedgerColumns, mergeVisibleLedgerColumns,
  setLedgerColumnHidden,
} from '../ledgerColumns.js'

const keys = cols => cols.map(col => col.key)

describe('ledger columns', () => {
  it('keeps an older layout and adds the source column hidden beside category', () => {
    const saved = [
      { key: 'amount', width: 120 },
      { key: 'date', width: 80 },
      { key: 'merchant', width: 300 },
      { key: 'category', width: 140 },
      { key: 'account', width: 150 },
      { key: 'tags', width: 90 },
    ]
    const cols = normalizeLedgerColumns(saved)
    expect(keys(cols)).toEqual(['amount', 'date', 'merchant', 'source', 'category', 'account', 'tags'])
    expect(cols.find(col => col.key === 'source').hidden).toBe(true)
    expect(cols.find(col => col.key === 'merchant').width).toBe(300)
    expect(keys(visibleLedgerColumns(cols))).toEqual(['amount', 'date', 'merchant', 'category', 'account', 'tags'])
  })

  it('falls back to defaults for a corrupt layout', () => {
    expect(normalizeLedgerColumns([{ key: 'date' }, { key: 'date' }])).toBeNull()
    expect(normalizeLedgerColumns([{ key: 'nope', width: 10 }])).toBeNull()
    expect(normalizeLedgerColumns('x')).toBeNull()
  })

  it('writes a reorder of the visible columns around the hidden ones', () => {
    const cols = setLedgerColumnHidden(defaultLedgerColumns(), 'account', true)
    const visible = visibleLedgerColumns(cols)
    // Move amount to the front and widen date.
    const reordered = [visible.at(-1), { ...visible[0], width: 140 }, ...visible.slice(1, -1)]
    const merged = mergeVisibleLedgerColumns(cols, reordered)
    // The hidden columns (source, account) stay behind category, the column they followed.
    expect(merged.map(col => (col.hidden ? `(${col.key})` : col.key)))
      .toEqual(['amount', 'date', 'merchant', 'category', '(source)', '(account)', 'tags'])
    expect(merged.find(col => col.key === 'date').width).toBe(140)

    const shown = setLedgerColumnHidden(merged, 'account', false)
    expect(keys(visibleLedgerColumns(shown))).toEqual(['amount', 'date', 'merchant', 'category', 'account', 'tags'])
  })

  it('round-trips the hidden flag through a saved layout', () => {
    const cols = setLedgerColumnHidden(defaultLedgerColumns(), 'source', false)
    expect(normalizeLedgerColumns(JSON.parse(JSON.stringify(cols)))).toEqual(cols)
  })
})
