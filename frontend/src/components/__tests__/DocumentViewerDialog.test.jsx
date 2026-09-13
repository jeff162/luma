// @vitest-environment jsdom

// Editing a text document from its viewer. What matters is who is offered the edit, that a save reports the
// replacement (a new id) to the host rather than assuming the old one still stands, and that a failed save
// leaves what was typed on screen.

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import DocumentViewerDialog from '../DocumentViewerDialog.jsx'
import { api } from '../../lib/api.js'

vi.mock('../../lib/api.js', () => ({
  api: {
    documentFileUrl: (id, opts) => `/api/documents/${id}/file${opts?.download ? '?download=true' : ''}`,
    getDocumentText: vi.fn(),
    editDocumentText: vi.fn(),
  },
}))

const NOTE = { id: 'doc-1', filename: 'Pasted 2026-03-14.txt', mime_type: 'text/plain' }
const REPLACEMENT = { ...NOTE, id: 'doc-9' }

beforeEach(() => {
  api.getDocumentText.mockResolvedValue('Brake pads 249.50\n-- signature')
  api.editDocumentText.mockResolvedValue({ document: REPLACEMENT })
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
