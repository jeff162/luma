// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import React, { useCallback, useState } from 'react'
import { api } from '../../lib/api.js'
import { AppDialog, Button, Spinner } from '../ui.jsx'
import { EditedTransactionsWarning } from '../EditedTransactionsWarning.jsx'

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
    <AppDialog
      title={`Undo import: ${undoTarget.filename}`}
      description={`This will permanently delete ${netCount} transactions.`}
      onClose={cancel}
      width={480}
      actions={(
        <>
          <Button variant="secondary" onClick={cancel}>Cancel</Button>
          {undoLoading ? null : undoEdited.length > 0 ? (
            <Button variant="danger" onClick={() => confirmUndo(true)}>Delete all anyway</Button>
          ) : (
            <Button variant="danger" onClick={() => confirmUndo(false)}>Delete {netCount} transactions</Button>
          )}
        </>
      )}
    >
      {undoLoading ? <Spinner /> : undoEdited.length > 0 ? <EditedTransactionsWarning rows={undoEdited} /> : null}
    </AppDialog>
  ) : null

  return { openUndo, undoNode }
}
