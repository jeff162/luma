// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/* eslint-disable react-refresh/only-export-components -- provider + useAmazonImportDetailViewer hook + nav-bar pill live together by design */

// App-level state for the Amazon import-detail report (the investigative "what did this import do" view).
// Hoisted out of the page tree like the reconciliation report so it floats free, survives navigation, and
// minimizes to a nav-bar pill. The generic open/close/reload/minimize/restore machine lives in the shared
// `useDetachedReportViewer` hook; this file supplies the batch loader, the rendered dialog, and the pill.
// Opened from a card pill with a `category` so it lands on that view (orders / discarded / duplicates / …).

import { createContext, lazy, Suspense, useContext, useMemo } from 'react'
import { api } from '../lib/api.js'
import { useDetachedReportViewer } from '../lib/useDetachedReportViewer.js'
import { MinimizedReportPill } from '../components/MinimizedReportPill.jsx'

const AmazonImportDetailDialog = lazy(() =>
  import('../components/importExport/AmazonImportDetailDialog.jsx')
    .then(m => ({ default: m.AmazonImportDetailDialog })))

const AmazonImportDetailViewerContext = createContext(null)

export function useAmazonImportDetailViewer() {
  const ctx = useContext(AmazonImportDetailViewerContext)
  if (!ctx) {
    throw new Error('useAmazonImportDetailViewer must be used inside <AmazonImportDetailViewerProvider>')
  }
  return ctx
}

const loadImportDetail = (params) => api.getAmazonImportDetail(params.batchId)

export function AmazonImportDetailViewerProvider({ children }) {
  const { viewer, open, reload, close, minimize, restore } = useDetachedReportViewer(loadImportDetail)
  const value = useMemo(
    () => ({ viewer, open, reload, close, minimize, restore }),
    [viewer, open, reload, close, minimize, restore])
  return (
    <AmazonImportDetailViewerContext.Provider value={value}>
      {children}
    </AmazonImportDetailViewerContext.Provider>
  )
}

export function AmazonImportDetailViewerRenderer() {
  const { viewer, close, reload, minimize } = useAmazonImportDetailViewer()
  if (!viewer || viewer.minimized) return null
  return (
    <Suspense fallback={null}>
      <AmazonImportDetailDialog
        data={viewer.data}
        loading={!!viewer.loading}
        error={viewer.error || ''}
        initialCategory={viewer.params?.category || 'orders'}
        onClose={close}
        onReload={reload}
        onMinimize={minimize}
      />
    </Suspense>
  )
}

// Nav-bar restore chip; the badge counts the "you probably lost something" rows (discarded items + duplicate
// orders), since those are the reason to come back to this report.
export function MinimizedAmazonImportDetailNavItem() {
  const { viewer, restore } = useAmazonImportDetailViewer()
  if (!viewer || !viewer.minimized) return null
  const title = viewer.params?.title || ''
  const data = viewer.data
  const lost = (data?.items_discarded?.length || 0) + (data?.duplicate_orders?.length || 0)
  return (
    <MinimizedReportPill
      label={title ? `Import detail — ${title}` : 'Amazon import detail'}
      badgeCount={lost}
      title={`Restore Amazon import detail${title ? ` — ${title}` : ''}`}
      onRestore={restore}
    />
  )
}
