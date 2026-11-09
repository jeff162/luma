// @vitest-environment jsdom

// The ledger is sized to the whole result from its first response and fetches the page the viewport is
// on, so a reader who drags the scrollbar deep into the list is served that page directly — not every
// page between the top and there, which is what made the thumb lag the mouse while rows were loading.
//
// jsdom does no layout, so the scroll viewport and the rows are given fixed heights (as in
// WindowedRows.test.jsx), keyed off the row's data-index.

import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Transactions from '../Transactions.jsx'
import { TransactionShareProvider } from '../../contexts/TransactionShareContext.jsx'
import { api } from '../../lib/api.js'

vi.mock('../../lib/api.js', () => ({
  api: {
    getTransactions: vi.fn(),
    getFilterAttributes: vi.fn(() => Promise.resolve([])),
    getCategories: vi.fn(() => Promise.resolve([])),
    getAccounts: vi.fn(() => Promise.resolve([])),
    getTags: vi.fn(() => Promise.resolve([])),
  },
}))
// Stable across renders, as the real context is: the list re-queries whenever the filters change identity.
const filterContext = {
  filters: { selections: [] },
  clearDate: () => {},
  removeSelections: () => {},
  getRawDate: () => null,
}
vi.mock('../../lib/FilterContext.jsx', () => ({ useFilters: () => filterContext }))
vi.mock('../../contexts/SyncStatusContext.jsx', () => ({ useAfterLedgerChange: () => {} }))
// Stable per call, as the real hook is.
const preference = [null, () => {}]
vi.mock('../../lib/UserPreferencesContext.jsx', () => ({ useUserPreference: () => preference, useDeviceLayoutPreference: () => preference }))
vi.mock('../../lib/useStoredDocuments.js', () => ({ useStoredDocuments: () => ({ documents: [], refresh: vi.fn() }) }))
vi.mock('../../lib/useReimbursementCount.js', () => ({ useReimbursementCount: () => ({ count: 0, reload: vi.fn() }) }))

// The cells are stood in: what is under test is which rows are fetched and placed, and the real cells
// need the app's providers.
vi.mock('../../components/TransactionRow.jsx', async importOriginal => ({
  ...(await importOriginal()),
  MerchantCell: ({ txn }) => <span>{txn.merchant_name}</span>,
  CategoryCell: () => null,
  TransactionMarkersCell: () => null,
  TransactionAmountCell: () => null,
}))

const VIEWPORT_HEIGHT = 600
const ROW_HEIGHT = 40
const TOTAL = 5000

beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  const heightOf = element => (element.hasAttribute('data-index') ? ROW_HEIGHT : VIEWPORT_HEIGHT)
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get() { return 800 } })
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { return heightOf(this) } })
  Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    const height = heightOf(this)
    return { x: 0, y: 0, top: 0, left: 0, right: 800, bottom: height, width: 800, height, toJSON() {} }
  }
})

afterEach(() => { cleanup(); vi.clearAllMocks() })

function serveLedger() {
  api.getTransactions.mockImplementation(({ offset = 0, limit }) => Promise.resolve({
    total: TOTAL,
    transactions: Array.from({ length: Math.min(limit, TOTAL - offset) }, (_, i) => ({
      id: `t${offset + i}`, date: '2026-01-01', merchant_name: `Row ${offset + i}`,
      amount: 1, category_names: [], needs_review: 0,
    })),
  }))
}

describe('the ledger pages by position', () => {
  it('fetches the page under a deep scroll without walking the pages before it', async () => {
    serveLedger()
    const { container } = render(
      <MemoryRouter><TransactionShareProvider><Transactions /></TransactionShareProvider></MemoryRouter>,
    )
    await screen.findByText('Row 0')
    // The scroll height is the whole list's before anything past the first page is loaded: unloaded rows
    // are sized by the page's estimate, so the bound is loose, but a first page alone is far below it.
    const firstRow = container.querySelector('[data-index]')
    const spacer = firstRow.parentElement.parentElement
    expect(parseFloat(spacer.style.height)).toBeGreaterThan(TOTAL * 30)
    const viewport = firstRow.closest('div[style*="overflow-y: auto"]')

    api.getTransactions.mockClear()
    viewport.scrollTop = 3200 * ROW_HEIGHT
    fireEvent.scroll(viewport)

    // The rows that arrive are the ones at that depth, fetched as the first request after the scroll.
    await screen.findAllByText(/^Row 3\d{3}$/)
    const offsets = api.getTransactions.mock.calls.map(call => call[0].offset)
    expect(offsets[0]).toBe(3000)
    expect(offsets).not.toContain(500)
  })
})
