// @vitest-environment jsdom

// Editing a text document from its viewer. What matters is who is offered the edit, that a save reports the
// replacement (a new id) to the host rather than assuming the old one still stands, and that a failed save
// leaves what was typed on screen.

import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import DocumentViewerDialog from '../DocumentViewerDialog.jsx'
import { api } from '../../lib/api.js'

vi.mock('../../lib/api.js', () => ({
  api: {
    documentFileUrl: (id, opts) => `/api/documents/${id}/file${opts?.download ? '?download=true' : ''}`,
    getDocumentText: vi.fn(),
    probeDocumentFile: vi.fn(),
    editDocumentText: vi.fn(),
  },
}))

const NOTE = { id: 'doc-1', filename: 'Pasted 2026-03-14.txt', mime_type: 'text/plain' }
const REPLACEMENT = { ...NOTE, id: 'doc-9' }

beforeEach(() => {
  api.getDocumentText.mockResolvedValue('Brake pads 249.50\n-- signature')
  api.editDocumentText.mockResolvedValue({ document: REPLACEMENT })
  api.probeDocumentFile.mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('DocumentViewerDialog editing', () => {
  it('offers Edit for a text document only', () => {
    const onDocumentReplaced = vi.fn()
    const { rerender } = render(<DocumentViewerDialog document={NOTE} onClose={vi.fn()} onDocumentReplaced={onDocumentReplaced} />)
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy()

    // HTML is kept for its formatting, which is not edited; a PDF or a photograph is not text to edit.
    for (const mime_type of ['text/html', 'application/pdf', 'image/jpeg']) {
      rerender(<DocumentViewerDialog document={{ ...NOTE, mime_type }} onClose={vi.fn()} onDocumentReplaced={onDocumentReplaced} />)
      expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
    }
  })

  it('opens straight into the editor when asked, once, under StrictMode', async () => {
    // A document list's Edit opens the viewer already editing. StrictMode mounts the effect twice, which is
    // what the app runs under; the editor must still open, with one fetch of the text.
    render(
      <StrictMode>
        <DocumentViewerDialog document={NOTE} openInEdit onClose={vi.fn()} onDocumentReplaced={vi.fn()} />
      </StrictMode>,
    )

    const box = await screen.findByLabelText('Document text')
    expect(box.value).toBe('Brake pads 249.50\n-- signature')
    expect(api.getDocumentText).toHaveBeenCalledTimes(1)
  })

  it('saves an edit and reports the document that replaced it', async () => {
    const onDocumentReplaced = vi.fn()
    const user = userEvent.setup()
    render(<DocumentViewerDialog document={NOTE} onClose={vi.fn()} onDocumentReplaced={onDocumentReplaced} />)

    await user.click(screen.getByRole('button', { name: 'Edit' }))
    const box = await screen.findByLabelText('Document text')
    expect(box.value).toBe('Brake pads 249.50\n-- signature')

    await user.clear(box)
    await user.type(box, 'Brake pads 249.50')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(onDocumentReplaced).toHaveBeenCalledWith('doc-1', REPLACEMENT))
    expect(api.editDocumentText).toHaveBeenCalledWith('doc-1', 'Brake pads 249.50')
    expect(screen.queryByLabelText('Document text')).toBeNull()
  })

  it('makes no request when nothing was changed', async () => {
    const onDocumentReplaced = vi.fn()
    const user = userEvent.setup()
    render(<DocumentViewerDialog document={NOTE} onClose={vi.fn()} onDocumentReplaced={onDocumentReplaced} />)

    await user.click(screen.getByRole('button', { name: 'Edit' }))
    await screen.findByLabelText('Document text')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(api.editDocumentText).not.toHaveBeenCalled()
    expect(onDocumentReplaced).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy()
  })

  it('keeps the draft on screen and says why when a save fails', async () => {
    api.editDocumentText.mockRejectedValue(new Error('A text document cannot be empty. Remove it instead.'))
    const onDocumentReplaced = vi.fn()
    const user = userEvent.setup()
    render(<DocumentViewerDialog document={NOTE} onClose={vi.fn()} onDocumentReplaced={onDocumentReplaced} />)

    await user.click(screen.getByRole('button', { name: 'Edit' }))
    const box = await screen.findByLabelText('Document text')
    await user.clear(box)
    await user.type(box, ' ')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText(/cannot be empty/)).toBeTruthy()
    expect(screen.getByLabelText('Document text').value).toBe(' ')
    expect(onDocumentReplaced).not.toHaveBeenCalled()
  })
})

describe('DocumentViewerDialog viewing', () => {
  it('shows why a file cannot be served instead of a blank frame', async () => {
    api.probeDocumentFile.mockRejectedValue(new Error("The server cannot read this document's file (Permission denied)."))
    render(<DocumentViewerDialog document={{ ...NOTE, mime_type: 'application/pdf' }} onClose={vi.fn()} />)
    expect((await screen.findByRole('alert')).textContent).toMatch(/cannot read this document's file/)
    expect(document.querySelector('iframe')).toBeNull()
  })

  it('shows the file once it can be served', async () => {
    render(<DocumentViewerDialog document={{ ...NOTE, mime_type: 'image/jpeg' }} onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByRole('img')).toBeTruthy())
  })
})
