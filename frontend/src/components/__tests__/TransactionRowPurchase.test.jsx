// @vitest-environment jsdom

// The ledger's multi-payment purchase marker. Like the document marker beside it, it is interactive
// because a marker that stands for something openable and does nothing reads as broken — this repo has
// twice reversed a marker left inert on the reasoning that another route already existed.
//
// What is pinned: it opens the shared editor rather than a second implementation of one, it reports the
// result up so the row's own marker follows an ungroup without a page refetch, and it says nothing at
// all on a row the list feed gave no purchase.

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { TransactionMarkersCell } from '../TransactionRow.jsx'
import { api } from '../../lib/api.js'

vi.mock('../../lib/api.js', () => ({
  api: {
    getTags: vi.fn().mockResolvedValue([]),
    documentFileUrl: id => `/api/documents/${id}/file`,
    getTransactionPurchase: vi.fn(),
    updatePurchase: vi.fn(),
    removePurchasePayment: vi.fn(),
    deletePurchase: vi.fn(),
  },
}))

vi.mock('../../contexts/UnifiedDuplicatesViewerContext.jsx', () => ({
  useUnifiedDuplicatesViewer: () => ({ open: vi.fn() }),
}))

// What the list feed carries per row: the summary, not the sibling payments.
const SUMMARY = {
  id: 'p1', label: 'Kitchen counters', position: 1, payment_count: 2,
  linked_total: 2400, expected_total: 6000,
}

const FULL = {
  id: 'p1', label: 'Kitchen counters', reference: 'INV-4471',
  expected_total: 6000, linked_total: 6000, unaccounted: 0, payment_count: 2,
  payments: [
    { txn_id: 'dep', date: '2026-03-04', amount: 2400, payee: 'Riverstone Joinery', account_name: 'Rewards Card', trashed: false },
    { txn_id: 'bal', date: '2026-05-19', amount: 3600, payee: 'Riverstone Joinery', account_name: 'Rewards Card', trashed: false },
  ],
}

function renderRow(txn, props = {}) {
  return render(
    <MemoryRouter>
      <TransactionMarkersCell txn={{ id: 'dep', tags: [], ...txn }} {...props} />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  api.getTransactionPurchase.mockResolvedValue({ purchase: FULL })
  api.deletePurchase.mockResolvedValue({ ok: true })
})

afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('the ledger purchase marker', () => {
  it('is absent on a row the feed gave no purchase', () => {
    renderRow({ purchase: null })
    expect(screen.queryByLabelText(/purchase/i)).toBeNull()
  })

  it('names which payment it is, what of, and how the total stands', () => {
    renderRow({ purchase: SUMMARY })
    // Spending is stored positive and displayed negative.
    expect(screen.getByLabelText(
      'Payment 1 of 2 · Kitchen counters · -$2,400.00 of -$6,000.00 — open this purchase',
    )).toBeTruthy()
  })

  it('opens the shared editor, not a second one', async () => {
    const user = userEvent.setup()
    renderRow({ purchase: SUMMARY })

    await user.click(screen.getByLabelText(/open this purchase/))
    // The editor's own fields and its payment list — the same dialog the detail panel opens.
    expect(await screen.findByLabelText('Expected total')).toBeTruthy()
    expect(screen.getByText('2026-05-19')).toBeTruthy()
  })

  it('reports the result up so the row follows an ungroup without a page refetch', async () => {
    const onUpdatePurchase = vi.fn()
    const user = userEvent.setup()
    renderRow({ purchase: SUMMARY }, { onUpdatePurchase })

    await user.click(screen.getByLabelText(/open this purchase/))
    await user.click(await screen.findByText('Ungroup this purchase'))
    const confirms = await screen.findAllByText('Ungroup')
    await user.click(confirms[confirms.length - 1])

    await waitFor(() => expect(onUpdatePurchase).toHaveBeenCalledWith('dep', null))
  })

  it('reports the row summary, not the whole record, after an edit', async () => {
    // The row renders from the summary shape the list feed supplies; handing it the full record would
    // work by accident until something read a field the feed does not carry.
    api.updatePurchase.mockResolvedValue({ ...FULL, label: 'Deck rebuild' })
    const onUpdatePurchase = vi.fn()
    const user = userEvent.setup()
    renderRow({ purchase: SUMMARY }, { onUpdatePurchase })

    await user.click(screen.getByLabelText(/open this purchase/))
    await screen.findByLabelText('Purchase name')
    await user.click(screen.getByText('Save'))

    await waitFor(() => expect(onUpdatePurchase).toHaveBeenCalled())
    expect(onUpdatePurchase.mock.calls[0][1]).toEqual({
      id: 'p1', label: 'Deck rebuild', position: 1, payment_count: 2,
      linked_total: 6000, expected_total: 6000,
    })
  })
})
