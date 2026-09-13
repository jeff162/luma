// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../lib/api.js'
import { buildPastedHtmlPreview } from '../lib/pastedHtmlPreview.js'
import DropZone from './DropZone.jsx'
import DocumentViewerDialog from './DocumentViewerDialog.jsx'
import { AppConfirmDialog, Button, Spinner } from './ui.jsx'
import FeatureExplainer from '../help/FeatureExplainer.jsx'

/*
 * Receipts and invoices attached to one transaction: the list, the attach target, and the viewer.
 *
 * **Attaching is one seam with four ways in.** Dropping a file, browsing for one, pasting an image, and
 * pasting text all end at the same upload. Paste is the whole of the "email me the receipt" story — what
 * arrives by mail is copied out of the client rather than saved first — with no mailbox integration
 * behind it. It lives on a real textarea because that is the only thing browsers will deliver a paste to
 * or offer a right-click "Paste" on; see `handlePaste` for why image and text settle differently.
 *
 * **Uploads are shown per file, not as one busy flag.** Several files can be dropped at once and each
 * settles on its own, so a large scan finishing after a small photo is visible progress rather than a
 * panel that appears stuck. A failure names the file it belongs to, since "that didn't work" is not
 * actionable when three things were dropped.
 *
 * **Detaching asks first.** The file is deleted, not trashed — there is no undo behind it — which is
 * the repo's line for when a confirm is owed.
 *
 * **`onDocumentsChange` reports the list, not a count.** The ledger row opens documents straight from
 * its own copy, so it needs their ids — a count is enough to draw a marker and not enough to act on
 * one, which left a row opening a document that had been replaced.
 */
export default function DocumentsPanel({ txnId, onDocumentsChange }) {
  const [documents, setDocuments] = useState([])
  const [loading, setLoading] = useState(true)
  const [uploads, setUploads] = useState([])
  const [viewing, setViewing] = useState(null)
  const [pendingDetach, setPendingDetach] = useState(null)
  const [pastedText, setPastedText] = useState('')
  const [richPaste, setRichPaste] = useState(null)

  // `onDocumentsChange` is a *notification*, not an input to the fetch, so it is held in a ref rather
  // than depended on. Hosts pass an inline arrow — a new function every render — and depending on its
  // identity turns "tell me what changed" into "refetch on every parent render". That is not merely
  // wasteful: the notification patches the host's row, which re-renders the host, which produces
  // another new arrow, so the panel loops between its loading and loaded states forever.
  const notifyRef = useRef(onDocumentsChange)
  notifyRef.current = onDocumentsChange
  // What was last reported, and for which transaction. Keyed on the document *ids* rather than on how
  // many there are: deleting one and attaching another leaves the count where it started while the
  // host still holds the removed document's id, which it will happily try to open.
  const reported = useRef({ txnId: null, key: null })

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const result = await api.getTransactionDocuments(txnId)
      const rows = result.documents || []
      setDocuments(rows)
      const key = rows.map(row => row.id).join(',')
      if (reported.current.txnId !== txnId || reported.current.key !== key) {
        reported.current = { txnId, key }
        notifyRef.current?.(rows)
      }
    } catch {
      setDocuments([])
    } finally {
      setLoading(false)
    }
  }, [txnId])

  useEffect(() => { load() }, [load])

  const attach = useCallback(async (files) => {
    for (const file of files) {
      const key = `${file.name}-${Date.now()}-${Math.random()}`
      setUploads(prev => [...prev, { key, name: file.name || 'Pasted image', error: null }])
      try {
        // A pasted image is a File named "image.png" at best and "blob" at worst, so it is renamed to
        // something a person will recognize in the list a year from now.
        const named = file.name && file.name !== 'blob' ? undefined : `Pasted ${new Date().toLocaleDateString()}.png`
        await api.attachTransactionDocument(txnId, file, named)
        setUploads(prev => prev.filter(u => u.key !== key))
        await load()
      } catch (err) {
        setUploads(prev => prev.map(u => (u.key === key ? { ...u, error: err.message || 'Upload failed' } : u)))
      }
    }
  }, [txnId, load])

  // The paste target has to be a genuinely editable element, which is the whole reason this is a
  // textarea rather than a handler on the panel. A `paste` event only fires at the *focused* element,
  // and browsers offer "Paste" in the right-click menu only for editable ones — so a listener on a plain
  // div is unreachable by either route, however clearly it is labelled.
  //
  // The two kinds of paste settle differently, and deliberately so. An **image** has nothing to review,
  // so it attaches at once, exactly like a dropped file. **Text** lands in the box first: a receipt
  // pasted out of an email usually arrives wrapped in signature and quoting, and attaching it unseen
  // would store that too. Showing it before it is committed follows the same machine-proposes /
  // user-approves shape the rest of the app uses.
  function handlePaste(event) {
    const files = Array.from(event.clipboardData?.files || [])
    if (files.length) {
      event.preventDefault()
      attach(files)
      return
    }
    // A receipt copied out of an email carries its table as `text/html`, and the plain flavour a textarea
    // receives is that table flattened — every cell on its own line, so an amount ends up under the thing
    // it is the price of rather than beside it. So a paste with real markup is shown *as formatted* and
    // attached as such.
    //
    // That is shown rather than described because the textarea cannot display the markup, and a note
    // saying "the layout you cannot see will be kept, unless you edit what you can see" left no way to
    // know what was about to be stored.
    const html = event.clipboardData?.getData?.('text/html') || ''
    const plain = event.clipboardData?.getData?.('text/plain') || ''
    // Only when the rich flavour actually carries markup. A source can offer a `text/html` flavour that
    // is just the same words again, and storing *that* as HTML would be strictly worse: it renders as a
    // web page while holding nothing the plain text did not, so there is no layout being preserved.
    // And only into an empty box: pasting into text already being edited is an insertion into that text,
    // not a new document, so the browser is left to insert the plain flavour as it normally would.
    if (pastedText.trim() || !plain || !/<[a-z!/]/i.test(html)) return
    // The preview takes the box's place, so the browser's own insertion of the plain flavour is not wanted.
    event.preventDefault()
    setRichPaste({ html, preview: buildPastedHtmlPreview(html) })
  }

  function discardPaste() {
    setPastedText('')
    setRichPaste(null)
  }

  async function attachPaste() {
    const stamp = new Date().toISOString().slice(0, 10)
    let file
    if (richPaste) {
      file = new File([richPaste.html], `Pasted ${stamp}.html`, { type: 'text/html' })
    } else {
      const body = pastedText.trim()
      if (!body) return
      file = new File([body], `Pasted ${stamp}.txt`, { type: 'text/plain' })
    }
    discardPaste()
    await attach([file])
  }

  async function confirmDetach() {
    const target = pendingDetach
    setPendingDetach(null)
    if (!target) return
    await api.detachDocument(target.id)
    await load()
  }

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Documents
        </span>
        <FeatureExplainer topic="transaction-documents" placement="bottom-left" />
      </div>

      {loading ? <Spinner /> : (
        <div style={{ display: 'grid', gap: 4 }}>
          {documents.map(doc => (
            <DocumentRow
              key={doc.id}
              doc={doc}
              onView={() => setViewing(doc)}
              onDetach={() => setPendingDetach(doc)}
            />
          ))}
        </div>
      )}

      {uploads.map(upload => (
        <div key={upload.key} style={{ fontSize: 12, color: upload.error ? 'var(--danger)' : 'var(--muted)' }}>
          {upload.error ? `${upload.name} — ${upload.error}` : `Attaching ${upload.name}…`}
        </div>
      ))}

      <DropZone
        onFiles={attach}
        accept="application/pdf,image/*,text/plain,text/html,message/rfc822,.eml"
        multiple
        padding="16px 12px"
      >
        Drop a receipt or invoice here, or click to browse. A saved email (.eml) works too.
      </DropZone>

      {richPaste ? (
        // `sandbox` with no tokens: no scripts, and an origin that is not this app's. The document it is
        // given carries the rest of the protection — see `lib/pastedHtmlPreview.js`. The white ground is the
        // page an email is written against; the frame is otherwise transparent, and unstyled black text on
        // a dark theme's panel would be unreadable.
        <iframe
          sandbox=""
          srcDoc={richPaste.preview}
          title="Preview of the pasted receipt"
          style={{
            width: '100%', height: 260, boxSizing: 'border-box',
            border: '1px solid var(--border)', borderRadius: 6, background: '#fff',
          }}
        />
      ) : (
        <textarea
          value={pastedText}
          onChange={e => setPastedText(e.target.value)}
          onPaste={handlePaste}
          placeholder="…or paste a receipt here — an image attaches straight away, text can be trimmed first."
          rows={pastedText ? 5 : 2}
          style={{
            width: '100%', boxSizing: 'border-box', resize: 'vertical',
            background: 'var(--surface2)', color: 'var(--text)',
            border: '1px solid var(--border)', borderRadius: 6,
            padding: '6px 8px', fontSize: 13, fontFamily: 'inherit', outline: 'none',
          }}
        />
      )}
      {richPaste || pastedText.trim() ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'flex-end' }}>
          <Button variant="ghost" small onClick={discardPaste}>Discard</Button>
          <Button small onClick={attachPaste}>Attach</Button>
        </div>
      ) : null}

      {viewing ? (
        <DocumentViewerDialog
          document={viewing}
          onClose={() => setViewing(null)}
          onDocumentReplaced={(_, replacement) => { setViewing(replacement); load() }}
        />
      ) : null}

      {pendingDetach ? (
        <AppConfirmDialog
          title="Remove this document?"
          description={`“${pendingDetach.filename}” will be deleted. This cannot be undone.`}
          confirmLabel="Remove"
          confirmVariant="danger"
          onConfirm={confirmDetach}
          onCancel={() => setPendingDetach(null)}
        />
      ) : null}
    </div>
  )
}

function DocumentRow({ doc, onView, onDetach }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '4px 6px', borderRadius: 6, background: 'var(--surface2)',
    }}>
      <button
        type="button"
        onClick={onView}
        title={doc.filename}
        style={{
          flex: 1, minWidth: 0, textAlign: 'left', background: 'none', border: 'none', padding: 0,
          color: 'var(--text)', fontSize: 13, cursor: 'pointer',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}
      >
        {doc.filename}
      </button>
      {/* Only shown when there is text, and it says which tier produced it rather than merely that
          something was extracted — a PDF's own text layer is exact where OCR would be a guess. */}
      {doc.text_source ? (
        <span
          title="This document's text is searchable — type doc: in the transactions filter"
          style={{ fontSize: 11, color: 'var(--muted)' }}
        >
          searchable
        </span>
      ) : null}
      <span style={{ fontSize: 11, color: 'var(--muted)' }}>{formatSize(doc.byte_size)}</span>
      <button
        type="button"
        onClick={onDetach}
        title={`Remove ${doc.filename}`}
        aria-label={`Remove ${doc.filename}`}
        style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 14, padding: '0 2px' }}
      >
        ×
      </button>
    </div>
  )
}

function formatSize(bytes) {
  if (!bytes && bytes !== 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
