// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

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
 *   - the user's debounced search input (matches display_name / merchant_name / raw_name via
 *     the backend's LIKE filter — does NOT match dates; for date lookups, sort by Date and
 *     scroll)
 *
 * The panel itself is read-write for categories: changes the user makes from this drawer
 * (via the inline CategoryPicker) update the underlying txn rows directly, the same way the
 * Transactions page does.
 */

import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api.js'
import { txnMutations } from '../lib/txnMutations.js'
import { Spinner } from './ui.jsx'
import TransactionListTable from './TransactionListTable.jsx'
import { useTransactionTableLayout } from '../lib/transactionTablePreferences.js'
import { DetailPanelShell, useDetailPanelChrome, usePagedTransactions } from './detailShared.jsx'

const IMPORT_BATCH_DETAIL_TABLE_STORAGE_KEY_PREFIX = 'fintrack.import-batch-detail.transactions.columns'
const IMPORT_BATCH_DETAIL_TABLE_PREF_KEY = 'ui.importBatchDetail.transactions.columns'

export default function ImportBatchDetail({
  batch,
  categories = [],
  onAddCategory,
  onClose,
  forceFloating = true,
  stackIndex = 0,
  isTopmost = true,
}) {
  const dateFilter = batch?._dateFilter || null
  const dateStart = dateFilter?.dateStart || null
  const dateEnd   = dateFilter?.dateEnd   || null

  const [searchInput, setSearchInput] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  useEffect(() => {
    const handle = setTimeout(() => setDebouncedSearch(searchInput.trim()), 250)
    return () => clearTimeout(handle)
  }, [searchInput])
  const { pos, dragging, panelRef, onDragStart } = useDetailPanelChrome(onClose, { forceFloating, stackIndex })
  const [totalCount, setTotalCount] = useState(0)
  const [countLoading, setCountLoading] = useState(true)
  const [columnConfig, setColumnConfig] = useTransactionTableLayout({
    storageKeyPrefix: IMPORT_BATCH_DETAIL_TABLE_STORAGE_KEY_PREFIX,
    preferenceKey: IMPORT_BATCH_DETAIL_TABLE_PREF_KEY,
  })
  const loadPage = useCallback((offset, limit) => (
    api.getTransactions({
      import_batch_id: batch.id,
      ...(dateStart ? { date_start: dateStart } : {}),
      ...(dateEnd   ? { date_end:   dateEnd   } : {}),
      ...(debouncedSearch ? { search: debouncedSearch } : {}),
      limit,
      offset,
    })
  ), [batch.id, dateStart, dateEnd, debouncedSearch])
  const {
    rows,
    setRows,
    loading,
    listRef,
  } = usePagedTransactions({
    activeKey: `${batch.id}|${dateStart || ''}|${dateEnd || ''}|${debouncedSearch}`,
    loadPage,
  })

  useEffect(() => {
    let cancelled = false
    setCountLoading(true)
    api.getTransactions({
      import_batch_id: batch.id,
      ...(dateStart ? { date_start: dateStart } : {}),
      ...(dateEnd   ? { date_end:   dateEnd   } : {}),
      ...(debouncedSearch ? { search: debouncedSearch } : {}),
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
  }, [batch.id, dateStart, dateEnd, debouncedSearch])

  async function handleCategorySave(txnId, categoryId, categoryObj) {
    await txnMutations.setCategory(txnId, categoryId)
    const resolvedCategory = categoryObj || categories.find(category => category.id === categoryId) || null
    setRows(prev => prev.map(txn => (
      txn.id === txnId
        ? {
          ...txn,
          category_id: categoryId,
          category_name: resolvedCategory?.name ?? null,
          category_color: null,
          category_overridden: 1,
        }
        : txn
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
    <DetailPanelShell
      pos={pos}
      dragging={dragging}
      panelRef={panelRef}
      onDragStart={onDragStart}
      onClose={onClose}
      header={header}
      isTopmost={isTopmost}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, flex: 1, minHeight: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5, flex: '1 1 280px' }}>
            Imported transactions from this file. Category changes made here update the underlying transactions directly.
          </div>
          <input
            type="search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search merchant / payee…"
            aria-label="Search merchant or payee"
            style={{
              flex: '0 1 240px',
              padding: '6px 10px',
              fontSize: 13,
              borderRadius: 6,
              border: '1px solid var(--border)',
              background: 'var(--surface2)',
              color: 'var(--text)',
              outline: 'none',
            }}
          />
        </div>
        {loading && rows.length === 0 ? (
          <Spinner />
        ) : (
          <TransactionListTable
            rows={rows}
            categories={categories}
            onCategorySave={handleCategorySave}
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
  )
}
