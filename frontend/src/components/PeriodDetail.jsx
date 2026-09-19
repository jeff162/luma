// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useMemo, useState } from 'react'
import { api } from '../lib/api.js'
import { makeRowReconciler, applyCategoryChange } from '../lib/txnMutations.js'
import { formatSignedMoneyAmount } from '../lib/moneyDisplay.js'
import { periodReportParams } from '../lib/periodReportScope.js'
import { Spinner } from './ui.jsx'
import TransactionListTable from './TransactionListTable.jsx'
import TransactionDetail from './TransactionDetail.jsx'
import CategoryDetail from './CategoryDetail.jsx'
import TransactionListToolbar from './TransactionListToolbar.jsx'
import { useBulkTransactionEditing, BulkEditChrome } from '../lib/useBulkTransactionEditing.jsx'
import { useTransactionTableLayout } from '../lib/transactionTablePreferences.js'
import {
  DetailPanelShell,
  useDetailPanelChrome,
  usePagedTransactions,
  usePanelReveal,
} from './detailShared.jsx'

const PERIOD_DETAIL_TABLE_PREF_KEY = 'ui.periodDetail.transactions.columns'

/*
 * Floating detail panel scoped to a date range from the Dashboard's single-period trend chart — one
 * trend bar (a month, a quarter, a full period, or a whole year, depending on the selected period's
 * length), or the selected period itself via the "View transactions" header link. `start`/`end` are
 * inclusive ISO dates; `label` is the human range name shown in the header (the bar's own label, or
 * the FilterBar preset). `view` ('spending' | 'income') mirrors the chart's filter so the listed rows
 * exactly match the bar the user clicked, including refunds-in-expense-categories that pull a bar
 * negative. `scope` narrows it further to one slice of the breakdown it was opened from — a category row
 * of the Trends averages table, or the drilled group behind a Trends month bar — and leads the title. The
 * list is infinite-scroll paginated with server-side sort (usePagedTransactions), so a
 * whole-year range isn't truncated at a fetch cap and column sort reorders the entire result — not
 * just the loaded page. Multiple panels stack via stackIndex/forceFloating, matching TransactionDetail.
 *
 * Unlike the panels that stack a trend chart above their list, this one is a list and nothing else, so
 * it takes the full height the window allows and hands the leftover to the table (`fillHeight` on both
 * the shell and the table). That is what makes an enlarged window show more rows: a fixed row cap in a
 * content-sized panel cannot use the extra space, however much of it there is.
 */
export default function PeriodDetail({
  start,
  end,
  label,
  view,
  accountId,
  tagIds,
  ownerIds,
  filters = {},
  scope = null,
  categories = [],
  onClose,
  forceFloating = false,
  stackIndex = 0,
  isTopmost = true,
}) {
  const { pos, size, panelRef, onDragStart, onResizeStart } = useDetailPanelChrome(onClose, { forceFloating, stackIndex })
  const [payeeDetail, setPayeeDetail] = useState(null)
  const [categoryDetail, setCategoryDetail] = useState(null)
  const [columnConfig, setColumnConfig] = useTransactionTableLayout({
    preferenceKey: PERIOD_DETAIL_TABLE_PREF_KEY,
  })

  // Filter that resolves the same rows the list shows, for the fetch and for "select all matching" bulk
  // edits. `date_start`/`date_end` scope the range; `view` mirrors the chart's spending/income filter.
  const bulkFilterParams = useMemo(
    () => periodReportParams({ start, end, view, accountId, tagIds, ownerIds, filters, scope }),
    [start, end, view, accountId, tagIds, ownerIds, filters, scope],
  )

  const activeKey = start && end ? JSON.stringify(bulkFilterParams) : null
  const loadPage = useCallback((offset, limit, sort) => (
    api.getTransactions({ ...bulkFilterParams, limit, offset, sort_by: sort.key, sort_dir: sort.dir })
  ), [bulkFilterParams])
  const {
    rows: transactions,
    setRows: setTransactions,
    loading,
    listRef,
    total: txnTotal,
    setTotal: setTxnTotal,
    sumAmount: txnSum,
    sortState,
    onSort,
    copy,
  } = usePagedTransactions({ activeKey, loadPage, exportParams: bulkFilterParams })

  // Hold the panel invisible until its geometry settles, so it fades in fully formed rather than
  // visibly growing as its content lands (see usePanelReveal).
  const revealed = usePanelReveal(panelRef, !loading)

  const bulk = useBulkTransactionEditing({
    rows: transactions,
    setRows: setTransactions,
    total: txnTotal,
    filterParams: bulkFilterParams,
    categories,
    onRowsTrashed: count => setTxnTotal(prev => Math.max(0, prev - count)),
  })

  function saveCategory(txnId, catId, catObj) {
    const cat = catObj || categories.find(c => c.id === catId)
    applyCategoryChange(txnId, cat, (patch, id) => setTransactions(prev => prev.map(t => (
      t.id === id ? { ...t, ...patch } : t
    ))))
  }

  const viewLabel = view === 'income' ? 'Income' : 'Spending'
  const title = `${scope?.name ? `${scope.name} · ` : ''}${label} · ${viewLabel}`
  // Count and total come from the server aggregate over the whole range, not the loaded page, so they
  // stay correct as the user scrolls. Income sums are stored negative, so flip the sign to show a
  // positive magnitude.
  const total = view === 'income' ? -txnSum : txnSum

  const header = (
    <>
      <div style={{ fontSize: 17, fontWeight: 600, lineHeight: 1.35 }}>
        {title}
      </div>
      <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2 }}>
        {txnTotal} transaction{txnTotal !== 1 ? 's' : ''} · {formatSignedMoneyAmount(total)}
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
      fillHeight
    >
      {loading ? (
        <Spinner />
      ) : transactions.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--muted)' }}>No transactions found.</div>
      ) : (
        <>
          <TransactionListToolbar rows={transactions} copy={copy} title={title} bulk={bulk} />
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
            fillHeight
            scrollRef={listRef}
            sortState={sortState}
            onSort={onSort}
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
