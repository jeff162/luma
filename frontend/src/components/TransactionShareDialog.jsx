// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// A read-only "copy for sharing" overlay: it shows a dense, decoration-free rendering of one
// transaction (a labeled record of every captured field) or a list of them (a compact table), and a
// Copy button that writes the same content to the clipboard in both rich-HTML and plain-text flavors.
// The preview and the clipboard output come from one formatter (lib/transactionShare.js) so what the
// user sees is exactly what they paste. Opened app-wide via TransactionShareContext.
//
// A list larger than TRANSACTION_COPY_ROW_LIMIT is not copied whole. When the host says how large its
// list is (`total`) the rows are never fetched; the dialog says why, offers to copy the first
// TRANSACTION_COPY_ROW_LIMIT in the list's order, and, if the host passes `onDownload`, offers every row as
// a file.

import { useEffect, useState } from 'react'
import { AppDialog, Button } from './ui.jsx'
import { useBusyIndicator } from '../lib/useBusyIndicator.js'
import {
  getTransactionShareFields,
  TRANSACTION_COPY_ROW_LIMIT,
  TRANSACTION_SHARE_COLUMNS,
  getTransactionListRows,
  buildSingleShareText,
  buildSingleShareHtml,
  buildListShareText,
  buildListShareHtml,
  copyShare,
} from '../lib/transactionShare.js'

const LIST_DESCRIPTION = 'A clipboard copy of the transactions shown.'

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

export default function TransactionShareDialog({ mode, txn, rows, loadRows = null, total = null, onDownload = null, title, onClose }) {
  const [copyState, setCopyState] = useState('idle')   // 'idle' | 'copied' | 'failed'
  // Rows fetched through `loadRows`: null until they arrive.
  const [loaded, setLoaded] = useState({ rows: null, failed: false })
  const [download, setDownload] = useState({ busy: false, failed: false })
  // An oversized list the user chose to copy the first TRANSACTION_COPY_ROW_LIMIT of.
  const [firstRowsOnly, setFirstRowsOnly] = useState(false)
  const isList = mode === 'list'
  const listSize = total ?? rows?.length ?? 0
  const tooMany = isList && listSize > TRANSACTION_COPY_ROW_LIMIT
  const refusing = tooMany && !firstRowsOnly

  // An oversized list is loaded only by "Copy first", which fetches just the rows it copies.
  useEffect(() => {
    if (!loadRows || tooMany) return undefined
    let cancelled = false
    loadRows()
      .then(result => { if (!cancelled) setLoaded({ rows: result || [], failed: false }) })
      .catch(() => { if (!cancelled) setLoaded({ rows: null, failed: true }) })
    return () => { cancelled = true }
  }, [loadRows, tooMany])

  let listRows = loadRows ? loaded.rows : rows
  if (!loadRows && firstRowsOnly) listRows = rows.slice(0, TRANSACTION_COPY_ROW_LIMIT)
  const waiting = isList && !refusing && listRows == null
  const showLoading = useBusyIndicator(waiting && !loaded.failed)
  const showDownloading = useBusyIndicator(download.busy)
  const count = isList ? (listRows?.length || 0) : 1

  async function copy(list) {
    const payload = isList
      ? { text: buildListShareText(list), html: buildListShareHtml(list) }
      : { text: buildSingleShareText(txn), html: buildSingleShareHtml(txn) }
    const ok = await copyShare(payload)
    // Surface failure rather than doing nothing silently — otherwise a blocked clipboard reads as a
    // dead button. Select the text in the preview so the user can copy it by hand as a fallback.
    setCopyState(ok ? 'copied' : 'failed')
    setTimeout(() => setCopyState('idle'), ok ? 1600 : 3200)
  }

  // Straight to the clipboard, since that is what was asked for; the dialog then shows what was copied,
  // which is also what the clipboard-failure fallback points at.
  async function handleCopyFirst() {
    setFirstRowsOnly(true)
    if (!loadRows) {
      await copy(rows.slice(0, TRANSACTION_COPY_ROW_LIMIT))
      return
    }
    try {
      const first = ((await loadRows({ limit: TRANSACTION_COPY_ROW_LIMIT })) || []).slice(0, TRANSACTION_COPY_ROW_LIMIT)
      setLoaded({ rows: first, failed: false })
      await copy(first)
    } catch {
      setLoaded({ rows: null, failed: true })
    }
  }

  async function handleDownload() {
    setDownload({ busy: true, failed: false })
    try {
      await onDownload()
      setDownload({ busy: false, failed: false })
    } catch {
      setDownload({ busy: false, failed: true })
    }
  }

  let listBody = null
  if (refusing) {
    listBody = (
      <div style={{ fontSize: 13, color: 'var(--muted)', display: 'grid', gap: 6 }}>
        <div>
          This list contains {listSize.toLocaleString()} transactions which exceeds the maximum of {TRANSACTION_COPY_ROW_LIMIT} that can be
          copied to the clipboard.
        </div><div>
          Choices are: {onDownload
            ? ` Copy the first ${TRANSACTION_COPY_ROW_LIMIT}, download the entire set as a CSV file, or add a filter to narrow the list.`
            : ` Copy the first ${TRANSACTION_COPY_ROW_LIMIT}, or use the filters to narrow the list.`}
        </div>
        {download.failed ? <div style={{ color: 'var(--danger)' }}>The download failed.</div> : null}
      </div>
    )
  } else if (isList) {
    if (loaded.failed) listBody = <div style={{ fontSize: 13, color: 'var(--danger)' }}>Couldn’t load the transactions.</div>
    else if (waiting) listBody = showLoading ? <div style={{ fontSize: 13, color: 'var(--muted)' }}>Loading transactions…</div> : null
    else if (count === 0) listBody = <div style={{ fontSize: 13, color: 'var(--muted)' }}>No transactions to copy.</div>
    else listBody = <ListTable rows={listRows} />
  }

  let description = 'A clipboard copy of this transaction.'
  if (isList) {
    if (refusing || waiting) description = LIST_DESCRIPTION
    else if (firstRowsOnly) description = `A clipboard copy of the first ${count} of the ${listSize.toLocaleString()} transactions.`
    else description = `A clipboard copy of the ${count} transaction${count === 1 ? '' : 's'}.`
  }

  return (
    <AppDialog
      title={title || (isList ? 'Copy transactions' : 'Copy transaction')}
      description={description}
      width="min(680px, 100%)"
      onClose={onClose}
      actions={refusing ? (
        <>
          <Button variant="ghost" onClick={onClose}>Close</Button>
          <Button variant={onDownload ? 'ghost' : 'primary'} onClick={handleCopyFirst}>
            Copy first {TRANSACTION_COPY_ROW_LIMIT}
          </Button>
          {onDownload ? (
            <Button onClick={handleDownload} disabled={download.busy}>
              {showDownloading ? 'Downloading…' : 'Download CSV'}
            </Button>
          ) : null}
        </>
      ) : (
        <>
          {copyState === 'failed' ? (
            <span style={{ fontSize: 12, color: 'var(--danger)', alignSelf: 'center', marginRight: 'auto' }}>
              Couldn’t reach the clipboard — select the text above and copy it manually.
            </span>
          ) : null}
          <Button variant="ghost" onClick={onClose}>Close</Button>
          <Button onClick={() => copy(listRows)} disabled={isList && listRows == null}>
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
        {isList ? listBody : <SingleRecord txn={txn} />}
      </div>
    </AppDialog>
  )
}
