// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../lib/api.js'
import { useStoredDocuments } from '../lib/useStoredDocuments.js'
import DocumentAttachTarget from './DocumentAttachTarget.jsx'
import DocumentList from './DocumentList.jsx'
import StoredDocumentPicker from './StoredDocumentPicker.jsx'
import { Button, Spinner } from './ui.jsx'
import FeatureExplainer from '../help/FeatureExplainer.jsx'

/*
 * Receipts and invoices attached to one transaction: the list, and the ways to add one.
 *
 * The list and what can be done to each document are `DocumentList`'s; adding one is
 * `DocumentAttachTarget`'s. What this panel adds is the transaction: uploads go to it, and **Stored
 * documents (N)** attaches one kept earlier — an invoice that arrived before its charge was imported. That
 * button appears only when there is something stored, so a ledger that never uses the store never sees it.
 *
 * **`onDocumentsChange` reports the list, not a count.** The ledger row opens documents straight from
 * its own copy, so it needs their ids — a count is enough to draw a marker and not enough to act on
 * one, which left a row opening a document that had been replaced.
 */
export default function DocumentsPanel({ txnId, onDocumentsChange }) {
  const [documents, setDocuments] = useState([])
  // Which transaction the list on screen belongs to, so a reload keeps it while a new transaction waits.
  const [loadedFor, setLoadedFor] = useState(null)
  const [picking, setPicking] = useState(false)
  const { documents: storedDocuments, reload: reloadStored } = useStoredDocuments()

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
    try {
      const result = await api.getTransactionDocuments(txnId)
      const rows = result.documents || []
      setDocuments(rows)
      // Names too, not only ids: a rename changes what the row's marker lists.
      const key = rows.map(row => `${row.id}:${row.filename}`).join(',')
      if (reported.current.txnId !== txnId || reported.current.key !== key) {
        reported.current = { txnId, key }
        notifyRef.current?.(rows)
      }
    } catch {
      setDocuments([])
    } finally {
      setLoadedFor(txnId)
    }
  }, [txnId])

  useEffect(() => { load() }, [load])

  // A move changes both lists, and the stored count would otherwise wait out the mutation signal's debounce.
  const reloadBoth = useCallback(async () => {
    await Promise.all([load(), reloadStored()])
  }, [load, reloadStored])

  const storedCount = storedDocuments?.length || 0

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Documents
        </span>
        <FeatureExplainer topic="transaction-documents" placement="bottom-left" />
      </div>

      {/* Kept on screen through a reload: a rename or a move re-fetches, and a spinner in place of the list
          would flash for a request that returns in milliseconds. */}
      {loadedFor !== txnId ? <Spinner /> : (
        <DocumentList documents={documents} onChange={reloadBoth} detachable />
      )}

      <DocumentAttachTarget
        upload={file => api.attachTransactionDocument(txnId, file)}
        onUploaded={load}
        actions={storedCount > 0 ? (
          <Button variant="secondary" size="compact" onClick={() => setPicking(true)}>
            Stored documents ({storedCount})
          </Button>
        ) : null}
      />

      {picking ? (
        <StoredDocumentPicker
          documents={storedDocuments || []}
          onAttach={async doc => {
            await api.attachStoredDocument(doc.id, txnId)
            await reloadBoth()
          }}
          onClose={() => setPicking(false)}
        />
      ) : null}
    </div>
  )
}
