// @vitest-environment jsdom

// Two loads of the ledger for the SAME query can be in flight at once, and the newer one has to win.
//
// This is the mechanism behind the intermittent in `frontend/tests/ui/needs-review-marker.spec.js`: the
// out-of-order guard used to compare a key built from the filter params, which cannot tell two calls for
// one query apart, so both committed and arrival order decided. Against a ledger being written to at the
// same time the two responses differ, and the grid took whichever landed last.
//
// StrictMode is the trigger here rather than a stand-in for one: it runs the mount effect twice in dev,
// which is exactly how the browser suite met this. In production the same overlap comes from
// `useAfterLedgerSync`, the refresh button and `bulk.onReload`, all of which re-load with the filters
// unchanged.

import { StrictMode } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
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
vi.mock('../../lib/FilterContext.jsx', () => ({
  useFilters: () => ({
    filters: { selections: [] },
    clearDate: vi.fn(),
    removeSelections: vi.fn(),
    getRawDate: () => null,
  }),
}))
vi.mock('../../contexts/SyncStatusContext.jsx', () => ({ useAfterLedgerSync: () => {} }))
vi.mock('../../lib/UserPreferencesContext.jsx', () => ({ useUserPreference: () => [null, vi.fn()] }))
vi.mock('../../lib/useStoredDocuments.js', () => ({ useStoredDocuments: () => ({ documents: [], refresh: vi.fn() }) }))
vi.mock('../../lib/useReimbursementCount.js', () => ({ useReimbursementCount: () => ({ count: 0, reload: vi.fn() }) }))

afterEach(() => { cleanup(); vi.clearAllMocks() })

// A promise whose resolution this test controls, so the two responses can be landed in either order.
function deferred() {
  let resolve
  const promise = new Promise(r => { resolve = r })
  return { promise, resolve }
}

const listOf = (count) => ({
  transactions: Array.from({ length: count }, (_, i) => ({
    id: `t${i}`, date: '2026-01-0{i}'.replace('{i}', String(i + 1)), merchant_name: `Row ${i}`,
    amount: 10 + i, category_names: [], needs_review: 0,
  })),
  total: count,
})

describe('two loads of the same query', () => {
  it('commits the newer response even when the older one lands last', async () => {
    // Every load the page issues, held open until this test decides the order they land in.
    const pending = []
    api.getTransactions.mockImplementation(() => {
      const call = deferred()
      pending.push(call)
      return call.promise
    })

    render(
      <StrictMode><MemoryRouter><TransactionShareProvider><Transactions /></TransactionShareProvider></MemoryRouter></StrictMode>,
    )

    // StrictMode's second mount issues an identical request while the first is still in flight — the
    // overlap the guard has to survive. Nothing has resolved, so every call made by now is concurrent.
    await waitFor(() => expect(pending.length).toBeGreaterThan(1))
    const params = api.getTransactions.mock.calls.map(c => JSON.stringify(c[0]))
    expect(new Set(params).size).toBe(1)   // one query, several calls — what the old key could not see

    // The newest call answers first, then every older one — the ordering that used to decide the grid.
    const newest = pending[pending.length - 1]
    newest.resolve(listOf(1))
    await screen.findByText('1 transaction')
    pending.slice(0, -1).forEach(call => call.resolve(listOf(2)))

    // Each older response must be dropped on arrival, not painted over the newer one.
    await waitFor(() => expect(screen.queryByText('2 transactions')).toBeNull())
    expect(screen.getByText('1 transaction')).toBeTruthy()
  })
})
