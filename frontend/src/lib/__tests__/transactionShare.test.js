// @vitest-environment jsdom

// What a copied or shared transaction says about its categories. A split row's own `category_name` is the
// category it carried *before* it was split — kept only so un-splitting can restore it — so printing that
// names a category the transaction is no longer in, in text that leaves the app for an email or a note.

import { describe, expect, it } from 'vitest'
import { TRANSACTION_SHARE_COLUMNS, getTransactionShareFields } from '../transactionShare.js'

const categoryOf = txn => TRANSACTION_SHARE_COLUMNS.find(col => col.key === 'category').get(txn)

const SPLIT = {
  id: 't1',
  date: '2026-04-10',
  amount: 100,
  merchant_name: 'Fixture Store',
  category_name: 'Groceries',   // the retained pre-split category
  is_split: true,
  split_part_id: null,
  split_parts: [
    { category_name: 'Groceries', amount: 60 },
    { category_name: 'Hardware', amount: 40 },
  ],
}

describe('the category a copied transaction reports', () => {
  it('names every category a split touched, not the one it carried before', () => {
    expect(categoryOf(SPLIT)).toBe('Groceries / Hardware')
  })

  it('reads the same in the single-transaction copy', () => {
    const fields = getTransactionShareFields(SPLIT)
    expect(fields.find(field => field.label === 'Category').value).toBe('Groceries / Hardware')
  })

  it('leaves an ordinary transaction exactly as it was', () => {
    expect(categoryOf({ ...SPLIT, is_split: false, split_parts: [] })).toBe('Groceries')
    expect(categoryOf({ id: 't2', amount: 5 })).toBe('Uncategorized')
  })

  it('reports a part row as the part it is', () => {
    // A category-scoped list returns one allocation, which has a category of its own.
    expect(categoryOf({ ...SPLIT, split_part_id: 'p2', category_name: 'Hardware' })).toBe('Hardware')
  })
})
