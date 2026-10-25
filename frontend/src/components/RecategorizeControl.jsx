// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/* eslint-disable react-refresh/only-export-components -- the recategorize hook and its button/banner are one small control kit shared by Rules and the rule-suggestions page */

import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api.js'
import { Button, IconButton } from './ui.jsx'
import { useBusyIndicator } from '../lib/useBusyIndicator.js'

// Shared "re-run categorization" control, used by the Rules page and the imported rule-suggestions
// page. Retroactive recategorization (services/categorizer.recategorize_all) is global and
// override-skipping: it runs every rule in one pass but never touches manually edited rows
// (category_overridden = 1), so it cannot clobber user edits. A trusted import's category is not locked —
// a file's categories rank below the rules, so a matching rule reclaims it here too. The hook owns the pending-count preview and the transient result note;
// the presentational pieces render the button/banner so each page can place them in its own layout.
export function useRecategorize() {
  const [pendingCount, setPendingCount] = useState(0)
  const [result, setResult] = useState(null)

  const reloadPreview = useCallback(() => {
    api.getRecategorizePreview()
      .then(preview => setPendingCount(Number(preview?.pending || 0)))
      .catch(() => setPendingCount(0))
  }, [])

  useEffect(() => { reloadPreview() }, [reloadPreview])

  // Auto-dismiss the result note, but tracked so the timer is cleared if the component unmounts first.
  useEffect(() => {
    if (result === null) return undefined
    const timer = setTimeout(() => setResult(null), 6000)
    return () => clearTimeout(timer)
  }, [result])

  const run = useCallback(async () => {
    setResult(null)
    const outcome = await api.recategorize()
    setResult(outcome.updated)
    setPendingCount(0)
    reloadPreview()
    return outcome
  }, [reloadPreview])

  const dismissResult = useCallback(() => setResult(null), [])

  return { pendingCount, result, run, reloadPreview, dismissResult }
}

// Default label is "Categorize", with the ↻ carrying the "again" the word "Run" used to. Help names it
// the same way: a topic that calls a button something the button does not say sends the reader looking
// for a control that is not there, so the two move together.
export function RecategorizeButton({ pendingCount, onRun, label = '↻ Categorize', showCount = false }) {
  // Busy for as long as the run takes, including whatever the caller does once it returns. A run walks every
  // transaction, so on a real ledger it lasts long enough to be pressed twice with nothing on screen saying
  // the first press started anything; the result banner only arrives at the end.
  const [running, setRunning] = useState(false)
  const busy = useBusyIndicator(running)
  async function run() {
    if (running) return
    setRunning(true)
    try {
      await onRun?.()
    } finally {
      setRunning(false)
    }
  }
  const hasPending = pendingCount > 0
  return (
    <Button
      variant="secondary"
      onClick={run}
      disabled={running}
      title={running ? 'Re-categorizing transactions…' : hasPending
        ? `${pendingCount} transaction${pendingCount === 1 ? '' : 's'} could be re-categorized`
        : 'No transactions currently look eligible for re-categorization'}
    >
      {busy ? 'Categorizing…' : showCount && hasPending ? `${label} (${pendingCount})` : label}
    </Button>
  )
}

export function RecategorizeResultBanner({ result, onDismiss, style }) {
  if (result === null) return null
  const positive = result > 0
  return (
    <div style={{
      padding: '10px 16px',
      borderRadius: 8,
      background: positive
        ? 'color-mix(in srgb, var(--success) 10%, var(--surface2))'
        : 'var(--surface2)',
      border: `1px solid ${positive ? 'color-mix(in srgb, var(--success) 30%, var(--border))' : 'var(--border)'}`,
      fontSize: 13,
      color: positive ? 'var(--success)' : 'var(--muted)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12,
      flexShrink: 0,
      ...style,
    }}>
      <span>
        {positive
          ? `↻ ${result} transaction${result === 1 ? '' : 's'} re-categorized.`
          : '↻ No transactions needed re-categorization.'}
      </span>
      <IconButton aria-label="Dismiss" onClick={onDismiss}>×</IconButton>
    </div>
  )
}
