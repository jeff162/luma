// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useState } from 'react'
import { api } from '../lib/api.js'
import { formatCurrency, monthLabel } from '../lib/utils.js'
import { Spinner } from './ui.jsx'
import TransactionListTable from './TransactionListTable.jsx'
import { useTransactionTableLayout } from '../lib/transactionTablePreferences.js'
import {
  DETAIL_LIST_MAX_HEIGHT,
  DetailPanelShell,
  useDetailPanelChrome,
} from './detailShared.jsx'

const MONTH_DETAIL_TABLE_STORAGE_KEY_PREFIX = 'fintrack.month-detail.transactions.columns'
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
  const { pos, size, dragging, resizing, panelRef, onDragStart, onResizeStart } = useDetailPanelChrome(onClose, { forceFloating, stackIndex })
  const [transactions, setTransactions] = useState([])
  const [loading, setLoading] = useState(true)
  const [columnConfig, setColumnConfig] = useTransactionTableLayout({
    storageKeyPrefix: MONTH_DETAIL_TABLE_STORAGE_KEY_PREFIX,
    preferenceKey: MONTH_DETAIL_TABLE_PREF_KEY,
  })

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    api.getTransactions({
      month,
      ...(accountId ? { account_id: accountId } : {}),
      ...(tagIds ? { tag_ids: tagIds } : {}),
      ...(ownerIds ? { owner_ids: ownerIds } : {}),
      ...filters,
      ...(view ? { view } : {}),
      limit: 1000,
    }).then(resp => {
      if (cancelled) return
      setTransactions(resp.transactions || [])
      setLoading(false)
    }).catch(() => {
      if (cancelled) return
      setTransactions([])
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [month, view, accountId, tagIds, ownerIds, filters])

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
        <TransactionListTable
          rows={transactions}
          categories={categories}
          onRowsChange={setTransactions}
          columnConfig={columnConfig}
          onColumnConfigChange={setColumnConfig}
          maxHeight={DETAIL_LIST_MAX_HEIGHT}
        />
      )}
    </DetailPanelShell>
  )
}
