// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// Shared rendering of import-source "origin" rows (see lib/importSourceFields.js). One place to draw
// a `{ label, value, suffix, note }` row so the transaction detail panel's Origin block and the
// merchant origin hover stay identical.

import { getTxnFileOriginRows } from '../lib/importSourceFields.js'

const mutedStyle = { color: 'var(--muted)' }

export function OriginRow({ row }) {
  if (row.note) {
    return <div style={mutedStyle}>{row.note}</div>
  }
  return (
    <div>
      <span style={mutedStyle}>{row.label}:</span>{' '}
      {/* A row carrying `href` (e.g. an Amazon order's own page) is followable — the surrounding
          hover card is `interactive`, so the pointer can reach it. */}
      {row.href ? (
        <a href={row.href} target="_blank" rel="noreferrer"
          style={{ color: 'var(--accent2)' }} onClick={e => e.stopPropagation()}>
          {row.value} ↗
        </a>
      ) : row.value}
      {row.suffix ? <span style={mutedStyle}> · {row.suffix}</span> : null}
    </div>
  )
}

export function OriginFieldList({ rows, gap = 6, fontSize = 12 }) {
  if (!rows?.length) return null
  return (
    <div style={{ display: 'grid', gap, fontSize }}>
      {rows.map(row => <OriginRow key={row.key} row={row} />)}
    </div>
  )
}

// Hover-card content for a merchant label: the full visible merchant name (so a truncated cell still
// reveals it) followed by the from-the-file origin rows — the same set the edit panel's "Show more"
// reveals (raw text, source description/extras, source file, imported category, source account), so the
// captured detail is readable on hover without opening the transaction. See getTxnFileOriginRows.
export function MerchantOriginHoverCard({ txn, onPin = null }) {
  const merchant = txn.display_name || txn.merchant_name || txn.raw_name || '—'
  const rows = getTxnFileOriginRows(txn)
  return (
    <div style={{ display: 'grid', gap: 6, maxWidth: 360 }}>
      <div style={{ display: 'flex', alignItems: 'start', justifyContent: 'space-between', gap: 10 }}>
        <div style={{ fontWeight: 600, fontSize: 12.5, wordBreak: 'break-word', minWidth: 0 }}>{merchant}</div>
        {onPin ? (
          <button
            type="button"
            onClick={onPin}
            style={{
              flexShrink: 0,
              border: '1px solid var(--border)',
              borderRadius: 999,
              background: 'var(--surface2)',
              color: 'var(--accent2)',
              padding: '2px 7px',
              fontSize: 10.5,
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            Pin
          </button>
        ) : null}
      </div>
      <OriginFieldList rows={rows} />
    </div>
  )
}
