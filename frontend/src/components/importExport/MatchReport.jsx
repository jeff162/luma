// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import React from 'react'
import { Spinner, EmptyState, SelectAllCheckbox } from '../ui.jsx'

// The shared match-report table: a sortable list where each row is one match entry (typically a left
// record ↔ a matched right record, via TransactionMatchCell). Extracted from the duplicate-detection
// report so any "did these records match?" report — duplicate detection, Amazon reconciliation, … —
// renders in one consistent format.
//
// Scope is deliberately just the *table*: sticky sortable headers (with indicators), the optional
// select-all / per-row checkboxes, and the rows themselves. Everything policy-shaped stays in the report
// that uses it, because it differs per report:
//   - sort is **controlled** — the report passes already-sorted `entries` + the current `sortState` and
//     owns `onHeaderClick` (the duplicate report sorts with a Kind tiebreaker and a date-defaults-desc
//     toggle; reconciliation sorts plainly);
//   - selection is **controlled** — the report owns `selectedIds` and the toggles (so it can drive its own
//     bulk bar); a report with no bulk actions just passes `selectable={false}`;
//   - per-row actions, the bulk-action bar, filters, and the surrounding chrome (floating panel, account
//     scoping) all stay in the report — per-row actions ride in a column's `render`.
//
// A `column` is { key, label, width?, align?, sortable?, render(entry) }.

export function MatchReport({
  columns = [],
  entries = [],
  getRowId,
  getRowStripe,
  sortState = null,
  onHeaderClick,
  selectable = false,
  selectedIds = null,
  onToggleRow,
  onToggleAll,
  allVisibleSelected = false,
  someVisibleSelected = false,
  loading = false,
  error = '',
  emptyMessage = 'Nothing to show.',
}) {
  const sortIndicator = (key) => {
    if (sortState?.key !== key) return <span style={{ color: 'var(--border)', marginLeft: 4 }}>↕</span>
    return <span style={{ marginLeft: 4 }}>{sortState.dir === 'asc' ? '↑' : '↓'}</span>
  }

  if (loading) return <div style={{ padding: '12px 16px' }}><Spinner /></div>
  if (error) return <div style={{ padding: '12px 16px', color: 'var(--danger)' }}>{error}</div>
  if (entries.length === 0) return <div style={{ padding: '12px 16px' }}><EmptyState message={emptyMessage} /></div>

  return (
    <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead style={{ position: 'sticky', top: 0, background: 'var(--surface)', zIndex: 1, boxShadow: '0 1px 0 var(--border)' }}>
          <tr style={{ color: 'var(--muted)', textAlign: 'left' }}>
            {selectable ? (
              <th style={{ padding: '8px 8px 8px 16px', width: 32 }}>
                <SelectAllCheckbox
                  checked={allVisibleSelected}
                  indeterminate={someVisibleSelected}
                  onChange={onToggleAll}
                  title={allVisibleSelected ? 'Deselect all visible' : 'Select all visible'}
                />
              </th>
            ) : null}
            {columns.map(col => (
              <th
                key={col.key}
                onClick={col.sortable ? () => onHeaderClick?.(col.key) : undefined}
                style={{ padding: '8px', cursor: col.sortable ? 'pointer' : 'default', userSelect: 'none', width: col.width, textAlign: col.align || 'left' }}
              >
                {col.label}{col.sortable ? sortIndicator(col.key) : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {entries.map(entry => {
            const id = getRowId(entry)
            const stripe = getRowStripe ? getRowStripe(entry) : 'var(--border)'
            return (
              <tr key={id} style={{ borderBottom: '1px solid color-mix(in srgb, var(--border) 60%, transparent)', borderLeft: `3px solid ${stripe}` }}>
                {selectable ? (
                  <td style={{ padding: '6px 8px 6px 16px', textAlign: 'center' }}>
                    <input type="checkbox" checked={!!selectedIds?.has(id)} onChange={() => onToggleRow?.(entry)} />
                  </td>
                ) : null}
                {columns.map(col => (
                  <td key={col.key} style={{ padding: '6px 8px', textAlign: col.align || 'left' }}>
                    {col.render(entry)}
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
