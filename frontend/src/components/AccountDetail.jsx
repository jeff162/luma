// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState, useEffect, useCallback, useMemo } from 'react'
import { api } from '../lib/api.js'
import { txnMutations } from '../lib/txnMutations.js'
import { formatCurrency } from '../lib/utils.js'
import { Button, Spinner } from './ui.jsx'
import TransactionListTable from './TransactionListTable.jsx'
import TransactionDetail from './TransactionDetail.jsx'
import CopyTransactionsButton from './CopyTransactionsButton.jsx'
import CategoryDetail from './CategoryDetail.jsx'
import { useBulkTransactionEditing, BulkEditChrome } from '../lib/useBulkTransactionEditing.jsx'
import { useTransactionTableLayout } from '../lib/transactionTablePreferences.js'
import { useUnifiedDuplicatesViewer } from '../contexts/UnifiedDuplicatesViewerContext.jsx'
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

const ACCOUNT_DETAIL_TABLE_PREF_KEY = 'ui.accountDetail.transactions.columns'

// Toggle pill for the merged-account source filter. Multi-select: "All" clears the set, each source
// pill toggles its own account in/out.
function SourcePill({ label, active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
        borderRadius: 999,
        padding: '2px 10px',
        fontSize: 12,
        cursor: 'pointer',
        background: active ? 'var(--accent)' : 'var(--surface2)',
        color: active ? '#fff' : 'var(--text)',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </button>
  )
}

export default function AccountDetail({ account, categories = [], onClose, forceFloating = false, stackIndex = 0, initialPosition = null, isTopmost = true, dateStart = null, dateEnd = null }) {
  /*
   * This panel is mostly a thin account-specific wrapper around the shared detail-sheet chrome:
   * the chart picks the month, and the month list stays locally editable so inline category changes
   * feel immediate without disturbing the selected slice of history.
   */
  const { pos, size, panelRef, onDragStart, onResizeStart } = useDetailPanelChrome(onClose, { forceFloating, stackIndex, initialPosition })
  const [trend, setTrend]           = useState([])
  const [selectedMonth, setSelectedMonth] = useState(null)
  const [trendLoading, setTrendLoading] = useState(true)
  // A merged account's report spans every underlying (source) account; `mergeSources` lists them so the
  // user can narrow the chart + list to specific originals. `sourceFilter` empty = all sources; otherwise
  // the chosen source account ids drive both the trend and the transaction feed (server-side, so paging and
  // bulk "select all matching" stay in scope). Only populated for a genuinely merged account.
  const [mergeSources, setMergeSources] = useState([])
  const [sourceFilter, setSourceFilter] = useState(() => new Set())
  // The panel's body reflows as its two opening fetches land (the monthly trend fills the chart and
  // reveals the month section; the accounts fetch may add merged-source pills). Rather than let the
  // user watch it grow and reposition, it's held invisible until both first fetches are in and the
  // panel's geometry has gone quiet (see usePanelReveal), then fades in fully formed.
  const [accountsSettled, setAccountsSettled] = useState(false)
  const isMerged = mergeSources.length > 0
  const sourceCsv = sourceFilter.size ? Array.from(sourceFilter).join(',') : undefined

  useEffect(() => {
    let cancelled = false
    setSourceFilter(new Set())
    api.getAccounts({ include_children: true }).then(rows => {
      if (cancelled) return
      setAccountsSettled(true)
      const all = rows || []
      const children = all.filter(r => r.parent_account_id === account.id)
      if (children.length === 0) {
        setMergeSources([])
        return
      }
      const parent = all.find(r => r.id === account.id)
      // Use each account's own (original) name, not the inherited display name, so the merged children
      // read as distinct sources.
      setMergeSources([
        ...(parent ? [{ id: parent.id, name: parent.name, mask: parent.mask }] : []),
        ...children.map(c => ({ id: c.id, name: c.name, mask: c.mask })),
      ])
    }).catch(() => { if (!cancelled) { setAccountsSettled(true); setMergeSources([]) } })
    return () => { cancelled = true }
  }, [account.id])

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
  const activeKey = anchorReady ? `acct:${account.id}|${sourceCsv || 'all'}|${rangeMode}|${rangeKey}` : null
  const loadPage = useCallback((offset, limit) => (
    api.getTransactions({
      account_ids: String(account.id),
      ...(sourceCsv ? { source_account_ids: sourceCsv } : {}),
      ...range.params,
      limit,
      offset,
    })
  ), [account.id, sourceCsv, range])
  const {
    rows: monthTxns,
    loading: txnLoading,
    listRef,
  } = usePagedTransactions({ activeKey, loadPage })
  const [localMonthTxns, setLocalMonthTxns] = useState([])
  // The row's merchant ↗ opens the payee detail as a child panel (so it surfaces the per-transaction
  // origin/source info). It is hosted here rather than by the page, so it stacks via the shared panel
  // registry and closes with this account panel; edits made inside it reconcile back into the month list.
  const [payeeDetail, setPayeeDetail] = useState(null)
  const [categoryDetail, setCategoryDetail] = useState(null)
  const [columnConfig, setColumnConfig] = useTransactionTableLayout({
    preferenceKey: ACCOUNT_DETAIL_TABLE_PREF_KEY,
    showAccount: false,
    showSourceAccount: isMerged,
  })
  const displayName = `${account.name}${account.mask ? ` ···${account.mask}` : ''}`

  // Explains an account with little/no visible activity: how many of its imported rows were skipped or
  // removed as duplicates of transactions already present elsewhere, with a deep-link into the duplicate
  // report scoped to just this account's rows (which can be scattered across the report otherwise).
  const duplicatesViewer = useUnifiedDuplicatesViewer()
  const [duplicateSummary, setDuplicateSummary] = useState(null)
  useEffect(() => {
    let cancelled = false
    api.getAccountDuplicateSummary(account.id)
      .then(result => { if (!cancelled) setDuplicateSummary(result) })
      .catch(() => { if (!cancelled) setDuplicateSummary(null) })
    return () => { cancelled = true }
  }, [account.id])

  function openDuplicatesForAccount() {
    if (!duplicateSummary?.primary_batch_id) return
    duplicatesViewer.open({
      batchId: duplicateSummary.primary_batch_id,
      title: duplicateSummary.primary_batch_filename || displayName,
      accountFilter: { id: account.id, name: displayName },
    })
  }

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

  useEffect(() => {
    setTrendLoading(true)
    // Caller owns the date scope (Dashboard/Transactions pass the global filter; the Accounts page passes
    // nothing → full account history). Account scope already defaults to full history when unfiltered.
    // Use the cash-flow view (no category-type filter), not 'spending': an account's activity is ALL its
    // money movement, including income/payments and transactions in not-yet-typed imported categories.
    // A 'spending' trend would hide both, falsely reporting "no activity" for, e.g., an account whose
    // imported rows all sit in type-less categories under Unassigned.
    api.getMonthlyTrend(60, undefined, String(account.id), dateStart || undefined, dateEnd || undefined, undefined, 'cash_flow', undefined, sourceCsv ? { source_account_ids: sourceCsv } : undefined).then(rows => {
      setTrend(rows)
      setTrendLoading(false)
      if (rows.length > 0) setSelectedMonth(rows[rows.length - 1].month)
    })
  }, [account.id, dateStart, dateEnd, sourceCsv])

  const revealed = usePanelReveal(panelRef, accountsSettled && !trendLoading)

  // Reserve the full 7-row list height for year/all-time (their lists scroll at DETAIL_LIST_MAX_HEIGHT
  // regardless of any one month's count); month mode sizes to its busiest bar.
  const monthSectionHeight = getDetailMonthSectionHeight(rangeMode === 'month' ? trend : [{ count: 999 }])

  // Bulk edit over the current window's rows for this account. The filter mirrors the list fetch (window
  // params + account + any source-account narrowing) so "select all matching" resolves the whole window
  // even when the list is paged; the count comes from the same trend sum.
  const bulk = useBulkTransactionEditing({
    rows: localMonthTxns,
    setRows: setLocalMonthTxns,
    total: range.count || localMonthTxns.length,
    filterParams: {
      ...range.params,
      account_ids: String(account.id),
      ...(sourceCsv ? { source_account_ids: sourceCsv } : {}),
    },
    categories,
  })

  const header = (
    <>
      <div style={{ fontSize: 17, fontWeight: 600 }}>{displayName}</div>
      <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2 }}>
        Account activity history
        {/* Label the actual window the chart shows (its month span), not the global filter. */}
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
            Monthly activity — {displayName}
          </div>

          {duplicateSummary?.skipped_count > 0 && (
            <div style={{
              marginBottom: 12, padding: '10px 12px', borderRadius: 8,
              border: '1px solid var(--border)',
              background: 'color-mix(in srgb, var(--accent) 7%, var(--surface2))',
              fontSize: 12, color: 'var(--text)', lineHeight: 1.5,
            }}>
              <strong>{duplicateSummary.skipped_count}</strong> imported transaction{duplicateSummary.skipped_count === 1 ? ' was' : 's were'} skipped as duplicates of transactions already present
              {duplicateSummary.matched_accounts.length > 0 ? <> on <strong>{duplicateSummary.matched_accounts.join(', ')}</strong></> : null}
              {duplicateSummary.matched_sources.length > 0 ? ` (from ${duplicateSummary.matched_sources.join(', ')})` : ''}
              {'. '}
              {duplicateSummary.primary_batch_id ? (
                <button
                  type="button"
                  onClick={openDuplicatesForAccount}
                  style={{
                    background: 'none', border: 'none', padding: 0,
                    color: 'var(--accent2)', cursor: 'pointer', fontSize: 12, textDecoration: 'underline',
                  }}
                >
                  View in duplicate report
                </button>
              ) : null}
            </div>
          )}

          {isMerged && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 12 }}>
              <span style={{ fontSize: 12, color: 'var(--muted)', marginRight: 2 }}>Account:</span>
              <SourcePill label="All" active={sourceFilter.size === 0} onClick={() => setSourceFilter(new Set())} />
              {mergeSources.map(src => (
                <SourcePill
                  key={src.id}
                  label={`${src.name}${src.mask ? ` ···${src.mask}` : ''}`}
                  active={sourceFilter.has(src.id)}
                  onClick={() => setSourceFilter(prev => {
                    const next = new Set(prev)
                    if (next.has(src.id)) next.delete(src.id)
                    else next.add(src.id)
                    return next
                  })}
                />
              ))}
            </div>
          )}

          {trendLoading ? <Spinner /> : trend.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--muted)', padding: '16px 0' }}>
              No history found for this account.
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
                  {range.label} · {displayName}
                </div>
                <DetailRangeControl mode={rangeMode} onChange={setRangeMode} />
              </div>

              {txnLoading && monthTxns.length === 0 ? <Spinner /> : monthTxns.length === 0 ? (
                <div style={{ fontSize: 13, color: 'var(--muted)' }}>No transactions found.</div>
              ) : (
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6, marginBottom: 8 }}>
                    <CopyTransactionsButton rows={localMonthTxns} title={`${range.label} · ${displayName}`} tooltip="Copy the transactions shown" />
                    <Button variant="ghost" small onClick={bulk.toggle}>
                      {bulk.bulkMode ? '✕ Done' : 'Bulk Edit'}
                    </Button>
                  </div>
                  <BulkEditChrome controller={bulk} />
                  <TransactionListTable
                    rows={localMonthTxns}
                    categories={categories}
                    {...bulk.tableProps}
                    onCategorySave={saveCategory}
                    onCategoryOpenDetail={setCategoryDetail}
                    onTransactionOpenDetail={setPayeeDetail}
                    onTrashed={txnId => setPayeeDetail(prev => (prev && prev.id === txnId ? null : prev))}
                    onRowsChange={setLocalMonthTxns}
                    showAccount={false}
                    showSourceAccount={isMerged}
                    markExcludedFromTotals
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
                    {range.count ? `${range.count} in totals · ` : ''}
                    Total: {formatCurrency(range.count ? range.total : localMonthTxns.reduce((s, t) => s + t.amount, 0))}
                    {/* The total (and the chart above) omit excluded-from-totals rows like transfers; the
                       rows stay listed and marked, so name the gap here rather than letting the count look wrong. */}
                    {localMonthTxns.some(t => t.excluded_from_totals)
                      ? ` · ${localMonthTxns.filter(t => t.excluded_from_totals).length} excluded`
                      : ''}
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
        onCategorized={(txnId, cat) => setLocalMonthTxns(prev => prev.map(t => (
          t.id === txnId
            ? { ...t, category_id: cat?.id ?? null, category_name: cat?.name ?? null, category_color: null, category_overridden: 1 }
            : t
        )))}
        onTrashed={txnId => setLocalMonthTxns(prev => prev.filter(t => t.id !== txnId))}
        onNotesSaved={(txnId, notes) => setLocalMonthTxns(prev => prev.map(t => (t.id === txnId ? { ...t, notes } : t)))}
        onTagsChanged={(txnId, tags) => setLocalMonthTxns(prev => prev.map(t => (t.id === txnId ? { ...t, tags } : t)))}
        forceFloating
        stackIndex={stackIndex + 1}
        dateStart={dateStart}
        dateEnd={dateEnd}
      />
    )}
    {categoryDetail && (
      <CategoryDetail
        category={categoryDetail}
        categories={categories}
        onClose={() => setCategoryDetail(null)}
        forceFloating
        stackIndex={stackIndex + 1}
        dateStart={dateStart}
        dateEnd={dateEnd}
      />
    )}
    </>
  )
}
