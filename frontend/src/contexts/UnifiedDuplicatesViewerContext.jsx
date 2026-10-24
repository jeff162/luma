// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/* eslint-disable react-refresh/only-export-components -- provider + useUnifiedDuplicatesViewer hook + nav-bar pill live together by design */

// App-level state for the unified duplicate-detection report dialog. The dialog used to live
// inside the Import page tree and would unmount whenever the user navigated away —
// frustrating for the cross-account-merge workflow where the user wants to investigate flagged
// rows by hopping to the Accounts or Transactions page and then come back. Hoisting the state
// here lets the dialog persist across route changes.
//
// The generic open/close/reload/minimize/restore state machine (over the envelope
// `{ params, data, loading, error, minimized }`) lives in the shared `useDetachedReportViewer`
// hook; this file adds only what is duplicate-report-specific: the data loader, a `version`
// counter that ImportExport watches (via `viewer.data.version`) so its file-card pill counts can
// refresh after the user resolves rows from the floating dialog, the account-scope filter, the
// drill-through registration slot, and the accounts-changed auto-reload. ImportExport registers a
// direct drill-through handler when it mounts (cheap, no URL churn); when it isn't mounted,
// drill-through falls back to a navigation to /import-export?openBatch=… so the source-batch detail
// panel can render there.

import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useMemo, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api.js'
import { useDetachedReportViewer } from '../lib/useDetachedReportViewer.js'
import { MinimizedReportPill } from '../components/MinimizedReportPill.jsx'

// Lazy so the heavy detail-panel chrome (`detailShared.jsx` is ~385 kB) doesn't get pulled into
// the eager App bundle. The dialog code only loads the first time the user opens the report.
const UnifiedDuplicatesDialog = lazy(() => import('../components/UnifiedDuplicatesDialog.jsx'))

const UnifiedDuplicatesViewerContext = createContext(null)

export function useUnifiedDuplicatesViewer() {
  const ctx = useContext(UnifiedDuplicatesViewerContext)
  if (!ctx) {
    throw new Error('useUnifiedDuplicatesViewer must be used inside <UnifiedDuplicatesViewerProvider>')
  }
  return ctx
}

// The report-specific fetch + payload shape. `version` advances on every load — including the first — so
// ImportExport can watch it and refresh its file-card pill counts.
//
// **Counting from 1 matters.** It used to start at 0, and the page's watcher skips 0 as "no report has
// loaded", so opening the report was the one load that refreshed nothing. That was invisible until a pill
// went stale by some other route: the user would click a "42 duplicates" pill, read "all duplicates
// resolved" in the dialog the click had just loaded, close it, and find the pill still saying 42 — the
// page holding a count the very same click had already disproved. Now any load reconciles the two, so the
// counts self-correct on the gesture a user naturally reaches for.
async function loadDuplicates(params, prev) {
  const result = await api.getBatchDuplicatesUnified(params.batchId)
  return {
    entries: Array.isArray(result.entries) ? result.entries : [],
    hardRejectCount: Number(result.hard_reject_count || 0),
    removedCount: Number(result.removed_count || 0),
    softFlagCount: Number(result.soft_flag_count || 0),
    ruleBreakdown: Array.isArray(result.rule_breakdown) ? result.rule_breakdown : [],
    // The account pairs the unresolved cross-account flags span — what lets the dialog ask the one
    // question that settles a whole pile of them at once.
    accountPairs: Array.isArray(result.account_pairs) ? result.account_pairs : [],
    version: (prev?.version ?? 0) + 1,
  }
}

export const __testing = { loadDuplicates }

export function UnifiedDuplicatesViewerProvider({ children }) {
  const { viewer, setViewer, open: openViewer, reload, close, minimize, restore } = useDetachedReportViewer(loadDuplicates)
  const drillThroughHandlerRef = useRef(null)
  const navigate = useNavigate()

  // `accountFilter` ({ id, name }) scopes the report to one account's rows — used by the deep link
  // from an empty account's detail panel so the user lands on exactly its skipped duplicates rather
  // than scrolling the whole batch report. `kindFilter` opens the report on one kind of entry — 'removed'
  // from a file ledger's "Removed as duplicates" line, whose rows are otherwise lost among the file's import
  // rejects. Both defaulted here so callers can omit them.
  const open = useCallback((params) => openViewer({ accountFilter: null, kindFilter: null, ...params }), [openViewer])

  // Clear the account scope without reloading — the dialog's "Show all" banner action.
  const clearAccountFilter = useCallback(() => {
    setViewer(prev => (prev ? { ...prev, params: { ...prev.params, accountFilter: null } } : prev))
  }, [setViewer])

  // ImportExport registers itself when mounted so drill-through can open a batch detail panel
  // in-place without a URL navigation.
  const registerDrillThroughHandler = useCallback((handler) => {
    drillThroughHandlerRef.current = handler
    return () => {
      if (drillThroughHandlerRef.current === handler) drillThroughHandlerRef.current = null
    }
  }, [])

  // Dialog calls this when the user clicks the source-batch link inside a matched-existing
  // cell. If ImportExport is mounted it handles the open directly; otherwise we send the user
  // back to /import-export with the params it needs to re-open the batch detail on arrival.
  const drillThrough = useCallback(({ batchId: targetBatchId, dateStart, dateEnd, filename }) => {
    if (!targetBatchId) return
    if (drillThroughHandlerRef.current) {
      drillThroughHandlerRef.current({ batchId: targetBatchId, dateStart, dateEnd, filename })
      return
    }
    const params = new URLSearchParams({ openBatch: targetBatchId })
    if (dateStart) params.set('dateStart', dateStart)
    if (dateEnd) params.set('dateEnd', dateEnd)
    navigate(`/import-export?${params.toString()}`)
  }, [navigate])

  // Auto-refresh the report when accounts change anywhere in the app (merge/detach/rename/
  // distinct-pair-forget/etc. — see `notifyAccountsChanged` in App.jsx). The typical workflow
  // is "review duplicates → pop over to Accounts to merge or rename → return to the report" —
  // without this listener the user would see stale display names or stale candidate pairs and
  // have to remember to hit Refresh. Debounced so a rapid sequence of edits coalesces into a
  // single reload. We read viewer/reload through refs so the listener identity is stable.
  const viewerRef = useRef(viewer)
  viewerRef.current = viewer
  const reloadRef = useRef(reload)
  reloadRef.current = reload
  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    let pendingTimeout = null
    function onAccountsChanged() {
      if (!viewerRef.current?.params?.batchId || viewerRef.current?.loading) return
      if (pendingTimeout) clearTimeout(pendingTimeout)
      pendingTimeout = setTimeout(() => {
        pendingTimeout = null
        reloadRef.current?.()
      }, 300)
    }
    window.addEventListener('luma:accounts-changed', onAccountsChanged)
    return () => {
      if (pendingTimeout) clearTimeout(pendingTimeout)
      window.removeEventListener('luma:accounts-changed', onAccountsChanged)
    }
  }, [])

  const value = useMemo(() => ({
    viewer, open, close, reload, registerDrillThroughHandler, drillThrough, minimize, restore, clearAccountFilter,
  }), [viewer, open, close, reload, registerDrillThroughHandler, drillThrough, minimize, restore, clearAccountFilter])

  return (
    <UnifiedDuplicatesViewerContext.Provider value={value}>
      {children}
    </UnifiedDuplicatesViewerContext.Provider>
  )
}

// Mounted once near the top of the App tree so the dialog survives route changes. Lazy
// import keeps the dialog's transitive dependencies (detailShared, the table layer) out of
// the eager bundle; Suspense fallback is null because the dialog has its own loading state
// and the chunk usually resolves before the user notices.
export function UnifiedDuplicatesViewerRenderer() {
  const { viewer, close, reload, drillThrough, minimize, clearAccountFilter } = useUnifiedDuplicatesViewer()
  if (!viewer || viewer.minimized) return null
  const { params, data } = viewer
  return (
    <Suspense fallback={null}>
      <UnifiedDuplicatesDialog
        entries={data?.entries || []}
        hardRejectCount={data?.hardRejectCount || 0}
        removedCount={data?.removedCount || 0}
        softFlagCount={data?.softFlagCount || 0}
        ruleBreakdown={data?.ruleBreakdown || []}
        accountPairs={data?.accountPairs || []}
        title={params?.title}
        batchId={params?.batchId}
        accountFilter={params?.accountFilter || null}
        kindFilter={params?.kindFilter || null}
        openedWith={params}
        onClearAccountFilter={clearAccountFilter}
        loading={!!viewer.loading}
        error={viewer.error || ''}
        onClose={close}
        onReload={reload}
        onMinimize={minimize}
        onDrillThrough={drillThrough}
      />
    </Suspense>
  )
}

// Styled as a chip (not a NavLink) so users don't mistake it for a permanent page entry.
export function MinimizedDuplicatesNavItem({ collapsed = false }) {
  const { viewer, restore } = useUnifiedDuplicatesViewer()
  if (!viewer || !viewer.minimized) return null
  const title = viewer.params?.title
  // softFlagCount = rows still awaiting a Keep/Reject decision; entries.length would also
  // count already-resolved hard_rejects and inflate the badge misleadingly.
  const unresolvedRows = viewer.data?.softFlagCount || 0
  return (
    <MinimizedReportPill
      label={`Duplicates — ${title}`}
      badgeCount={unresolvedRows}
      title={`Restore duplicate detection report — ${title} (${unresolvedRows} left to review)`}
      navIcon="duplicates"
      collapsed={collapsed}
      onRestore={restore}
    />
  )
}
