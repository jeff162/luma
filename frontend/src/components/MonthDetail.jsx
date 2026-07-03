// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api.js'
import { txnMutations, makeRowReconciler } from '../lib/txnMutations.js'
import { formatCurrency, monthLabel } from '../lib/utils.js'
import { Button, Spinner } from './ui.jsx'
import TransactionListTable from './TransactionListTable.jsx'
import TransactionDetail from './TransactionDetail.jsx'
import CategoryDetail from './CategoryDetail.jsx'
import CopyTransactionsButton from './CopyTransactionsButton.jsx'
import { useBulkTransactionEditing, BulkEditChrome } from '../lib/useBulkTransactionEditing.jsx'
import { useTransactionTableLayout } from '../lib/transactionTablePreferences.js'
import {
  DETAIL_LIST_MAX_HEIGHT,
  DetailPanelShell,
  useDetailPanelChrome,
  usePanelReveal,
} from './detailShared.jsx'

const MONTH_DETAIL_TABLE_PREF_KEY = 'ui.monthDetail.transactions.columns'

/*
 * Floating detail panel scoped to a single month bar from the Dashboard's monthly-trend chart.
 * `view` ('spending' | 'income') mirrors the chart's filter so the listed transactions exactly
 * match the bar the user clicked, including refunds-in-expense-categories that pull a bar
 * negative. Multiple panels can stack via stackIndex/forceFloating, matching TransactionDetail.
 */
export default function MonthDetail({
  month,
  view,
  accountId,
  tagIds,
  ownerIds,
  filters = {},
  categories = [],
  onClose,
  forceFloating = false,
  stackIndex = 0,
  isTopmost = true,
}) {
  const { pos, size, panelRef, onDragStart, onResizeStart } = useDetailPanelChrome(onClose, { forceFloating, stackIndex })
  const [transactions, setTransactions] = useState([])
  const [txnTotal, setTxnTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  // Hold the panel invisible until its geometry settles, so it fades in fully formed rather than
  // visibly growing as its content lands (see usePanelReveal).
  const revealed = usePanelReveal(panelRef, !loading)
  const [payeeDetail, setPayeeDetail] = useState(null)
  const [categoryDetail, setCategoryDetail] = useState(null)
  const [columnConfig, setColumnConfig] = useTransactionTableLayout({
    preferenceKey: MONTH_DETAIL_TABLE_PREF_KEY,
  })

  // Filter that resolves the same rows the list shows, for "select all matching" bulk edits.
  const bulkFilterParams = useMemo(() => ({
    month,
    ...(accountId ? { account_id: accountId } : {}),
    ...(tagIds ? { tag_ids: tagIds } : {}),
    ...(ownerIds ? { owner_ids: ownerIds } : {}),
    ...filters,
    ...(view ? { view } : {}),
  }), [month, view, accountId, tagIds, ownerIds, filters])
  const bulk = useBulkTransactionEditing({
    rows: transactions,
    setRows: setTransactions,
    total: txnTotal,
    filterParams: bulkFilterParams,
    categories,
    onRowsTrashed: count => setTxnTotal(prev => Math.max(0, prev - count)),
  })

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    api.getTransactions({ ...bulkFilterParams, limit: 1000 }).then(resp => {
      if (cancelled) return
      setTransactions(resp.transactions || [])
      setTxnTotal(Number(resp.total || 0))
      setLoading(false)
    }).catch(() => {
      if (cancelled) return
      setTransactions([])
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [bulkFilterParams])

  function saveCategory(txnId, catId, catObj) {
    const cat = catObj || categories.find(c => c.id === catId)
    setTransactions(prev => prev.map(t => (
      t.id === txnId ? {
        ...t,
        category_id: catId,
        category_name: cat?.name ?? null,
        category_color: null,
        category_overridden: 1,
      } : t
    )))
    txnMutations.setCategory(txnId, catId)
  }

  const viewLabel = view === 'income' ? 'Income' : 'Spending'
  const total = transactions.reduce((s, t) => {
    const amount = Number(t.amount) || 0
    return s + (view === 'income' ? -amount : amount)
  }, 0)

  const header = (
    <>
      <div style={{ fontSize: 17, fontWeight: 600, lineHeight: 1.35 }}>
        {monthLabel(month)} · {viewLabel}
      </div>
      <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2 }}>
        {transactions.length} transaction{transactions.length !== 1 ? 's' : ''} · {formatCurrency(total)}
      </div>
    </>
  )

  return (
    <>
    <DetailPanelShell
      pos={pos}
      size={size}
      revealed={revealed}
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
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6, marginBottom: 8 }}>
            <CopyTransactionsButton rows={transactions} title={`${monthLabel(month)} · ${viewLabel}`} tooltip="Copy the transactions shown" />
            <Button variant="ghost" small onClick={bulk.toggle}>
              {bulk.bulkMode ? '✕ Done' : 'Bulk Edit'}
            </Button>
          </div>
          <BulkEditChrome controller={bulk} />
          <TransactionListTable
            rows={transactions}
            categories={categories}
            {...bulk.tableProps}
            onCategorySave={saveCategory}
            onCategoryOpenDetail={setCategoryDetail}
            onTransactionOpenDetail={setPayeeDetail}
            onTrashed={txnId => {
              setTxnTotal(prev => Math.max(0, prev - 1))
              setPayeeDetail(prev => (prev && prev.id === txnId ? null : prev))
            }}
            onRowsChange={setTransactions}
            columnConfig={columnConfig}
            onColumnConfigChange={setColumnConfig}
            maxHeight={DETAIL_LIST_MAX_HEIGHT}
          />
        </>
      )}
    </DetailPanelShell>
    {payeeDetail && (
      <TransactionDetail
        txn={payeeDetail}
        categories={categories}
        onClose={() => setPayeeDetail(null)}
        onReconcile={makeRowReconciler(setTransactions, { onRemoved: () => setTxnTotal(prev => Math.max(0, prev - 1)) })}
        forceFloating
        stackIndex={stackIndex + 1}
      />
    )}
    {categoryDetail && (
      <CategoryDetail
        category={categoryDetail}
        categories={categories}
        onClose={() => setCategoryDetail(null)}
        forceFloating
        stackIndex={stackIndex + 1}
      />
    )}
    </>
  )
}
