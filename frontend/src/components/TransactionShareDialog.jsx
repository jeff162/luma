// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// A read-only "copy for sharing" overlay: it shows a dense, decoration-free rendering of one
// transaction (a labeled record of every captured field) or a list of them (a compact table), and a
// Copy button that writes the same content to the clipboard in both rich-HTML and plain-text flavors.
// The preview and the clipboard output come from one formatter (lib/transactionShare.js) so what the
// user sees is exactly what they paste. Opened app-wide via TransactionShareContext.

import { useState } from 'react'
import { AppDialog, Button } from './ui.jsx'
import {
  getTransactionShareFields,
  TRANSACTION_SHARE_COLUMNS,
  getTransactionListRows,
  buildSingleShareText,
  buildSingleShareHtml,
  buildListShareText,
  buildListShareHtml,
  copyShare,
} from '../lib/transactionShare.js'

function SingleRecord({ txn }) {
  const fields = getTransactionShareFields(txn)
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '4px 14px', fontSize: 13, lineHeight: 1.5 }}>
      {fields.map((field, i) => (
        field.label ? (
          <div key={i} style={{ display: 'contents' }}>
            <div style={{ color: 'var(--muted)', whiteSpace: 'nowrap' }}>{field.label}</div>
            <div style={{ wordBreak: 'break-word' }}>{field.value}</div>
          </div>
        ) : (
          <div key={i} style={{ gridColumn: '1 / -1', color: 'var(--muted)' }}>{field.value}</div>
        )
      ))}
    </div>
  )
}

function ListTable({ rows }) {
  const cellRows = getTransactionListRows(rows)
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', fontSize: 13, width: '100%' }}>
        <thead>
          <tr>
            {TRANSACTION_SHARE_COLUMNS.map(col => (
              <th key={col.key} style={{
                textAlign: col.align === 'right' ? 'right' : 'left',
                padding: '4px 10px', color: 'var(--muted)', fontWeight: 600,
                borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap',
              }}>{col.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {cellRows.map((cells, r) => (
            <tr key={r}>
              {cells.map((cell, c) => (
                <td key={c} style={{
                  textAlign: TRANSACTION_SHARE_COLUMNS[c].align === 'right' ? 'right' : 'left',
                  padding: '4px 10px', borderBottom: '1px solid var(--border)',
                  whiteSpace: TRANSACTION_SHARE_COLUMNS[c].key === 'merchant' ? 'normal' : 'nowrap',
                }}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function TransactionShareDialog({ mode, txn, rows, title, onClose }) {
  const [copyState, setCopyState] = useState('idle')   // 'idle' | 'copied' | 'failed'
  const isList = mode === 'list'
  const count = isList ? (rows?.length || 0) : 1

  async function handleCopy() {
    const payload = isList
      ? { text: buildListShareText(rows), html: buildListShareHtml(rows) }
      : { text: buildSingleShareText(txn), html: buildSingleShareHtml(txn) }
    const ok = await copyShare(payload)
    // Surface failure rather than doing nothing silently — otherwise a blocked clipboard reads as a
    // dead button. Select the text in the preview so the user can copy it by hand as a fallback.
    setCopyState(ok ? 'copied' : 'failed')
    setTimeout(() => setCopyState('idle'), ok ? 1600 : 3200)
  }

  return (
    <AppDialog
      title={title || (isList ? 'Copy transactions' : 'Copy transaction')}
      description={isList
        ? `A plain, dense copy of the ${count} transaction${count === 1 ? '' : 's'} shown — paste it into an email or notes.`
        : 'A plain, dense copy of every captured field for this transaction — paste it into an email or notes.'}
      width="min(680px, 100%)"
      onClose={onClose}
      actions={(
        <>
          {copyState === 'failed' ? (
            <span style={{ fontSize: 12, color: 'var(--danger)', alignSelf: 'center', marginRight: 'auto' }}>
              Couldn’t reach the clipboard — select the text above and copy it manually.
            </span>
          ) : null}
          <Button variant="ghost" onClick={onClose}>Close</Button>
          <Button onClick={handleCopy}>
            {copyState === 'copied' ? 'Copied ✓' : copyState === 'failed' ? 'Copy failed' : 'Copy'}
          </Button>
        </>
      )}
    >
      <div style={{
        maxHeight: 420, overflowY: 'auto',
        border: '1px solid var(--border)', borderRadius: 8,
        padding: '12px 14px', background: 'var(--surface2)',
      }}>
        {isList
          ? (count === 0 ? <div style={{ fontSize: 13, color: 'var(--muted)' }}>No transactions to copy.</div> : <ListTable rows={rows} />)
          : <SingleRecord txn={txn} />}
      </div>
    </AppDialog>
  )
}
