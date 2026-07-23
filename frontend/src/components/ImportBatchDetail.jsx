// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * File-scoped ledger drawer: shows every transaction that was imported from a single
 * import_batch, across all accounts the file populated. Reached from the file-card on the
 * Import / Export page (full file view) and from the duplicate-detection dialog's drill-
 * through arrow (file view, optionally scoped to a date range from a coverage-window match).
 *
 * Three filters all flow through the same `activeKey` into `usePagedTransactions`, which
 * resets pagination to page 1 whenever any of them change:
 *   - the batch id itself (always present)
 *   - an optional date range from `batch._dateFilter` (set by drill-through callers; lives
 *     on the batch payload so the parent doesn't need to plumb extra props through its
 *     stacked-panel state)
 *   - the user's debounced search input (the backend quick-filter: merchant / category / account /
 *     amount, plus date jumps — a full date, year, or month, or a year-less partial like a bare
 *     month or month/day that matches that calendar slot across every year)
 *
 * The panel itself is read-write for categories: changes the user makes from this drawer
 * (via the inline CategoryPicker) update the underlying txn rows directly, the same way the
 * Transactions page does.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api.js'
import { txnMutations, makeRowReconciler, categoryReconcilePatch } from '../lib/txnMutations.js'
import { formatMoneyMagnitude } from '../lib/moneyDisplay.js'
import { Button, Spinner } from './ui.jsx'
import TransactionListTable from './TransactionListTable.jsx'
import TransactionDetail from './TransactionDetail.jsx'
import CategoryDetail from './CategoryDetail.jsx'
import { useBulkTransactionEditing, BulkEditChrome } from '../lib/useBulkTransactionEditing.jsx'
import { useTransactionTableLayout } from '../lib/transactionTablePreferences.js'
import FeatureExplainer from '../help/FeatureExplainer.jsx'
import { DetailPanelShell, useDetailPanelChrome, usePagedTransactions } from './detailShared.jsx'

const IMPORT_BATCH_DETAIL_TABLE_PREF_KEY = 'ui.importBatchDetail.transactions.columns'

// This drawer is a file-scoped ledger, so the Account column must read as the account the file
// actually populated — its as-imported label (`source_account_raw_name` = account.name). The
// shared transaction table otherwise shows the effective `account_name`, which resolves a merged
// child to its parent's display name and would hide the file's real account. When the source
// account has since been merged under a parent, we keep the file label and annotate the mapping
// (e.g. "Credit Card → Rewards Card") so the merge stays visible without rewriting history.
function withSourceAccountLabel(txn) {
  const source = txn?.source_account_raw_name
  if (!source) return txn
  if (source === txn.account_name) return txn
  return { ...txn, account_name: `${source} → ${txn.account_name}` }
}

export default function ImportBatchDetail({
  batch,
  categories = [],
  onAddCategory,
  onClose,
  onReviewCountChange,
  forceFloating = true,
  stackIndex = 0,
  isTopmost = true,
}) {
  const dateFilter = batch?._dateFilter || null
  const dateStart = dateFilter?.dateStart || null
  const dateEnd   = dateFilter?.dateEnd   || null

  // Reviewing rows here (categorizing, bulk/row-menu "Mark reviewed", detail-panel edits) clears their
  // needs_review flag, which the parent import card surfaces as its "N to review" pill. Those clears
  // include rows past the loaded page (bulk "select all matching"), so rather than track a delta we
  // re-query the batch's authoritative remaining count on close and hand it back, letting the card
  // reconcile in place instead of only refreshing on a page revisit. The count is whole-batch — no
  // date/search scope — since the pill counts the whole file regardless of any drill-through filter.
  const reportReviewCount = useCallback(() => {
    if (!onReviewCountChange) return
    api.getTransactions({ import_batch_id: batch.id, needs_review: true, limit: 1 })
      .then(result => onReviewCountChange(batch.id, Number(result?.total || 0)))
      .catch(() => {})
  }, [onReviewCountChange, batch.id])
  const handleClose = useCallback(() => {
    reportReviewCount()
    onClose?.()
  }, [reportReviewCount, onClose])

  const [filterInput, setFilterInput] = useState('')
  const [debouncedFilter, setDebouncedFilter] = useState('')
  useEffect(() => {
    const handle = setTimeout(() => setDebouncedFilter(filterInput.trim()), 250)
    return () => clearTimeout(handle)
  }, [filterInput])
  const { pos, panelRef, onDragStart } = useDetailPanelChrome(handleClose, { forceFloating, stackIndex })
  const [totalCount, setTotalCount] = useState(0)
  const [countLoading, setCountLoading] = useState(true)
  const [payeeDetail, setPayeeDetail] = useState(null)
  const [categoryDetail, setCategoryDetail] = useState(null)
  const [columnConfig, setColumnConfig] = useTransactionTableLayout({
    preferenceKey: IMPORT_BATCH_DETAIL_TABLE_PREF_KEY,
  })
  const loadPage = useCallback((offset, limit) => (
    api.getTransactions({
      import_batch_id: batch.id,
      ...(dateStart ? { date_start: dateStart } : {}),
      ...(dateEnd   ? { date_end:   dateEnd   } : {}),
      ...(debouncedFilter ? { quick_filter: debouncedFilter } : {}),
      limit,
      offset,
    }).then(result => ({
      ...result,
      transactions: (result?.transactions || []).map(withSourceAccountLabel),
    }))
  ), [batch.id, dateStart, dateEnd, debouncedFilter])
  const {
    rows,
    setRows,
    loading,
    listRef,
  } = usePagedTransactions({
    activeKey: `${batch.id}|${dateStart || ''}|${dateEnd || ''}|${debouncedFilter}`,
    loadPage,
  })

  // Bulk edit over this file's imported rows. Scope mirrors the list fetch (batch + date/search), so
  // "select all matching" resolves the whole file even though the list is paged; rows reconcile in place.
  const bulk = useBulkTransactionEditing({
    rows,
    setRows,
    total: totalCount,
    filterParams: {
      import_batch_id: batch.id,
      ...(dateStart ? { date_start: dateStart } : {}),
      ...(dateEnd ? { date_end: dateEnd } : {}),
      ...(debouncedFilter ? { quick_filter: debouncedFilter } : {}),
    },
    categories,
    onRowsTrashed: count => setTotalCount(prev => Math.max(0, prev - count)),
  })

  useEffect(() => {
    let cancelled = false
    setCountLoading(true)
    api.getTransactions({
      import_batch_id: batch.id,
      ...(dateStart ? { date_start: dateStart } : {}),
      ...(dateEnd   ? { date_end:   dateEnd   } : {}),
      ...(debouncedFilter ? { quick_filter: debouncedFilter } : {}),
      limit: 1,
      offset: 0,
    }).then(result => {
      if (cancelled) return
      setTotalCount(Number(result?.total || 0))
      setCountLoading(false)
    }).catch(() => {
      if (cancelled) return
      setTotalCount(0)
      setCountLoading(false)
    })
    return () => { cancelled = true }
  }, [batch.id, dateStart, dateEnd, debouncedFilter])

  // Rows this file imported that were later removed as confirmed duplicates (via the duplicate
  // report's Discard new / Replace existing, or an account merge). They are trashed, so they
  // never come back from getTransactions — we surface them here as an audit trail so a Replace
  // done from another file's report doesn't make this file's matching row vanish without a trace.
  const [dedupedRows, setDedupedRows] = useState([])
  const [dedupedOpen, setDedupedOpen] = useState(false)
  useEffect(() => {
    let cancelled = false
    api.getBatchDedupedRows(batch.id)
      .then(result => { if (!cancelled) setDedupedRows(result?.rows || []) })
      .catch(() => { if (!cancelled) setDedupedRows([]) })
    return () => { cancelled = true }
  }, [batch.id])
  const visibleDeduped = useMemo(() => {
    // Best-effort merchant-substring filter on the small removed-rows audit list; the main table's
    // quick filter is backend-resolved (date/amount/etc.) and this list isn't, so a non-name query
    // (e.g. a date) simply hides it.
    const term = debouncedFilter.toLowerCase()
    if (!term) return dedupedRows
    return dedupedRows.filter(r => (r.merchant || '').toLowerCase().includes(term))
  }, [dedupedRows, debouncedFilter])

  async function handleCategorySave(txnId, categoryId, categoryObj) {
    await txnMutations.setCategory(txnId, categoryId)
    const resolvedCategory = categoryObj || categories.find(category => category.id === categoryId) || null
    setRows(prev => prev.map(txn => (
      txn.id === txnId ? { ...txn, ...categoryReconcilePatch(resolvedCategory) } : txn
    )))
  }

  const dateFilterLabel = (dateStart || dateEnd)
    ? ` (filtered: ${dateStart || ''}${dateEnd && dateEnd !== dateStart ? ` … ${dateEnd}` : ''})`
    : ''
  const header = (
    <>
      <div style={{ fontSize: 17, fontWeight: 600, lineHeight: 1.35 }}>
        {batch.filename}
      </div>
      <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2 }}>
        Imported {(batch.imported_at || '').slice(0, 16).replace('T', ' ')}
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>
        {countLoading ? 'Loading imported transactions…' : `${totalCount} imported transaction${totalCount === 1 ? '' : 's'} from this file${dateFilterLabel}`}
      </div>
    </>
  )

  return (
    <>
    <DetailPanelShell
      pos={pos}
      panelRef={panelRef}
      onDragStart={onDragStart}
      onClose={handleClose}
      header={header}
      isTopmost={isTopmost}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, flex: 1, minHeight: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <input
            type="search"
            value={filterInput}
            onChange={(e) => setFilterInput(e.target.value)}
            placeholder="Search merchant, amount, or date (2023, 03, 03/15, 03/2023, 03/15/2023)…"
            aria-label="Search transactions by merchant, amount, or date"
            title="Matches merchant, category, account, amount, or date. Date jumps support a year (2023), month-in-year (03/2023), or day (03/15/2023); a year-less month (03) or month/day (03/15) matches that slot across every year. Prefix to restrict, e.g. amount:68 or date:03/2023."
            style={{
              flex: '0 1 360px',
              minWidth: 240,
              padding: '8px 12px',
              fontSize: 13,
              borderRadius: 8,
              border: '1px solid var(--accent)',
              background: 'var(--surface2)',
              color: 'var(--text)',
              outline: 'none',
            }}
          />
          <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5, flex: '1 1 220px' }}>
            Imported transactions from this file. Category changes made here update the underlying transactions directly.
          </div>
          <FeatureExplainer topic="searching-transactions" placement="bottom-left" />
          <Button variant="ghost" small onClick={bulk.toggle}>
            {bulk.bulkMode ? '✕ Done' : 'Bulk Edit'}
          </Button>
        </div>
        <BulkEditChrome controller={bulk} />
        {visibleDeduped.length > 0 ? (
          <div style={{ flex: '0 0 auto', border: '1px solid color-mix(in srgb, var(--warning) 30%, var(--border))', borderRadius: 8, background: 'color-mix(in srgb, var(--warning) 6%, var(--surface2))', overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center' }}>
              <button
                type="button"
                onClick={() => setDedupedOpen(open => !open)}
                style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text)', fontSize: 12.5, textAlign: 'left' }}
              >
                <span style={{ color: 'var(--warning)' }}>{dedupedOpen ? '▾' : '▸'}</span>
                <span style={{ fontWeight: 600 }}>Removed as duplicates ({visibleDeduped.length})</span>
                <span style={{ color: 'var(--muted)', fontWeight: 400 }}>— the matching copy is kept on another account</span>
              </button>
              <span style={{ paddingRight: 10, display: 'inline-flex' }}>
                <FeatureExplainer topic="removed-as-duplicates" placement="bottom-left" />
              </span>
            </div>
            {dedupedOpen ? (
              <div style={{ maxHeight: 180, overflow: 'auto', borderTop: '1px solid color-mix(in srgb, var(--warning) 24%, var(--border))' }}>
                {visibleDeduped.map(r => {
                  const survivor = r.surviving_account_name
                    ? (r.surviving_account_merged_into && r.surviving_account_merged_into !== r.surviving_account_name
                      ? `${r.surviving_account_name} → ${r.surviving_account_merged_into}`
                      : r.surviving_account_name)
                    : 'another account'
                  return (
                    <div key={r.id} style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '4px 12px', fontSize: 12, borderTop: '1px solid color-mix(in srgb, var(--border) 50%, transparent)' }}>
                      <span style={{ color: 'var(--muted)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{r.date}</span>
                      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textDecoration: 'line-through', textDecorationColor: 'color-mix(in srgb, var(--muted) 55%, transparent)' }}>{r.merchant || '—'}</span>
                      <span style={{ fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{formatMoneyMagnitude(Math.abs(r.amount || 0))}</span>
                      <span style={{ color: 'var(--muted)', flexShrink: 0 }}>
                        {r.resolved_by === 'auto_merge' ? '→ merged into ' : '→ kept on '}{survivor}
                      </span>
                    </div>
                  )
                })}
              </div>
            ) : null}
          </div>
        ) : null}
        {loading && rows.length === 0 ? (
          <Spinner />
        ) : (
          <TransactionListTable
            rows={rows}
            categories={categories}
            {...bulk.tableProps}
            onCategorySave={handleCategorySave}
            onCategoryOpenDetail={setCategoryDetail}
            onTransactionOpenDetail={setPayeeDetail}
            onTrashed={txnId => {
              setTotalCount(prev => Math.max(0, prev - 1))
              setPayeeDetail(prev => (prev && prev.id === txnId ? null : prev))
            }}
            onAddCategory={onAddCategory}
            onRowsChange={setRows}
            columnConfig={columnConfig}
            onColumnConfigChange={setColumnConfig}
            fillHeight
            scrollRef={listRef}
            emptyMessage="No imported transactions remain for this file."
          />
        )}
      </div>
    </DetailPanelShell>
    {payeeDetail && (
      <TransactionDetail
        txn={payeeDetail}
        categories={categories}
        onClose={() => setPayeeDetail(null)}
        onReconcile={makeRowReconciler(setRows, { onRemoved: () => setTotalCount(prev => Math.max(0, prev - 1)) })}
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
