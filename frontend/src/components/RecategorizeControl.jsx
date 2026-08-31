// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/* eslint-disable react-refresh/only-export-components -- the recategorize hook and its button/banner are one small control kit shared by Rules and the rule-suggestions page */

import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api.js'
import { Button } from './ui.jsx'

// Shared "re-run categorization" control, used by the Rules page and the imported rule-suggestions
// page. Retroactive recategorization (services/categorizer.recategorize_all) is global and
// override-skipping: it runs every rule in one pass but never touches manually edited or import-locked
// rows (category_overridden = 1), so it cannot clobber user edits or the imported categories that rule
// suggestions are learned from. The hook owns the pending-count preview and the transient result note;
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

// Default label is "Run categorization", which is what the Help topics have always called it — the
// button read "Re-run categorization" and the docs read "Run categorization" for the same control.
export function RecategorizeButton({ pendingCount, onRun, label = '↻ Run categorization', showCount = false }) {
  const hasPending = pendingCount > 0
  const style = hasPending
    ? {
        background: 'color-mix(in srgb, var(--surface2) 58%, var(--accent) 16%)',
        border: '1px solid color-mix(in srgb, var(--accent) 36%, var(--border))',
        boxShadow: '0 1px 0 rgba(255,255,255,0.03), 0 10px 22px rgba(0,0,0,0.12)',
      }
    : {
        background: 'color-mix(in srgb, var(--surface2) 88%, transparent)',
        border: '1px solid color-mix(in srgb, var(--border) 88%, transparent)',
        boxShadow: 'none',
        color: 'color-mix(in srgb, var(--muted) 88%, var(--text))',
      }
  return (
    <Button
      variant="ghost"
      small
      onClick={onRun}
      style={style}
      title={hasPending
        ? `${pendingCount} transaction${pendingCount === 1 ? '' : 's'} could be re-categorized`
        : 'No transactions currently look eligible for re-categorization'}
    >
      {showCount && hasPending ? `${label} (${pendingCount})` : label}
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
      <button
        onClick={onDismiss}
        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', fontSize: 16, lineHeight: 1, padding: 0 }}
      >×</button>
    </div>
  )
}
