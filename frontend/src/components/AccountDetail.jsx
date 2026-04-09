// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

import { useState, useEffect, useCallback } from 'react'
import { api } from '../lib/api.js'
import { formatCurrency, formatDate, monthLabel } from '../lib/utils.js'
import { Spinner } from './ui.jsx'
import { CategoryCell, MerchantCell } from './TransactionRow.jsx'
import AmountDisplay from './AmountDisplay.jsx'
import { useFilters } from '../lib/FilterContext.jsx'
import {
  DETAIL_LIST_MAX_HEIGHT,
  getDetailMonthSectionHeight,
  DetailPanelShell,
  DetailTrendChart,
  useDetailPanelChrome,
  usePagedMonthTransactions,
} from './detailShared.jsx'

export default function AccountDetail({ account, categories = [], onClose }) {
  /*
   * This panel is mostly a thin account-specific wrapper around the shared detail-sheet chrome:
   * the chart picks the month, and the month list stays locally editable so inline category changes
   * feel immediate without disturbing the selected slice of history.
   */
  const { filters } = useFilters()
  const dateStart = filters.date?.start || null
  const dateEnd   = filters.date?.end   || null
  const { pos, dragging, panelRef, onDragStart } = useDetailPanelChrome(onClose)
  const [trend, setTrend]           = useState([])
  const [selectedMonth, setSelectedMonth] = useState(null)
  const [trendLoading, setTrendLoading] = useState(true)
  const loadMonthPage = useCallback((month, offset, limit) => (
    api.getTransactions({
      account_ids: String(account.id),
      month,
      direction: 'debit',
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
        category_color: cat?.color ?? null,
        category_overridden: 1,
      } : t
    )))
    api.overrideCategory(txnId, catId)
  }

  useEffect(() => {
    setTrendLoading(true)
    api.getMonthlyTrend(60, undefined, String(account.id), dateStart, dateEnd).then(rows => {
      setTrend(rows)
      setTrendLoading(false)
      if (rows.length > 0) setSelectedMonth(rows[rows.length - 1].month)
    })
  }, [account.id, dateStart, dateEnd])

  const selectedMonthRow = trend.find(r => r.month === selectedMonth)
  const monthSectionHeight = getDetailMonthSectionHeight(trend)
  const header = (
    <>
      <div style={{ fontSize: 17, fontWeight: 600 }}>🏦 {displayName}</div>
      <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2 }}>
        Account spending history
        {dateStart || dateEnd
          ? ` · ${dateStart ? dateStart.slice(0, 7) : ''}${dateStart && dateEnd ? ' – ' : ''}${dateEnd ? dateEnd.slice(0, 7) : ''}`
          : ' · all time'}
      </div>
    </>
  )

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
            Monthly spending — {displayName}
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
                <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                  <div style={{
                    display: 'grid', gridTemplateColumns: '110px 1fr 160px 110px',
                    padding: '7px 14px', fontSize: 11, fontWeight: 600,
                    color: 'var(--muted)', textTransform: 'uppercase',
                    letterSpacing: '0.05em', background: 'var(--surface2)',
                    borderBottom: '1px solid var(--border)',
                  }}>
                    <span>Date</span>
                    <span>Merchant</span>
                    <span>Category</span>
                    <span style={{ textAlign: 'right' }}>Amount</span>
                  </div>

                  <div ref={listRef} style={{ maxHeight: DETAIL_LIST_MAX_HEIGHT, overflowY: 'auto' }}>
                    {localMonthTxns.map(t => (
                      <div key={t.id} style={{
                        display: 'grid', gridTemplateColumns: '110px 1fr 160px 110px',
                        padding: '9px 14px', alignItems: 'center', fontSize: 13,
                        borderBottom: '1px solid var(--border)',
                      }}>
                        <span style={{ color: 'var(--muted)', fontSize: 12 }}>{formatDate(t.date)}</span>
                        <MerchantCell txn={t} onRename={() => {}} />
                        <CategoryCell
                          txn={t}
                          categories={categories}
                          onSave={saveCategory}
                        />
                        <AmountDisplay amount={t.amount} isPending={!!t.is_pending} />
                      </div>
                    ))}
                  </div>

                  <div style={{
                    padding: '8px 14px', fontSize: 13, fontWeight: 600,
                    textAlign: 'right', borderTop: '1px solid var(--border)',
                    background: 'var(--surface2)',
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
