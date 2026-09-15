// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// The shared "copy for sharing" trigger. Drop it onto any surface that shows a transaction (pass `txn`)
// or a list of them (pass `rows`); it opens the app-wide TransactionShareDialog through
// useTransactionShare. One button so the affordance looks and behaves the same on every surface.
// A list whose surface has loaded only some of its rows passes `loadRows` (an async function returning
// all of them, or the first `limit` when called with `{ limit }`) instead of `rows`; the dialog fetches
// them once it is open. `total` (the list's full size) lets the dialog turn away a list past the copy limit
// without fetching it, and `onDownload` offers that list as a file instead.

import { Tooltip } from './ui.jsx'
import { useTransactionShare } from '../contexts/TransactionShareContext.jsx'

function CopyGlyph({ size = 14 }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="none" aria-hidden="true">
      <rect x="5.5" y="5.5" width="8" height="8.5" rx="1.4" stroke="currentColor" strokeWidth="1.2" />
      <path d="M10.5 3.5H3.9a1 1 0 0 0-1 1v7.1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

export default function CopyTransactionsButton({
  txn = null, rows = null, loadRows = null, total = null, onDownload = null, title = null, tooltip, style = null,
}) {
  const { openTransaction, openTransactions } = useTransactionShare()
  const isList = rows != null || loadRows != null
  const label = tooltip || (isList ? 'Copy these transactions' : 'Copy this transaction')

  function handleClick(event) {
    event.stopPropagation()
    if (isList) openTransactions(rows, { title, loadRows, total, onDownload })
    else openTransaction(txn, { title })
  }

  return (
    <Tooltip content={label}>
      <button
        type="button"
        onClick={handleClick}
        aria-label={label}
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          background: 'none', border: 'none', padding: '2px 4px',
          color: 'var(--muted)', cursor: 'pointer', lineHeight: 1,
          ...style,
        }}
      >
        <CopyGlyph />
      </button>
    </Tooltip>
  )
}
