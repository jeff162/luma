// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/* eslint-disable react-refresh/only-export-components -- provider + useReconciliationViewer hook + nav-bar pill live together by design */

// App-level state for the reconciliation reports — one viewer for every vendor, opened with
// `open({ vendor, batchId, title })`. Like the duplicate-detection report, the dialog is hoisted out of the
// page tree so the user can go inspect a transaction with the report still open, or stash it to a nav-bar
// pill and restore it later with its loaded data intact. The generic open/close/reload/minimize/restore
// state machine lives in the shared `useDetachedReportViewer` hook; how each vendor's report is fetched and
// named lives in RECONCILIATION_REPORTS.

import { createContext, lazy, Suspense, useContext, useMemo } from 'react'
import { useDetachedReportViewer } from '../lib/useDetachedReportViewer.js'
import { RECONCILIATION_REPORTS } from '../lib/reconciliationReports.js'
import { MinimizedReportPill } from '../components/MinimizedReportPill.jsx'

// Lazy so the floating-panel chrome, the table layer and every vendor's presentation stay out of the eager
// App bundle (loaded the first time a report opens). Named export, so map it to `default` for lazy().
const ReconciliationReportDialog = lazy(() =>
  import('../components/importExport/reconciliation/ReconciliationReportDialog.jsx')
    .then(m => ({ default: m.ReconciliationReportDialog })))

const ReconciliationViewerContext = createContext(null)

export function useReconciliationViewer() {
  const ctx = useContext(ReconciliationViewerContext)
  if (!ctx) {
    throw new Error('useReconciliationViewer must be used inside <ReconciliationViewerProvider>')
  }
  return ctx
}

// The whole report payload — the dialog derives its buckets from this. `version` advances on every load,
// the first included, so a page watching it refreshes its file cards' "N to resolve" counts whenever the
// report is opened or reloaded (see `lib/useDetachedReportViewer.js`).
const loadReport = async (params, prev) => ({
  ...(await RECONCILIATION_REPORTS[params.vendor].load(params)),
  version: (prev?.version ?? 0) + 1,
})

export function ReconciliationViewerProvider({ children }) {
  const { viewer, open, reload, close, minimize, restore } = useDetachedReportViewer(loadReport)
  const value = useMemo(
    () => ({ viewer, open, reload, close, minimize, restore }),
    [viewer, open, reload, close, minimize, restore])
  return (
    <ReconciliationViewerContext.Provider value={value}>
      {children}
    </ReconciliationViewerContext.Provider>
  )
}

// Mounted once near the top of the App tree so the dialog survives route changes.
export function ReconciliationViewerRenderer() {
  const { viewer, close, reload, minimize } = useReconciliationViewer()
  if (!viewer || viewer.minimized) return null
  const vendor = viewer.params.vendor
  return (
    <Suspense fallback={null}>
      <ReconciliationReportDialog
        key={vendor}
        vendor={vendor}
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

// Styled as a chip (not a NavLink) so users don't mistake it for a permanent page entry. The badge counts
// the rows the vendor says still need resolving.
export function MinimizedReconciliationNavItem() {
  const { viewer, restore } = useReconciliationViewer()
  if (!viewer || !viewer.minimized) return null
  const report = RECONCILIATION_REPORTS[viewer.params.vendor]
  const title = viewer.params.title || ''
  const problemCount = report.problemCount(viewer.data)
  return (
    <MinimizedReportPill
      label={title ? `${report.title} — ${title}` : report.title}
      badgeCount={problemCount}
      title={`Restore ${report.title} report${title ? ` — ${title}` : ''} (${problemCount} to resolve)`}
      onRestore={restore}
    />
  )
}
