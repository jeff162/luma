// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useLocation } from 'react-router-dom'
import { api } from '../lib/api.js'
import { downloadMatchingTransactions, fetchAllMatchingTransactions } from '../lib/allMatchingTransactions.js'
import { amountFilterParams, selectionsToParams } from '../lib/filterParams.js'
import { txnMutations, applyCategoryChange } from '../lib/txnMutations.js'
import { formatDate } from '../lib/utils.js'
import ImportBatchDetail from '../components/ImportBatchDetail.jsx'
import AttributeFilterControl from '../components/AttributeFilterControl.jsx'
import PillGridTable from '../components/PillGridTable.jsx'
import { formatTransactionAmount } from '../lib/moneyDisplay.js'
import { Button, Card, PageHeader, Spinner, EmptyState, FilterConflictNote, SearchInput, SelectAllCheckbox, Tooltip, RefreshButton, IconButton } from '../components/ui.jsx'
import { planHidingProbes, hidingNoteText, hidingActionLabel } from '../lib/searchHidingProbe.js'
import TransactionDetail from '../components/TransactionDetail.jsx'
import CategoryDetail from '../components/CategoryDetail.jsx'
import AccountDetail from '../components/AccountDetail.jsx'
import { MerchantCell, CategoryCell, TransactionMarkersCell, TransactionAmountCell, getTxnMerchantLabel, getTxnImportSourceLabel } from '../components/TransactionRow.jsx'
import { splitCategoryNames, transactionRowKey } from '../lib/splitRows.js'
import RuleSuggestionToast from '../components/RuleSuggestionToast.jsx'
import { useTransactionRowActions, TransactionRowActionsChrome } from '../lib/useTransactionRowActions.jsx'
import { BULK_SELECT_COLUMN_KEY } from '../lib/useTransactionSelection.js'
import { useBulkTransactionEditing, BulkEditChrome } from '../lib/useBulkTransactionEditing.jsx'
import { useFilters } from '../lib/FilterContext.jsx'
import { useDismissibleLayer } from '../lib/uiInteractions.js'
import { useAfterLedgerSync } from '../contexts/SyncStatusContext.jsx'
import { useUserPreference } from '../lib/UserPreferencesContext.jsx'
import FeatureExplainer from '../help/FeatureExplainer.jsx'
import CopyTransactionsButton from '../components/CopyTransactionsButton.jsx'
import LinkPurchaseDialog from '../components/LinkPurchaseDialog.jsx'
import AddTransactionDialog from '../components/AddTransactionDialog.jsx'
import ReimbursementsReportDialog from '../components/ReimbursementsReportDialog.jsx'
import StoredDocumentsDialog from '../components/StoredDocumentsDialog.jsx'
import TagsDialog from '../components/TagsDialog.jsx'
import ExportTransactionsDialog from '../components/ExportTransactionsDialog.jsx'
import { useStoredDocuments } from '../lib/useStoredDocuments.js'
import { useReimbursementCount } from '../lib/useReimbursementCount.js'
import { sessionStore } from '../lib/browserStorage.js'
import WindowedRows from '../components/WindowedRows.jsx'
import { leadingRows } from '../lib/rowSlots.js'
import { usePagedRowSlots } from '../lib/usePagedRowSlots.js'

const COLUMN_DEFS = [
  { key: 'date', label: 'Date', defaultWidth: 100, minWidth: 70 },
  { key: 'merchant', label: 'Merchant', defaultWidth: 220, minWidth: 120 },
  { key: 'category', label: 'Category', defaultWidth: 150, minWidth: 100 },
  { key: 'account', label: 'Account', defaultWidth: 150, minWidth: 100 },
  // Note/tag/status markers (see TransactionMarkersCell). Not sortable — no single meaningful order
  // across a mix of tags, notes, and status flags.
  { key: 'tags', label: 'Tags', defaultWidth: 90, minWidth: 44, sortable: false },
  { key: 'amount', label: 'Amount', defaultWidth: 92, minWidth: 70 },
]

const DEFAULT_ORDER = ['date', 'merchant', 'category', 'account', 'tags', 'amount']
const TXN_COLUMNS_PREF_KEY = 'ui.transactions.columns'
const TXN_SESSION_STATE_STORAGE_KEY = 'luma:txn-session-state'
const DEFAULT_TRANSACTION_SORT = { key: 'date', dir: 'desc' }
const TRANSACTIONS_PAGE_SIZE = 500
// Rows past the viewport, either way, that are fetched before they scroll into view.
const TRANSACTIONS_PREFETCH_ROWS = 200
const TRANSACTIONS_ROW_ESTIMATE = 38
let transactionsSessionInitialized = false


function normalizeTransactionSortState(value) {
  if (!value || typeof value !== 'object') return DEFAULT_TRANSACTION_SORT
  const key = COLUMN_DEFS.some(column => column.key === value.key) ? value.key : DEFAULT_TRANSACTION_SORT.key
  const dir = value.dir === 'asc' ? 'asc' : 'desc'
  return { key, dir }
}

// The ledger's attribute quick filter always carries a *choice*; what varies is whether it is applied.
// Uncategorized is the seed because it is the most-reached-for of the set and the one the Tasks nudge
// links to — starting with nothing chosen would leave the button unable to name itself, which is the
// whole reason it is one button rather than a row of toggles.
const DEFAULT_ATTRIBUTE_FILTER = { attribute: 'uncategorized', active: false }

function normalizeAttributeFilter(value) {
  // The key is not validated against the vocabulary here: that list is fetched, so it is not available
  // when session state is read, and an unknown key already narrows to nothing server-side rather than
  // erroring. Shape is all this can honestly check.
  if (!value || typeof value !== 'object' || typeof value.attribute !== 'string') {
    return DEFAULT_ATTRIBUTE_FILTER
  }
  return { attribute: value.attribute, active: !!value.active }
}

function getTransactionsNavigationType() {
  if (typeof window === 'undefined' || !window.performance?.getEntriesByType) return ''
  const navigationEntry = window.performance.getEntriesByType('navigation')[0]
  return navigationEntry?.type || ''
}

function loadTransactionsSessionState() {
  if (typeof window === 'undefined') return null
  if (!transactionsSessionInitialized) {
    transactionsSessionInitialized = true
    if (getTransactionsNavigationType() === 'reload') {
      sessionStore.remove(TXN_SESSION_STATE_STORAGE_KEY)
      return null
    }
  }
  const parsed = sessionStore.getJson(TXN_SESSION_STATE_STORAGE_KEY)
  if (!parsed) return null
  return {
    quickFilter: typeof parsed.quickFilter === 'string' ? parsed.quickFilter : '',
    sortState: normalizeTransactionSortState(parsed.sortState),
    attributeFilter: normalizeAttributeFilter(parsed.attributeFilter),
  }
}

function saveTransactionsSessionState({ quickFilter, sortState, attributeFilter }) {
  sessionStore.setJson(TXN_SESSION_STATE_STORAGE_KEY, {
    quickFilter: quickFilter || '',
    sortState: normalizeTransactionSortState(sortState),
    attributeFilter: normalizeAttributeFilter(attributeFilter),
  })
}

function defaultColumnConfig() {
  return DEFAULT_ORDER.map(key => {
    const def = COLUMN_DEFS.find(d => d.key === key)
    return { key, width: def.defaultWidth }
  })
}

function normalizeColumnConfig(cfg) {
  if (!Array.isArray(cfg)) return null
  const byKey = new Map(cfg.map(col => [col.key, col]))
  // Reject a corrupt or foreign config (duplicate keys, or keys we no longer recognize) → defaults.
  // A config that merely predates a newly-added column is NOT rejected: the missing column is spliced
  // in below, so introducing a column (e.g. `tags`) doesn't wipe a user's customized order and widths.
  if (byKey.size !== cfg.length) return null
  if (![...byKey.keys()].every(key => DEFAULT_ORDER.includes(key))) return null
  // Preserve the user's order for the columns they saved; every column (including category) reorders
  // freely. Any column added since they last saved lands at its canonical position.
  const result = cfg.map(col => ({ ...col }))
  DEFAULT_ORDER.forEach((key, index) => {
    if (byKey.has(key)) return
    const def = COLUMN_DEFS.find(candidate => candidate.key === key)
    result.splice(Math.min(index, result.length), 0, { key, width: def.defaultWidth })
  })
  return result
}


function getInitialSortDirection(columnKey) {
  return columnKey === 'date' || columnKey === 'amount' ? 'desc' : 'asc'
}

function formatTransactionClipboardCell(key, txn, { showSourceInCategorySlot = false } = {}) {
  switch (key) {
    case 'date':
      return formatDate(txn.date)
    case 'merchant':
      return getTxnMerchantLabel(txn)
    case 'category':
      if (showSourceInCategorySlot) return getTxnImportSourceLabel(txn)
      // A whole split names every category it touched: its own `category_name` is the pre-split one kept
      // for un-splitting, which the transaction is no longer in. A part row carries its own category.
      return splitCategoryNames(txn) || txn.category_name || 'Uncategorized'
    case 'account':
      return `${txn.account_name || ''}${txn.account_mask ? ` ···${txn.account_mask}` : ''}`.trim()
    case 'tags':
      return (Array.isArray(txn.tags) ? txn.tags : []).map(tag => tag.name).join(', ')
    case 'amount':
      return formatTransactionAmount(txn.amount)
    default:
      return ''
  }
}

function escapeCsvClipboardCell(value) {
  const text = String(value ?? '')
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

export default function Transactions() {
  const initialSessionStateRef = useRef(loadTransactionsSessionState())
  // The ledger reads the *explicit* date via getRawDate() — never getDate() — so a page default (the
  // Dashboard's) can never leak in: an unset filter here always means all-time. See getRawDate's contract.
  const { filters, clearDate, removeSelections, getRawDate } = useFilters()
  const location = useLocation()
  const [categories, setCategories] = useState([])
  const [initialLoading, setInitialLoading] = useState(true)
  const [detailPanels, setDetailPanels] = useState([])
  const [batchDetailPanels, setBatchDetailPanels] = useState([])
  const [editId, setEditId] = useState(null)
  const [categoryHeaderMenu, setCategoryHeaderMenu] = useState(null)
  const [rulePrompt, setRulePrompt] = useState(null)
  const [addingTransaction, setAddingTransaction] = useState(false)
  const [storedDocumentsOpen, setStoredDocumentsOpen] = useState(false)
  const [tagsOpen, setTagsOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const storedDocuments = useStoredDocuments()
  const reimbursements = useReimbursementCount()
  // Deep-linkable so a Tasks reminder can open the report already narrowed to what it counted — the
  // same pattern the uncategorized and needs-review nudges use. The narrowing rides along as props
  // rather than being applied here: the report owns what its filters mean.
  const [reimbursementsOpen, setReimbursementsOpen] = useState(
    () => new URLSearchParams(location.search).get('reimbursements') === '1'
  )
  // Read once at mount, like the two flags above: the deep link describes how the page was *opened*,
  // so re-deriving it later would reapply a filter the reader may have already cleared.
  const [reimbursementsDeepLink] = useState(() => {
    const params = new URLSearchParams(location.search)
    return {
      dueOnly: params.get('due') === '1',
      // One owner, because a task names one. A comma list would be a filter the task never produces.
      ownerId: (params.get('owner_ids') || '').split(',')[0] || null,
    }
  })
  const [quickFilter, setQuickFilter] = useState(() => initialSessionStateRef.current?.quickFilter || '')
  const [debouncedQuickFilter, setDebouncedQuickFilter] = useState(() => initialSessionStateRef.current?.quickFilter?.trim() || '')
  // Page-local amount filter (ledger only — never the shared FilterBar/Dashboard). Bounds compare
  // against |amount|; side rides the `direction` param so the sign applies separately. See amountParams.
  // Right-click row menu + its note/tag/trash/rule editors — the same shared controller the report
  // lists use via TransactionListTable, so the ledger and the reports never fork this interaction.
  // The ledger owns its paginated list, so reconcile flows back here: note/tag patch the row in
  // place, trash drops it (decrementing the total) and closes any open detail panel for that row.
  const rowActions = useTransactionRowActions({
    onOpenDetail: txn => openDetailPanel('txn', txn),
    reconcileRow: (txnId, patch) => patchRow(txnId, patch),
    removeRow: txnId => {
      removeRow(txnId)
      setDetailPanels(prev => prev.filter(panel => !(panel.type === 'txn' && panel.item?.id === txnId)))
    },
    onRuleSaved: ({ applyToExisting }) => { if (applyToExisting) reload() },
    categories,
    onAddCategory: addCategory,
  })
  const isFirstLoad = useRef(true)
  const listScrollRef = useRef(null)
  const categoryHeaderMenuRef = useRef(null)
  // Column layout is single-source-of-truth: the stored preference, normalized on read (which also
  // applies the category-after-merchant layout rule), falling back to defaults. No local mirror /
  // load effect / localStorage — the setter persists straight through the context.
  const [storedCols, setStoredCols] = useUserPreference(TXN_COLUMNS_PREF_KEY, null)
  const cols = useMemo(() => normalizeColumnConfig(storedCols) || defaultColumnConfig(), [storedCols])
  const [sortState, setSortState] = useState(() => initialSessionStateRef.current?.sortState || DEFAULT_TRANSACTION_SORT)
  const [showSourceInCategorySlot, setShowSourceInCategorySlot] = useState(false)
  const totalDetailPanelCount = detailPanels.length + batchDetailPanels.length
  const multiDetailMode = totalDetailPanelCount > 1

  useDismissibleLayer({
    open: !!categoryHeaderMenu,
    onClose: () => setCategoryHeaderMenu(null),
    refs: [categoryHeaderMenuRef],
  })

  function openDetailPanel(type, item) {
    if (!item?.id) return
    setDetailPanels(prev => [
      ...prev.filter(panel => !(panel.type === type && panel.item?.id === item.id)),
      { type, item },
    ])
  }

  function closeDetailPanel(type, id) {
    setDetailPanels(prev => prev.filter(panel => !(panel.type === type && panel.item?.id === id)))
  }

  function openBatchDetail(batch) {
    if (!batch?.id) return
    setBatchDetailPanels(prev => prev.some(panel => panel.id === batch.id) ? prev : [...prev, batch])
  }

  function closeBatchDetail(batchId) {
    setBatchDetailPanels(prev => prev.filter(panel => panel.id !== batchId))
  }

  function handleColUpdate(newCols) {
    // The injected bulk-select column is render-only; never persist it into the user's column config.
    const persistable = newCols.filter(col => col.key !== BULK_SELECT_COLUMN_KEY)
    setStoredCols(persistable)
  }

  // The ledger's single-select attribute quick filter, deep-linkable as `?only=<key>` so a Tasks nudge
  // can route straight to the rows it is nagging about. `?uncategorized=1` and `?needs_review=1` are
  // the two links that predate it and are still honored — a bookmark or an older Tasks entry may carry
  // either, and a link that silently stops narrowing is worse than one that errors.
  const [attributeFilter, setAttributeFilter] = useState(() => {
    const search = new URLSearchParams(location.search)
    const only = search.get('only')
    if (only) return { attribute: only, active: true }
    if (search.get('uncategorized') === '1') return { attribute: 'uncategorized', active: true }
    if (search.get('needs_review') === '1') return { attribute: 'needs-review', active: true }
    // A link is an explicit instruction and outranks what the session remembers; with no link, the
    // session's choice carries over, and failing that the seeded default.
    return normalizeAttributeFilter(initialSessionStateRef.current?.attributeFilter)
  })
  const [filterAttributes, setFilterAttributes] = useState([])
  useEffect(() => { api.getFilterAttributes().then(setFilterAttributes) }, [])
  // The key actually in force, or undefined. Everything downstream reads this rather than the pair, so
  // "picked but switched off" cannot leak into a request.
  const activeAttribute = attributeFilter.active ? attributeFilter.attribute || undefined : undefined

  // Bulk edit. The filter params below mirror the list fetch exactly so "select all matching" resolves
  // the same rows server-side. The ledger is the paginated source of truth, so Apply re-fetches (via
  // onReload) rather than patching rows in place.
  const currentFilterParams = useMemo(() => {
    // The chip row becomes parameters through the shared facet registry (lib/filterParams.js), so a
    // bulk "select all matching" resolves the exact same rows the list shows (exclusions and all).
    const facetParams = selectionsToParams(filters.selections)
    return {
      date_start: getRawDate()?.start || undefined,
      date_end: getRawDate()?.end || undefined,
      ...facetParams,
      // The toolbar filter rides the AND parameter rather than joining the facet's OR list: it is a
      // separate control, so setting it on top of a FilterBar attribute chip has to *narrow*. Folding
      // it into `attribute_ids` would OR the two, and a second filter that widens the result is the one
      // behaviour a filter must never have. (It also ANDs across facets, so picking a category chip and
      // "Uncategorized" resolves to nothing — correct, and unlike the toggle it replaces, which
      // squatted on `category_id` and silently won.)
      require_all_attribute_ids: activeAttribute,
      quick_filter: debouncedQuickFilter || undefined,
      ...amountFilterParams(filters.amount),
    }
  }, [filters, getRawDate, activeAttribute, debouncedQuickFilter])


  useEffect(() => {
    api.getCategories().then(setCategories)
  }, [])

  useEffect(() => {
    setDetailPanels(current => current.map(panel => {
      if (panel.type !== 'category') return panel
      const nextCategory = categories.find(category => category.id === panel.item?.id)
      return nextCategory
        ? { ...panel, item: { ...panel.item, name: nextCategory.name, color: nextCategory.color } }
        : panel
    }))
  }, [categories])

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setDebouncedQuickFilter(quickFilter.trim())
    }, 180)
    return () => window.clearTimeout(timeoutId)
  }, [quickFilter])

  useEffect(() => {
    saveTransactionsSessionState({ quickFilter, sortState, attributeFilter })
  }, [quickFilter, sortState, attributeFilter])

  // One page of the list by position, in the list's own filter and sort. The filter is the same object bulk
  // edit resolves "select all matching" from, so the two cannot disagree about which rows are listed.
  const fetchPage = useCallback((offset, limit) => api.getTransactions({
    ...currentFilterParams,
    sort_by: sortState.key,
    sort_dir: sortState.dir,
    limit,
    offset,
  }), [currentFilterParams, sortState])

  // A transaction panel open on a row shows the row as last fetched.
  function refreshOpenPanels(rows) {
    setDetailPanels(current => current.map(panel => (
      panel.type === 'txn'
        ? { ...panel, item: rows.find(t => t.id === panel.item?.id) || panel.item }
        : panel
    )))
  }

  const paged = usePagedRowSlots({
    fetchPage,
    pageSize: TRANSACTIONS_PAGE_SIZE,
    prefetchRows: TRANSACTIONS_PREFETCH_ROWS,
    onRowsLoaded: refreshOpenPanels,
  })
  const { rows: shownRows, total, reset: resetList } = paged

  // A new query (`fromTop`) starts at its first row; anything else (the refresh button, a sync, a reload
  // after an edit) keeps the reader on the row they were on. Never rejects.
  const load = useCallback(async ({ fromTop = false } = {}) => {
    if (isFirstLoad.current) setInitialLoading(true)
    const { status } = await resetList({ fromTop })
    if (status === 'stale') return
    setInitialLoading(false)
    isFirstLoad.current = false
  }, [resetList])

  const reload = useCallback(() => load(), [load])

  useEffect(() => {
    isFirstLoad.current = true
    load({ fromTop: true })
  }, [load])

  // A sync lands rows on the server, where no mutation signal on this page can see them. The same in-place
  // re-query as the refresh button, so edited rows left in place for correction drop out here as they do there.
  useAfterLedgerSync(reload)

  const bulk = useBulkTransactionEditing({
    rows: shownRows,
    total,
    filterParams: currentFilterParams,
    categories,
    onReload: reload,
  })
  // Aliases so the page's custom PillGridTable select-column wiring (header + per-row checkbox) reads
  // from the controller without restating `bulk.` at every site.
  const selection = bulk.selection
  const bulkMode = bulk.bulkMode
  const bulkSelectedCount = bulk.selectedCount

  // When the ledger settles to *no* rows, quietly check whether a subtractive filter (the date window
  // or an exclude chip) is what's hiding the user's matches — rather than there genuinely being none.
  // The probes re-run the same query with one constraint dropped (see lib/searchHidingProbe); only the
  // zero-results path pays the cost, and a stale filter change cancels an in-flight probe. If nothing
  // would surface, we say nothing — the note never claims the filter is hiding what it isn't.
  const [hidingCause, setHidingCause] = useState(null)
  useEffect(() => {
    if (initialLoading) return
    if (total > 0) { setHidingCause(null); return }
    const probes = planHidingProbes(currentFilterParams)
    if (probes.length === 0) { setHidingCause(null); return }
    let cancelled = false
    setHidingCause(null)
      ; (async () => {
        for (const probe of probes) {
          let resp
          try {
            resp = await api.getTransactions({ ...probe.params, limit: 1, offset: 0 })
          } catch { return }
          if (cancelled) return
          if ((resp?.total || resp?.transactions?.length || 0) > 0) {
            setHidingCause(probe.cause)
            return
          }
        }
      })()
    return () => { cancelled = true }
  }, [total, initialLoading, currentFilterParams])

  function clearHidingCause(cause) {
    if (cause === 'date' || cause === 'filters') clearDate()
    if (cause === 'exclude' || cause === 'filters') {
      removeSelections(filters.selections.filter(s => s.mode === 'exclude').map(s => s.id))
    }
  }

  // Reflect a resolved category onto the page list in place — including in "uncategorized only" mode,
  // where the freshly categorized row no longer matches the filter but is left visible (restyled with
  // its new category) so a mis-tap stays correctable and the user can add a tag or note before moving
  // on. The row is pruned only when the user re-queries with the Refresh button. Shared by inline edits
  // and by edits made inside an open transaction detail panel.
  function reconcileCategorizedRow(txnId, patch) {
    patchRow(txnId, patch)
  }

  function saveCategory(txnId, catId, catObj) {
    setEditId(null)
    if (catId == null) {
      // The picker's "Uncategorized" clear: drop the override back to unassigned.
      applyCategoryChange(txnId, null, (patch, id) => reconcileCategorizedRow(id, patch),
        () => txnMutations.uncategorize(txnId))
      return
    }
    const cat = catObj || categories.find(c => c.id === catId)
    // Checked inside the updater, not against `categories`: a picker that just created the category has
    // already queued its own add, which this render's list does not show yet.
    if (catObj) addCategory(catObj)
    applyCategoryChange(txnId, cat, (patch, id) => reconcileCategorizedRow(id, patch))
  }

  // Single reconcile callback for a TransactionDetail panel: it persisted through txnMutations (which
  // already invalidated the derived counts), so just merge its patch into the page list — or drop the
  // row and decrement the total when the panel reports a trash (patch === null). The ledger holds row
  // slots rather than a flat list, so this can't use the flat makeRowReconciler helper.
  function reconcilePanelEdit(txnId, patch) {
    if (patch === null) removeRow(txnId)
    else patchRow(txnId, patch)
  }

  // Every in-place edit of a loaded row goes through these two.
  function patchRow(txnId, patch) {
    paged.setRows(prev => prev.map(t => (t.id === txnId ? { ...t, ...patch } : t)))
  }

  function removeRow(txnId) {
    paged.setRows(prev => prev.filter(t => t.id !== txnId))
    paged.setTotal(prev => Math.max(0, prev - 1))
  }

  function updateNote(txnId, notes) {
    patchRow(txnId, { notes })
  }

  // `blockedTags` arrives from the row tag picker (inherited/rule opt-out); it's absent when called
  // from TransactionDetail's onTagsChanged, so only patch it through when supplied.
  function updateTags(txnId, tags, blockedTags) {
    patchRow(txnId, { tags, ...(blockedTags !== undefined ? { blocked_tags: blockedTags } : {}) })
  }

  // The row's purchase marker reports the summary after an edit or an ungroup (null when the payments
  // were ungrouped), so the marker follows without re-fetching the page.
  function updatePurchase(txnId, purchase) {
    patchRow(txnId, { purchase })
  }

  // An edited text document comes back under a new id, which the row's marker opens from.
  function updateDocuments(txnId, documents) {
    patchRow(txnId, { documents })
  }

  function addCategory(cat) {
    setCategories(prev => prev.find(c => c.id === cat.id) ? prev : [...prev, cat])
  }

  function toggleSort(columnKey) {
    setSortState(current => (
      current.key === columnKey
        ? { key: columnKey, dir: current.dir === 'asc' ? 'desc' : 'asc' }
        : { key: columnKey, dir: getInitialSortDirection(columnKey) }
    ))
  }

  const tableColumns = useMemo(
    () => cols.map(col => {
      const def = COLUMN_DEFS.find(candidate => candidate.key === col.key)
      const headerLabel = col.key === 'category' && showSourceInCategorySlot ? 'Source' : (def?.label ?? col.key)
      const align = col.key === 'amount' ? 'end' : 'start'
      const sortable = def?.sortable !== false
      return {
        ...col,
        label: headerLabel,
        align,
        sortable,
        minWidth: def?.minWidth ?? 60,
        leadingInset: col.key === 'date' ? 4 : undefined,
        trailingInset: col.key === 'amount' ? 4 : undefined,
        title: col.key === 'category'
          ? `${headerLabel} — right-click for options`
          : sortable
            ? `Click to sort. Drag middle to move ${headerLabel}`
            : `Drag middle to move ${headerLabel}`,
        onContextMenu: col.key === 'category'
          ? event => {
            event.preventDefault()
            event.stopPropagation()
            setCategoryHeaderMenu({
              x: event.clientX,
              y: event.clientY,
            })
          }
          : undefined,
      }
    }),
    [cols, showSourceInCategorySlot],
  )

  // In bulk mode prepend a render-only, non-interactive select column whose header is the select-all
  // checkbox (PillTableHeader renders `col.render()` instead of a sort pill).
  const allMatchingSelected = selection.allMatching && selection.excludedCount === 0
  const renderColumns = useMemo(() => {
    if (!bulkMode) return tableColumns
    return [
      {
        key: BULK_SELECT_COLUMN_KEY,
        label: '',
        width: 40,
        minWidth: 40,
        align: 'center',
        cellPadding: 0,
        sortable: false,
        draggable: false,
        resizable: false,
        render: () => (
          <SelectAllCheckbox
            checked={allMatchingSelected}
            indeterminate={!allMatchingSelected && bulkSelectedCount > 0}
            onChange={() => { if (bulkSelectedCount > 0) selection.clear(); else selection.selectAllMatching() }}
            title="Select all matching transactions"
          />
        ),
      },
      ...tableColumns,
    ]
  }, [bulkMode, tableColumns, allMatchingSelected, bulkSelectedCount, selection])

  // CSV copy runs off the bulk selection rather than off a dragged text selection. It used to read the
  // rows back out of the DOM and intersect them with the browser's selection range, which only worked
  // because every loaded row was a real node; now that the ledger is windowed, a drag could only ever
  // reach the rows currently mounted. Driving it from the selection is both windowing-safe and strictly
  // more capable — select-all-matching can copy the whole filtered result, which no drag could.
  const [copyStatus, setCopyStatus] = useState('')
  const [copying, setCopying] = useState(false)

  /*
   * "Link as one purchase" — grouping a deposit and its balance (or an instalment plan) as one thing.
   *
   * Deliberately **ids-only**: linking is a claim about specific transactions, so it operates on rows
   * the user picked and can see listed in the dialog before saving. "All matching" reaches past the
   * loaded pages by design and has no sensible reading here — nobody means "every row this filter
   * returns is one purchase" — so the action is withheld in that mode rather than silently re-resolving
   * a set the dialog cannot show.
   */
  const [linkingPurchase, setLinkingPurchase] = useState(null)
  const selectedRowsForPurchase = useMemo(
    () => (selection.allMatching ? [] : shownRows.filter(txn => selection.isSelected(txn.id))),
    [selection, shownRows],
  )

  // Every row the list is showing, including the pages not scrolled to yet, in the list's own filter and
  // sort — so a copy comes out in the order on screen. Once every page is loaded those rows are the answer.
  // `limit` asks for only the first that many (the copy dialog's "Copy first 500").
  const loadAllShownTransactions = useCallback(({ limit } = {}) => {
    const leading = leadingRows(paged.slots, limit ? Math.min(limit, total) : total)
    if (leading) return Promise.resolve(leading)
    return fetchAllMatchingTransactions(
      { ...currentFilterParams, sort_by: sortState.key, sort_dir: sortState.dir },
      { maxRows: limit },
    )
  }, [currentFilterParams, total, paged.slots, sortState])

  // The same set as a CSV file, for a list past the copy limit. The export takes the list feed's own filter
  // and sort, so the file holds exactly the rows a copy would have.
  const downloadShownTransactions = useCallback(() => downloadMatchingTransactions({
    ...currentFilterParams,
    sort_by: sortState.key,
    sort_dir: sortState.dir,
  }), [currentFilterParams, sortState])

  const copySelectedTransactions = useCallback(async () => {
    setCopying(true)
    setCopyStatus('')
    try {
      // In all-matching mode the selection reaches past the loaded pages, so re-resolve it from the
      // server using the same filter *and sort* the list is showing — otherwise the CSV would come out
      // in a different order than what the user is looking at.
      const candidates = selection.allMatching ? await loadAllShownTransactions() : shownRows

      const selected = candidates.filter(txn => selection.isSelected(txn.id))
      const csvText = selected
        .map(txn => cols.map(col => escapeCsvClipboardCell(formatTransactionClipboardCell(col.key, txn, { showSourceInCategorySlot }))).join(','))
        .join('\r\n')

      if (!csvText) {
        setCopyStatus('Nothing to copy')
        return
      }
      // writeText only: the clipboard API restricts which MIME types a page may write, so the old
      // copy-event handler's parallel text/csv flavour isn't available here. Spreadsheets paste CSV
      // text fine.
      await navigator.clipboard.writeText(csvText)
      setCopyStatus(`Copied ${selected.length} row${selected.length === 1 ? '' : 's'}`)
    } catch {
      setCopyStatus('Copy failed')
    } finally {
      setCopying(false)
    }
  }, [cols, shownRows, loadAllShownTransactions, selection, showSourceInCategorySlot])

  // Clear the transient status so it doesn't linger next to a selection it no longer describes.
  useEffect(() => {
    if (!copyStatus) return undefined
    const timer = setTimeout(() => setCopyStatus(''), 2500)
    return () => clearTimeout(timer)
  }, [copyStatus])

  function renderCell(col, txn) {
    switch (col.key) {
      case BULK_SELECT_COLUMN_KEY:
        return (
          <input
            type="checkbox"
            checked={selection.isSelected(txn.id)}
            onChange={() => selection.toggle(txn.id)}
            onClick={e => e.stopPropagation()}
            title="Select transaction"
            style={{ cursor: 'pointer', margin: 0 }}
          />
        )
      case 'date':
        return (
          <span style={{ color: 'var(--muted)', fontSize: 13 }}>
            {formatDate(txn.date)}
          </span>
        )
      case 'merchant':
        return (
          <MerchantCell
            txn={txn}
            onOpenDetail={detailTxn => openDetailPanel('txn', detailTxn)}
            onRename={(id, name) => patchRow(id, { display_name: name })}
            onUpdateNote={updateNote}
          />
        )
      case 'category': {
        if (showSourceInCategorySlot) {
          const sourceLabel = getTxnImportSourceLabel(txn)
          return (
            <span
              title={sourceLabel}
              style={{
                color: 'var(--muted)',
                fontSize: 12,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                maxWidth: '100%',
                minWidth: 0,
                verticalAlign: 'top',
              }}
            >
              <span style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                display: 'inline-block',
                minWidth: 0,
                flex: '0 1 auto',
              }}>
                {sourceLabel}
              </span>
              {txn.import_batch_id ? (
                <IconButton
                  size="compact"
                  tone="accent"
                  onClick={event => {
                    event.stopPropagation()
                    openBatchDetail({
                      id: txn.import_batch_id,
                      filename: txn.import_batch_filename,
                      imported_at: txn.import_batch_imported_at,
                    })
                  }}
                  aria-label="Open import file report"
                  style={{ flexShrink: 0 }}
                >
                  ↗
                </IconButton>
              ) : null}
            </span>
          )
        }
        return (
          <CategoryCell
            txn={txn}
            categories={categories}
            onSave={(txnId, catId, catObj) => saveCategory(txnId, catId, catObj)}
            onAddCategory={addCategory}
            onRulePrompt={setRulePrompt}
            onOpenSplit={rowActions.openSplitFromMenu}
            onOpenDetail={txn.category_id ? () => openDetailPanel('category', {
              id: txn.category_id,
              name: txn.category_name,
            }) : undefined}
          />
        )
      }
      case 'account': {
        const accountStr = `${txn.account_name}${txn.account_mask ? ` ···${txn.account_mask}` : ''}`
        return (
          <span
            title={accountStr}
            style={{
              color: 'var(--muted)', fontSize: 13,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              display: 'inline-flex', alignItems: 'center', gap: 4,
            }}
          >
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {accountStr}
            </span>
            <IconButton
              size="compact"
              tone="accent"
              onClick={e => {
                e.stopPropagation()
                openDetailPanel('account', { id: txn.account_id, name: txn.account_name, mask: txn.account_mask })
              }}
              aria-label="View account detail"
              style={{ flexShrink: 0 }}
            >↗</IconButton>
          </span>
        )
      }
      case 'tags':
        return (
          <TransactionMarkersCell
            txn={txn}
            onUpdateNote={updateNote}
            onUpdateTags={updateTags}
            onUpdatePurchase={updatePurchase}
            onUpdateDocuments={updateDocuments}
            onMarkReviewed={bulkMode ? undefined : rowActions.markReviewed}
            onOpenDetail={detailTxn => openDetailPanel('txn', detailTxn)}
          />
        )
      case 'amount':
        return (
          <TransactionAmountCell
            txn={txn}
            onOpenDetail={detailTxn => openDetailPanel('txn', detailTxn)}
          />
        )
      default:
        return null
    }
  }

  return (
    <div data-browser-context-passthrough="true" style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ padding: '24px 24px 0', flexShrink: 0 }}>
        <PageHeader
          title="Transactions"
          help={<FeatureExplainer topic="page-transactions" placement="bottom-left" />}
          // Edited rows are left in place so a mis-tap stays correctable (see reconcileCategorizedRow); this
          // re-queries on demand to drop rows that no longer match the active filter. Not while the first
          // page is still arriving, which would only start the same query again.
          refresh={(
            <RefreshButton
              onRefresh={() => (initialLoading ? undefined : reload())}
              title="Refresh — re-query the list and drop transactions that no longer match"
            />
          )}
        >

          {/* The review surface for money owed back. Beside the ledger because that is where the rows
              live; it lists only what is still open, so it empties as things are completed. The count is
              what keeps money in that nothing claims from going unseen, since only money owed raises a
              reminder. */}
          <Button variant="secondary" onClick={() => setReimbursementsOpen(true)}>
            {reimbursements.count ? `Reimbursements (${reimbursements.count})` : 'Reimbursements'}
          </Button>
          {/* Paperwork that arrived before its transaction. Here because this is where transactions arrive;
              the count is what keeps a kept invoice from being forgotten once its charge does. */}
          <Button variant="secondary" onClick={() => setStoredDocumentsOpen(true)}>
            {storedDocuments.documents?.length ? `Stored documents (${storedDocuments.documents.length})` : 'Stored documents'}
          </Button>
          <Button variant="secondary" onClick={() => setTagsOpen(true)}>Tags</Button>
          <Button variant="secondary" onClick={() => setExportOpen(true)}>Export…</Button>
          {/* The ledger is where someone notices a transaction is missing, so this is where adding one
              belongs — beside the list it will appear in, not parked in Settings. */}
          <Button variant="secondary" onClick={() => setAddingTransaction(true)}>+New</Button>
        </PageHeader>
      </div>

      <div data-browser-context-passthrough="true" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: '0 24px 24px' }}>
        <div style={{ padding: '0 0 12px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <SearchInput
              value={quickFilter}
              onChange={setQuickFilter}
              placeholder="Search…"
              aria-label="Search transactions"
              title="Matches names, imported text, category, account, date, amount, and the text inside attached documents. -42.10 is money paid out, +42.10 money received. Start with a keyword to search one field; everything after it is the value, e.g. merchant:city water, raw:meter reading (imported text only) or doc:brake pads."
              wrapperStyle={{ width: 180 }}
            />
            <FeatureExplainer topic="searching-transactions" placement="bottom-left" />
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            <AttributeFilterControl
              attributes={filterAttributes}
              value={attributeFilter.attribute}
              active={attributeFilter.active}
              onChange={next => { setAttributeFilter(next); isFirstLoad.current = true }}
            />
            <Button size="compact" variant="secondary" pressed={bulkMode} onClick={bulk.toggle}>
              {bulkMode ? '✕ Done' : 'Bulk Edit'}
            </Button>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, fontSize: 12, color: 'var(--muted)' }}>
              <CopyTransactionsButton
                loadRows={loadAllShownTransactions}
                total={total}
                onDownload={downloadShownTransactions}
                title="Transactions"
                tooltip="Copy the transactions shown"
              />
              {total} transaction{total === 1 ? '' : 's'}
            </span>
          </div>
        </div>

        <BulkEditChrome
          controller={bulk}
          barStyle={{ marginBottom: 12 }}
          actions={
            <>
              <Button
                variant="secondary"
                onClick={copySelectedTransactions}
                disabled={bulkSelectedCount === 0 || copying}
                title="Copy the selected transactions as CSV"
              >
                {copying ? 'Copying…' : 'Copy as CSV'}
              </Button>
              <Tooltip content={
                selection.allMatching
                  ? 'Pick the individual payments to group them as one purchase'
                  : 'Several payments for one thing — a deposit and a balance, or an instalment plan'
              }>
                <Button
                  variant="secondary"
                  onClick={() => setLinkingPurchase(selectedRowsForPurchase)}
                  disabled={selection.allMatching || selectedRowsForPurchase.length < 2}
                >
                  Link as one purchase
                </Button>
              </Tooltip>
              {copyStatus ? <span style={{ fontSize: 12, color: 'var(--muted)', alignSelf: 'center' }}>{copyStatus}</span> : null}
            </>
          }
        />

        {linkingPurchase ? (
          <LinkPurchaseDialog
            rows={linkingPurchase}
            onClose={() => setLinkingPurchase(null)}
            onLinked={async () => {
              setLinkingPurchase(null)
              bulk.selection.clear()
              // The rows' purchase summaries come from the list feed, so the markers and the panel's
              // section follow from a reload — the same route a bulk edit on this page already takes.
              await reload()
            }}
          />
        ) : null}

        {/* Card clips the rounded corners; the inner div is the actual scroll viewport
            so the sticky PillTableHeader inside pins to it, and the windowed rows measure
            the viewport from the same element. */}
        <Card style={{ padding: 0, overflow: 'hidden', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <div
            ref={listScrollRef}
            style={{ overflowX: 'auto', overflowY: 'auto', flex: 1, minHeight: 0 }}
          >
            <PillGridTable
              columns={renderColumns}
              onColumnsChange={handleColUpdate}
              sortState={sortState}
              onSort={toggleSort}
              headerStyle={{
                position: 'sticky',
                top: 0,
                background: 'var(--surface)',
                zIndex: 2,
              }}
              renderBody={({ columns: activeColumns, gridTemplateColumns }) => (
                <div>
                  {initialLoading ? <Spinner /> : total === 0 ? (
                    <>
                      <EmptyState message={quickFilter.trim() ? 'No matching transactions' : 'No transactions found'} />
                      {hidingCause && (
                        <div style={{ padding: '0 24px 32px', maxWidth: 620, margin: '0 auto' }}>
                          <FilterConflictNote
                            actionLabel={hidingActionLabel(hidingCause)}
                            onAction={() => clearHidingCause(hidingCause)}
                          >
                            {hidingNoteText(hidingCause)}
                          </FilterConflictNote>
                        </div>
                      )}
                    </>
                  ) : (
                    // Windowed: only the rows near the viewport are in the DOM. No `content-visibility`
                    // here — windowing already keeps unmounted rows out of layout, and the
                    // intrinsic-size placeholder would feed the virtualizer a wrong measurement.
                    <WindowedRows
                      scrollRef={listScrollRef}
                      items={paged.paging.slots}
                      getItemKey={transactionRowKey}
                      estimateSize={TRANSACTIONS_ROW_ESTIMATE}
                      measureKey={activeColumns.map(col => col.width).join(',')}
                      onRangeChange={paged.paging.onRangeChange}
                      apiRef={paged.paging.apiRef}
                      renderRow={txn => (
                        <div
                          onContextMenu={e => rowActions.onContextMenu(e, txn)}
                          style={{
                            display: 'grid',
                            gridTemplateColumns,
                            padding: '9px 14px', alignItems: 'center',
                            borderBottom: '1px solid var(--border)',
                            fontSize: 13,
                            background: editId === txn.id ? 'var(--surface2)' : 'transparent',
                            minWidth: 0,
                          }}
                        >
                          {activeColumns.map(col => (
                            <div
                              key={col.key}
                              style={{
                                minWidth: 0,
                                ...(col.key === BULK_SELECT_COLUMN_KEY
                                  ? { display: 'flex', justifyContent: 'center' }
                                  : col.key === 'amount'
                                    ? {}
                                    : { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }),
                              }}
                            >
                              {renderCell(col, txn)}
                            </div>
                          ))}
                        </div>
                      )}
                    />
                  )}
                </div>
              )}
            />
          </div>
        </Card>

        <TransactionRowActionsChrome controller={rowActions} />

        {categoryHeaderMenu && (
          <div
            ref={categoryHeaderMenuRef}
            style={{
              position: 'fixed',
              zIndex: 620,
              left: Math.min(categoryHeaderMenu.x, window.innerWidth - 220),
              top: Math.min(categoryHeaderMenu.y, window.innerHeight - 120),
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 10,
              boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
              padding: 4,
              minWidth: 200,
            }}
          >
            <button
              type="button"
              onClick={() => {
                setShowSourceInCategorySlot(value => !value)
                setCategoryHeaderMenu(null)
              }}
              style={{
                width: '100%',
                textAlign: 'left',
                padding: '8px 14px',
                cursor: 'pointer',
                fontSize: 13,
                color: 'var(--text)',
                borderRadius: 6,
                border: 'none',
                background: 'transparent',
              }}
              onMouseEnter={event => { event.currentTarget.style.background = 'var(--surface2)' }}
              onMouseLeave={event => { event.currentTarget.style.background = 'transparent' }}
            >
              {showSourceInCategorySlot ? 'Switch to category' : 'Switch to source'}
            </button>
          </div>
        )}

        {detailPanels.map((panel, index) => {
          if (panel.type === 'txn') {
            return (
              <TransactionDetail
                key={`txn:${panel.item.id}`}
                txn={panel.item}
                categories={categories}
                forceFloating={multiDetailMode}
                stackIndex={index}
                isTopmost={index === totalDetailPanelCount - 1}
                onClose={() => closeDetailPanel('txn', panel.item.id)}
                dateStart={getRawDate()?.start || undefined}
                dateEnd={getRawDate()?.end || undefined}
                onReconcile={reconcilePanelEdit}
              />
            )
          }
          if (panel.type === 'category') {
            return (
              <CategoryDetail
                key={`category:${panel.item.id}`}
                category={panel.item}
                categories={categories}
                forceFloating={multiDetailMode}
                stackIndex={index}
                isTopmost={index === totalDetailPanelCount - 1}
                onClose={() => closeDetailPanel('category', panel.item.id)}
                dateStart={getRawDate()?.start || undefined}
                dateEnd={getRawDate()?.end || undefined}
              />
            )
          }
          if (panel.type === 'account') {
            return (
              <AccountDetail
                key={`account:${panel.item.id}`}
                account={panel.item}
                categories={categories}
                forceFloating={multiDetailMode}
                stackIndex={index}
                isTopmost={index === totalDetailPanelCount - 1}
                onClose={() => closeDetailPanel('account', panel.item.id)}
                dateStart={getRawDate()?.start || undefined}
                dateEnd={getRawDate()?.end || undefined}
              />
            )
          }
          return null
        })}

        {batchDetailPanels.map((batch, index) => (
          <ImportBatchDetail
            key={`batch:${batch.id}`}
            batch={batch}
            categories={categories}
            onAddCategory={category => setCategories(prev => prev.some(existing => existing.id === category.id) ? prev : [...prev, category])}
            onClose={() => closeBatchDetail(batch.id)}
            forceFloating={multiDetailMode}
            stackIndex={detailPanels.length + index}
            isTopmost={detailPanels.length + index === totalDetailPanelCount - 1}
          />
        ))}

        {rulePrompt && (
          <RuleSuggestionToast
            prompt={rulePrompt}
            onSaved={({ applyToExisting }) => {
              // Applying the rule to existing rows is done through txnMutations.applyRule, which
              // already refreshed the Tasks count; here we just reload the visible list.
              if (applyToExisting) reload()
            }}
            onDismiss={() => setRulePrompt(null)}
          />
        )}

        {addingTransaction && (
          <AddTransactionDialog
            categories={categories}
            onAddCategory={addCategory}
            onClose={() => setAddingTransaction(false)}
            // A reload rather than an optimistic insert: the new row has to land in the current sort
            // and filter, which only the query knows — and the server may have categorized it by rule
            // on the way in, so what comes back is not what was sent.
            onCreated={reload}
          />
        )}

        {storedDocumentsOpen && (
          <StoredDocumentsDialog
            documents={storedDocuments.documents}
            reload={storedDocuments.reload}
            onClose={() => setStoredDocumentsOpen(false)}
          />
        )}

        {tagsOpen && (
          <TagsDialog
            onClose={({ changed }) => {
              setTagsOpen(false)
              // The rows carry each tag's name and colour, so an edit to one is refetched.
              if (changed) reload()
            }}
          />
        )}

        {exportOpen && <ExportTransactionsDialog onClose={() => setExportOpen(false)} />}

        {reimbursementsOpen && (
          <ReimbursementsReportDialog
            categories={categories}
            onAddCategory={addCategory}
            ownerId={reimbursementsDeepLink.ownerId}
            dueOnly={reimbursementsDeepLink.dueOnly}
            onClose={() => setReimbursementsOpen(false)}
            // Completing or editing one can move a transaction's allocations, so the ledger behind is
            // refetched rather than patched — the change is not confined to the rows on screen.
            onChanged={reload}
          />
        )}

      </div>
    </div>
  )
}
