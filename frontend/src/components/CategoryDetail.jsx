// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

import { useState, useEffect, useCallback } from 'react'
import { api } from '../lib/api.js'
import { txnMutations } from '../lib/txnMutations.js'
import { formatCurrency, monthLabel } from '../lib/utils.js'
import { Spinner, Badge, CategoryMarker } from './ui.jsx'
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

const CATEGORY_DETAIL_TABLE_STORAGE_KEY_PREFIX = 'fintrack.category-detail.transactions.columns'
const CATEGORY_DETAIL_TABLE_PREF_KEY = 'ui.categoryDetail.transactions.columns'

export default function CategoryDetail({ category, categories = [], onClose, forceFloating = false, stackIndex = 0, isTopmost = true, dateStart = null, dateEnd = null }) {
  /*
   * Like the other detail drawers, this component lets the chart choose the active month and then
   * treats that month's rows as a small editable working set so in-place recategorization does not
   * force the user back through the drill path.
   */
  const { pos, size, dragging, resizing, panelRef, onDragStart, onResizeStart } = useDetailPanelChrome(onClose, { forceFloating, stackIndex })
  const [trend, setTrend]           = useState([])
  const [selectedMonth, setSelectedMonth] = useState(null)
  const [trendLoading, setTrendLoading] = useState(true)
  const [columnConfig, setColumnConfig] = useTransactionTableLayout({
    storageKeyPrefix: CATEGORY_DETAIL_TABLE_STORAGE_KEY_PREFIX,
    preferenceKey: CATEGORY_DETAIL_TABLE_PREF_KEY,
  })
  const loadMonthPage = useCallback((month, offset, limit) => (
    api.getTransactions({
      month,
      category_ids: String(category.id),
      limit,
      offset,
    })
  ), [category.id])
  const {
    rows: monthTxns,
    loading: txnLoading,
    listRef,
  } = usePagedMonthTransactions({ selectedMonth, loadPage: loadMonthPage })

  useEffect(() => {
    setTrendLoading(true)
    // The caller owns the date scope: Dashboard/Transactions pass their global filter; pages without a
    // filter bar (Categories) pass nothing. With no explicit range we anchor the 36-month window to the
    // category's most recent activity (not today) so an old category still shows its latest 3 years
    // instead of an empty chart.
    api.getMonthlyTrend(36, category.id, undefined, dateStart || undefined, dateEnd || undefined, undefined, undefined, undefined, (dateStart || dateEnd) ? {} : { anchor: 'latest' }).then(rows => {
      setTrend(rows)
      setTrendLoading(false)
      if (rows.length > 0) setSelectedMonth(rows[rows.length - 1].month)
    })
  }, [category.id, dateStart, dateEnd])

  const selectedMonthRow = trend.find(r => r.month === selectedMonth)
  const monthSectionHeight = getDetailMonthSectionHeight(trend)

  const [localMonthTxns, setLocalMonthTxns] = useState([])

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
    txnMutations.setCategory(txnId, catId)
  }

  const header = (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <CategoryMarker kind="category" size={8} />
        <span style={{ fontSize: 17, fontWeight: 600 }}>
          {category.name}
        </span>
        <Badge label={category.name} toneKey={category.id || category.name} />
      </div>
      <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2 }}>
        Activity history
        {/* Label the actual window shown by the chart (the trend's month span) rather than the global
            date filter, which this drawer does not apply. */}
        {trend.length > 0
          ? ` · ${trend[0].month}${trend[trend.length - 1].month !== trend[0].month ? ` – ${trend[trend.length - 1].month}` : ''}`
          : (trendLoading ? '' : ' · no activity')}
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
            Monthly activity — {category.name}
          </div>

          {trendLoading ? <Spinner /> : trend.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--muted)', padding: '16px 0' }}>
              No history found for this category.
            </div>
          ) : (
            <DetailTrendChart trend={trend} selectedMonth={selectedMonth} onSelectMonth={setSelectedMonth} />
          )}

          {selectedMonth && (
            <div style={{ marginTop: 24, height: monthSectionHeight }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>
                {monthLabel(selectedMonth)} · {category.name}
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
