// @vitest-environment jsdom

// One part of a split, as a category-scoped list shows it. The row's name is the whole purchase's, so every
// part of it would read alike; the part's own description is what says which item this row is.

import { afterEach, describe, it, expect, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { MerchantCell } from '../TransactionRow.jsx'
import { TransactionShareProvider } from '../../contexts/TransactionShareContext.jsx'

vi.mock('../../lib/api.js', () => ({
  api: { updateMerchant: vi.fn() },
}))

const PARTS = [
  { id: 'p1', category_id: 'groceries', category_name: 'Groceries', amount: 60, label: 'Pantry restock' },
  { id: 'p2', category_id: 'hardware', category_name: 'Hardware', amount: 40, label: 'Shelf brackets' },
]

function renderCell(txn) {
  return render(
    <MemoryRouter>
      <TransactionShareProvider>
        <MerchantCell txn={{ id: 't1', merchant_name: 'Harbor Supply', ...txn }} showReport={false} />
      </TransactionShareProvider>
    </MemoryRouter>,
  )
}

afterEach(cleanup)

describe('the merchant cell on one part of a split', () => {
  it('shows the description of the part this row is, under the name', () => {
    renderCell({ amount: 40, is_split: true, split_part_id: 'p2', split_parts: PARTS })
    expect(screen.getByText('Harbor Supply')).toBeTruthy()
    expect(screen.getByText('Shelf brackets')).toBeTruthy()
    expect(screen.queryByText('Pantry restock')).toBeNull()
  })

  it('shows no description on the whole split, which the unscoped ledger lists', () => {
    renderCell({ amount: 100, is_split: true, split_part_id: null, split_parts: PARTS })
    expect(screen.queryByText('Shelf brackets')).toBeNull()
    expect(screen.queryByText('Pantry restock')).toBeNull()
  })
})
