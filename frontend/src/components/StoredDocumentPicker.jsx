// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { formatTimestamp } from '../lib/utils.js'
import DocumentViewerDialog from './DocumentViewerDialog.jsx'
import { AppDialog, Button } from './ui.jsx'

/*
 * Choosing a stored document to attach to a transaction.
 *
 * Only attaching happens here. Renaming, editing and deleting stored documents belong to the stored-documents
 * dialog on the Transactions page, which is where the store is managed; this is the moment an invoice kept
 * earlier meets the charge it describes, and the one question it asks is *which one*. A name can be opened to
 * check before choosing, since `documentation.png` three times over is not an answer on its own.
 *
 * Newest first, as the store lists them. Portalled, because it is opened from inside a detail panel.
 */
export default function StoredDocumentPicker({ documents, onAttach, onClose }) {
  const [viewing, setViewing] = useState(null)
  const [error, setError] = useState(null)
  // A ref rather than state, because a same-tick double press sees the state from before the first one.
  const busy = useRef(false)

  async function attach(doc) {
    if (busy.current) return
    busy.current = true
    setError(null)
    try {
      await onAttach(doc)
      onClose()
    } catch (err) {
      setError(err.message || 'That document could not be attached.')
    } finally {
      busy.current = false
    }
  }

  return createPortal(
    <>
      <AppDialog
        title="Attach a stored document"
        onClose={onClose}
        dismissOnBackdrop
        width="min(560px, 100%)"
        actions={<Button variant="secondary" onClick={onClose}>Cancel</Button>}
      >
        {error ? <div style={{ fontSize: 13, color: 'var(--danger)' }}>{error}</div> : null}
        <div style={{ display: 'grid', gap: 4 }}>
          {documents.map(doc => (
            <div
              key={doc.id}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '4px 6px', borderRadius: 6, background: 'var(--surface2)',
              }}
            >
              <button
                type="button"
                onClick={() => setViewing(doc)}
                title={`Open ${doc.filename}`}
                style={{
                  flex: 1, minWidth: 0, textAlign: 'left', background: 'none', border: 'none', padding: 0,
                  color: 'var(--text)', fontSize: 13, cursor: 'pointer',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}
              >
                {doc.filename}
              </button>
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>{formatTimestamp(doc.created_at)}</span>
              <Button size="compact" onClick={() => attach(doc)} aria-label={`Attach ${doc.filename}`}>
                Attach
              </Button>
            </div>
          ))}
        </div>
      </AppDialog>
      {viewing ? <DocumentViewerDialog document={viewing} onClose={() => setViewing(null)} /> : null}
    </>,
    document.body,
  )
}
