// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// Shared rendering of import-source "origin" rows (see lib/importSourceFields.js). One place to draw
// a `{ label, value, suffix, note }` row so the transaction detail panel's Origin block and the
// merchant origin hover stay identical.

import { getTxnFileOriginRows } from '../lib/importSourceFields.js'
import CopyTransactionsButton from './CopyTransactionsButton.jsx'

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
// `copyable` puts the shared copy affordance in the card's corner. Opt-in rather than automatic for
// two reasons: the card is also fed *partial* origin objects (the duplicate report's hard-rejected
// rows never became transactions), where a copy would hand back a half-record; and the copy button
// reads `useTransactionShare`, which throws where the provider is not mounted. So a caller turns it on
// only where the object really is a ledger transaction.
//
// It exists because the card's text was already selectable and copyable — the card is `interactive`,
// so Ctrl+C works — but nothing said so, which is indistinguishable from it not working. This is the
// same content the transaction editor's copy already produces, through the same formatter.
export function MerchantOriginHoverCard({ txn, onPin = null, copyable = false }) {
  const merchant = txn.display_name || txn.merchant_name || txn.raw_name || '—'
  const rows = getTxnFileOriginRows(txn)
  return (
    <div style={{ display: 'grid', gap: 6, maxWidth: 360 }}>
      <div style={{ display: 'flex', alignItems: 'start', justifyContent: 'space-between', gap: 10 }}>
        <div style={{ fontWeight: 600, fontSize: 12.5, wordBreak: 'break-word', minWidth: 0 }}>{merchant}</div>
        {copyable ? (
          <div style={{ flexShrink: 0 }}>
            <CopyTransactionsButton txn={txn} tooltip="Copy this transaction and its source detail" />
          </div>
        ) : null}
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
