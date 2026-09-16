// @vitest-environment jsdom

// The documents panel's own behavior, as distinct from the store's.
//
// Pinned here because nothing else can catch them: that the four ways of attaching (drop, browse, paste an
// image, paste text) all reach one upload and name a paste `documentation.<ext>`; that a paste carrying no
// file is left alone — otherwise the panel would swallow ordinary text pastes anywhere inside it; that a
// failed upload names its file; and that the two ways of taking a document away differ in what they ask —
// moving it to the stored documents asks nothing, deleting it confirms first, since only that loses the file.
// The stored-documents button is asserted by whether it appears and what attaching through it sends.

import { useState } from 'react'
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { render, screen, cleanup, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import DocumentsPanel from '../DocumentsPanel.jsx'
import { api } from '../../lib/api.js'

vi.mock('../../lib/api.js', () => ({
  api: {
    getTransactionDocuments: vi.fn(),
    attachTransactionDocument: vi.fn(),
    detachDocument: vi.fn(),
    deleteDocument: vi.fn(),
    renameDocument: vi.fn(),
    getStoredDocuments: vi.fn(),
    attachStoredDocument: vi.fn(),
    documentFileUrl: (id, opts) => `/api/documents/${id}/file${opts?.download ? '?download=true' : ''}`,
  },
}))

const INVOICE = {
  id: 'doc-1',
  filename: 'repair-invoice.pdf',
  mime_type: 'application/pdf',
  byte_size: 24_576,
  text_source: 'pdf_text',
}

const PHOTO = {
  id: 'doc-2',
  filename: 'receipt.jpg',
  mime_type: 'image/jpeg',
  byte_size: 310_000,
  text_source: null,
}

function pasteInto(element, flavours) {
  // `userEvent.paste` carries only plain text, so the multi-flavour clipboard this feature depends on
  // has to be dispatched directly. A raw `dispatchEvent` is outside React's batching — `fireEvent` and
  // `userEvent` wrap theirs — so the state it sets would land after the test moved on. `act` puts it
  // back inside the render the assertions are about.
  act(() => {
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', {
      value: { files: [], getData: type => flavours[type] || '' },
    })
    element.dispatchEvent(event)
    // Unless the panel took the paste over, the textarea would insert the plain flavour itself at the
    // caret; jsdom does not do that for a synthetic event, so it is appended here in its place.
    if (event.defaultPrevented) return
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setValue.call(element, element.value + (flavours['text/plain'] || ''))
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const RICH_RECEIPT = {
  'text/plain': 'Professional Tune Up\n1\n$350.00',
  'text/html': '<table><tr><td>Professional Tune Up</td><td>1</td><td>$350.00</td></tr></table>',
}
function pdfFile(name = 'invoice.pdf') {
  return new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], name, { type: 'application/pdf' })
}

const STORED_QUOTE = {
  id: 'doc-7',
  txn_id: null,
  filename: 'garage-quote.pdf',
  mime_type: 'application/pdf',
  byte_size: 12_000,
  created_at: '2026-03-10T09:00:00Z',
  text_source: 'pdf_text',
}

function pasteFile(element, file) {
  act(() => {
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: { files: [file] } })
    element.dispatchEvent(event)
  })
}

const findBox = () => screen.findByLabelText('Drop or paste a document')

beforeEach(() => {
  api.getTransactionDocuments.mockResolvedValue({ documents: [] })
  api.attachTransactionDocument.mockResolvedValue({ document: INVOICE, already_attached: false })
  api.detachDocument.mockResolvedValue({ document: { ...INVOICE, txn_id: null }, already_stored: false })
  api.deleteDocument.mockResolvedValue({ ok: true })
  api.renameDocument.mockResolvedValue({ document: INVOICE })
  api.getStoredDocuments.mockResolvedValue({ documents: [] })
  api.attachStoredDocument.mockResolvedValue({ document: STORED_QUOTE, already_attached: false })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('DocumentsPanel', () => {
  it('lists what is attached and marks only the documents whose text was extracted', async () => {
    api.getTransactionDocuments.mockResolvedValue({ documents: [INVOICE, PHOTO] })
    render(<DocumentsPanel txnId="t1" />)

    expect(await screen.findByText('repair-invoice.pdf')).toBeTruthy()
    expect(screen.getByText('receipt.jpg')).toBeTruthy()
    // A photograph carries no text until OCR exists, and saying otherwise would promise a search that
    // returns nothing.
    expect(screen.getAllByText('searchable')).toHaveLength(1)
  })

  it('uploads a file chosen through the browse input', async () => {
    const user = userEvent.setup()
    const { container } = render(<DocumentsPanel txnId="t1" />)
    await findBox()

    await user.upload(container.querySelector('input[type="file"]'), pdfFile())

    await waitFor(() => expect(api.attachTransactionDocument).toHaveBeenCalledTimes(1))
    expect(api.attachTransactionDocument.mock.calls[0][0]).toBe('t1')
  })

  it('uploads files dropped onto the box, under their own names', async () => {
    // The paste box is also the drop target — one box instead of two, since adding a document is occasional.
    render(<DocumentsPanel txnId="t1" />)
    const box = await findBox()

    const file = pdfFile('dropped.pdf')
    act(() => {
      const event = new Event('drop', { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'dataTransfer', { value: { files: [file], types: ['Files'] } })
      box.dispatchEvent(event)
    })

    await waitFor(() => expect(api.attachTransactionDocument).toHaveBeenCalledTimes(1))
    expect(api.attachTransactionDocument.mock.calls[0][1].name).toBe('dropped.pdf')
  })

  it('attaches a pasted image straight away, named documentation with its own extension', async () => {
    // Paste is the whole of the "email me the receipt" story. An image has nothing to review, so it
    // settles exactly like a dropped file. Chromium names clipboard image data "image.png" and others
    // "blob"; neither says anything, so both become `documentation.<ext>`.
    render(<DocumentsPanel txnId="t1" />)
    const box = await findBox()

    pasteFile(box, new File([new Uint8Array([0x89, 0x50])], 'image.png', { type: 'image/png' }))
    await waitFor(() => expect(api.attachTransactionDocument).toHaveBeenCalledTimes(1))
    pasteFile(box, new File([new Uint8Array([0xff, 0xd8, 0xff])], 'blob', { type: 'image/jpeg' }))
    await waitFor(() => expect(api.attachTransactionDocument).toHaveBeenCalledTimes(2))

    expect(api.attachTransactionDocument.mock.calls.map(call => call[1].name))
      .toEqual(['documentation.png', 'documentation.jpg'])
  })

  it('keeps the name of a real file that was copied and pasted', async () => {
    render(<DocumentsPanel txnId="t1" />)
    pasteFile(await findBox(), new File([new Uint8Array([0x89, 0x50])], 'tire-invoice.png', { type: 'image/png' }))

    await waitFor(() => expect(api.attachTransactionDocument).toHaveBeenCalledTimes(1))
    expect(api.attachTransactionDocument.mock.calls[0][1].name).toBe('tire-invoice.png')
  })

  it('lets pasted text be trimmed before it is attached', async () => {
    // Text pasted out of an email arrives wrapped in signature and quoting, so it lands in the box
    // first. Attaching it unseen would store all of that.
    const user = userEvent.setup()
    render(<DocumentsPanel txnId="t1" />)
    const box = await findBox()

    await user.click(box)
    await user.paste('ACME Auto Repair — brake pads 249.50')
    // Nothing is sent while it is still on screen to edit.
    expect(api.attachTransactionDocument).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Attach' }))

    await waitFor(() => expect(api.attachTransactionDocument).toHaveBeenCalledTimes(1))
    const sent = api.attachTransactionDocument.mock.calls[0][1]
    expect(sent.type).toBe('text/plain')
    expect(sent.name).toBe('documentation.txt')
    expect(await sent.text()).toBe('ACME Auto Repair — brake pads 249.50')
  })

  it('shows a formatted paste as it will be attached, in a sandboxed preview', async () => {
    // A receipt copied out of an email carries its table as text/html; the plain flavour a textarea
    // receives is that table flattened. The textarea cannot show the markup, so the markup is what is shown.
    const user = userEvent.setup()
    render(<DocumentsPanel txnId="t1" />)
    const box = await findBox()

    pasteInto(box, RICH_RECEIPT)

    const preview = await screen.findByTitle('Preview of the pasted receipt')
    // No tokens at all: a token-less sandbox is what withholds scripts and this app's origin.
    expect(preview.getAttribute('sandbox')).toBe('')
    expect(preview.getAttribute('srcdoc')).toContain('<td>$350.00</td>')
    expect(preview.getAttribute('srcdoc')).toContain('Content-Security-Policy')
    expect(screen.queryByLabelText('Drop or paste a document')).toBeNull()
    // Attached as shown or not at all: the formatting is the point, and it is not editable.
    expect(screen.queryByRole('button', { name: /edit/i })).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Attach' }))

    await waitFor(() => expect(api.attachTransactionDocument).toHaveBeenCalledTimes(1))
    const sent = api.attachTransactionDocument.mock.calls[0][1]
    expect(sent.type).toBe('text/html')
    expect(sent.name).toBe('documentation.html')
    // The stored copy is the paste itself, not the preview's rewritten document.
    expect(await sent.text()).toBe(RICH_RECEIPT['text/html'])
  })

  it('inserts a formatted paste as text when the box already holds text', async () => {
    // Pasting into text being edited adds to that text; it is not a new document to preview.
    const user = userEvent.setup()
    render(<DocumentsPanel txnId="t1" />)
    const box = await findBox()
    await user.type(box, 'Order notes: ')

    pasteInto(box, RICH_RECEIPT)

    expect(screen.queryByTitle('Preview of the pasted receipt')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Attach' }))
    const sent = api.attachTransactionDocument.mock.calls[0][1]
    expect(sent.type).toBe('text/plain')
    expect(await sent.text()).toBe(`Order notes: ${RICH_RECEIPT['text/plain']}`)
  })

  it('discards a formatted paste and returns to an empty box', async () => {
    const user = userEvent.setup()
    render(<DocumentsPanel txnId="t1" />)
    pasteInto(await findBox(), RICH_RECEIPT)
    await screen.findByTitle('Preview of the pasted receipt')

    await user.click(screen.getByRole('button', { name: 'Discard' }))

    expect(api.attachTransactionDocument).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Drop or paste a document').value).toBe('')
    expect(screen.queryByRole('button', { name: 'Attach' })).toBeNull()
  })

  it('discards pasted text without attaching it', async () => {
    const user = userEvent.setup()
    render(<DocumentsPanel txnId="t1" />)
    const box = await findBox()

    await user.click(box)
    await user.paste('something else entirely')
    await user.click(screen.getByRole('button', { name: 'Discard' }))

    expect(api.attachTransactionDocument).not.toHaveBeenCalled()
    expect(box.value).toBe('')
  })

  it('names the file a failed upload belongs to', async () => {
    // "That didn't work" is not actionable when three things were dropped together.
    api.attachTransactionDocument.mockRejectedValue(new Error('That file is larger than the 25 MB limit.'))
    const user = userEvent.setup()
    const { container } = render(<DocumentsPanel txnId="t1" />)
    await findBox()

    await user.upload(container.querySelector('input[type="file"]'), pdfFile('huge-scan.pdf'))

    expect(await screen.findByText(/huge-scan\.pdf — That file is larger/)).toBeTruthy()
  })

  it('confirms before deleting, and does nothing if the confirm is dismissed', async () => {
    api.getTransactionDocuments.mockResolvedValue({ documents: [INVOICE] })
    const user = userEvent.setup()
    render(<DocumentsPanel txnId="t1" />)

    await user.click(await screen.findByLabelText('Delete repair-invoice.pdf'))
    expect(screen.getByText(/cannot be undone/)).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(api.deleteDocument).not.toHaveBeenCalled()

    await user.click(screen.getByLabelText('Delete repair-invoice.pdf'))
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(api.deleteDocument).toHaveBeenCalledWith('doc-1'))
    expect(api.detachDocument).not.toHaveBeenCalled()
  })

  it('moves a document to the stored documents without asking, since that can be undone', async () => {
    api.getTransactionDocuments.mockResolvedValue({ documents: [INVOICE] })
    const user = userEvent.setup()
    render(<DocumentsPanel txnId="t1" />)

    api.getTransactionDocuments.mockResolvedValue({ documents: [] })
    await user.click(await screen.findByLabelText('Move repair-invoice.pdf to stored documents'))

    await waitFor(() => expect(api.detachDocument).toHaveBeenCalledWith('doc-1'))
    expect(screen.queryByText(/cannot be undone/)).toBeNull()
    expect(api.deleteDocument).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByText('repair-invoice.pdf')).toBeNull())
  })

  it('renames a document in place', async () => {
    api.getTransactionDocuments.mockResolvedValue({ documents: [INVOICE] })
    const user = userEvent.setup()
    render(<DocumentsPanel txnId="t1" />)

    await user.click(await screen.findByLabelText('Rename repair-invoice.pdf'))
    const field = screen.getByLabelText('Document name')
    await user.clear(field)
    await user.type(field, 'Brake job.pdf{Enter}')

    await waitFor(() => expect(api.renameDocument).toHaveBeenCalledWith('doc-1', 'Brake job.pdf'))
  })

  it('offers the stored documents only when there are some, and attaches the one chosen', async () => {
    const user = userEvent.setup()
    const { unmount } = render(<DocumentsPanel txnId="t1" />)
    await findBox()
    await waitFor(() => expect(api.getStoredDocuments).toHaveBeenCalled())
    expect(screen.queryByRole('button', { name: /Stored documents/ })).toBeNull()
    unmount()

    api.getStoredDocuments.mockResolvedValue({ documents: [STORED_QUOTE] })
    render(<DocumentsPanel txnId="t1" />)
    await user.click(await screen.findByRole('button', { name: 'Stored documents (1)' }))
    api.getStoredDocuments.mockResolvedValue({ documents: [] })
    api.getTransactionDocuments.mockResolvedValue({ documents: [STORED_QUOTE] })
    await user.click(screen.getByRole('button', { name: 'Attach garage-quote.pdf' }))

    await waitFor(() => expect(api.attachStoredDocument).toHaveBeenCalledWith('doc-7', 't1'))
    // The picker closes, the document is on the transaction, and the button goes with the last stored one.
    expect(await screen.findByText('garage-quote.pdf')).toBeTruthy()
    await waitFor(() => expect(screen.queryByRole('button', { name: /Stored documents/ })).toBeNull())
  })

  it('fetches once even when the host re-renders it with a fresh callback each time', async () => {
    // The regression this exists for. A host passes `onDocumentsChange` as an inline arrow — a new identity
    // every render — and the report itself patches the host's row, which re-renders the host. With the
    // callback in the fetch's dependencies that is an infinite loop, seen as the panel flashing between
    // its loading and loaded states. Nothing in the tests above could catch it: they pass a stable
    // `vi.fn()`, so the identity never changes and the loop never starts.
    function Host() {
      const [count, setCount] = useState(0)
      return (
        <div>
          <span data-testid="host-count">{count}</span>
          {/* Deliberately inline, and deliberately setting state from the callback. */}
          <DocumentsPanel txnId="t1" onDocumentsChange={next => setCount(next.length)} />
        </div>
      )
    }

    api.getTransactionDocuments.mockResolvedValue({ documents: [INVOICE] })
    render(<Host />)

    await waitFor(() => expect(screen.getByTestId('host-count').textContent).toBe('1'))
    // Drain a few task turns rather than sleeping a fixed span: a loop re-enters through state updates,
    // so it shows up within a handful of them, and a wall-clock wait would be a tax on every suite run.
    for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0))
    expect(api.getTransactionDocuments).toHaveBeenCalledTimes(1)
  })

  it('reports its documents to the host, not merely how many', async () => {
    // The row's paperclip *opens* documents from the host's own copy, so it needs their ids. Reporting
    // a count was enough to draw the marker and not enough to act on it.
    api.getTransactionDocuments.mockResolvedValue({ documents: [INVOICE, PHOTO] })
    const onDocumentsChange = vi.fn()
    render(<DocumentsPanel txnId="t1" onDocumentsChange={onDocumentsChange} />)

    await waitFor(() => expect(onDocumentsChange).toHaveBeenCalledWith([INVOICE, PHOTO]))
  })

  it('reports a replacement even though the count did not change', async () => {
    // Deleting one document and attaching another leaves the count where it started, so a count-keyed
    // report stays silent and the host keeps opening the id it no longer has.
    const REPLACEMENT = { ...INVOICE, id: 'doc-9', filename: 'invoice-v2.html' }
    api.getTransactionDocuments.mockResolvedValue({ documents: [INVOICE] })
    const onDocumentsChange = vi.fn()
    const user = userEvent.setup()
    render(<DocumentsPanel txnId="t1" onDocumentsChange={onDocumentsChange} />)
    await waitFor(() => expect(onDocumentsChange).toHaveBeenCalledWith([INVOICE]))

    api.getTransactionDocuments.mockResolvedValue({ documents: [REPLACEMENT] })
    await user.click(await screen.findByLabelText('Delete repair-invoice.pdf'))
    await user.click(screen.getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(onDocumentsChange).toHaveBeenLastCalledWith([REPLACEMENT]))
  })

  it('reports a rename, which changes what the row lists without changing any id', async () => {
    const RENAMED = { ...INVOICE, filename: 'Brake job.pdf' }
    api.getTransactionDocuments.mockResolvedValue({ documents: [INVOICE] })
    const onDocumentsChange = vi.fn()
    const user = userEvent.setup()
    render(<DocumentsPanel txnId="t1" onDocumentsChange={onDocumentsChange} />)
    await waitFor(() => expect(onDocumentsChange).toHaveBeenCalledWith([INVOICE]))

    api.getTransactionDocuments.mockResolvedValue({ documents: [RENAMED] })
    await user.click(await screen.findByLabelText('Rename repair-invoice.pdf'))
    await user.type(screen.getByLabelText('Document name'), '{Control>}a{/Control}Brake job.pdf{Enter}')

    await waitFor(() => expect(onDocumentsChange).toHaveBeenLastCalledWith([RENAMED]))
  })
})
