// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/* eslint-disable react-refresh/only-export-components -- provider + useAmazonReconciliationViewer hook + nav-bar pill live together by design */

// App-level state for the Amazon reconciliation report. Like the duplicate-detection report, the dialog
// used to live inside the Import/Export page tree and unmounted on navigation; hoisting it here lets the
// user go inspect a transaction (or anything else) with the report still open, or stash it to a nav-bar
// pill and restore it later with its loaded data intact. The generic open/close/reload/minimize/restore
// state machine lives in the shared `useDetachedReportViewer` hook — this file supplies only the batch
// loader, the rendered dialog, and the minimized pill.

import { createContext, lazy, Suspense, useContext, useMemo } from 'react'
import { api } from '../lib/api.js'
import { useDetachedReportViewer } from '../lib/useDetachedReportViewer.js'
import { MinimizedReportPill } from '../components/MinimizedReportPill.jsx'

// Lazy so the floating-panel chrome + table layer stay out of the eager App bundle (loaded the first
// time the user opens the report). The dialog is a named export, so map it to `default` for lazy().
const AmazonReconciliationDialog = lazy(() =>
  import('../components/importExport/AmazonReconciliationDialog.jsx')
    .then(m => ({ default: m.AmazonReconciliationDialog })))

const AmazonReconciliationViewerContext = createContext(null)

export function useAmazonReconciliationViewer() {
  const ctx = useContext(AmazonReconciliationViewerContext)
  if (!ctx) {
    throw new Error('useAmazonReconciliationViewer must be used inside <AmazonReconciliationViewerProvider>')
  }
  return ctx
}

// The whole reconciliation payload for a batch — the dialog derives its buckets from this. `_version`
// advances on every (re)load so a page watching it can refresh the file card's "N to resolve" count after
// the user resolves items in the floating report.
const loadReconciliation = async (params, prev) => ({
  ...(await api.getAmazonReconciliation(params.batchId)),
  _version: (prev?._version ?? -1) + 1,
})

export function AmazonReconciliationViewerProvider({ children }) {
  const { viewer, open, reload, close, minimize, restore } = useDetachedReportViewer(loadReconciliation)
  const value = useMemo(
    () => ({ viewer, open, reload, close, minimize, restore }),
    [viewer, open, reload, close, minimize, restore])
  return (
    <AmazonReconciliationViewerContext.Provider value={value}>
      {children}
    </AmazonReconciliationViewerContext.Provider>
  )
}

// Mounted once near the top of the App tree so the dialog survives route changes.
export function AmazonReconciliationViewerRenderer() {
  const { viewer, close, reload, minimize } = useAmazonReconciliationViewer()
  if (!viewer || viewer.minimized) return null
  return (
    <Suspense fallback={null}>
      <AmazonReconciliationDialog
        data={viewer.data}
        loading={!!viewer.loading}
        error={viewer.error || ''}
        onClose={close}
        onReload={reload}
        onMinimize={minimize}
      />
    </Suspense>
  )
}

// Styled as a chip (not a NavLink) so users don't mistake it for a permanent page entry. Badge counts
// the rows that still need attention — ambiguous duplicate charges + orders with no charge found.
export function MinimizedAmazonReconciliationNavItem() {
  const { viewer, restore } = useAmazonReconciliationViewer()
  if (!viewer || !viewer.minimized) return null
  const title = viewer.params?.title || ''
  const data = viewer.data
  const problemCount = (data?.duplicate?.length || 0) + (data?.amazon_unmatched?.length || 0)
  return (
    <MinimizedReportPill
      label={title ? `Amazon reconciliation — ${title}` : 'Amazon reconciliation'}
      badgeCount={problemCount}
      title={`Restore Amazon reconciliation report${title ? ` — ${title}` : ''} (${problemCount} to resolve)`}
      onRestore={restore}
    />
  )
}
