// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/* eslint-disable react-refresh/only-export-components -- a controller hook that owns its own rendered panel stack */

import React, { Suspense, lazy, useCallback, useState } from 'react'
import { Spinner } from '../ui.jsx'

const ImportBatchDetail = lazy(() => import('../ImportBatchDetail.jsx'))

// The shared per-batch file-ledger (`↗`): a stack of floating `ImportBatchDetail` panels. Extracted from
// the Import tab so every import surface (the CSV importer and each marketplace tab) opens the same
// ledger. The hook owns the panel stack + its render; the caller keeps any surface-specific wiring
// (e.g. the Import tab's duplicate-viewer drill-through / URL-param openers) by calling `openBatchDetail`.
export function useBatchDetailPanels({ categories, onAddCategory, onReviewCountChange }) {
  const [batchDetailPanels, setBatchDetailPanels] = useState([])

  const openBatchDetail = useCallback((batch) => {
    if (!batch?.id) return
    // If the panel for this batch is already open, REPLACE its entry with the new payload rather than
    // no-op'ing — the drill-through link can re-open the same batch with a different `_dateFilter`, and
    // dropping the second invocation would leave a stale filter on screen.
    setBatchDetailPanels(prev => {
      const existingIndex = prev.findIndex(panel => panel.id === batch.id)
      if (existingIndex === -1) return [...prev, batch]
      const next = [...prev]
      next[existingIndex] = batch
      return next
    })
  }, [])

  const closeBatchDetail = useCallback((batchId) => {
    setBatchDetailPanels(prev => prev.filter(panel => panel.id !== batchId))
  }, [])

  const panelsNode = (
    <Suspense fallback={batchDetailPanels.length ? (
      <div style={{
        position: 'fixed', right: 24, bottom: 24, zIndex: 220,
        display: 'inline-flex', alignItems: 'center', gap: 10, padding: '10px 14px',
        borderRadius: 12, border: '1px solid color-mix(in srgb, var(--accent) 24%, var(--border))',
        background: 'color-mix(in srgb, var(--surface) 94%, var(--surface2))',
        boxShadow: '0 16px 40px rgba(15, 23, 42, 0.24)', color: 'var(--text)', fontSize: 13,
      }}>
        <Spinner size={14} />
        <span>Loading import details...</span>
      </div>
    ) : null}>
      {batchDetailPanels.map((batch, index) => (
        <ImportBatchDetail
          key={batch.id}
          batch={batch}
          categories={categories}
          onAddCategory={onAddCategory}
          onReviewCountChange={onReviewCountChange}
          onClose={() => closeBatchDetail(batch.id)}
          forceFloating
          stackIndex={index}
          isTopmost={index === batchDetailPanels.length - 1}
        />
      ))}
    </Suspense>
  )

  return { openBatchDetail, closeBatchDetail, panelsNode }
}
