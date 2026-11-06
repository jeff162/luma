// @vitest-environment jsdom

// The ledger's document marker. It is the only place a document can be opened without first opening the
// transaction, and it is the natural next action after a search that matched inside one — so what is
// pinned here is that it opens, and that the two counts open different things.

import { useState } from 'react'
import { afterEach, describe, it, expect, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { TransactionMarkersCell } from '../TransactionRow.jsx'
import { api } from '../../lib/api.js'

vi.mock('../../lib/api.js', () => ({
  api: {
    getTags: vi.fn().mockResolvedValue([]),
    documentFileUrl: id => `/api/documents/${id}/file`,
    getDocumentText: vi.fn(),
    probeDocumentFile: async () => {},
    editDocumentText: vi.fn(),
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

  it('shows on hover the passage the search matched, with the matched words highlighted', async () => {
    // The viewer hands the file to the browser and cannot point at the match, so the hover shows it.
    const user = userEvent.setup()
    const excerpt = [{ text: '…new boat trailer tire ST225/', hit: false }, { text: '75D15', hit: true }, { text: '/8…', hit: false }]
    renderRow({ documents: [{ ...INVOICE, match_excerpt: excerpt }, ESTIMATE], document_count: 2, matched_document: true })

    await user.hover(screen.getByLabelText('Matched inside an attached document — open it'))

    await waitFor(() => expect([...document.querySelectorAll('mark')].map(mark => mark.textContent)).toEqual(['75D15']))
    expect(screen.getAllByText(INVOICE.filename).length).toBeGreaterThan(0)
    expect(screen.queryByText(ESTIMATE.filename)).toBeNull()
  })

  it('opens the edited document, not the one it replaced, after an edit made from the row', async () => {
    // An edit replaces the document under a new id. The row opens documents from its own copy, so unless
    // that copy is swapped the next click reaches for a document that no longer exists.
    const NOTE = { id: 'doc-1', filename: 'Pasted 2026-03-14.txt', mime_type: 'text/plain' }
    api.getDocumentText.mockResolvedValue('Brake pads 249.50\n-- signature')
    api.editDocumentText.mockResolvedValue({ document: { ...NOTE, id: 'doc-9', txn_id: 't1' } })

    function Host() {
      const [txn, setTxn] = useState({ id: 't1', tags: [], documents: [NOTE], document_count: 1 })
      return (
        <MemoryRouter>
          <TransactionMarkersCell txn={txn} onUpdateDocuments={(_, documents) => setTxn(prev => ({ ...prev, documents }))} />
        </MemoryRouter>
      )
    }
    const user = userEvent.setup()
    render(<Host />)

    await user.click(screen.getByLabelText('Open the attached document'))
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    await user.type(await screen.findByLabelText('Document text'), ' edited')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.getByTitle(NOTE.filename).getAttribute('src')).toBe('/api/documents/doc-9/file'))

    await user.click(screen.getByRole('button', { name: 'Close' }))
    await user.click(screen.getByLabelText('Open the attached document'))
    expect(screen.getByTitle(NOTE.filename).getAttribute('src')).toBe('/api/documents/doc-9/file')
  })

  it('is absent when the transaction carries nothing', () => {
    renderRow({ documents: [], document_count: 0 })
    expect(screen.queryByLabelText(/attached document/i)).toBeNull()
  })
})
