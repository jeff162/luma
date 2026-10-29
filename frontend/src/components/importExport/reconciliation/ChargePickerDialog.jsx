// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo, useState } from 'react'
import { AppDialog, Button } from '../../ui.jsx'
import { formatTransactionAmount } from '../../../lib/moneyDisplay.js'
import { formatDate } from '../../../lib/utils.js'

// The reconciliation report's manual pairing window: pick the ledger row(s) that belong to one record the
// matcher could not pair on its own. Candidates are sorted by date proximity to the record, and a running
// sum of the selection is compared with the record's amount — a mismatch warns but never blocks, because a
// real pairing does not always reconcile to the penny. `multiple` is per vendor: a record paid by several
// charges takes checkboxes, one paid by a single row takes one choice.
export function ChargePickerDialog({
  title,
  description,
  targetLabel,
  target,
  targetDate,
  candidates,
  multiple = true,
  mismatchNote,
  emptyMessage,
  confirmLabel,
  busy,
  onCancel,
  onConfirm,
}) {
  const targetAmount = Math.abs(Number(target) || 0)
  const [selected, setSelected] = useState(() => new Set())
  const sorted = useMemo(() => {
    const diff = (d) => (targetDate && d ? Math.abs((new Date(d) - new Date(targetDate)) / 86400000) : 9e9)
    return [...candidates].sort((a, b) => diff(a.date) - diff(b.date))
  }, [candidates, targetDate])
  // Magnitudes: a transfer's other half carries the opposite sign, and what is being compared is how much.
  const sum = sorted.reduce((s, c) => s + (selected.has(c.id) ? Math.abs(Number(c.amount) || 0) : 0), 0)
  const matches = Math.abs(sum - targetAmount) <= 0.02
  const toggle = (id) => setSelected(prev => {
    if (!multiple) return prev.has(id) ? new Set() : new Set([id])
    const next = new Set(prev)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  })
  return (
    <AppDialog
      title={title}
      description={description}
      width="min(640px, 100%)"
      onClose={onCancel}
      actions={(
        <>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button onClick={() => onConfirm([...selected])} disabled={busy || selected.size === 0}>
            {confirmLabel(selected.size)}
          </Button>
        </>
      )}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
        padding: '8px 12px', borderRadius: 8, background: 'var(--surface2)', fontSize: 13 }}>
        <span style={{ color: 'var(--muted)' }}>{targetLabel} <strong style={{ color: 'var(--text)' }}>{formatTransactionAmount(targetAmount)}</strong></span>
        <span style={{ color: matches ? 'var(--success)' : 'var(--warning)', fontWeight: 600 }}>
          Selected {formatTransactionAmount(sum)} {matches ? '✓' : `· ${formatTransactionAmount(sum - targetAmount)} off`}
        </span>
      </div>
      {!matches && selected.size > 0 ? (
        <div style={{ fontSize: 11, color: 'var(--warning)', marginTop: 6 }}>{mismatchNote}</div>
      ) : null}
      <div style={{ marginTop: 12, maxHeight: '46vh', overflow: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
        {sorted.length === 0 ? (
          <div style={{ padding: 16, color: 'var(--muted)', fontSize: 13 }}>{emptyMessage}</div>
        ) : sorted.map(c => (
          <label key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
            borderBottom: '1px solid color-mix(in srgb, var(--border) 60%, transparent)', cursor: 'pointer', fontSize: 13 }}>
            <input type={multiple ? 'checkbox' : 'radio'} checked={selected.has(c.id)} onChange={() => toggle(c.id)} />
            <span style={{ width: 88, color: 'var(--muted)', flexShrink: 0 }}>{formatDate(c.date)}</span>
            <span style={{ width: 88, textAlign: 'right', flexShrink: 0 }}>{formatTransactionAmount(c.amount)}</span>
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--muted)' }}>
              {c.account}{c.name ? ` · ${c.name}` : ''}
            </span>
          </label>
        ))}
      </div>
    </AppDialog>
  )
}
