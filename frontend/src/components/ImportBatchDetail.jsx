// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * File-scoped ledger drawer: shows every transaction that was imported from a single
 * import_batch, across all accounts the file populated. Reached from the file-card on the
 * Import page (full file view) and from the duplicate-detection dialog's drill-
 * through arrow (file view, optionally scoped to a date range from a coverage-window match).
 *
 * Five filters all flow through the same `activeKey` into `usePagedTransactions`, which
 * resets pagination to page 1 whenever any of them change:
 *   - the batch id itself (always present)
 *   - an optional date range from `batch._dateFilter` (set by drill-through callers; lives
 *     on the batch payload so the parent doesn't need to plumb extra props through its
 *     stacked-panel state)
 *   - an optional sync scope from `batch._syncScope` (set by the Connections card, same
 *     payload-carried mechanism as `_dateFilter`): narrows the card to just the rows one
 *     sync delivered, so newly arrived transactions can be categorized where they arrived
 *     rather than amid a whole month of the card they landed on
 *   - the user's debounced search input — the same backend search (`quick_filter`) as the Transactions page, so
 *     its grammar (keywords, dates, signed amounts) is documented once, in the `searching-transactions`
 *     help topic and `_build_quick_filter_clause`
 *   - the ledger's quick filter (`AttributeFilterControl`), seeded from `batch._attributeFilter`: the card's
 *     "N to review" pill opens with Needs review switched on, every other way in opens with it chosen but
 *     off, so the rows still to look over are one click away without hiding the rest of the file
 *
 * The panel itself is read-write for categories: changes the user makes from this drawer
 * (via the inline CategoryPicker) update the underlying txn rows directly, the same way the
 * Transactions page does.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api.js'
import { makeRowReconciler, applyCategoryChange } from '../lib/txnMutations.js'
import { useUnifiedDuplicatesViewer } from '../contexts/UnifiedDuplicatesViewerContext.jsx'
import { Button, RefreshButton, SearchInput, SegmentedToggle, Spinner } from './ui.jsx'
import AttributeFilterControl from './AttributeFilterControl.jsx'
import TransactionListTable from './TransactionListTable.jsx'
import TransactionDetail from './TransactionDetail.jsx'
import CategoryDetail from './CategoryDetail.jsx'
import { useBulkTransactionEditing, BulkEditChrome } from '../lib/useBulkTransactionEditing.jsx'
import { useTransactionTableLayout } from '../lib/transactionTablePreferences.js'
import FeatureExplainer from '../help/FeatureExplainer.jsx'
import { DetailPanelShell, useDetailPanelChrome, usePagedTransactions } from './detailShared.jsx'
import ImportBatchNotImported from './importExport/ImportBatchNotImported.jsx'
import { summarizeImportOutcome } from '../lib/importExport/importOutcome.js'

const IMPORT_BATCH_DETAIL_TABLE_PREF_KEY = 'ui.importBatchDetail.transactions.columns'

// The quick filter's choice when the opener names none. A file's report is opened to look over what it
// brought in, so the attribute worth being one click away is the one the card's own pill counts.
const DEFAULT_ATTRIBUTE = 'needs-review'

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
  const dateEnd = dateFilter?.dateEnd || null
  // Scoped to one sync's rows. Only the connection id travels: the row ids live on the connection's stored
  // sync summary and the server expands them, so this stays one short param on every page, sort and count
  // rather than several kilobytes of query string.
  const syncConnectionId = batch?._syncScope?.connectionId || null
  // A data connection's card holds whatever its syncs delivered for a period, not a file, so its unscoped
  // report names the card rather than calling it a file.
  const isSyncCard = batch?.source_kind === 'connection_sync'
  const unscopedNoun = count => (isSyncCard
    ? `synced transaction${count === 1 ? '' : 's'} on this card`
    : `imported transaction${count === 1 ? '' : 's'} from this file`)

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
      .catch(() => { })
  }, [onReviewCountChange, batch.id])
  const handleClose = useCallback(() => {
    reportReviewCount()
    onClose?.()
  }, [reportReviewCount, onClose])

  // The file's two halves — what it brought in, and what it did not. The second tab exists only when the
  // file left something out, so a clean import looks exactly as it did before there were tabs. Which one
  // opens travels on the payload (`_view`/`_rejectedKind`) like every other opener instruction here, so a
  // card's "N rejected" pill lands on those rows with their reason already selected.
  const notImportedSummary = summarizeImportOutcome(batch)
  const notImportedCount = notImportedSummary.rejectedCount
    + notImportedSummary.accountSkippedCount
    + notImportedSummary.trailingNonTransactionCount
  const seedView = batch?._view === 'not-imported' && notImportedCount > 0 ? 'not-imported' : 'imported'
  const [view, setView] = useState(seedView)
  useEffect(() => { setView(seedView) }, [seedView, batch])

  // Seeded from the payload rather than held by the opener, like `_dateFilter`. Re-applied when the payload
  // changes, because re-opening an open report replaces its entry: the pill turning the filter on, or the ↗
  // opening it plain, is an explicit instruction that outranks whatever was toggled since.
  const seedAttribute = batch?._attributeFilter?.attribute || DEFAULT_ATTRIBUTE
  const seedActive = !!batch?._attributeFilter?.active
  const [attributeFilter, setAttributeFilter] = useState({ attribute: seedAttribute, active: seedActive })
  useEffect(() => {
    setAttributeFilter({ attribute: seedAttribute, active: seedActive })
  }, [seedAttribute, seedActive])
  // Fetched, as on the Transactions page, so the two cannot drift in keys or labels.
  const [filterAttributes, setFilterAttributes] = useState([])
  useEffect(() => {
    api.getFilterAttributes().then(setFilterAttributes).catch(() => { })
  }, [])
  const activeAttribute = attributeFilter.active ? attributeFilter.attribute : null
  const activeAttributeLabel = activeAttribute
    ? filterAttributes.find(attribute => attribute.key === activeAttribute)?.label || null
    : null
  // A reviewed or recategorized row stays where it is until a refresh, as on the Transactions page, so a
  // row does not vanish from a filtered list the moment it stops matching. This re-runs the counts beside
  // the list; the list itself reloads through `usePagedTransactions().reload`, which keeps the reader's place.
  const [refreshNonce, setRefreshNonce] = useState(0)

  const [filterInput, setFilterInput] = useState('')
  const [debouncedFilter, setDebouncedFilter] = useState('')
  useEffect(() => {
    const handle = setTimeout(() => setDebouncedFilter(filterInput.trim()), 250)
    return () => clearTimeout(handle)
  }, [filterInput])
  const { pos, panelRef, onDragStart } = useDetailPanelChrome(handleClose, { forceFloating, stackIndex })
  const [totalCount, setTotalCount] = useState(0)
  // The scope's size without the quick filter, so a filtered header can say "12 of 240".
  const [unfilteredCount, setUnfilteredCount] = useState(0)
  const [countLoading, setCountLoading] = useState(true)
  const [payeeDetail, setPayeeDetail] = useState(null)
  const [categoryDetail, setCategoryDetail] = useState(null)
  const [columnConfig, setColumnConfig] = useTransactionTableLayout({
    preferenceKey: IMPORT_BATCH_DETAIL_TABLE_PREF_KEY,
  })
  // The panel's scope, in one place: the list, the count and "select all matching" must resolve the same
  // set or a bulk edit reaches rows the list never showed.
  const unfilteredScopeParams = useMemo(() => ({
    import_batch_id: batch.id,
    ...(syncConnectionId ? { sync_connection_id: syncConnectionId } : {}),
    ...(dateStart ? { date_start: dateStart } : {}),
    ...(dateEnd ? { date_end: dateEnd } : {}),
    ...(debouncedFilter ? { quick_filter: debouncedFilter } : {}),
  }), [batch.id, syncConnectionId, dateStart, dateEnd, debouncedFilter])
  // The quick filter ANDs, through the same parameter the Transactions page sends it on.
  const scopeParams = useMemo(() => (
    activeAttribute ? { ...unfilteredScopeParams, require_all_attribute_ids: activeAttribute } : unfilteredScopeParams
  ), [unfilteredScopeParams, activeAttribute])
  const loadPage = useCallback((offset, limit, sort) => (
    api.getTransactions({
      ...scopeParams,
      limit,
      offset,
      sort_by: sort.key,
      sort_dir: sort.dir,
    }).then(result => ({
      ...result,
      transactions: (result?.transactions || []).map(withSourceAccountLabel),
    }))
  ), [scopeParams])
  const {
    rows,
    setRows,
    loading,
    reload,
    reloading,
    paging,
    sortState,
    onSort,
  } = usePagedTransactions({
    activeKey: `${batch.id}|${syncConnectionId || ''}|${dateStart || ''}|${dateEnd || ''}|${debouncedFilter}|${activeAttribute || ''}`,
    loadPage,
  })
  const refresh = useCallback(() => {
    setRefreshNonce(n => n + 1)
    reload()
  }, [reload])

  // Bulk edit over this file's imported rows. Scope mirrors the list fetch (batch + date/search), so
  // "select all matching" resolves the whole file even though the list is paged; rows reconcile in place.
  const bulk = useBulkTransactionEditing({
    rows,
    setRows,
    total: totalCount,
    filterParams: scopeParams,
    categories,
    onRowsTrashed: count => setTotalCount(prev => Math.max(0, prev - count)),
  })

  useEffect(() => {
    let cancelled = false
    setCountLoading(true)
    const count = params => api.getTransactions({ ...params, limit: 1, offset: 0 })
      .then(result => Number(result?.total || 0))
    Promise.all([
      count(scopeParams),
      activeAttribute ? count(unfilteredScopeParams) : null,
    ]).then(([scoped, unfiltered]) => {
      if (cancelled) return
      setTotalCount(scoped)
      setUnfilteredCount(unfiltered ?? scoped)
      setCountLoading(false)
    }).catch(() => {
      if (cancelled) return
      setTotalCount(0)
      setUnfilteredCount(0)
      setCountLoading(false)
    })
    return () => { cancelled = true }
  }, [scopeParams, unfilteredScopeParams, activeAttribute, refreshNonce])

  // Rows this file imported that were later removed as confirmed duplicates (a duplicate report's Discard new
  // or Replace existing — possibly another file's — or an account merge). They are trashed, so they never
  // come back from getTransactions, and without a trace here a Replace done elsewhere would make this file's
  // matching row simply vanish. Only the count is shown: the rows are reviewed, and restored, in the file's
  // duplicate report, which the line opens — a second read-only rendering here left no way to act on them.
  const duplicatesViewer = useUnifiedDuplicatesViewer()
  const [removedCount, setRemovedCount] = useState(0)
  useEffect(() => {
    let cancelled = false
    api.getBatchRemovedDuplicates(batch.id)
      .then(result => { if (!cancelled) setRemovedCount(Number(result?.count || 0)) })
      .catch(() => { if (!cancelled) setRemovedCount(0) })
    return () => { cancelled = true }
  }, [batch.id, refreshNonce])
  // A Restore in that report puts a row back in this ledger and takes it off the count, so each reload of
  // the report refreshes this panel. Keyed to the version seen at mount, so opening the ledger after the
  // report was used earlier does not repeat the load it just did.
  const duplicatesVersion = duplicatesViewer.viewer?.data?.version || 0
  const handledDuplicatesVersionRef = useRef(duplicatesVersion)
  useEffect(() => {
    if (duplicatesVersion === handledDuplicatesVersionRef.current) return
    handledDuplicatesVersionRef.current = duplicatesVersion
    refresh()
  }, [duplicatesVersion, refresh])

  async function handleCategorySave(txnId, categoryId, categoryObj) {
    const resolvedCategory = categoryObj || categories.find(category => category.id === categoryId) || null
    await applyCategoryChange(txnId, resolvedCategory, (patch, id) => setRows(prev => prev.map(txn => (
      txn.id === id ? { ...txn, ...patch } : txn
    ))))
  }

  const dateFilterLabel = (dateStart || dateEnd)
    ? ` (filtered: ${dateStart || ''}${dateEnd && dateEnd !== dateStart ? ` … ${dateEnd}` : ''})`
    : ''
  const scopeNoun = syncConnectionId
    ? `transaction${unfilteredCount === 1 ? '' : 's'} from ${batch?._syncScope?.label || 'the last sync'}`
    : unscopedNoun(unfilteredCount)
  const header = (
    <>
      <div style={{ fontSize: 17, fontWeight: 600, lineHeight: 1.35, display: 'flex', alignItems: 'center', gap: 8 }}>
        {batch.filename}
        {/* Kept out of the panel drag, which the header starts. */}
        <RefreshButton
          onRefresh={refresh}
          loading={reloading}
          onMouseDown={event => event.stopPropagation()}
          title="Refresh — re-query the list and drop transactions that no longer match"
        />
      </div>
      <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2 }}>
        Imported {(batch.imported_at || '').slice(0, 16).replace('T', ' ')}
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>
        {countLoading
          ? 'Loading imported transactions…'
          // Scoped views say what they are scoped to, because the count no longer describes the card named
          // directly above it: a sync files its rows onto the card for their month, which by then usually
          // holds earlier rows from earlier syncs. Saying "from this file" over a subset would misreport
          // both the card and the sync.
          // With the quick filter on, the count is a subset of the scope, and stating only that subset's size
          // would read as the size of the file.
          : activeAttribute
            ? `${activeAttributeLabel || 'Filtered'}: ${totalCount} of ${unfilteredCount} ${scopeNoun}${dateFilterLabel}`
            : syncConnectionId
              ? `${totalCount} transaction${totalCount === 1 ? '' : 's'} from ${batch?._syncScope?.label || 'the last sync'}${dateFilterLabel}`
              : `${totalCount} ${unscopedNoun(totalCount)}${dateFilterLabel}`}
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
          {notImportedCount > 0 ? (
            <div style={{ flex: '0 0 auto', display: 'flex' }}>
              <SegmentedToggle
                value={view}
                onChange={setView}
                ariaLabel="Which of this file's rows to show"
                options={[
                  { value: 'imported', label: 'Imported' },
                  { value: 'not-imported', label: 'Not imported', badge: notImportedCount },
                ]}
              />
            </div>
          ) : null}
          {view === 'not-imported' ? (
            <ImportBatchNotImported
              batchId={batch.id}
              seedKind={batch?._rejectedKind || null}
              onOpenDuplicates={() => duplicatesViewer.open({ batchId: batch.id, title: batch.filename })}
            />
          ) : (
          <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <SearchInput
              value={filterInput}
              onChange={setFilterInput}
              placeholder="Search names, imported text, amounts, or dates (2023, 03/15, -42.10)…"
              aria-label={isSyncCard ? "Search this card's transactions" : "Search this file's transactions"}
              title="Matches names, imported text, category, account, amount, or date. -42.10 is money paid out, +42.10 money received. Dates can be a year (2023), month-in-year (03/2023), or day (03/15/2023); a month (03) or month/day (03/15) matches every year. Start with a keyword to search one field; everything after it is the value, e.g. merchant:city water, raw:meter reading (imported text only) or amount:-68."
              wrapperStyle={{ flex: '0 1 360px', minWidth: 240 }}
              style={{ fontSize: 13, border: '1px solid var(--accent)' }}
            />
            <AttributeFilterControl
              attributes={filterAttributes}
              value={attributeFilter.attribute}
              active={attributeFilter.active}
              onChange={setAttributeFilter}
            />
            <FeatureExplainer topic="searching-transactions" placement="bottom-left" />
            <Button variant="ghost" small onClick={bulk.toggle}>
              {bulk.bulkMode ? '✕ Done' : 'Bulk Edit'}
            </Button>
          </div>
          <BulkEditChrome controller={bulk} />
          {removedCount > 0 ? (
            <div style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '7px 12px', border: '1px solid color-mix(in srgb, var(--warning) 30%, var(--border))', borderRadius: 8, background: 'color-mix(in srgb, var(--warning) 6%, var(--surface2))', fontSize: 12.5 }}>
              <span style={{ fontWeight: 600 }}>Removed as duplicates ({removedCount})</span>
              <button
                type="button"
                // Opens on just the removed rows: the report holds every duplicate of the file, and landing on
                // thousands of import rejects left the ones this line counts nowhere to be found.
                onClick={() => duplicatesViewer.open({ batchId: batch.id, title: batch.filename, kindFilter: 'removed' })}
                style={{ background: 'none', border: 'none', padding: 0, color: 'var(--accent2)', cursor: 'pointer', fontSize: 12.5 }}
              >
                Review or restore in the duplicate report ↗
              </button>
              <span style={{ marginLeft: 'auto', display: 'inline-flex' }}>
                <FeatureExplainer topic="removed-as-duplicates" placement="bottom-left" />
              </span>
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
              paging={paging}
              sortState={sortState}
              onSort={onSort}
              emptyMessage={isSyncCard ? 'No synced transactions remain on this card.' : 'No imported transactions remain for this file.'}
            />
          )}
          </>
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
