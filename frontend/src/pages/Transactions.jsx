// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useLocation } from 'react-router-dom'
import { api } from '../lib/api.js'
import { txnMutations } from '../lib/txnMutations.js'
import { formatDate } from '../lib/utils.js'
import ImportBatchDetail from '../components/ImportBatchDetail.jsx'
import PillGridTable from '../components/PillGridTable.jsx'
import { formatTransactionAmount } from '../lib/moneyDisplay.js'
import { Button, Card, PageHeader, Spinner, EmptyState, Input, SelectAllCheckbox } from '../components/ui.jsx'
import TransactionDetail from '../components/TransactionDetail.jsx'
import CategoryDetail from '../components/CategoryDetail.jsx'
import AccountDetail from '../components/AccountDetail.jsx'
import { MerchantCell, CategoryCell, TransactionAmountCell, getTxnMerchantLabel, getTxnImportSourceLabel } from '../components/TransactionRow.jsx'
import RuleSuggestionToast from '../components/RuleSuggestionToast.jsx'
import { useTransactionRowActions, TransactionRowActionsChrome } from '../lib/useTransactionRowActions.jsx'
import { BULK_SELECT_COLUMN_KEY } from '../lib/useTransactionSelection.js'
import { useBulkTransactionEditing, BulkEditChrome } from '../lib/useBulkTransactionEditing.jsx'
import { useFilters } from '../lib/FilterContext.jsx'
import { useDismissibleLayer } from '../lib/uiInteractions.js'
import { useUserPreference } from '../lib/UserPreferencesContext.jsx'
import FeatureExplainer from '../help/FeatureExplainer.jsx'

const COLUMN_DEFS = [
  { key: 'date', label: 'Date', defaultWidth: 100, minWidth: 70 },
  { key: 'merchant', label: 'Merchant', defaultWidth: 220, minWidth: 120 },
  { key: 'category', label: 'Category', defaultWidth: 150, minWidth: 100 },
  { key: 'account', label: 'Account', defaultWidth: 150, minWidth: 100 },
  { key: 'amount', label: 'Amount', defaultWidth: 110, minWidth: 70 },
]

const DEFAULT_ORDER = ['date', 'merchant', 'category', 'account', 'amount']
const TXN_COLUMNS_PREF_KEY = 'ui.transactions.columns'
const TXN_SESSION_STATE_STORAGE_KEY = 'luma:txn-session-state'
const DEFAULT_TRANSACTION_SORT = { key: 'date', dir: 'desc' }
const TRANSACTIONS_BASE_PAGE_SIZE = 500
const TRANSACTIONS_MAX_PAGE_SIZE = 1000
const TRANSACTIONS_PAGE_GROWTH_STEP = 250
const TRANSACTIONS_PAGE_GROWTH_INTERVAL = 1500
const TRANSACTIONS_SCROLL_BUFFER_PX = 1600
let transactionsSessionInitialized = false

function getTransactionsPageSize(loadedCount = 0) {
  const growthSteps = Math.floor(Math.max(0, loadedCount) / TRANSACTIONS_PAGE_GROWTH_INTERVAL)
  return Math.min(
    TRANSACTIONS_MAX_PAGE_SIZE,
    TRANSACTIONS_BASE_PAGE_SIZE + (growthSteps * TRANSACTIONS_PAGE_GROWTH_STEP),
  )
}


function normalizeTransactionSortState(value) {
  if (!value || typeof value !== 'object') return DEFAULT_TRANSACTION_SORT
  const key = COLUMN_DEFS.some(column => column.key === value.key) ? value.key : DEFAULT_TRANSACTION_SORT.key
  const dir = value.dir === 'asc' ? 'asc' : 'desc'
  return { key, dir }
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
      try {
        window.sessionStorage.removeItem(TXN_SESSION_STATE_STORAGE_KEY)
      } catch { }
      return null
    }
  }
  try {
    const raw = window.sessionStorage.getItem(TXN_SESSION_STATE_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return {
      quickFilter: typeof parsed?.quickFilter === 'string' ? parsed.quickFilter : '',
      sortState: normalizeTransactionSortState(parsed?.sortState),
    }
  } catch {
    return null
  }
}

function saveTransactionsSessionState({ quickFilter, sortState }) {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.setItem(TXN_SESSION_STATE_STORAGE_KEY, JSON.stringify({
      quickFilter: quickFilter || '',
      sortState: normalizeTransactionSortState(sortState),
    }))
  } catch { }
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
  const allPresent = DEFAULT_ORDER.every(key => byKey.has(key))
  if (!allPresent || byKey.size !== DEFAULT_ORDER.length) return null
  // Preserve the user's column order as-is — every column (including category) reorders freely.
  // (Validation above guarantees exactly the expected set of keys.)
  return cfg.map(col => ({ ...col }))
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
      return showSourceInCategorySlot ? getTxnImportSourceLabel(txn) : (txn.category_name || 'Uncategorized')
    case 'account':
      return `${txn.account_name || ''}${txn.account_mask ? ` ···${txn.account_mask}` : ''}`.trim()
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
  const { filters } = useFilters()
  const location = useLocation()
  const [categories, setCategories] = useState([])
  const [data, setData] = useState({ transactions: [], total: 0, offset: 0, limit: TRANSACTIONS_BASE_PAGE_SIZE })
  const [initialLoading, setInitialLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [detailPanels, setDetailPanels] = useState([])
  const [batchDetailPanels, setBatchDetailPanels] = useState([])
  const [editId, setEditId] = useState(null)
  const [categoryHeaderMenu, setCategoryHeaderMenu] = useState(null)
  const [rulePrompt, setRulePrompt] = useState(null)
  const [quickFilter, setQuickFilter] = useState(() => initialSessionStateRef.current?.quickFilter || '')
  const [debouncedQuickFilter, setDebouncedQuickFilter] = useState(() => initialSessionStateRef.current?.quickFilter?.trim() || '')
  // Right-click row menu + its note/tag/trash/rule editors — the same shared controller the report
  // lists use via TransactionListTable, so the ledger and the reports never fork this interaction.
  // The ledger owns its paginated list, so reconcile flows back here: note/tag patch the row in
  // place, trash drops it (decrementing the total) and closes any open detail panel for that row.
  const rowActions = useTransactionRowActions({
    onOpenDetail: txn => openDetailPanel('txn', txn),
    reconcileRow: (txnId, patch) => setData(prev => ({
      ...prev,
      transactions: prev.transactions.map(t => (t.id === txnId ? { ...t, ...patch } : t)),
    })),
    removeRow: txnId => {
      setData(prev => ({
        ...prev,
        transactions: prev.transactions.filter(t => t.id !== txnId),
        total: Math.max(0, (prev.total || 0) - 1),
      }))
      setDetailPanels(prev => prev.filter(panel => !(panel.type === 'txn' && panel.item?.id === txnId)))
    },
    onRuleSaved: ({ applyToExisting }) => { if (applyToExisting) { isFirstLoad.current = true; load() } },
  })
  const isFirstLoad = useRef(true)
  const listScrollRef = useRef(null)
  const categoryHeaderMenuRef = useRef(null)
  const latestRequestKeyRef = useRef('')
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

  const [uncategorizedOnly, setUncategorizedOnly] = useState(
    () => new URLSearchParams(location.search).get('uncategorized') === '1'
  )
  // "Needs review only" is an independent axis from uncategorized (a rule-categorized row can still
  // need review). Deep-linkable so the import "review this file" nudge can route straight to it.
  const [needsReviewOnly, setNeedsReviewOnly] = useState(
    () => new URLSearchParams(location.search).get('needs_review') === '1'
  )

  // Bulk edit. The filter params below mirror the list fetch exactly so "select all matching" resolves
  // the same rows server-side. The ledger is the paginated source of truth, so Apply re-fetches (via
  // onReload) rather than patching rows in place.
  const currentFilterParams = useMemo(() => {
    const sel = filters.selections || []
    const ofType = (type, key = 'id') => sel.filter(s => s.type === type).map(s => s[key])
    const accountSel = ofType('account')
    const groupSel = ofType('group')
    const categorySel = ofType('category')
    const tagSel = ofType('tag')
    const payeeSel = ofType('payee', 'label')
    const ownerSel = ofType('owner')
    return {
      date_start: filters.date?.start || undefined,
      date_end: filters.date?.end || undefined,
      account_ids: accountSel.length ? accountSel.join(',') : undefined,
      group_ids: groupSel.length ? groupSel.join(',') : undefined,
      category_id: uncategorizedOnly ? '__uncategorized__' : undefined,
      category_ids: !uncategorizedOnly && categorySel.length ? categorySel.join(',') : undefined,
      tag_ids: tagSel.length ? tagSel.join(',') : undefined,
      payees: payeeSel.length ? payeeSel.join('|') : undefined,
      owner_ids: ownerSel.length ? ownerSel.join(',') : undefined,
      quick_filter: debouncedQuickFilter || undefined,
      needs_review: needsReviewOnly ? true : undefined,
    }
  }, [filters, uncategorizedOnly, needsReviewOnly, debouncedQuickFilter])


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
    saveTransactionsSessionState({ quickFilter, sortState })
  }, [quickFilter, sortState])

  const load = useCallback(async ({ append = false, offsetOverride = 0 } = {}) => {
    const accountSel = filters.selections.filter(s => s.type === 'account').map(s => s.id)
    const groupSel = filters.selections.filter(s => s.type === 'group').map(s => s.id)
    const categorySel = filters.selections.filter(s => s.type === 'category').map(s => s.id)
    const tagSel = filters.selections.filter(s => s.type === 'tag').map(s => s.id)
    const payeeSel = filters.selections.filter(s => s.type === 'payee').map(s => s.label)
    const ownerSel = filters.selections.filter(s => s.type === 'owner').map(s => s.id)
    const offset = append ? offsetOverride : 0
    const pageSize = getTransactionsPageSize(offset)
    const requestKey = JSON.stringify({
      accountSel,
      groupSel,
      categorySel,
      tagSel,
      payeeSel,
      ownerSel,
      uncategorizedOnly,
      needsReviewOnly,
      dateStart: filters.date?.start || '',
      dateEnd: filters.date?.end || '',
      quickFilter: debouncedQuickFilter,
      sortBy: sortState.key,
      sortDir: sortState.dir,
      offset,
      pageSize,
    })
    // Filter/search requests can resolve out of order; keep only the newest one so
    // the grid never snaps back to stale results after fast typing or toggling.
    latestRequestKeyRef.current = requestKey

    if (append) setLoadingMore(true)
    else if (isFirstLoad.current) setInitialLoading(true)

    const response = await api.getTransactions({
      date_start: filters.date?.start || undefined,
      date_end: filters.date?.end || undefined,
      account_ids: accountSel.length ? accountSel.join(',') : undefined,
      group_ids: groupSel.length ? groupSel.join(',') : undefined,
      category_id: uncategorizedOnly ? '__uncategorized__' : undefined,
      category_ids: !uncategorizedOnly && categorySel.length ? categorySel.join(',') : undefined,
      tag_ids: tagSel.length ? tagSel.join(',') : undefined,
      payees: payeeSel.length ? payeeSel.join('|') : undefined,
      owner_ids: ownerSel.length ? ownerSel.join(',') : undefined,
      quick_filter: debouncedQuickFilter || undefined,
      needs_review: needsReviewOnly || undefined,
      sort_by: sortState.key,
      sort_dir: sortState.dir,
      limit: pageSize,
      offset,
    })

    if (latestRequestKeyRef.current !== requestKey) return

    setData(prev => {
      const transactions = append
        ? [...prev.transactions, ...response.transactions]
        : response.transactions
      setDetailPanels(current => current.map(panel => (
        panel.type === 'txn'
          ? { ...panel, item: transactions.find(t => t.id === panel.item?.id) || panel.item }
          : panel
      )))
      return {
        ...response,
        transactions,
      }
    })
    setInitialLoading(false)
    setLoadingMore(false)
    isFirstLoad.current = false
  }, [filters, uncategorizedOnly, needsReviewOnly, debouncedQuickFilter, sortState])

  useEffect(() => {
    isFirstLoad.current = true
    setLoadingMore(false)
    load({ append: false }).catch(() => {
      setInitialLoading(false)
      setLoadingMore(false)
      isFirstLoad.current = false
    })
  }, [load])

  const bulk = useBulkTransactionEditing({
    rows: data.transactions,
    total: data.total,
    filterParams: currentFilterParams,
    categories,
    onReload: async () => { isFirstLoad.current = true; await load() },
  })
  // Aliases so the page's custom PillGridTable select-column wiring (header + per-row checkbox) reads
  // from the controller without restating `bulk.` at every site.
  const selection = bulk.selection
  const bulkMode = bulk.bulkMode
  const bulkSelectedCount = bulk.selectedCount

  const maybeLoadMore = useCallback(() => {
    if (initialLoading || loadingMore) return
    if (data.transactions.length >= data.total) return
    const root = listScrollRef.current
    if (!root) return
    const remaining = root.scrollHeight - root.scrollTop - root.clientHeight
    if (remaining > TRANSACTIONS_SCROLL_BUFFER_PX) return
    load({ append: true, offsetOverride: data.transactions.length }).catch(() => setLoadingMore(false))
  }, [data.total, data.transactions.length, initialLoading, loadingMore, load])

  useEffect(() => {
    maybeLoadMore()
  }, [data.transactions.length, maybeLoadMore])

  // Reflect a resolved category onto the page list in place — including in "uncategorized only" mode,
  // where the freshly categorized row no longer matches the filter but is left visible (restyled with
  // its new category) so a mis-tap stays correctable and the user can add a tag or note before moving
  // on. The row is pruned only when the user re-queries with the Refresh button. Shared by inline edits
  // and by edits made inside an open transaction detail panel.
  function reconcileCategorizedRow(txnId, cat) {
    setData(prev => ({
      ...prev,
      transactions: prev.transactions.map(t =>
        t.id === txnId ? {
          ...t,
          category_id: cat?.id ?? null,
          category_name: cat?.name ?? null,
          category_color: null,
          category_overridden: 1,
        } : t
      ),
    }))
  }

  function saveCategory(txnId, catId, catObj) {
    setEditId(null)
    if (catId == null) {
      // The picker's "Uncategorized" clear: drop the override back to unassigned.
      reconcileCategorizedRow(txnId, null)
      txnMutations.uncategorize(txnId)
      return
    }
    const cat = catObj || categories.find(c => c.id === catId)
    if (catObj && !categories.find(c => c.id === catObj.id)) {
      setCategories(prev => [...prev, catObj])
    }
    reconcileCategorizedRow(txnId, cat)
    txnMutations.setCategory(txnId, catId)
  }

  // A transaction detail panel persisted its own override through txnMutations (which already
  // invalidated the derived counts); just reconcile the page list, no second request needed.
  function handlePanelCategorized(txnId, cat) {
    reconcileCategorizedRow(txnId, cat)
  }

  function updateNote(txnId, notes) {
    setData(prev => ({
      ...prev,
      transactions: prev.transactions.map(t =>
        t.id === txnId ? { ...t, notes } : t
      ),
    }))
  }

  function updateTags(txnId, tags) {
    setData(prev => ({
      ...prev,
      transactions: prev.transactions.map(t =>
        t.id === txnId ? { ...t, tags } : t
      ),
    }))
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
      return {
        ...col,
        label: headerLabel,
        align,
        minWidth: def?.minWidth ?? 60,
        leadingInset: col.key === 'date' ? 4 : undefined,
        trailingInset: col.key === 'amount' ? 4 : undefined,
        title: col.key === 'category'
          ? `${headerLabel} — right-click for options`
          : `Click to sort. Drag middle to move ${headerLabel}`,
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

  const handleTransactionCopy = useCallback((event) => {
    const root = listScrollRef.current
    const selection = window.getSelection?.()
    if (!root || !selection || selection.isCollapsed || selection.rangeCount === 0) return

    const range = selection.getRangeAt(0)
    const rowIds = Array.from(root.querySelectorAll('[data-txn-copy-row]'))
      .filter(row => {
        try {
          return range.intersectsNode(row)
        } catch {
          return false
        }
      })
      .map(row => row.getAttribute('data-txn-copy-row'))
      .filter(Boolean)

    if (rowIds.length === 0) return

    const txnById = new Map(data.transactions.map(txn => [txn.id, txn]))
    const csvText = rowIds
      .map(id => txnById.get(id))
      .filter(Boolean)
      .map(txn => cols.map(col => escapeCsvClipboardCell(formatTransactionClipboardCell(col.key, txn, { showSourceInCategorySlot }))).join(','))
      .join('\r\n')

    if (!csvText) return

    event.preventDefault()
    event.clipboardData.setData('text/plain', csvText)
    event.clipboardData.setData('text/csv', csvText)
  }, [cols, data.transactions, showSourceInCategorySlot])

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
            onRename={(id, name) => setData(prev => ({
              ...prev,
              transactions: prev.transactions.map(t => t.id === id ? { ...t, display_name: name } : t),
            }))}
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
                <button
                  type="button"
                  onClick={event => {
                    event.stopPropagation()
                    openBatchDetail({
                      id: txn.import_batch_id,
                      filename: txn.import_batch_filename,
                      imported_at: txn.import_batch_imported_at,
                    })
                  }}
                  title="Open import file report"
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'var(--accent2)',
                    cursor: 'pointer',
                    fontSize: 11,
                    padding: '3px 5px',
                    opacity: 0.75,
                    lineHeight: 1,
                    flexShrink: 0,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: 6,
                  }}
                >
                  ↗
                </button>
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
            <button
              onClick={e => {
                e.stopPropagation()
                openDetailPanel('account', { id: txn.account_id, name: txn.account_name, mask: txn.account_mask })
              }}
              title="View account detail"
              style={{
                background: 'none', border: 'none', color: 'var(--accent2)',
                cursor: 'pointer', fontSize: 11, padding: '3px 5px', opacity: 0.75,
                lineHeight: 1, flexShrink: 0, display: 'inline-flex', alignItems: 'center',
                justifyContent: 'center', borderRadius: 6,
              }}
            >↗</button>
          </span>
        )
      }
      case 'amount':
        return (
          <TransactionAmountCell
            txn={txn}
            onUpdateNote={updateNote}
            onUpdateTags={updateTags}
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
        <PageHeader title="Transactions" />
      </div>

      <div data-browser-context-passthrough="true" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: '0 24px 24px' }}>
        <div style={{ padding: '0 0 12px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Input
              value={quickFilter}
              onChange={setQuickFilter}
              placeholder="Quick filter…"
              aria-label="Quick filter transactions"
              title="Quick filter matches date, merchant, category, account, or amount. Prefix with a field name to restrict the match, e.g. merchant:transfer."
              style={{ width: 180 }}
            />
            {quickFilter.trim() && (
              <button
                onClick={() => setQuickFilter('')}
                style={{
                  background: 'none',
                  border: '1px solid var(--border)',
                  color: 'var(--muted)',
                  borderRadius: 8,
                  padding: '5px 9px',
                  fontSize: 12,
                  cursor: 'pointer',
                }}
              >
                Clear
              </button>
            )}
            <FeatureExplainer topic="searching-transactions" placement="bottom-left" />
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            {/* Edited rows are left in place so a mis-tap stays correctable (see reconcileCategorizedRow);
              this re-queries on demand to drop rows that no longer match the active filter. */}
            <Button
              variant="ghost"
              small
              onClick={() => load({ append: false })}
              disabled={initialLoading}
              title="Re-query the list and drop transactions that no longer match"
            >
              ↻ Refresh
            </Button>
            <button
              onClick={() => { setUncategorizedOnly(v => !v); isFirstLoad.current = true }}
              style={{
                padding: '4px 11px', borderRadius: 6, fontSize: 12, cursor: 'pointer',
                border: `1px solid ${uncategorizedOnly ? 'var(--accent)' : 'var(--border)'}`,
                background: uncategorizedOnly
                  ? 'color-mix(in srgb, var(--accent) 12%, var(--surface2))'
                  : 'var(--surface2)',
                color: uncategorizedOnly ? 'var(--accent2)' : 'var(--muted)',
                fontWeight: uncategorizedOnly ? 500 : 400,
              }}
            >
              {uncategorizedOnly ? '✕ Uncategorized only' : 'Uncategorized only'}
            </button>
            <button
              onClick={() => { setNeedsReviewOnly(v => !v); isFirstLoad.current = true }}
              title="Show only transactions still flagged as needing review"
              style={{
                padding: '4px 11px', borderRadius: 6, fontSize: 12, cursor: 'pointer',
                border: `1px solid ${needsReviewOnly ? 'var(--review-marker-color)' : 'var(--border)'}`,
                background: needsReviewOnly
                  ? 'color-mix(in srgb, var(--review-marker-color) 14%, var(--surface2))'
                  : 'var(--surface2)',
                color: needsReviewOnly ? 'var(--review-marker-color)' : 'var(--muted)',
                fontWeight: needsReviewOnly ? 500 : 400,
              }}
            >
              {needsReviewOnly ? '✕ Needs review' : 'Needs review'}
            </button>
            <FeatureExplainer topic="reviewing-transactions" placement="bottom-left" />
            <button
              onClick={bulk.toggle}
              style={{
                padding: '4px 11px', borderRadius: 6, fontSize: 12, cursor: 'pointer',
                border: `1px solid ${bulkMode ? 'var(--accent)' : 'var(--border)'}`,
                background: bulkMode ? 'color-mix(in srgb, var(--accent) 12%, var(--surface2))' : 'var(--surface2)',
                color: bulkMode ? 'var(--accent2)' : 'var(--muted)',
                fontWeight: bulkMode ? 500 : 400,
              }}
            >
              {bulkMode ? '✕ Done' : 'Bulk Edit'}
            </button>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>
              {data.total} transaction{data.total === 1 ? '' : 's'}
            </span>
          </div>
        </div>

        <BulkEditChrome controller={bulk} barStyle={{ marginBottom: 12 }} />

        {/* Card clips the rounded corners; the inner div is the actual scroll viewport
            so the sticky PillTableHeader inside pins to it. listScrollRef + maybeLoadMore
            stay on the scroll viewport so infinite-scroll fires from the same element
            the rows scroll inside. */}
        <Card style={{ padding: 0, overflow: 'hidden', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <div
            ref={listScrollRef}
            onScroll={maybeLoadMore}
            onCopy={handleTransactionCopy}
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
                  {initialLoading ? <Spinner /> : data.transactions.length === 0 ? (
                    <EmptyState message={quickFilter.trim() ? 'No matching transactions' : 'No transactions found'} />
                  ) : (
                    data.transactions.map(txn => (
                      <div
                        key={txn.id}
                        data-txn-copy-row={txn.id}
                        onContextMenu={e => rowActions.onContextMenu(e, txn)}
                        style={{
                          display: 'grid',
                          gridTemplateColumns,
                          padding: '9px 14px', alignItems: 'center',
                          borderBottom: '1px solid var(--border)',
                          fontSize: 13,
                          background: editId === txn.id ? 'var(--surface2)' : 'transparent',
                          minWidth: 0,
                          // Skip style/layout/paint for off-screen rows so a column resize (which
                          // re-styles the grid template) only touches visible rows, not the whole
                          // infinitely-scrolled ledger. contain-intrinsic-size reserves scroll space.
                          contentVisibility: 'auto',
                          containIntrinsicSize: 'auto 40px',
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
                    ))
                  )}
                  {!initialLoading && data.transactions.length > 0 ? (
                    <div style={{ padding: '12px 14px', textAlign: 'center', color: 'var(--muted)', fontSize: 11 }}>
                      {loadingMore
                        ? 'Loading more transactions…'
                        : data.transactions.length < data.total
                          ? 'Scroll for older transactions'
                          : 'All matching transactions loaded'}
                    </div>
                  ) : null}
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
                dateStart={filters.date?.start || undefined}
                dateEnd={filters.date?.end || undefined}
                onCategorized={handlePanelCategorized}
                onNotesSaved={updateNote}
                onTagsChanged={updateTags}
                onTrashed={txnId => setData(prev => ({
                  ...prev,
                  transactions: prev.transactions.filter(t => t.id !== txnId),
                  total: Math.max(0, (prev.total || 0) - 1),
                }))}
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
                dateStart={filters.date?.start || undefined}
                dateEnd={filters.date?.end || undefined}
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
                dateStart={filters.date?.start || undefined}
                dateEnd={filters.date?.end || undefined}
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
              if (applyToExisting) {
                isFirstLoad.current = true
                load()
              }
            }}
            onDismiss={() => setRulePrompt(null)}
          />
        )}

      </div>
    </div>
  )
}
