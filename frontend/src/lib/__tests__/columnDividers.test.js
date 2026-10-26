// Dragging a divider moves only that divider: the two columns beside it trade width and every other
// column keeps its width, so nothing further along is pushed out of view. The last column's dividers
// change the table's width instead.

import { describe, expect, it } from 'vitest'
import { dividerIsDraggable, moveDivider } from '../columnDividers.js'

const widths = columns => Object.fromEntries(columns.map(column => [column.key, column.width]))

const ledger = [
  { key: 'date', width: 100 },
  { key: 'merchant', width: 260 },
  { key: 'category', width: 150, minWidth: 120 },
  { key: 'amount', width: 110 },
]

describe('moveDivider', () => {
  it('trades width between the two neighbours and leaves the rest alone', () => {
    expect(widths(moveDivider(ledger, 'date', 20))).toEqual({ date: 120, merchant: 240, category: 150, amount: 110 })
  })

  it('stops where the neighbour reaches its minimum width', () => {
    expect(widths(moveDivider(ledger, 'merchant', 100))).toEqual({ date: 100, merchant: 290, category: 120, amount: 110 })
  })

  it('slides the last column along whole from the divider before it', () => {
    expect(widths(moveDivider(ledger, 'category', 30))).toEqual({ date: 100, merchant: 260, category: 180, amount: 110 })
  })

  it('widens the last column from the divider after it', () => {
    expect(widths(moveDivider(ledger, 'amount', 30))).toEqual({ date: 100, merchant: 260, category: 150, amount: 140 })
  })

  it('lets a fluid column take up the change on its side', () => {
    const columns = [{ key: 'name', width: 'minmax(0, 1fr)' }, { key: 'type', width: 110, minWidth: 90 }]
    expect(widths(moveDivider(columns, 'name', 15))).toEqual({ name: 'minmax(0, 1fr)', type: 95 })
  })
})

describe('dividerIsDraggable', () => {
  it('gives no grip beside a fixed column', () => {
    const columns = [{ key: 'select', width: 40, resizable: false }, { key: 'date', width: 100 }, { key: 'actions', kind: 'spacer', width: 28 }]
    expect([0, 1, 2].map(index => dividerIsDraggable(columns, index))).toEqual([false, false, false])
  })
})
