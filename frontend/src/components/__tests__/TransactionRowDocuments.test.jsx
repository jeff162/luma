// @vitest-environment jsdom

// The ledger's document marker. It is the only place a document can be opened without first opening the
// transaction, and it is the natural next action after a search that matched inside one — so what is
// pinned here is that it opens, and that the two counts open different things.

import { afterEach, describe, it, expect, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { TransactionMarkersCell } from '../TransactionRow.jsx'

vi.mock('../../lib/api.js', () => ({
  api: {
    getTags: vi.fn().mockResolvedValue([]),
    documentFileUrl: id => `/api/documents/${id}/file`,
  },
}))

vi.mock('../../contexts/UnifiedDuplicatesViewerContext.jsx', () => ({
  useUnifiedDuplicatesViewer: () => ({ open: vi.fn() }),
}))

const INVOICE = { id: 'doc-1', filename: 'repair-invoice.pdf', mime_type: 'application/pdf' }
const ESTIMATE = { id: 'doc-2', filename: 'estimate.pdf', mime_type: 'application/pdf' }

function renderRow(txn) {
  return render(
    <MemoryRouter>
      <TransactionMarkersCell txn={{ id: 't1', tags: [], ...txn }} />
    </MemoryRouter>,
  )
}

afterEach(cleanup)

describe('the ledger document marker', () => {
  it('opens the document directly when there is only one', async () => {
    const user = userEvent.setup()
    renderRow({ documents: [INVOICE], document_count: 1 })

    await user.click(screen.getByLabelText('Open the attached document'))

    // Straight to the viewer: one document has nothing to choose between, so a chooser would be a
    // pointless click in the common case.
    expect(screen.getByTitle('repair-invoice.pdf')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy()
  })

  it('offers a choice when there are several', async () => {
    const user = userEvent.setup()
    renderRow({ documents: [ESTIMATE, INVOICE], document_count: 2 })

    await user.click(screen.getByLabelText('Open 2 attached documents'))
    // A repair arrives as an estimate and then a final invoice; the row cannot guess which is wanted.
    await user.click(screen.getByRole('button', { name: 'estimate.pdf' }))

    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy()
  })

  it('says the row matched inside a document, and offers to open it', async () => {
    // After a search that matched attachment text, this marker is the row's only visible explanation
    // for being in the results at all.
    renderRow({ documents: [INVOICE], document_count: 1, matched_document: true })

    expect(screen.getByLabelText('Matched inside an attached document — open it')).toBeTruthy()
  })

  it('is absent when the transaction carries nothing', () => {
    renderRow({ documents: [], document_count: 0 })
    expect(screen.queryByLabelText(/attached document/i)).toBeNull()
  })
})
