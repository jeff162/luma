// @vitest-environment jsdom

// The documents panel's own behavior, as distinct from the store's.
//
// Three things are worth pinning here because nothing else can catch them: that the three ways of
// attaching (drop, browse, paste) all reach one upload, that a paste carrying no file is left alone —
// otherwise the panel would swallow ordinary text pastes anywhere inside it — and that a failed upload
// names the file it belongs to rather than reporting a bare "that didn't work" when several were
// dropped at once.
//
// Detaching is asserted through its confirm, since the file is deleted rather than trashed and the
// confirm is the only thing standing between a click and an unrecoverable loss.

import { useState } from 'react'
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import DocumentsPanel from '../DocumentsPanel.jsx'
import { api } from '../../lib/api.js'

vi.mock('../../lib/api.js', () => ({
  api: {
    getTransactionDocuments: vi.fn(),
    attachTransactionDocument: vi.fn(),
    detachDocument: vi.fn(),
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
  // has to be dispatched directly.
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', {
    value: { files: [], getData: type => flavours[type] || '' },
  })
  element.dispatchEvent(event)
  // The textarea would receive the plain flavour itself; jsdom does not do that for a synthetic event.
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setValue.call(element, flavours['text/plain'] || '')
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

function pdfFile(name = 'invoice.pdf') {
  return new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], name, { type: 'application/pdf' })
}

beforeEach(() => {
  api.getTransactionDocuments.mockResolvedValue({ documents: [] })
  api.attachTransactionDocument.mockResolvedValue({ document: INVOICE, already_attached: false })
  api.detachDocument.mockResolvedValue({ ok: true })
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
    await screen.findByText(/Drop a receipt/)

    await user.upload(container.querySelector('input[type="file"]'), pdfFile())

    await waitFor(() => expect(api.attachTransactionDocument).toHaveBeenCalledTimes(1))
    expect(api.attachTransactionDocument.mock.calls[0][0]).toBe('t1')
  })

  it('uploads files dropped onto the zone', async () => {
    render(<DocumentsPanel txnId="t1" />)
    const zone = await screen.findByText(/Drop a receipt/)

    const file = pdfFile('dropped.pdf')
    const event = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', { value: { files: [file] } })
    zone.closest('[role="button"]').dispatchEvent(event)

    await waitFor(() => expect(api.attachTransactionDocument).toHaveBeenCalledTimes(1))
  })

  it('attaches a pasted image straight away, with a name of its own', async () => {
    // Paste is the whole of the "email me the receipt" story. An image has nothing to review, so it
    // settles exactly like a dropped file.
    render(<DocumentsPanel txnId="t1" />)
    const box = await screen.findByPlaceholderText(/paste a receipt here/i)

    const file = new File([new Uint8Array([0xff, 0xd8, 0xff])], 'blob', { type: 'image/jpeg' })
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: { files: [file] } })
    box.dispatchEvent(event)

    await waitFor(() => expect(api.attachTransactionDocument).toHaveBeenCalledTimes(1))
    // A pasted image has no useful name of its own; without this every paste lands as "blob".
    expect(api.attachTransactionDocument.mock.calls[0][2]).toMatch(/^Pasted /)
  })

  it('lets pasted text be trimmed before it is attached', async () => {
    // Text pasted out of an email arrives wrapped in signature and quoting, so it lands in the box
    // first. Attaching it unseen would store all of that.
    const user = userEvent.setup()
    render(<DocumentsPanel txnId="t1" />)
    const box = await screen.findByPlaceholderText(/paste a receipt here/i)

    await user.click(box)
    await user.paste('ACME Auto Repair — brake pads 249.50')
    // Nothing is sent while it is still on screen to edit.
    expect(api.attachTransactionDocument).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Attach' }))

    await waitFor(() => expect(api.attachTransactionDocument).toHaveBeenCalledTimes(1))
    const sent = api.attachTransactionDocument.mock.calls[0][1]
    expect(sent.type).toBe('text/plain')
    expect(await sent.text()).toBe('ACME Auto Repair — brake pads 249.50')
  })

  it('keeps the layout when a paste carries a rich flavour and is left alone', async () => {
    // A receipt copied out of an email carries its table as text/html; the plain flavour a textarea
    // receives is that table flattened, with every amount on a line below the thing it prices.
    render(<DocumentsPanel txnId="t1" />)
    const box = await screen.findByPlaceholderText(/paste a receipt here/i)

    pasteInto(box, {
      'text/plain': 'Professional Tune Up\n1\t$350.00',
      'text/html': '<table><tr><td>Professional Tune Up</td><td>1</td><td>$350.00</td></tr></table>',
    })

    await screen.findByText(/Keeps the layout from the original/)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Attach' }))

    await waitFor(() => expect(api.attachTransactionDocument).toHaveBeenCalledTimes(1))
    const sent = api.attachTransactionDocument.mock.calls[0][1]
    expect(sent.type).toBe('text/html')
    expect(await sent.text()).toContain('<table>')
  })

  it('stores the edited text once the box has been touched', async () => {
    // Editing is an unambiguous statement that the text is what was wanted; attaching markup that still
    // carries the unedited content would store the very thing just removed.
    const user = userEvent.setup()
    render(<DocumentsPanel txnId="t1" />)
    const box = await screen.findByPlaceholderText(/paste a receipt here/i)

    pasteInto(box, {
      'text/plain': 'Professional Tune Up\n1\t$350.00',
      'text/html': '<table><tr><td>Professional Tune Up</td><td>1</td><td>$350.00</td></tr></table>',
    })
    await screen.findByText(/Keeps the layout from the original/)

    await user.type(box, ' — front derailleur')

    expect(screen.queryByText(/Keeps the layout from the original/)).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Attach' }))

    const sent = api.attachTransactionDocument.mock.calls[0][1]
    expect(sent.type).toBe('text/plain')
    expect(await sent.text()).toContain('front derailleur')
  })

  it('discards pasted text without attaching it', async () => {
    const user = userEvent.setup()
    render(<DocumentsPanel txnId="t1" />)
    const box = await screen.findByPlaceholderText(/paste a receipt here/i)

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
    await screen.findByText(/Drop a receipt/)

    await user.upload(container.querySelector('input[type="file"]'), pdfFile('huge-scan.pdf'))

    expect(await screen.findByText(/huge-scan\.pdf — That file is larger/)).toBeTruthy()
  })

  it('confirms before detaching, and does nothing if the confirm is dismissed', async () => {
    api.getTransactionDocuments.mockResolvedValue({ documents: [INVOICE] })
    const user = userEvent.setup()
    render(<DocumentsPanel txnId="t1" />)

    await user.click(await screen.findByLabelText('Remove repair-invoice.pdf'))
    expect(screen.getByText(/cannot be undone/)).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(api.detachDocument).not.toHaveBeenCalled()

    await user.click(screen.getByLabelText('Remove repair-invoice.pdf'))
    await user.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(api.detachDocument).toHaveBeenCalledWith('doc-1'))
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
    await user.click(await screen.findByLabelText('Remove repair-invoice.pdf'))
    await user.click(screen.getByRole('button', { name: 'Remove' }))

    await waitFor(() => expect(onDocumentsChange).toHaveBeenLastCalledWith([REPLACEMENT]))
  })
})
