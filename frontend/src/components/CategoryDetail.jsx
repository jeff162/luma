/**
 * CategoryDetail — Category spending history panel
 *
 * Opens as a bottom sheet (same drag-to-float behaviour as TransactionDetail).
 * Shows a monthly bar chart of spending in the category, then a transaction
 * list for whichever month is selected.
 *
 * Props:
 *   category   — { id, name }  (from the txn row)
 *   onClose    — () => void
 */

import { useState, useEffect, useCallback } from 'react'
import { api } from '../lib/api.js'
import { formatCurrency, monthLabel } from '../lib/utils.js'
import { Spinner, Badge, CategoryMarker } from './ui.jsx'
import TransactionListTable from './TransactionListTable.jsx'
import { useFilters } from '../lib/FilterContext.jsx'
import {
  DETAIL_LIST_MAX_HEIGHT,
  getDetailMonthSectionHeight,
  DetailPanelShell,
  DetailTrendChart,
  useDetailPanelChrome,
  usePagedMonthTransactions,
} from './detailShared.jsx'

// ── Main component ────────────────────────────────────────────────────────────

export default function CategoryDetail({ category, categories = [], onClose }) {
  const { filters } = useFilters()
  const dateStart = filters.date?.start || null
  const dateEnd   = filters.date?.end   || null
  const { pos, dragging, panelRef, onDragStart } = useDetailPanelChrome(onClose)
  const [trend, setTrend]           = useState([])
  const [selectedMonth, setSelectedMonth] = useState(null)
  const [trendLoading, setTrendLoading] = useState(true)
  const loadMonthPage = useCallback((month, offset, limit) => (
    api.getTransactions({
      month,
      category_ids: String(category.id),
      direction: 'debit',
      limit,
      offset,
    })
  ), [category.id])
  const {
    rows: monthTxns,
    loading: txnLoading,
    listRef,
  } = usePagedMonthTransactions({ selectedMonth, loadPage: loadMonthPage })

  // ── Load trend ────────────────────────────────────────────────────────────

  useEffect(() => {
    setTrendLoading(true)
    // getMonthlyTrend accepts an optional category_id
    api.getMonthlyTrend(36, category.id).then(rows => {
      setTrend(rows)
      setTrendLoading(false)
      if (rows.length > 0) setSelectedMonth(rows[rows.length - 1].month)
    })
  }, [category.id])

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
        category_color: cat?.color ?? null,
        category_overridden: 1,
      } : t
    )))
    api.overrideCategory(txnId, catId)
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
        Spending history
        {dateStart || dateEnd
          ? ` · ${dateStart ? dateStart.slice(0, 7) : ''}${dateStart && dateEnd ? ' – ' : ''}${dateEnd ? dateEnd.slice(0, 7) : ''}`
          : ' · all time'}
      </div>
    </>
  )

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <DetailPanelShell
      pos={pos}
      dragging={dragging}
      panelRef={panelRef}
      onDragStart={onDragStart}
      onClose={onClose}
      header={header}
    >
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>
            Monthly spending — {category.name}
          </div>

          {trendLoading ? <Spinner /> : trend.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--muted)', padding: '16px 0' }}>
              No history found for this category.
            </div>
          ) : (
            <DetailTrendChart trend={trend} selectedMonth={selectedMonth} onSelectMonth={setSelectedMonth} />
          )}

          {/* Month transaction list */}
          {selectedMonth && (
            <div style={{ marginTop: 24, height: monthSectionHeight }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>
                {monthLabel(selectedMonth)} · {category.name}
              </div>

              {txnLoading && monthTxns.length === 0 ? <Spinner /> : monthTxns.length === 0 ? (
                <div style={{ fontSize: 13, color: 'var(--muted)' }}>No transactions found.</div>
              ) : (
                <div>
                  <div ref={listRef}>
                    <TransactionListTable
                      rows={localMonthTxns}
                      categories={categories}
                      onCategorySave={saveCategory}
                      onRowsChange={setLocalMonthTxns}
                      maxHeight={DETAIL_LIST_MAX_HEIGHT}
                    />
                  </div>
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
