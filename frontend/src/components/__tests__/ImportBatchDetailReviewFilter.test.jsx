// @vitest-environment jsdom

// An import card's "N to review" pill opens the file's report on just the rows it counts, while the ↗ opens
// the whole file with Needs review one click away. Both go through the report's quick filter — the same
// control and server parameter as the Transactions ledger — so the list, its count and a bulk "select all
// matching" narrow together, and the header says how the filtered count relates to the file.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ImportBatchDetail from '../ImportBatchDetail.jsx'
import { api } from '../../lib/api.js'

vi.mock('../../lib/api.js', () => ({
  api: {
    getTransactions: vi.fn(),
    getFilterAttributes: vi.fn(),
    getBatchRemovedDuplicates: vi.fn(),
    // Bulk edit's tag picker loads the tag list on mount.
    getTags: vi.fn(() => Promise.resolve([])),
  },
}))
// The list itself is asserted where it lives; here only what the report asks the server for matters.
vi.mock('../TransactionListTable.jsx', () => ({ default: () => null }))
vi.mock('../TransactionDetail.jsx', () => ({ default: () => null }))
vi.mock('../../help/FeatureExplainer.jsx', () => ({ default: () => null }))
vi.mock('../../lib/transactionTablePreferences.js', () => ({ useTransactionTableLayout: () => [null, () => {}] }))
const openDuplicatesReport = vi.fn()
vi.mock('../../contexts/UnifiedDuplicatesViewerContext.jsx', () => ({
  useUnifiedDuplicatesViewer: () => ({ open: openDuplicatesReport, viewer: null }),
}))

const ATTRIBUTES = [
  { key: 'needs-review', label: 'Needs review', description: '' },
  { key: 'uncategorized', label: 'Uncategorized', description: '' },
]
const BATCH = { id: 'b1', filename: 'harborline-august.csv', imported_at: '2026-09-01T10:00:00' }

function serve() {
  api.getFilterAttributes.mockResolvedValue(ATTRIBUTES)
  api.getBatchRemovedDuplicates.mockResolvedValue({ count: 0 })
  api.getTransactions.mockImplementation(params => Promise.resolve({
    transactions: [],
    total: params.require_all_attribute_ids === 'needs-review' ? 12 : 240,
  }))
}

const askedForReviewOnly = () => api.getTransactions.mock.calls.some(
  ([params]) => params.import_batch_id === 'b1' && params.require_all_attribute_ids === 'needs-review' && params.limit !== 1,
)

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ImportBatchDetail quick filter', () => {
  it('opens on the rows needing review when the pill asks, and says how many of the file they are', async () => {
    serve()
    render(<ImportBatchDetail batch={{ ...BATCH, _attributeFilter: { attribute: 'needs-review', active: true } }} />)

    expect(await screen.findByText('Needs review: 12 of 240 imported transactions from this file')).toBeTruthy()
    expect(askedForReviewOnly()).toBe(true)
  })

  it('opens on the whole file from the ↗, with Needs review one click away', async () => {
    serve()
    const user = userEvent.setup()
    render(<ImportBatchDetail batch={BATCH} />)

    expect(await screen.findByText('240 imported transactions from this file')).toBeTruthy()
    expect(askedForReviewOnly()).toBe(false)

    await user.click(await screen.findByRole('button', { name: 'Needs review' }))

    await waitFor(() => expect(askedForReviewOnly()).toBe(true))
    expect(await screen.findByText('Needs review: 12 of 240 imported transactions from this file')).toBeTruthy()
  })

  it('calls a data connection card a card, not a file', async () => {
    serve()
    const user = userEvent.setup()
    render(<ImportBatchDetail batch={{ ...BATCH, filename: 'Harborline · August 2026', source_kind: 'connection_sync' }} />)

    expect(await screen.findByText('240 synced transactions on this card')).toBeTruthy()
    await user.click(await screen.findByRole('button', { name: 'Needs review' }))
    expect(await screen.findByText('Needs review: 12 of 240 synced transactions on this card')).toBeTruthy()
    expect(screen.queryByText(/this file/)).toBeNull()
  })
})

describe('ImportBatchDetail removed duplicates', () => {
  it('says how many rows were removed and opens the report where they can be restored', async () => {
    serve()
    api.getBatchRemovedDuplicates.mockResolvedValue({ count: 3 })
    render(<ImportBatchDetail batch={BATCH} />)

    expect(await screen.findByText('Removed as duplicates (3)')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /Review or restore in the duplicate report/ }))
    expect(openDuplicatesReport).toHaveBeenCalledWith({ batchId: 'b1', title: 'harborline-august.csv', kindFilter: 'removed' })
  })

  it('says nothing when no row was removed', async () => {
    serve()
    render(<ImportBatchDetail batch={BATCH} />)
    await screen.findByText('240 imported transactions from this file')
    expect(screen.queryByText(/Removed as duplicates/)).toBeNull()
  })
})
