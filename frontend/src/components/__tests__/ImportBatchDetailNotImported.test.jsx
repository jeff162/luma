// @vitest-environment jsdom

// A file's report has two halves: what it brought in, and what it left out. The second tab exists only
// when there is something to show, opens directly from the card's "rejected" pill, and is the only place
// several classes of refusal are visible at all — a skipped account used to leave a count and nothing
// else. What it must never do is present a capped record as the whole of it.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ImportBatchDetail from '../ImportBatchDetail.jsx'
import { api } from '../../lib/api.js'

vi.mock('../../lib/api.js', () => ({
  api: {
    getTransactions: vi.fn(() => Promise.resolve({ transactions: [], total: 0 })),
    getFilterAttributes: vi.fn(() => Promise.resolve([])),
    getBatchRemovedDuplicates: vi.fn(() => Promise.resolve({ count: 0 })),
    getBatchNotImported: vi.fn(),
    getTags: vi.fn(() => Promise.resolve([])),
  },
}))
vi.mock('../TransactionListTable.jsx', () => ({ default: () => null }))
vi.mock('../TransactionDetail.jsx', () => ({ default: () => null }))
vi.mock('../../help/FeatureExplainer.jsx', () => ({ default: () => null }))
vi.mock('../../lib/transactionTablePreferences.js', () => ({ useTransactionTableLayout: () => [null, () => {}] }))
const openDuplicatesReport = vi.fn()
vi.mock('../../contexts/UnifiedDuplicatesViewerContext.jsx', () => ({
  useUnifiedDuplicatesViewer: () => ({ open: openDuplicatesReport, viewer: null }),
}))
// Stable per key, as the real hook's value is: a fresh array each render makes the column-preference
// consumer re-merge forever.
const preferences = new Map()
function storedPreference(key, fallback) {
  if (!preferences.has(key)) preferences.set(key, fallback)
  return [preferences.get(key), value => { preferences.set(key, value); return Promise.resolve() }]
}
vi.mock('../../lib/UserPreferencesContext.jsx', () => ({
  useUserPreference: storedPreference,
  useDeviceLayoutPreference: storedPreference,
}))

const BATCH = {
  id: 'b1',
  filename: 'harborline-august.csv',
  imported_at: '2026-09-01T10:00:00',
  import_summary: {
    imported_count: 240,
    validation_error_count: 1,
    account_skipped_count: 2,
    rejected_count: 1,
  },
}

function serveNotImported(overrides = {}) {
  api.getBatchNotImported.mockResolvedValue({
    batch_id: 'b1',
    headers: ['Date', 'Description', 'Amount', 'Account', 'Reference'],
    extra_headers: ['Account', 'Reference'],
    rows: [
      {
        row: 4, kind: 'validation_error', reason: "Invalid date: 'n/a'",
        values: { Date: 'n/a', Description: 'Annual fee', Amount: '35.00', Account: 'Card', Reference: 'X99' },
        date: 'n/a', description: 'Annual fee', amount: null,
      },
      {
        row: 9, kind: 'account_skipped', reason: "Skipped account 'Savings'",
        values: { Date: '2026-08-04', Description: 'Interest', Amount: '-1.12', Account: 'Savings', Reference: '' },
        date: '2026-08-04', description: 'Interest', amount: -1.12,
      },
    ],
    totals: { validation_error: 1, currency: 0, zero_amount: 0, account_skipped: 2, trailing_text: 0 },
    total_count: 3,
    duplicate_count: 0,
    ...overrides,
  })
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  preferences.clear()
})

describe('the file report’s Not imported tab', () => {
  it('is offered when the file left something out, and the card’s pill opens straight onto it', async () => {
    serveNotImported()
    render(<ImportBatchDetail batch={{ ...BATCH, _view: 'not-imported' }} />)
    await waitFor(() => expect(api.getBatchNotImported).toHaveBeenCalledWith('b1'))
    // The class that previously left only a count behind.
    expect(await screen.findByText("Skipped account 'Savings'")).toBeTruthy()
    expect(screen.getByText("Invalid date: 'n/a'")).toBeTruthy()
  })

  it('is reachable from the imported half, and fetches only once asked for', async () => {
    serveNotImported()
    render(<ImportBatchDetail batch={BATCH} />)
    await waitFor(() => expect(api.getTransactions).toHaveBeenCalled())
    expect(api.getBatchNotImported).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: /Not imported/ }))
    expect(await screen.findByText("Skipped account 'Savings'")).toBeTruthy()
  })

  it('stays out of the way when the whole file came in', async () => {
    serveNotImported()
    render(<ImportBatchDetail batch={{ id: 'b2', filename: 'clean.csv', import_summary: { imported_count: 10 } }} />)
    await waitFor(() => expect(api.getTransactions).toHaveBeenCalled())
    // The same query that finds the control in the test above, so its absence here means something.
    expect(screen.queryByRole('button', { name: /Not imported/ })).toBeNull()
    expect(api.getBatchNotImported).not.toHaveBeenCalled()
  })

  it('shows one reason at a time when a pill is chosen', async () => {
    serveNotImported()
    render(<ImportBatchDetail batch={{ ...BATCH, _view: 'not-imported' }} />)
    await screen.findByText("Skipped account 'Savings'")
    await userEvent.click(screen.getByRole('button', { name: /Validation error \(1\)/ }))
    await waitFor(() => expect(screen.queryByText("Skipped account 'Savings'")).toBeNull())
    expect(screen.getByText("Invalid date: 'n/a'")).toBeTruthy()
  })

  it('says the record is partial rather than reporting what it kept as the total', async () => {
    serveNotImported({
      totals: { validation_error: 1, currency: 0, zero_amount: 0, account_skipped: 900, trailing_text: 0 },
      total_count: 901,
    })
    render(<ImportBatchDetail batch={{ ...BATCH, _view: 'not-imported' }} />)
    expect(await screen.findByText(/2 of 901 rows are kept/)).toBeTruthy()
  })

  it('counts duplicates but sends them to the report that can act on them', async () => {
    serveNotImported({ duplicate_count: 7 })
    render(<ImportBatchDetail batch={{ ...BATCH, _view: 'not-imported' }} />)
    await userEvent.click(await screen.findByRole('button', { name: /Review them in the duplicate report/ }))
    expect(openDuplicatesReport).toHaveBeenCalledWith(expect.objectContaining({ batchId: 'b1' }))
  })
})
