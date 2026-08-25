// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createPortal } from 'react-dom'
import { api } from '../lib/api.js'
import { AppDialog, Button } from './ui.jsx'

/*
 * Viewing an attached receipt or invoice.
 *
 * The bytes never pass through JavaScript: the element points straight at the document's own URL and
 * the browser renders it. That is what keeps a 20 MB scan from being read into memory to be looked at,
 * and it is why the endpoint's `Content-Type` has to be the one recorded at ingest — this component
 * makes no decision about what the file is beyond picking an element for it.
 *
 * PDFs go in an `<iframe>` because that is the only way to reach the browser's own PDF viewer, with its
 * paging and text selection. The server sends a sandbox CSP with the file, so the embedded viewer
 * cannot script against this origin — the reason that header exists rather than being belt-and-braces.
 *
 * There is no in-app zoom, rotate or page control, deliberately: every browser already ships those for
 * both element types, and "Open in a new tab" hands the document to the full viewer for anything more.
 */
export default function DocumentViewerDialog({ document: doc, onClose }) {
  if (!doc) return null

  const fileUrl = api.documentFileUrl(doc.id)
  // PDFs and text both go to an iframe: it is how the browser's own viewer is reached for one,
  // and how the other is rendered as text without the bytes passing through JavaScript.
  const isImage = (doc.mime_type || '').startsWith('image/')

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
      actions={
        <>
          {/* A plain link, not a fetch-and-save: the browser is already able to stream this to disk,
              and routing it through JavaScript would only add a copy in memory. */}
          <a
            href={api.documentFileUrl(doc.id, { download: true })}
            style={{ textDecoration: 'none' }}
          >
            <Button variant="ghost">Download</Button>
          </a>
          <a href={fileUrl} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}>
            <Button variant="ghost">Open in a new tab</Button>
          </a>
          <Button onClick={onClose}>Close</Button>
        </>
      }
    >
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'var(--surface2)', borderRadius: 8, minHeight: 360,
      }}>
        {isImage ? (
          <img
            src={fileUrl}
            alt={doc.filename}
            style={{ maxWidth: '100%', maxHeight: '70vh', objectFit: 'contain', borderRadius: 8 }}
          />
        ) : (
          <iframe
            src={fileUrl}
            title={doc.filename}
            style={{ width: '100%', height: '70vh', border: 'none', borderRadius: 8, background: 'var(--surface)' }}
          />
        )}
      </div>
    </AppDialog>,
    document.body,
  )
}
