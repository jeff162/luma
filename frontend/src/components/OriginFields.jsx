// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

// Shared rendering of import-source "origin" rows (see lib/importSourceFields.js). One place to draw
// a `{ label, value, suffix, note }` row so the transaction detail panel's Origin block and the
// merchant origin hover stay identical.

import { getTxnMerchantOriginRows } from '../lib/importSourceFields.js'

const mutedStyle = { color: 'var(--muted)' }

export function OriginRow({ row }) {
  if (row.note) {
    return <div style={mutedStyle}>{row.note}</div>
  }
  return (
    <div>
      <span style={mutedStyle}>{row.label}:</span> {row.value}
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
// reveals it) followed by the source text / file rows the visible name doesn't already convey.
export function MerchantOriginHoverCard({ txn, onPin = null }) {
  const merchant = txn.display_name || txn.merchant_name || txn.raw_name || '—'
  const rows = getTxnMerchantOriginRows(txn)
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
