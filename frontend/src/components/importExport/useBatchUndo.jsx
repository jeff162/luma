// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import React, { useCallback, useState } from 'react'
import { api } from '../../lib/api.js'
import { Card, Button, Spinner } from '../ui.jsx'
import { formatTransactionAmount, getTransactionAmountColor } from '../../lib/moneyDisplay.js'

// The shared "undo an import batch" flow: a confirm dialog that first surfaces any transactions the user
// manually edited after import (so undo never silently deletes edited work), then deletes the batch —
// `force` skipping the edited-rows guard. Extracted from the Import tab so the marketplace import tabs
// reuse the exact same behavior. The host passes `onAfterUndo(batch)` for its own post-undo cleanup +
// refetch (the delete itself and the dialog live here).
export function useBatchUndo(onAfterUndo) {
  const [undoTarget, setUndoTarget] = useState(null)
  const [undoEdited, setUndoEdited] = useState([])
  const [undoLoading, setUndoLoading] = useState(false)

  const openUndo = useCallback(async (batch) => {
    if (!batch?.id) return
    setUndoTarget(batch)
    setUndoLoading(true)
    setUndoEdited(await api.getBatchEdited(batch.id).catch(() => []))
    setUndoLoading(false)
  }, [])

  const cancel = useCallback(() => { setUndoTarget(null); setUndoEdited([]) }, [])

  const confirmUndo = useCallback(async (force) => {
    const batch = undoTarget
    setUndoTarget(null)
    setUndoEdited([])
    if (!batch?.id) return
    await api.undoBatch(batch.id, force)
    await onAfterUndo?.(batch)
  }, [undoTarget, onAfterUndo])

  const netCount = undoTarget
    ? (undoTarget.row_count - (undoTarget.skipped_count || 0) - (undoTarget.deduped_count || 0))
    : 0

  const undoNode = undoTarget ? (
    <div style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <Card style={{ width: 480, maxHeight: '80vh', overflow: 'auto' }}>
        <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>Undo import: {undoTarget.filename}</div>
        <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 16 }}>This will permanently delete {netCount} transactions.</div>
        {undoLoading ? <Spinner /> : undoEdited.length > 0 ? (
          <>
            <div style={{ background: 'color-mix(in srgb, var(--danger) 10%, var(--surface2))', border: '1px solid var(--danger)', borderRadius: 8, padding: '10px 14px', marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6, color: 'var(--danger)' }}>⚠ {undoEdited.length} transactions were manually edited after import</div>
              <div style={{ maxHeight: 180, overflowY: 'auto' }}>
                {undoEdited.map(t => (
                  <div key={t.id} style={{ display: 'grid', gridTemplateColumns: '90px 1fr 80px', fontSize: 12, padding: '4px 0', borderBottom: '1px solid var(--border)' }}>
                    <span style={{ color: 'var(--muted)' }}>{t.date}</span>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.display_name || t.merchant_name || t.raw_name}</span>
                    <span style={{ textAlign: 'right', color: getTransactionAmountColor(t.amount) }}>{formatTransactionAmount(t.amount)}</span>
                  </div>
                ))}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <Button variant="danger" onClick={() => confirmUndo(true)}>Delete all anyway</Button>
              <Button variant="ghost" onClick={cancel}>Cancel</Button>
            </div>
          </>
        ) : (
          <div style={{ display: 'flex', gap: 10 }}>
            <Button variant="danger" onClick={() => confirmUndo(false)}>Delete {netCount} transactions</Button>
            <Button variant="ghost" onClick={cancel}>Cancel</Button>
          </div>
        )}
      </Card>
    </div>
  ) : null

  return { openUndo, undoNode }
}
