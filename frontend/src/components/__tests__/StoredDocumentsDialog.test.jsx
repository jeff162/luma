// @vitest-environment jsdom

// The stored-documents dialog: what it sends when something is added, and that a document added alone
// arrives ready to be named — it came by drop or paste, and its name is what it will be picked by later.
// Nothing here moves a document onto a transaction; that is the transaction panel's, and has no control here.

import { useState } from 'react'
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { render, screen, cleanup, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import StoredDocumentsDialog from '../StoredDocumentsDialog.jsx'
import { api } from '../../lib/api.js'

vi.mock('../../lib/api.js', () => ({
  api: {
    storeDocument: vi.fn(),
    renameDocument: vi.fn(),
    deleteDocument: vi.fn(),
    documentFileUrl: id => `/api/documents/${id}/file`,
  },
}))

vi.mock('../../help/FeatureExplainer.jsx', () => ({ default: () => null }))

const PASTED = {
  id: 'doc-3', txn_id: null, filename: 'documentation.png', mime_type: 'image/png', byte_size: 2048,
  created_at: '2026-09-16T12:00:00Z', text_source: null,
}

// The host's `useStoredDocuments`, reduced to the state it hands the dialog.
function Host({ initial = [] }) {
  const [documents, setDocuments] = useState(initial)
  const reload = vi.fn(async () => setDocuments([PASTED]))
  return <StoredDocumentsDialog documents={documents} reload={reload} onClose={vi.fn()} />
}

function pasteImage(box) {
  act(() => {
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', {
      value: { files: [new File([new Uint8Array([0x89, 0x50])], 'image.png', { type: 'image/png' })] },
    })
    box.dispatchEvent(event)
  })
}

beforeEach(() => {
  api.storeDocument.mockResolvedValue({ document: PASTED, already_stored: false })
  api.renameDocument.mockResolvedValue({ document: { ...PASTED, filename: 'Tire quote.png' } })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('StoredDocumentsDialog', () => {
  it('stores a paste and opens its name for editing', async () => {
    const user = userEvent.setup()
    render(<Host />)
    expect(screen.getByText('No stored documents.')).toBeTruthy()

    pasteImage(screen.getByLabelText('Drop or paste a document'))

    await waitFor(() => expect(api.storeDocument).toHaveBeenCalledTimes(1))
    expect(api.storeDocument.mock.calls[0][0].name).toBe('documentation.png')
    const field = await screen.findByLabelText('Document name')
    await user.clear(field)
    await user.type(field, 'Tire quote.png{Enter}')
    await waitFor(() => expect(api.renameDocument).toHaveBeenCalledWith('doc-3', 'Tire quote.png'))
  })

  it('leaves a file that was already stored with the name it has', async () => {
    api.storeDocument.mockResolvedValue({ document: PASTED, already_stored: true })
    render(<Host initial={[PASTED]} />)

    pasteImage(screen.getByLabelText('Drop or paste a document'))

    await waitFor(() => expect(api.storeDocument).toHaveBeenCalledTimes(1))
    expect(screen.queryByLabelText('Document name')).toBeNull()
  })

  it('offers no way to move a stored document, only to delete it', async () => {
    render(<Host initial={[PASTED]} />)
    expect(screen.getByLabelText('Delete documentation.png')).toBeTruthy()
    expect(screen.queryByLabelText(/Move documentation\.png/)).toBeNull()
  })
})
