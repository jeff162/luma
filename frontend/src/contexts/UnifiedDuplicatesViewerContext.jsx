// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

/* eslint-disable react-refresh/only-export-components -- provider + useUnifiedDuplicatesViewer hook + nav-bar pill live together by design */

// App-level state for the unified duplicate-detection report dialog. The dialog used to live
// inside the Import/Export page tree and would unmount whenever the user navigated away —
// frustrating for the cross-account-merge workflow where the user wants to investigate flagged
// rows by hopping to the Accounts or Transactions page and then come back. Hoisting the state
// here lets the dialog persist across route changes.
//
// The context owns: the viewer payload (entries, counts, loading/error), open/close/reload
// operations, a `version` counter that ImportExport watches so its file-card pill counts can
// refresh after the user resolves rows from the floating dialog, and a registration slot for
// the drill-through handler. ImportExport registers a direct handler when it mounts (cheap,
// no URL churn); when it isn't mounted, drill-through falls back to a navigation to
// /import-export?openBatch=… so the source-batch detail panel can render there.

import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api.js'

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

export function UnifiedDuplicatesViewerProvider({ children }) {
  const [viewer, setViewer] = useState(null)
  const drillThroughHandlerRef = useRef(null)
  const navigate = useNavigate()

  const close = useCallback(() => { setViewer(null) }, [])

  // Minimize hides the dialog without dropping its loaded state. While minimized, the dialog
  // disappears from view and a small pill appears in the nav bar (via MinimizedDuplicatesNavItem
  // below); clicking the pill restores the dialog with its existing entries, sort, position,
  // and size intact. This is the answer to "the dialog is covering the accounts I'm trying to
  // edit" — you can stash it without losing your place in the report.
  const minimize = useCallback(() => {
    setViewer(prev => prev ? { ...prev, minimized: true } : prev)
  }, [])
  const restore = useCallback(() => {
    setViewer(prev => prev ? { ...prev, minimized: false } : prev)
  }, [])

  // ImportExport keeps its file-card pill counts in sync by watching `viewer.version` and
  // re-fetching the batch list when this counter advances.
  const reload = useCallback(async () => {
    const current = viewer
    if (!current?.batchId) return
    const { batchId, title, accountFilter } = current
    try {
      const result = await api.getBatchDuplicatesUnified(batchId)
      setViewer({
        batchId, title, accountFilter: accountFilter || null, loading: false, error: '',
        entries: Array.isArray(result.entries) ? result.entries : [],
        hardRejectCount: Number(result.hard_reject_count || 0),
        softFlagCount: Number(result.soft_flag_count || 0),
        ruleBreakdown: Array.isArray(result.rule_breakdown) ? result.rule_breakdown : [],
        version: (current.version || 0) + 1,
        // Carry minimized forward — a reload triggered by an account-change event must NOT
        // unminimize the dialog, otherwise editing accounts while the report is stashed in
        // the nav bar would pop the dialog back open mid-edit.
        minimized: !!current.minimized,
      })
    } catch (err) {
      setViewer(prev => prev ? { ...prev, error: err?.message || 'Reload failed' } : prev)
    }
  }, [viewer])

  // `accountFilter` ({ id, name }) scopes the report to one account's rows — used by the deep link
  // from an empty account's detail panel so the user lands on exactly its skipped duplicates rather
  // than scrolling the whole batch report.
  const open = useCallback(async ({ batchId, title, accountFilter = null }) => {
    if (!batchId) return
    setViewer({
      batchId, title, accountFilter, loading: true, error: '',
      entries: [], hardRejectCount: 0, softFlagCount: 0, ruleBreakdown: [], version: 0,
    })
    try {
      const result = await api.getBatchDuplicatesUnified(batchId)
      setViewer({
        batchId, title, accountFilter, loading: false, error: '',
        entries: Array.isArray(result.entries) ? result.entries : [],
        hardRejectCount: Number(result.hard_reject_count || 0),
        softFlagCount: Number(result.soft_flag_count || 0),
        ruleBreakdown: Array.isArray(result.rule_breakdown) ? result.rule_breakdown : [],
        version: 0,
      })
    } catch (err) {
      setViewer({
        batchId, title, accountFilter, loading: false,
        error: err?.message || 'Could not load duplicate report.',
        entries: [], hardRejectCount: 0, softFlagCount: 0, ruleBreakdown: [], version: 0,
      })
    }
  }, [])

  // Clear the account scope without reloading — the dialog's "Show all" banner action.
  const clearAccountFilter = useCallback(() => {
    setViewer(prev => prev ? { ...prev, accountFilter: null } : prev)
  }, [])

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
  // single reload. We read viewer through a ref so the listener identity is stable.
  const viewerRef = useRef(viewer)
  viewerRef.current = viewer
  const reloadRef = useRef(reload)
  reloadRef.current = reload
  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    let pendingTimeout = null
    function onAccountsChanged() {
      if (!viewerRef.current?.batchId || viewerRef.current?.loading) return
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
  return (
    <Suspense fallback={null}>
      <UnifiedDuplicatesDialog
        entries={viewer.entries}
        hardRejectCount={viewer.hardRejectCount}
        softFlagCount={viewer.softFlagCount}
        ruleBreakdown={viewer.ruleBreakdown}
        title={viewer.title}
        batchId={viewer.batchId}
        accountFilter={viewer.accountFilter || null}
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
export function MinimizedDuplicatesNavItem() {
  const { viewer, restore } = useUnifiedDuplicatesViewer()
  if (!viewer || !viewer.minimized) return null
  // softFlagCount = rows still awaiting a Keep/Reject decision; entries.length would also
  // count already-resolved hard_rejects and inflate the badge misleadingly.
  const unresolvedRows = viewer.softFlagCount || 0
  return (
    <button
      type="button"
      onClick={restore}
      title={`Restore duplicate detection report — ${viewer.title} (${unresolvedRows} left to review)`}
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 10px',
        margin: '4px 0',
        background: 'color-mix(in srgb, var(--warning) 14%, var(--surface2))',
        color: 'var(--text)',
        border: '1px solid color-mix(in srgb, var(--warning) 40%, var(--border))',
        borderRadius: 8,
        cursor: 'pointer',
        fontSize: 12,
        textAlign: 'left',
        width: '100%',
        overflow: 'hidden',
      }}
    >
      <span style={{ fontSize: 13, lineHeight: 1, color: 'var(--warning)' }}>↗</span>
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        Duplicates — {viewer.title}
      </span>
      {unresolvedRows > 0 ? (
        <span style={{
          background: 'var(--warning)', color: '#fff',
          fontSize: 10, fontWeight: 700,
          padding: '1px 6px', borderRadius: 99,
          lineHeight: '16px', minWidth: 18, textAlign: 'center',
        }}>
          {unresolvedRows}
        </span>
      ) : null}
    </button>
  )
}
