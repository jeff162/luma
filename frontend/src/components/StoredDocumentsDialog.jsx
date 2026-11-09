// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from 'react'
import { api } from '../lib/api.js'
import FeatureExplainer from '../help/FeatureExplainer.jsx'
import DocumentAttachTarget from './DocumentAttachTarget.jsx'
import DocumentList from './DocumentList.jsx'
import { Button } from './ui.jsx'
import FloatingDialog from './FloatingDialog.jsx'

/*
 * The stored documents: paperwork kept before the transaction it belongs to has arrived.
 *
 * Adding, naming, editing and deleting happen here; attaching does not. A document meets its transaction
 * from the transaction's own Documents section, because that is when the charge is on screen — a picker of
 * transactions here would be a second, worse way to find a row the ledger already finds.
 *
 * A document added alone opens its name for editing, since it arrived by drop or paste without one worth
 * keeping and the name is what it will be picked by later. Several dropped at once are left as they came
 * rather than chasing the last of them.
 *
 * `documents` and `reload` come from the host's `useStoredDocuments`, which is already counting them.
 */
export default function StoredDocumentsDialog({ documents, reload, onClose }) {
  const [renameId, setRenameId] = useState(null)

  return (
    // Floating, so a document can be compared with the ledger while it waits for its transaction.
    <FloatingDialog
      panelKey="ui.storedDocuments.panel"
      title="Stored documents"
      help={<FeatureExplainer topic="transaction-documents" placement="bottom-left" />}
      description="Receipts and invoices kept until their transaction arrives. Attach one from that transaction's Documents section."
      onClose={onClose}
      width={640}
      actions={<Button onClick={onClose}>Close</Button>}
    >
      <DocumentList documents={documents || []} onChange={reload} renameId={renameId} />
      {documents?.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--muted)' }}>No stored documents.</div>
      ) : null}
      <DocumentAttachTarget
        upload={api.storeDocument}
        commitLabel="Store"
        onUploaded={async (result, { batchSize }) => {
          // A file already stored keeps the name it was given; see above for why only a lone one is offered.
          if (batchSize === 1 && !result.already_stored) setRenameId(result.document.id)
          await reload()
        }}
      />
    </FloatingDialog>
  )
}
