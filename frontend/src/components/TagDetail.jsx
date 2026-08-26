// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useMemo, useState } from 'react'
import { api } from '../lib/api.js'
import { makeRowReconciler, applyCategoryChange } from '../lib/txnMutations.js'
import { formatSignedMoneyAmount } from '../lib/moneyDisplay.js'
import { Spinner } from './ui.jsx'
import TransactionListTable from './TransactionListTable.jsx'
import TransactionDetail from './TransactionDetail.jsx'
import CategoryDetail from './CategoryDetail.jsx'
import TransactionListToolbar from './TransactionListToolbar.jsx'
import { useBulkTransactionEditing, BulkEditChrome } from '../lib/useBulkTransactionEditing.jsx'
import { useTransactionTableLayout } from '../lib/transactionTablePreferences.js'
import {
  DETAIL_LIST_MAX_HEIGHT,
  DetailPanelShell,
  useDetailPanelChrome,
  usePagedTransactions,
  usePanelReveal,
} from './detailShared.jsx'

const TAG_DETAIL_TABLE_PREF_KEY = 'ui.tagDetail.transactions.columns'

/*
 * Floating detail panel scoped to one tag-signature wedge from the dashboard's
 * tag report. The signature is the *exact* set of selected report tags a transaction
 * carries — so an "Alice + Essential" wedge shows transactions tagged with both,
 * a single-tag wedge shows transactions with that one tag only, and the "Other /
 * Untagged" wedge shows transactions that match none of the selected report tags.
 *
 * The backend tag filter is OR-only, so we fetch any transactions matching at least
 * one report tag (or, for the Other signature, fetch all view-scoped transactions
 * for the period) and post-filter on the frontend by exact signature match.
 */
export default function TagDetail({
  signature,
  reportTagIds,
  reportName,
  view,
  accountId,
  dateStart,
  dateEnd,
  filterTagIds,
  categories = [],
  onClose,
  forceFloating = false,
  stackIndex = 0,
  isTopmost = true,
}) {
  const { pos, size, panelRef, onDragStart, onResizeStart } =
    useDetailPanelChrome(onClose, { forceFloating, stackIndex })
  const [payeeDetail, setPayeeDetail] = useState(null)
  const [categoryDetail, setCategoryDetail] = useState(null)
  const [columnConfig, setColumnConfig] = useTransactionTableLayout({
    preferenceKey: TAG_DETAIL_TABLE_PREF_KEY,
  })

  const signatureTagIds = signature?.signature_tag_ids || []
  const signatureKey = signatureTagIds.slice().sort().join('|')
  const reportTagsKey = (reportTagIds || []).slice().sort().join('|')

  // Scope the slice entirely server-side: a row must have *all* the signature's tags
  // (require_all_tag_ids, AND) and *none* of the report's other tags (exclude_tag_ids). For the "Other"
  // slice (no signature tags) that reduces to "none of the report's tags." Because require_all is
  // independent of the OR `tag_ids`, the active filter's own tag_ids still applies on top. These params
  // resolve exactly the slice's rows, so they drive both the paged fetch and "select all matching".
  const fetchParams = useMemo(() => {
    const otherReportTags = (reportTagIds || []).filter(id => !signatureTagIds.includes(id))
    return {
      ...(dateStart ? { date_start: dateStart } : {}),
      ...(dateEnd ? { date_end: dateEnd } : {}),
      ...(accountId ? { account_id: accountId } : {}),
      ...(filterTagIds ? { tag_ids: filterTagIds } : {}),
      ...(signatureTagIds.length ? { require_all_tag_ids: signatureTagIds.join(',') } : {}),
      ...(otherReportTags.length ? { exclude_tag_ids: otherReportTags.join(',') } : {}),
      ...(view ? { view } : {}),
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- signatureKey/reportTagsKey subsume the arrays
  }, [signatureKey, reportTagsKey, view, accountId, dateStart, dateEnd, filterTagIds])

  const activeKey = signature ? JSON.stringify(fetchParams) : null
  const loadPage = useCallback((offset, limit, sort) => (
    api.getTransactions({ ...fetchParams, limit, offset, sort_by: sort.key, sort_dir: sort.dir })
  ), [fetchParams])
  const {
    rows: transactions,
    setRows: setTransactions,
    loading,
    listRef,
    sortState,
    onSort,
  } = usePagedTransactions({ activeKey, loadPage })

  // Hold the panel invisible until its geometry settles, so it fades in fully formed rather than
  // visibly growing as its content lands (see usePanelReveal).
  const revealed = usePanelReveal(panelRef, !loading)

  function saveCategory(txnId, catId, catObj) {
    const cat = catObj || categories.find(c => c.id === catId)
    applyCategoryChange(txnId, cat, patch => setTransactions(prev => prev.map(t => (
      t.id === txnId ? { ...t, ...patch } : t
    ))))
  }

  // Count and total are the authoritative server bucket values for this slice (from the tag-report
  // aggregation), not a sum of the displayed rows — so the header matches the pie exactly and is
  // independent of how many rows have paged in.
  const headerCount = Number(signature?.count) || 0
  // Signed net from the server bucket (no ABS): a signature that net-refunded reads negative, matching
  // the pie/list. The header shows the true amount.
  const total = Number(signature?.total) || 0
  const headerLabel = signature?.signature_name || 'Tag signature'

  // The slice is fully server-resolvable (fetchParams), so "select all matching" resolves the whole
  // slice server-side rather than only the loaded rows.
  const bulk = useBulkTransactionEditing({
    rows: transactions,
    setRows: setTransactions,
    total: headerCount,
    filterParams: fetchParams,
    categories,
  })

  const header = (
    <>
      <div style={{ fontSize: 17, fontWeight: 600, lineHeight: 1.35 }}>{headerLabel}</div>
      <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2 }}>
        {reportName ? `${reportName} · ` : ''}{headerCount} transaction{headerCount !== 1 ? 's' : ''} · {formatSignedMoneyAmount(total)}
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
      {loading ? (
        <Spinner />
      ) : transactions.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--muted)' }}>No transactions found.</div>
      ) : (
        <>
          <TransactionListToolbar rows={transactions} title={reportName || 'Tagged transactions'} bulk={bulk} />
          <BulkEditChrome controller={bulk} />
          <TransactionListTable
            rows={transactions}
            categories={categories}
            {...bulk.tableProps}
            onCategorySave={saveCategory}
            onCategoryOpenDetail={setCategoryDetail}
            onTransactionOpenDetail={setPayeeDetail}
            onTrashed={txnId => setPayeeDetail(prev => (prev && prev.id === txnId ? null : prev))}
            onRowsChange={setTransactions}
            columnConfig={columnConfig}
            onColumnConfigChange={setColumnConfig}
            maxHeight={DETAIL_LIST_MAX_HEIGHT}
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
        onReconcile={makeRowReconciler(setTransactions)}
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
