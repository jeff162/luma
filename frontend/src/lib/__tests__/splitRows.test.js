// The test that separates a split *transaction* row from one of its expanded *part* rows, and the row
// key that depends on it. Both are pure, and both are wrong in ways that render plausibly — a part row
// mislabelled as the whole split still draws, and two rows sharing a key still produce a list — so they
// are asserted here rather than left to the surfaces that consume them.

import { describe, it, expect } from 'vitest'
import { isSplitPartRow, transactionRowKey, splitPartSummary, wholeTransactionRow } from '../splitRows.js'

describe('isSplitPartRow', () => {
  it('is false for an ordinary transaction', () => {
    expect(isSplitPartRow({ id: 't1', is_split: false })).toBe(false)
  })

  it('is false for a whole split, which is what the unexpanded ledger shows', () => {
    expect(isSplitPartRow({ id: 't1', is_split: true, split_part_id: null })).toBe(false)
  })

  it('is true only when the row came back as one allocation', () => {
    expect(isSplitPartRow({ id: 't1', is_split: true, split_part_id: 'p1' })).toBe(true)
  })
})

describe('transactionRowKey', () => {
  it('is the transaction id where the row is a transaction', () => {
    expect(transactionRowKey({ id: 't1', is_split: true })).toBe('t1')
    expect(transactionRowKey({ id: 't2', is_split: false })).toBe('t2')
  })

  it('separates two allocations of one transaction that share a category and an amount', () => {
    // The case the id alone cannot key: the split rules permit two parts in one category, so a list
    // scoped to it shows both — and identical amounts leave nothing else to tell them apart.
    const a = { id: 't1', is_split: true, split_part_id: 'p1', category_id: 'c1', amount: 10 }
    const b = { id: 't1', is_split: true, split_part_id: 'p2', category_id: 'c1', amount: 10 }
    expect(transactionRowKey(a)).not.toBe(transactionRowKey(b))
  })

  it('cannot collide with a plain transaction id', () => {
    expect(transactionRowKey({ id: 't1', is_split: true, split_part_id: 'p1' })).toBe('t1:p1')
  })
})

describe('splitPartSummary', () => {
  it('recovers the transaction amount an expanded row does not carry', () => {
    const summary = splitPartSummary({
      id: 't1', amount: -10, is_split: true, split_part_id: 'p1', split_part_count: 2,
      split_parts: [{ amount: -10 }, { amount: -240 }],
    })
    expect(summary).toEqual({ partCount: 2, total: -250 })
  })

  it('rounds to the cent rather than leaving float drift in a displayed figure', () => {
    const summary = splitPartSummary({ split_parts: [{ amount: 0.1 }, { amount: 0.2 }] })
    expect(summary.total).toBe(0.3)
  })

  it('reports no total rather than a confident zero when the parts did not come along', () => {
    // A host that renders rows without requesting allocations should fall back, not print $0.00 as if
    // that were the purchase.
    expect(splitPartSummary({ id: 't1', is_split: true, split_part_count: 2 }).total).toBeNull()
  })
})

describe('wholeTransactionRow', () => {
  const PART = {
    id: 't1', amount: -10, is_split: true, split_part_id: 'p1', split_part_count: 2,
    split_parts: [{ amount: -10 }, { amount: -240 }],
  }

  it('restores the purchase amount an expanded row replaced with its part\'s', () => {
    // The split editor reconciles the allocations against this number. Given the part's $10 it would
    // show a transaction whose own parts overshoot it and refuse every save.
    expect(wholeTransactionRow(PART).amount).toBe(-250)
    expect(wholeTransactionRow(PART).id).toBe('t1')
  })

  it('stops presenting the result as one allocation', () => {
    expect(isSplitPartRow(wholeTransactionRow(PART))).toBe(false)
  })

  it('hands back a whole transaction untouched', () => {
    const txn = { id: 't2', amount: -250, is_split: true, split_part_count: 2 }
    expect(wholeTransactionRow(txn)).toBe(txn)
  })

  it('leaves the row alone rather than guessing when the parts are missing', () => {
    const bare = { id: 't1', amount: -10, is_split: true, split_part_id: 'p1' }
    expect(wholeTransactionRow(bare)).toBe(bare)
  })
})
