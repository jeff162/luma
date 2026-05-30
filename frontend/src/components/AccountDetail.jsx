// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

import { useState, useEffect, useCallback } from 'react'
import { api } from '../lib/api.js'
import { formatCurrency, monthLabel } from '../lib/utils.js'
import { Spinner } from './ui.jsx'
import { useFilters } from '../lib/FilterContext.jsx'
import TransactionListTable from './TransactionListTable.jsx'
import { useTransactionTableLayout } from '../lib/transactionTablePreferences.js'
import {
  DETAIL_LIST_MAX_HEIGHT,
  getDetailMonthSectionHeight,
  DetailPanelShell,
  DetailTrendChart,
  useDetailPanelChrome,
  usePagedMonthTransactions,
} from './detailShared.jsx'

const ACCOUNT_DETAIL_TABLE_STORAGE_KEY_PREFIX = 'fintrack.account-detail.transactions.columns'
const ACCOUNT_DETAIL_TABLE_PREF_KEY = 'ui.accountDetail.transactions.columns'

export default function AccountDetail({ account, categories = [], onClose, forceFloating = false, stackIndex = 0, initialPosition = null, isTopmost = true }) {
  /*
   * This panel is mostly a thin account-specific wrapper around the shared detail-sheet chrome:
   * the chart picks the month, and the month list stays locally editable so inline category changes
   * feel immediate without disturbing the selected slice of history.
   */
  const { filters } = useFilters()
  const dateStart = filters.date?.start || null
  const dateEnd   = filters.date?.end   || null
  const { pos, size, dragging, resizing, panelRef, onDragStart, onResizeStart } = useDetailPanelChrome(onClose, { forceFloating, stackIndex, initialPosition })
  const [trend, setTrend]           = useState([])
  const [selectedMonth, setSelectedMonth] = useState(null)
  const [trendLoading, setTrendLoading] = useState(true)
  const loadMonthPage = useCallback((month, offset, limit) => (
    api.getTransactions({
      account_ids: String(account.id),
      month,
      limit,
      offset,
    })
  ), [account.id])
  const {
    rows: monthTxns,
    loading: txnLoading,
    listRef,
  } = usePagedMonthTransactions({ selectedMonth, loadPage: loadMonthPage })
  const [localMonthTxns, setLocalMonthTxns] = useState([])
  const [columnConfig, setColumnConfig] = useTransactionTableLayout({
    storageKeyPrefix: ACCOUNT_DETAIL_TABLE_STORAGE_KEY_PREFIX,
    preferenceKey: ACCOUNT_DETAIL_TABLE_PREF_KEY,
    showAccount: false,
  })
  const displayName = `${account.name}${account.mask ? ` ···${account.mask}` : ''}`

  useEffect(() => {
    setLocalMonthTxns(monthTxns)
  }, [monthTxns])

  function saveCategory(txnId, catId, catObj) {
    const cat = catObj || categories.find(c => c.id === catId)
    setLocalMonthTxns(prev => prev.map(t => (
      t.id === txnId ? {
        ...t,
        category_id: catId,
        category_name: cat?.name ?? null,
        category_color: null,
        category_overridden: 1,
      } : t
    )))
    api.overrideCategory(txnId, catId)
  }

  useEffect(() => {
    setTrendLoading(true)
    api.getMonthlyTrend(60, undefined, String(account.id), dateStart, dateEnd, undefined, 'spending').then(rows => {
      setTrend(rows)
      setTrendLoading(false)
      if (rows.length > 0) setSelectedMonth(rows[rows.length - 1].month)
    })
  }, [account.id, dateStart, dateEnd])

  const selectedMonthRow = trend.find(r => r.month === selectedMonth)
  const monthSectionHeight = getDetailMonthSectionHeight(trend)
  const header = (
    <>
      <div style={{ fontSize: 17, fontWeight: 600 }}>{displayName}</div>
      <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2 }}>
        Account activity history
        {dateStart || dateEnd
          ? ` · ${dateStart ? dateStart.slice(0, 7) : ''}${dateStart && dateEnd ? ' – ' : ''}${dateEnd ? dateEnd.slice(0, 7) : ''}`
          : ' · all time'}
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
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>
            Monthly activity — {displayName}
          </div>

          {trendLoading ? <Spinner /> : trend.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--muted)', padding: '16px 0' }}>
              No history found for this account.
            </div>
          ) : (
            <DetailTrendChart trend={trend} selectedMonth={selectedMonth} onSelectMonth={setSelectedMonth} />
          )}

          {selectedMonth && (
            <div style={{ marginTop: 24, height: monthSectionHeight }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>
                {monthLabel(selectedMonth)} · {displayName}
              </div>

              {txnLoading && monthTxns.length === 0 ? <Spinner /> : monthTxns.length === 0 ? (
                <div style={{ fontSize: 13, color: 'var(--muted)' }}>No transactions found.</div>
              ) : (
                <div>
                  <TransactionListTable
                    rows={localMonthTxns}
                    categories={categories}
                    onCategorySave={saveCategory}
                    onRowsChange={setLocalMonthTxns}
                    showAccount={false}
                    columnConfig={columnConfig}
                    onColumnConfigChange={setColumnConfig}
                    maxHeight={DETAIL_LIST_MAX_HEIGHT}
                    scrollRef={listRef}
                  />
                  <div style={{
                    padding: '8px 14px', fontSize: 13, fontWeight: 600,
                    textAlign: 'right', borderTop: '1px solid var(--border)',
                    background: 'var(--surface2)',
                    borderLeft: '1px solid var(--border)',
                    borderRight: '1px solid var(--border)',
                    borderBottom: '1px solid var(--border)',
                    borderBottomLeftRadius: 8,
                    borderBottomRightRadius: 8,
                  }}>
                    {selectedMonthRow?.count ? `${selectedMonthRow.count} matching · ` : ''}
                    Total: {formatCurrency(selectedMonthRow?.total ?? localMonthTxns.reduce((s, t) => s + t.amount, 0))}
                  </div>
                </div>
              )}
            </div>
          )}
    </DetailPanelShell>
  )
}
