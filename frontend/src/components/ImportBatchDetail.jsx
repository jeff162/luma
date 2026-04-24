// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api.js'
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
  /*
   * File detail answers a ledger question rather than a spending-history question:
   * the user wants every transaction imported from this batch across accounts and
   * directions, so this drawer reuses the shared detail shell with a paged ledger.
   */
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
      limit,
      offset,
    })
  ), [batch.id])
  const {
    rows,
    setRows,
    loading,
    listRef,
  } = usePagedTransactions({
    activeKey: batch.id,
    loadPage,
  })

  useEffect(() => {
    let cancelled = false
    setCountLoading(true)
    api.getTransactions({
      import_batch_id: batch.id,
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
  }, [batch.id])

  async function handleCategorySave(txnId, categoryId, categoryObj) {
    await api.overrideCategory(txnId, categoryId)
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

  const header = (
    <>
      <div style={{ fontSize: 17, fontWeight: 600, lineHeight: 1.35 }}>
        {batch.filename}
      </div>
      <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2 }}>
        Imported {(batch.imported_at || '').slice(0, 16).replace('T', ' ')}
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>
        {countLoading ? 'Loading imported transactions…' : `${totalCount} imported transaction${totalCount === 1 ? '' : 's'} from this file`}
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
        <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>
          Imported transactions from this file. Category changes made here update the underlying transactions directly.
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
            usePillTable={true}
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
