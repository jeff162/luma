// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../lib/api.js'
import { AppDialog, Button } from './ui.jsx'
import { vh } from '../lib/displaySize.js'

/*
 * Viewing an attached receipt or invoice, and editing one that is plain text.
 *
 * The bytes never pass through JavaScript for viewing: the element points straight at the document's own
 * URL and the browser renders it. That is what keeps a 20 MB scan from being read into memory to be looked
 * at, and it is why the endpoint's `Content-Type` has to be the one recorded at ingest — this component
 * makes no decision about what the file is beyond picking an element for it.
 *
 * PDFs go in an `<iframe>` because that is the only way to reach the browser's own PDF viewer, with its
 * paging and text selection. The server sends a sandbox CSP with the file, so the embedded viewer
 * cannot script against this origin — the reason that header exists rather than being belt-and-braces.
 *
 * **The file is asked for one byte first** (`api.probeDocumentFile`), because neither element exposes an
 * error response: a file that is missing or that the server cannot read would otherwise show as a blank.
 * The server's message is shown in its place.
 *
 * There is no in-app zoom, rotate or page control, deliberately: every browser already ships those for
 * both element types, and "Open in a new tab" hands the document to the full viewer for anything more.
 *
 * **Editing is offered for `text/plain` only, and a saved edit is a different document.** The server
 * replaces rather than rewrites (see `replace_document_text`), so the answer carries a new id and
 * `onDocumentReplaced(previousId, replacement)` is how a host learns it. A host must swap the id in
 * whatever copy it opens documents from — the ledger row keeps its own — or its next open reaches for a
 * document that no longer exists. A host that does not pass the callback gets a viewer with no Edit.
 * `openInEdit` opens straight into the editor, for a host whose own control already said "edit".
 */
export default function DocumentViewerDialog({ document: doc, onClose, onDocumentReplaced, openInEdit = false }) {
  // null while viewing; while editing, the text as loaded and as it now stands.
  const [editing, setEditing] = useState(null)
  const [error, setError] = useState(null)
  // A ref rather than state, because a same-tick double press sees the state from before the first one.
  const busy = useRef(false)

  // null until the probe answers, then 'ok' or the server's message for a file it cannot serve.
  const [fileState, setFileState] = useState(null)
  const unservable = fileState !== null && fileState !== 'ok'

  const canEdit = doc?.mime_type === 'text/plain' && !!onDocumentReplaced

  useEffect(() => {
    if (!doc?.id) return undefined
    let current = true
    setFileState(null)
    api.probeDocumentFile(doc.id)
      .then(() => { if (current) setFileState('ok') })
      .catch(err => { if (current) setFileState(err.message || 'This document could not be opened.') })
    return () => { current = false }
  }, [doc?.id])

  useEffect(() => {
    if (openInEdit && canEdit) startEditing()
    // Only on opening: an edit that is saved or cancelled must not reopen the editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!doc) return null

  const fileUrl = api.documentFileUrl(doc.id)
  // PDFs and text both go to an iframe: it is how the browser's own viewer is reached for one,
  // and how the other is rendered as text without the bytes passing through JavaScript.
  const isImage = (doc.mime_type || '').startsWith('image/')

  async function startEditing() {
    if (busy.current) return
    busy.current = true
    setError(null)
    try {
      const text = await api.getDocumentText(doc.id)
      setEditing({ original: text, draft: text })
    } catch (err) {
      setError(err.message || 'This document could not be opened for editing.')
    } finally {
      busy.current = false
    }
  }

  function cancelEditing() {
    setEditing(null)
    setError(null)
  }

  async function saveEdit() {
    if (busy.current || !editing) return
    if (editing.draft === editing.original) {
      setEditing(null)
      return
    }
    busy.current = true
    setError(null)
    try {
      const result = await api.editDocumentText(doc.id, editing.draft)
      setEditing(null)
      onDocumentReplaced(doc.id, result.document)
    } catch (err) {
      // The draft stays on screen, so a refused or failed save costs nothing that was typed.
      setError(err.message || 'The edit could not be saved.')
    } finally {
      busy.current = false
    }
  }

  // **Portalled to the body, and that is load-bearing rather than tidy.** `AppDialog` renders where it
  // is mounted, which is fine for every caller that opens one from a page-level component — but this one
  // is also opened from a *ledger row*, and a `position: fixed` overlay inside a table is positioned and
  // stacked against whatever ancestor established a containing block, not the viewport. Opened that way
  // it surfaced underneath the page header with its own title bar cut off. A modal has no business being
  // clipped by whatever happened to render it, so it escapes to the body wherever it is opened from.
  return createPortal(
    <AppDialog
      onClose={onClose}
      title={doc.filename}
      width="min(920px, 100%)"
      actions={editing ? (
        <>
          <Button variant="secondary" onClick={cancelEditing}>Cancel</Button>
          <Button onClick={saveEdit}>Save</Button>
        </>
      ) : (
        <>
          {canEdit ? <Button variant="secondary" onClick={startEditing}>Edit</Button> : null}
          {/* Plain links, not a fetch-and-save: the browser is already able to stream this to disk,
              and routing it through JavaScript would only add a copy in memory. A file the server
              could not open has no link, since a disabled button inside one still follows it. */}
          {unservable ? (
            <>
              <Button variant="secondary" disabled>Download</Button>
              <Button variant="secondary" disabled>Open in a new tab</Button>
            </>
          ) : (
            <>
              <a
                href={api.documentFileUrl(doc.id, { download: true })}
                style={{ textDecoration: 'none' }}
              >
                <Button variant="secondary">Download</Button>
              </a>
              <a href={fileUrl} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}>
                <Button variant="secondary">Open in a new tab</Button>
              </a>
            </>
          )}
          <Button onClick={onClose}>Close</Button>
        </>
      )}
    >
      {error ? (
        <div style={{ fontSize: 13, color: 'var(--danger)', marginBottom: 8 }}>{error}</div>
      ) : null}
      {editing ? (
        <textarea
          aria-label="Document text"
          value={editing.draft}
          onChange={e => {
            const draft = e.target.value
            setEditing(prev => (prev ? { ...prev, draft } : prev))
          }}
          style={{
            width: '100%', height: vh(70), boxSizing: 'border-box', resize: 'vertical',
            background: 'var(--surface2)', color: 'var(--text)',
            border: '1px solid var(--border)', borderRadius: 8,
            padding: '8px 10px', fontSize: 13, fontFamily: 'monospace', outline: 'none',
          }}
        />
      ) : (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'var(--surface2)', borderRadius: 8, minHeight: 360,
        }}>
          {fileState === null ? null : unservable ? (
            <div role="alert" style={{ fontSize: 13, color: 'var(--danger)', padding: 20, maxWidth: 520 }}>{fileState}</div>
          ) : isImage ? (
            <img
              src={fileUrl}
              alt={doc.filename}
              style={{ maxWidth: '100%', maxHeight: vh(70), objectFit: 'contain', borderRadius: 8 }}
            />
          ) : (
            <iframe
              src={fileUrl}
              aria-label={doc.filename}
              style={{ width: '100%', height: vh(70), border: 'none', borderRadius: 8, background: 'var(--surface)' }}
            />
          )}
        </div>
      )}
    </AppDialog>,
    document.body,
  )
}
