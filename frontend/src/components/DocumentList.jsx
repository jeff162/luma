// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../lib/api.js'
import { useTransientTextEdit } from '../lib/uiInteractions.js'
import DocumentViewerDialog from './DocumentViewerDialog.jsx'
import TransientTextInput from './TransientTextInput.jsx'
import { AppConfirmDialog, IconButton, LinkButton } from './ui.jsx'
import { formatDecimal } from '../lib/displayFormat.js'

/*
 * A list of documents and everything done to one in place: view, rename, edit its text, and take it away.
 *
 * Shared by a transaction's Documents section and the stored-documents dialog, which offer the same actions
 * on the same noun and differ in one: only a document *on* a transaction can be moved off it.
 *
 * **Two ways to take a document away, styled by what each can undo.** `×` (when `detachable`) moves it to
 * the stored documents — the answer to "attached to the wrong transaction", reversible by attaching it
 * again, so it asks nothing. The bin deletes the file, which nothing can bring back, so it confirms first
 * and only that confirm is red.
 *
 * Every change is reported through `onChange`, and the host reloads: a rename, a move or an edit can each
 * change what the host holds (an edit replaces the document under a new id).
 *
 * `renameId` opens that document's name for editing as it arrives — a document added to the store was
 * dropped or pasted without a chance to name it, and a name is what it will be found by later.
 */
export default function DocumentList({ documents, onChange, detachable = false, renameId = null }) {
  const [viewing, setViewing] = useState(null)
  const [pendingDelete, setPendingDelete] = useState(null)
  const [error, setError] = useState(null)

  async function act(work) {
    setError(null)
    try {
      await work()
      await onChange?.()
    } catch (err) {
      setError(err.message || 'That did not work.')
    }
  }

  async function confirmDelete() {
    const target = pendingDelete
    setPendingDelete(null)
    if (target) await act(() => api.deleteDocument(target.id))
  }

  return (
    <div style={{ display: 'grid', gap: 4 }}>
      {documents.map(doc => (
        <DocumentRow
          key={doc.id}
          doc={doc}
          startRenaming={doc.id === renameId}
          onView={() => setViewing({ doc, openInEdit: false })}
          onEdit={doc.mime_type === 'text/plain' ? () => setViewing({ doc, openInEdit: true }) : null}
          onRename={filename => act(() => api.renameDocument(doc.id, filename))}
          onDetach={detachable ? () => act(() => api.detachDocument(doc.id)) : null}
          onDelete={() => setPendingDelete(doc)}
        />
      ))}
      {error ? <div style={{ fontSize: 12, color: 'var(--danger)' }}>{error}</div> : null}

      {viewing ? (
        <DocumentViewerDialog
          // Keyed so a replacement (a saved edit) opens as a fresh viewer rather than re-entering the editor.
          key={viewing.doc.id}
          document={viewing.doc}
          openInEdit={viewing.openInEdit}
          onClose={() => setViewing(null)}
          onDocumentReplaced={(_, replacement) => {
            setViewing({ doc: replacement, openInEdit: false })
            onChange?.()
          }}
        />
      ) : null}

      {/* Portalled for the reason the viewer is: this list is mounted inside other dialogs and panels, and an
          overlay rendered in place is positioned against whatever ancestor happens to contain it. */}
      {pendingDelete ? createPortal(
        <AppConfirmDialog
          title="Delete this document?"
          description={`“${pendingDelete.filename}” will be deleted. This cannot be undone.`}
          confirmLabel="Delete"
          confirmVariant="danger"
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(null)}
        />,
        document.body,
      ) : null}
    </div>
  )
}

function DocumentRow({ doc, startRenaming, onView, onEdit, onRename, onDetach, onDelete }) {
  const name = useTransientTextEdit(doc.filename, { onCommit: onRename })

  useEffect(() => {
    if (startRenaming) name.beginEdit()
    // Once, when the row arrives asking for it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startRenaming])

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '4px 6px', borderRadius: 6, background: 'var(--surface2)',
    }}>
      {name.editing ? (
        <TransientTextInput
          aria-label="Document name"
          value={name.draft}
          onChange={name.setDraft}
          onCommit={name.commitEdit}
          onCancel={name.cancelEdit}
          restoreOnEscape
          style={{
            flex: 1, minWidth: 0, fontSize: 13, padding: '2px 6px', borderRadius: 4,
            border: '1px solid var(--accent)', background: 'var(--surface)', color: 'var(--text)',
          }}
          onFocus={event => {
            // The name is selected up to its extension, which is the part someone renaming means to change.
            const dot = event.target.value.lastIndexOf('.')
            event.target.setSelectionRange(0, dot > 0 ? dot : event.target.value.length)
          }}
        />
      ) : (
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
      )}
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
      <IconButton size="compact" onClick={() => name.beginEdit()} title="Rename" aria-label={`Rename ${doc.filename}`}>
        ✎
      </IconButton>
      {onEdit ? (
        <LinkButton tone="muted" onClick={onEdit} title="Edit the text" aria-label={`Edit the text of ${doc.filename}`} style={{ fontSize: 12 }}>
          Edit
        </LinkButton>
      ) : null}
      {onDetach ? (
        <IconButton size="compact" onClick={onDetach} title="Move to stored documents" aria-label={`Move ${doc.filename} to stored documents`}>
          ×
        </IconButton>
      ) : null}
      <IconButton size="compact" tone="danger" onClick={onDelete} title="Delete permanently" aria-label={`Delete ${doc.filename}`}>
        🗑
      </IconButton>
    </div>
  )
}

function formatSize(bytes) {
  if (!bytes && bytes !== 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${formatDecimal(bytes / (1024 * 1024), 1)} MB`
}
