// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState, useEffect, useCallback, useMemo } from 'react'
import { api } from '../lib/api.js'
import { txnMutations, makeRowReconciler, categoryReconcilePatch } from '../lib/txnMutations.js'
import { formatSignedMoneyAmount } from '../lib/moneyDisplay.js'
import { Spinner, Badge, CategoryMarker } from './ui.jsx'
import TransactionListTable from './TransactionListTable.jsx'
import TransactionDetail from './TransactionDetail.jsx'
import TransactionListToolbar from './TransactionListToolbar.jsx'
import { useBulkTransactionEditing, BulkEditChrome } from '../lib/useBulkTransactionEditing.jsx'
import { useTransactionTableLayout } from '../lib/transactionTablePreferences.js'
import {
  DETAIL_LIST_MAX_HEIGHT,
  getDetailMonthSectionHeight,
  DetailPanelShell,
  DetailTrendChart,
  DetailRangeControl,
  computeDetailRange,
  detailRangeStableKey,
  detailRangeActiveMonth,
  useDetailPanelChrome,
  usePagedTransactions,
  usePanelReveal,
} from './detailShared.jsx'

const CATEGORY_DETAIL_TABLE_PREF_KEY = 'ui.categoryDetail.transactions.columns'

export default function CategoryDetail({ category, categories = [], onClose, forceFloating = false, stackIndex = 0, isTopmost = true, dateStart = null, dateEnd = null }) {
  /*
   * Like the other detail drawers, this component lets the chart choose the active month and then
   * treats that month's rows as a small editable working set so in-place recategorization does not
   * force the user back through the drill path.
   */
  const { pos, size, panelRef, onDragStart, onResizeStart } = useDetailPanelChrome(onClose, { forceFloating, stackIndex })
  const [trend, setTrend]           = useState([])
  const [selectedMonth, setSelectedMonth] = useState(null)
  const [trendLoading, setTrendLoading] = useState(true)
  // Hold the panel invisible until its geometry settles, so it fades in fully formed rather than
  // visibly growing as the chart and list land (see usePanelReveal).
  const revealed = usePanelReveal(panelRef, !trendLoading)
  const [columnConfig, setColumnConfig] = useTransactionTableLayout({
    preferenceKey: CATEGORY_DETAIL_TABLE_PREF_KEY,
  })
  // The list defaults to the selected month but can widen to that bar's year or the whole charted span
  // (DetailRangeControl); `range` derives the fetch window + count/total and `rangeKey` keeps the fetch
  // stable so re-clicking a bar inside the same window doesn't reload identical rows.
  const [rangeMode, setRangeMode] = useState('month')
  const rangeKey = detailRangeStableKey(rangeMode, selectedMonth)
  const range = useMemo(
    () => computeDetailRange(rangeMode, selectedMonth, trend),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rangeKey subsumes selectedMonth; recomputing on every anchor click would refetch identical rows in year/all-time mode
    [rangeMode, rangeKey, trend],
  )
  const anchorReady = rangeMode === 'all' ? trend.length > 0 : !!selectedMonth
  const activeKey = anchorReady ? `cat:${category.id}|${rangeMode}|${rangeKey}` : null
  const loadPage = useCallback((offset, limit, sort) => (
    api.getTransactions({ ...range.params, category_ids: String(category.id), limit, offset, sort_by: sort.key, sort_dir: sort.dir })
  ), [range, category.id])
  const {
    rows: monthTxns,
    loading: txnLoading,
    listRef,
    sortState,
    onSort,
  } = usePagedTransactions({ activeKey, loadPage })

  useEffect(() => {
    let cancelled = false
    setTrendLoading(true)
    // The caller owns the date scope: Dashboard/Transactions pass their global filter; pages without a
    // filter bar (Categories) pass nothing. With no explicit range we anchor the 36-month window to the
    // category's most recent activity (not today) so an old category still shows its latest 3 years
    // instead of an empty chart.
    api.getMonthlyTrend(36, category.id, undefined, dateStart || undefined, dateEnd || undefined, undefined, undefined, undefined, (dateStart || dateEnd) ? {} : { anchor: 'latest' }).then(rows => {
      if (cancelled) return
      setTrend(rows)
      setTrendLoading(false)
      if (rows.length > 0) setSelectedMonth(rows[rows.length - 1].month)
    }).catch(() => {
      if (cancelled) return
      // Cleared for the same reason as the account trend: the effect re-runs per category, so a kept
      // series would be attributed to whichever category is on screen now.
      setTrend([])
      setTrendLoading(false)
    })
    return () => { cancelled = true }
  }, [category.id, dateStart, dateEnd])

  // Reserve the full 7-row list height for year/all-time (their lists scroll at DETAIL_LIST_MAX_HEIGHT
  // regardless of any one month's count); month mode sizes to its busiest bar.
  const monthSectionHeight = getDetailMonthSectionHeight(rangeMode === 'month' ? trend : [{ count: 999 }])

  const [localMonthTxns, setLocalMonthTxns] = useState([])
  const [payeeDetail, setPayeeDetail] = useState(null)

  useEffect(() => {
    setLocalMonthTxns(monthTxns)
  }, [monthTxns])

  // Bulk edit over the current window's rows for this category. The filter mirrors the list fetch
  // (window params + category) so "select all matching" resolves the whole window even when the list is
  // paged; the count comes from the same trend sum.
  const bulk = useBulkTransactionEditing({
    rows: localMonthTxns,
    setRows: setLocalMonthTxns,
    total: range.count || localMonthTxns.length,
    filterParams: { ...range.params, category_ids: String(category.id) },
    categories,
  })

  function saveCategory(txnId, catId, catObj) {
    const cat = catObj || categories.find(c => c.id === catId)
    setLocalMonthTxns(prev => prev.map(t => (
      t.id === txnId ? { ...t, ...categoryReconcilePatch(cat) } : t
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
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>
            Monthly activity — {category.name}
          </div>

          {trendLoading && trend.length === 0 ? <Spinner /> : trend.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--muted)', padding: '16px 0' }}>
              No history found for this category.
            </div>
          ) : (
            <DetailTrendChart
              trend={trend}
              selectedMonth={selectedMonth}
              onSelectMonth={setSelectedMonth}
              isMonthActive={detailRangeActiveMonth(rangeMode, selectedMonth)}
            />
          )}

          {anchorReady && (
            <div style={{ marginTop: 24, height: monthSectionHeight }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>
                  {range.label} · {category.name}
                </div>
                <DetailRangeControl mode={rangeMode} onChange={setRangeMode} />
              </div>

              {txnLoading && monthTxns.length === 0 ? <Spinner /> : monthTxns.length === 0 ? (
                <div style={{ fontSize: 13, color: 'var(--muted)' }}>No transactions found.</div>
              ) : (
                <div>
                  <TransactionListToolbar rows={localMonthTxns} title={`${range.label} · ${category.name}`} bulk={bulk} />
                  <BulkEditChrome controller={bulk} />
                  <TransactionListTable
                    rows={localMonthTxns}
                    categories={categories}
                    {...bulk.tableProps}
                    onCategorySave={saveCategory}
                    onTransactionOpenDetail={setPayeeDetail}
                    onTrashed={txnId => setPayeeDetail(prev => (prev && prev.id === txnId ? null : prev))}
                    onRowsChange={setLocalMonthTxns}
                    columnConfig={columnConfig}
                    onColumnConfigChange={setColumnConfig}
                    maxHeight={DETAIL_LIST_MAX_HEIGHT}
                    scrollRef={listRef}
                    sortState={sortState}
                    onSort={onSort}
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
                    {range.count ? `${range.count} matching · ` : ''}
                    {/* Scope-signed net: prefer the monthly-trend aggregate (already signed — income
                        negated to positive, refunds negative). The local-sum fallback (used only when the
                        window has no trend rows) is signed the same way monthly-trend signs a category
                        scope — income negates, everything else keeps its stored sign — so it can't
                        disagree with range.total. */}
                    Total: {formatSignedMoneyAmount(range.count
                      ? range.total
                      : ((category.category_type ?? categories.find(c => c.id === category.id)?.category_type) === 'income' ? -1 : 1)
                        * localMonthTxns.reduce((s, t) => s + t.amount, 0))}
                  </div>
                </div>
              )}
            </div>
          )}
    </DetailPanelShell>
    {payeeDetail && (
      <TransactionDetail
        txn={payeeDetail}
        categories={categories}
        onClose={() => setPayeeDetail(null)}
        onReconcile={makeRowReconciler(setLocalMonthTxns)}
        forceFloating
        stackIndex={stackIndex + 1}
        dateStart={dateStart}
        dateEnd={dateEnd}
      />
    )}
    </>
  )
}
