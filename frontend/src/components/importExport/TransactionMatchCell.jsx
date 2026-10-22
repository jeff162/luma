// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import React from 'react'
import { formatTransactionAmount } from '../../lib/moneyDisplay.js'
import { PendingMarker } from '../AmountDisplay.jsx'

// The shared record cell for a match report (duplicate detection, Amazon reconciliation, …): one
// transaction rendered as "date · merchant · amount" with its account underneath, plus an optional
// "from <file> ↗" drill-through link. Extracted from the duplicate report so every match report shows
// each side of a match identically. Pure presentation — the report supplies the drill-through handler.

// "from <file>" with an optional ↗ that opens that file's ledger (drill-through). Only shown when the
// record carries source-file info (hard-reject rows from an import) and the report wired `onDrillThrough`.
export function SourceFileLink({ filename, batchId, importedAt, dateStart, dateEnd, onDrillThrough }) {
  if (!filename) return null
  const short = filename.length > 32 ? `${filename.slice(0, 12)}…${filename.slice(-16)}` : filename
  const tipParts = [filename]
  if (importedAt) tipParts.push(`imported ${(importedAt || '').slice(0, 16).replace('T', ' ')}`)
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, color: 'var(--muted)', fontSize: 11 }}>
      <span title={tipParts.join(' — ')} style={{ whiteSpace: 'nowrap' }}>from {short}</span>
      {onDrillThrough && batchId ? (
        <button
          type="button"
          title={`Open ${filename} ledger${dateStart ? ` (${dateStart}…${dateEnd || dateStart})` : ''}`}
          onClick={() => onDrillThrough({ batchId, dateStart, dateEnd, filename })}
          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px', color: 'var(--accent)', fontSize: 12, lineHeight: 1 }}
        >↗</button>
      ) : null}
    </span>
  )
}

// One side of a match. `record` is { date, merchant, amount, is_pending?, account_name, account_merged_into?,
// csv_values?, source? }. `null` renders a muted em-dash. `csv_values` (a raw import row) is exposed on
// hover so a merchant-less funding leg is still identifiable; `account_merged_into` annotates a later
// account merge without hiding what the file said.
//
// The `csv_values` hover is a *native* title, so it is the fallback, not the first choice: a caller that
// wraps this cell in the richer origin hover card must withhold `csv_values`, or the cell shows a second
// tooltip on the browser's own dwell over the top of the first. See UnifiedDuplicatesDialog.partyBlock.
export function TransactionMatchCell({ record, onDrillThrough }) {
  if (!record) return <span style={{ color: 'var(--muted)' }}>—</span>
  const acct = record.account_name || ''
  const mergedInto = record.account_merged_into && record.account_merged_into !== acct ? record.account_merged_into : null
  const rawDetail = record.csv_values && typeof record.csv_values === 'object'
    ? Object.entries(record.csv_values).filter(([, v]) => String(v ?? '').trim() !== '').map(([k, v]) => `${k}: ${v}`).join('\n')
    : ''
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 1, lineHeight: 1.3 }} title={rawDetail || undefined}>
      <div>
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>{record.date || ''}</span>
        {' · '}
        <span>{record.merchant || ''}</span>
        {' · '}
        {record.is_pending ? <span style={{ display: 'inline-flex', verticalAlign: 'middle', marginRight: 4 }}><PendingMarker /></span> : null}
        <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{Number.isFinite(Number(record.amount)) ? formatTransactionAmount(record.amount) : ''}</span>
      </div>
      {acct ? (
        <div style={{ color: 'var(--muted)', fontSize: 11 }}>
          {acct}
          {mergedInto ? <span title={`Merged into ${mergedInto}`} style={{ color: 'var(--muted)' }}>{' → '}{mergedInto}</span> : null}
        </div>
      ) : null}
      {record.source ? <SourceFileLink {...record.source} onDrillThrough={onDrillThrough} /> : null}
    </div>
  )
}
