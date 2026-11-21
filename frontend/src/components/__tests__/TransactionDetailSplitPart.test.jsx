// @vitest-environment jsdom

/*
 * The detail panel opened from one expanded allocation of a split must describe the transaction.
 *
 * A category-scoped list expands splits, so the row it hands the panel carries the *part's* amount and
 * category while its id still names the whole purchase. The panel reads its header off that object but
 * fetches its Documents, Purchase and Reimbursement sections by id — so left unresolved it describes a
 * part in one half and the transaction in the other. What that looked like in the wild: a $10 header
 * above a line reporting a $250 receivable, with nothing on screen to explain the gap.
 *
 * Asserted through the header amount because that is the field the two halves disagreed about.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import TransactionDetail from '../TransactionDetail.jsx'
import { api } from '../../lib/api.js'

// Same shape as TransactionDetailReconcile: the panel calls a long tail of api methods just to render,
// and enumerating them would need extending every time it grew a section. `getTransactions` is the one
// this file is about, so it is the one defined.
vi.mock('../../lib/api.js', () => {
  const defined = {
    getTransactions: vi.fn(() => Promise.resolve({ transactions: [] })),
  }
  return {
    api: new Proxy(defined, {
      get: (target, prop) => target[prop] || (target[prop] = vi.fn(() => Promise.resolve([]))),
    }),
  }
})

vi.mock('../../lib/UserPreferencesContext.jsx', () => ({
  useUserPreference: (_key, fallback) => [fallback, vi.fn()],
  useDeviceLayoutPreference: (_key, fallback) => [fallback, vi.fn()],
  useOptionalUserPreference: (_key, fallback) => [fallback, vi.fn()],
}))
vi.mock('../../help/FeatureExplainer.jsx', () => ({ default: () => null }))
vi.mock('../../contexts/TransactionShareContext.jsx', () => ({
  useTransactionShare: () => ({ open: vi.fn(), share: vi.fn() }),
  TransactionShareProvider: ({ children }) => children,
}))

// A $250 deposit divided into $10 and $240. Stored negative because a deposit is; the header renders
// magnitudes, so the numbers on screen read $10.00 and $250.00.
const WHOLE = {
  id: 't1', date: '2026-09-01', amount: -250,
  merchant_name: 'Ticket share', display_name: 'Ticket share', raw_name: 'Ticket share',
  category_id: null, category_name: null, is_split: true, split_part_count: 2, notes: '', tags: [],
}
const PART = {
  ...WHOLE, amount: -10, split_part_id: 'p1',
  category_id: 'reimb', category_name: 'Awaiting reimbursement',
}

globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
Element.prototype.scrollIntoView = vi.fn()

beforeEach(() => {
  api.getTransactions.mockImplementation(params =>
    Promise.resolve({ transactions: params?.ids === 't1' ? [WHOLE] : [] }))
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

function renderPanel(txn) {
  return render(
    <MemoryRouter>
      <TransactionDetail txn={txn} categories={[]} onClose={() => {}} onReconcile={vi.fn()} />
    </MemoryRouter>,
  )
}

describe('the detail panel on one expanded part of a split', () => {
  it('shows the transaction it belongs to, not the allocation it was opened from', async () => {
    renderPanel(PART)
    // The part's own figure is what the panel would show unresolved, so its absence is the assertion.
    await waitFor(() => expect(screen.getByText('$250.00')).toBeTruthy())
    expect(screen.queryByText('$10.00')).toBeNull()
  })

  it('asks for the transaction by id rather than rebuilding it from the row', async () => {
    // Fetching is what keeps this correct when the seam substitutes a further field: the row cannot be
    // trusted to carry values it no longer has.
    renderPanel(PART)
    await waitFor(() =>
      expect(api.getTransactions).toHaveBeenCalledWith(expect.objectContaining({ ids: 't1' })))
  })

  it('leaves an ordinary row alone, so nothing that works today pays for the request', async () => {
    const plain = { ...WHOLE, is_split: false, split_part_count: 0 }
    renderPanel(plain)
    await waitFor(() => expect(screen.getByText('$250.00')).toBeTruthy())
    const asked = api.getTransactions.mock.calls.some(([params]) => params?.ids === 't1')
    expect(asked).toBe(false)
  })

  it('keeps the row it was handed when the fetch fails', async () => {
    // A wrong header is still a usable panel; a panel that refuses to describe the row is not.
    api.getTransactions.mockImplementation(() => Promise.reject(new Error('offline')))
    renderPanel(PART)
    await waitFor(() => expect(screen.getByText('$10.00')).toBeTruthy())
  })
})
