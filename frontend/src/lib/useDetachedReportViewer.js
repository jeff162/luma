// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useMemo, useRef, useState } from 'react'

// The shared state machine behind an app-level "detached report viewer" — a report dialog hoisted
// out of the page tree (see UnifiedDuplicatesViewerContext, AmazonReconciliationViewerContext) so it
// survives route changes, can be minimized to a nav-bar pill, and restored with its loaded data
// intact. It owns the envelope { params, data, loading, error, minimized } and the open / reload /
// close / minimize / restore transitions; everything report-specific — how data is fetched, its shape,
// and extras like drill-through, filters, or event-driven reloads — stays in the caller's provider,
// which supplies `load` and layers its extras on top of the returned `setViewer`.
//
//   const { viewer, setViewer, open, reload, close, minimize, restore } = useDetachedReportViewer(load)
//
// `load(params, prevData) => data` is the caller's fetch. It receives the prior data on a reload so a
// loader that derives from it (e.g. a version counter the page watches) can; on a fresh open prevData
// is null.
export function useDetachedReportViewer(load) {
  const [viewer, setViewer] = useState(null)
  // Through refs so open/reload keep a stable identity even when the caller passes an inline `load`,
  // and so reload can read the latest viewer without depending on it (a stable listener can call it).
  const loadRef = useRef(load)
  loadRef.current = load
  const viewerRef = useRef(viewer)
  viewerRef.current = viewer

  const open = useCallback(async (params) => {
    if (!params) return
    setViewer({ params, data: null, loading: true, error: '', minimized: false })
    try {
      const data = await loadRef.current(params, null)
      setViewer({ params, data, loading: false, error: '', minimized: false })
    } catch (err) {
      setViewer({ params, data: null, loading: false, error: err?.message || 'Could not load the report.', minimized: false })
    }
  }, [])

  // Re-fetch with the same params. `...prev` preserves the panel's `minimized` state — a background
  // reload (e.g. an account-changed event) must NOT pop a stashed dialog back open — and its params.
  const reload = useCallback(async () => {
    const current = viewerRef.current
    if (!current?.params) return
    try {
      const data = await loadRef.current(current.params, current.data)
      setViewer(prev => (prev ? { ...prev, data, loading: false, error: '' } : prev))
    } catch (err) {
      setViewer(prev => (prev ? { ...prev, error: err?.message || 'Reload failed' } : prev))
    }
  }, [])

  const close = useCallback(() => setViewer(null), [])
  const minimize = useCallback(() => setViewer(prev => (prev ? { ...prev, minimized: true } : prev)), [])
  const restore = useCallback(() => setViewer(prev => (prev ? { ...prev, minimized: false } : prev)), [])

  return useMemo(
    () => ({ viewer, setViewer, open, reload, close, minimize, restore }),
    [viewer, open, reload, close, minimize, restore],
  )
}
