// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useState } from 'react'
import { api } from '../lib/api.js'
import { formatCurrency } from '../lib/utils.js'
import { Button, Spinner } from './ui.jsx'
import TransactionListTable from './TransactionListTable.jsx'
import { useBulkTransactionEditing, BulkEditChrome } from '../lib/useBulkTransactionEditing.jsx'
import { useTransactionTableLayout } from '../lib/transactionTablePreferences.js'
import {
  DETAIL_LIST_MAX_HEIGHT,
  DetailPanelShell,
  useDetailPanelChrome,
} from './detailShared.jsx'

const TAG_DETAIL_TABLE_PREF_KEY = 'ui.tagDetail.transactions.columns'

/*
 * Floating detail panel scoped to one tag-signature wedge from the dashboard's
 * tag report. The signature is the *exact* set of selected report tags a transaction
 * carries — so an "Alice + Essential" wedge shows transactions tagged with both,
 * a single-tag wedge shows transactions with that one tag only, and the "Other /
 * Untagged" wedge shows transactions that match none of the selected report tags.
 *
 * The backend tag filter is OR-only, so we fetch any transactions matching at least
 * one report tag (or, for the Other signature, fetch all view-scoped transactions
 * for the period) and post-filter on the frontend by exact signature match.
 */
export default function TagDetail({
  signature,
  reportTagIds,
  reportName,
  view,
  accountId,
  dateStart,
  dateEnd,
  filterTagIds,
  categories = [],
  onClose,
  forceFloating = false,
  stackIndex = 0,
  isTopmost = true,
}) {
  const { pos, size, dragging, resizing, panelRef, onDragStart, onResizeStart } =
    useDetailPanelChrome(onClose, { forceFloating, stackIndex })
  const [transactions, setTransactions] = useState([])
  const [loading, setLoading] = useState(true)
  const [columnConfig, setColumnConfig] = useTransactionTableLayout({
    preferenceKey: TAG_DETAIL_TABLE_PREF_KEY,
  })

  // The visible rows are a client-side exact-signature subset of an OR-match fetch, so no server filter
  // can re-resolve them — "select all" selects every loaded row by id ('loaded' strategy) rather than
  // flipping to server all-matching.
  const bulk = useBulkTransactionEditing({
    rows: transactions,
    setRows: setTransactions,
    selectAllStrategy: 'loaded',
    categories,
  })

  const signatureTagIds = signature?.signature_tag_ids || []
  const signatureKey = signatureTagIds.slice().sort().join('|')
  const reportTagsKey = (reportTagIds || []).slice().sort().join('|')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const params = {
      ...(dateStart ? { date_start: dateStart } : {}),
      ...(dateEnd ? { date_end: dateEnd } : {}),
      ...(accountId ? { account_id: accountId } : {}),
      ...(filterTagIds ? { tag_ids: filterTagIds } : {}),
      ...(view ? { view } : {}),
      limit: 1000,
    }
    api.getTransactions(params).then(resp => {
      if (cancelled) return
      const reportSet = new Set(reportTagIds || [])
      const targetSet = new Set(signatureTagIds)
      const matching = (resp?.transactions || []).filter(txn => {
        const matched = (txn.tags || [])
          .map(t => t.id)
          .filter(id => reportSet.has(id))
        if (matched.length !== targetSet.size) return false
        for (const id of matched) {
          if (!targetSet.has(id)) return false
        }
        return true
      })
      setTransactions(matching)
      setLoading(false)
    }).catch(() => {
      if (cancelled) return
      setTransactions([])
      setLoading(false)
    })
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signatureKey, reportTagsKey, view, accountId, dateStart, dateEnd, filterTagIds])

  const total = transactions.reduce((s, t) => s + Math.abs(Number(t.amount) || 0), 0)
  const headerLabel = signature?.signature_name || 'Tag signature'

  const header = (
    <>
      <div style={{ fontSize: 17, fontWeight: 600, lineHeight: 1.35 }}>{headerLabel}</div>
      <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2 }}>
        {reportName ? `${reportName} · ` : ''}{transactions.length} transaction{transactions.length !== 1 ? 's' : ''} · {formatCurrency(total)}
      </div>
    </>
  )

  return (
    <DetailPanelShell
      pos={pos}
      size={size}
      dragging={dragging}
      resizing={resizing}
      panelRef={panelRef}
      onDragStart={onDragStart}
      onResizeStart={onResizeStart}
      onClose={onClose}
      header={header}
      isTopmost={isTopmost}
    >
      {loading ? (
        <Spinner />
      ) : transactions.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--muted)' }}>No transactions found.</div>
      ) : (
        <>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
            <Button variant="ghost" small onClick={bulk.toggle}>
              {bulk.bulkMode ? '✕ Done' : 'Bulk Edit'}
            </Button>
          </div>
          <BulkEditChrome controller={bulk} />
          <TransactionListTable
            rows={transactions}
            categories={categories}
            {...bulk.tableProps}
            onRowsChange={setTransactions}
            columnConfig={columnConfig}
            onColumnConfigChange={setColumnConfig}
            maxHeight={DETAIL_LIST_MAX_HEIGHT}
          />
        </>
      )}
    </DetailPanelShell>
  )
}
