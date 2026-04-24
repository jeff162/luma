// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useLocation } from 'react-router-dom'
import { api } from '../lib/api.js'
import { refreshTaskBadge } from '../App.jsx'
import { formatDate } from '../lib/utils.js'
import ImportBatchDetail from '../components/ImportBatchDetail.jsx'
import PillGridTable from '../components/PillGridTable.jsx'
import { formatTransactionAmount } from '../lib/moneyDisplay.js'
import { Card, PageHeader, Spinner, EmptyState, Input, OverlayBackdrop, FloatingPanel, FloatingPanelHeader } from '../components/ui.jsx'
import TransactionDetail from '../components/TransactionDetail.jsx'
import CategoryDetail from '../components/CategoryDetail.jsx'
import AccountDetail from '../components/AccountDetail.jsx'
import { MerchantCell, CategoryCell, ContextMenu, useContextMenu, NotePopover, TransactionAmountCell, getTxnMerchantLabel, getTxnImportSourceLabel } from '../components/TransactionRow.jsx'
import RuleSuggestionToast from '../components/RuleSuggestionToast.jsx'
import RuleForm from '../components/RuleForm.jsx'
import { useAppSession } from '../lib/AppSessionContext.jsx'
import { useFilters } from '../lib/FilterContext.jsx'
import { useDismissibleLayer } from '../lib/uiInteractions.js'
import { useUserPreferences } from '../lib/UserPreferencesContext.jsx'

const NEW_CATEGORY_SENTINEL = '__new__'

const NEW_CAT_COLORS = [
  '#6366f1', '#ec4899', '#f97316', '#eab308', '#22c55e',
  '#14b8a6', '#3b82f6', '#a855f7', '#ef4444', '#64748b',
]

const COLUMN_DEFS = [
  { key: 'date', label: 'Date', defaultWidth: 100, minWidth: 70 },
  { key: 'merchant', label: 'Merchant', defaultWidth: 220, minWidth: 120 },
  { key: 'category', label: 'Category', defaultWidth: 150, minWidth: 100 },
  { key: 'account', label: 'Account', defaultWidth: 150, minWidth: 100 },
  { key: 'amount', label: 'Amount', defaultWidth: 110, minWidth: 70 },
]

const DEFAULT_ORDER = ['date', 'merchant', 'category', 'account', 'amount']
const TXN_COLUMNS_STORAGE_KEY_PREFIX = 'fintrack:txn-columns'
const TXN_COLUMNS_PREF_KEY = 'ui.transactions.columns'
const TXN_SESSION_STATE_STORAGE_KEY = 'fintrack:txn-session-state'
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

function getTxnColumnsStorageKey(instanceId, userId) {
  return instanceId && userId ? `${TXN_COLUMNS_STORAGE_KEY_PREFIX}:${instanceId}:${userId}` : null
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

  const ordered = cfg.map(col => ({ ...col }))
  const merchantIndex = ordered.findIndex(col => col.key === 'merchant')
  const categoryIndex = ordered.findIndex(col => col.key === 'category')

  if (merchantIndex === -1 || categoryIndex === -1) return null
  if (categoryIndex === merchantIndex + 1) return ordered

  const [categoryCol] = ordered.splice(categoryIndex, 1)
  const nextMerchantIndex = ordered.findIndex(col => col.key === 'merchant')
  ordered.splice(nextMerchantIndex + 1, 0, categoryCol)
  return ordered
}

function loadColumnConfig(instanceId, userId) {
  const storageKey = getTxnColumnsStorageKey(instanceId, userId)
  if (!storageKey) return null
  try {
    const raw = localStorage.getItem(storageKey)
    if (!raw) return null
    return normalizeColumnConfig(JSON.parse(raw))
  } catch { return null }
}

function saveColumnConfig(instanceId, userId, cfg) {
  const storageKey = getTxnColumnsStorageKey(instanceId, userId)
  if (!storageKey) return
  try { localStorage.setItem(storageKey, JSON.stringify(cfg)) } catch { }
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

function RuleActionModal({ state, onClose, onSaved }) {
  const [categories, setCategories] = useState([])
  const [owners, setOwners] = useState([])
  const [accounts, setAccounts] = useState([])
  const [rule, setRule] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!state) return
    let cancelled = false
    async function loadModalData() {
      try {
        const [cats, own, acc, rules] = await Promise.all([
          api.getCategories(),
          api.getOwners(),
          api.getAccounts(),
          state.mode === 'edit' ? api.getRules() : Promise.resolve([]),
        ])
        if (cancelled) return
        setCategories(cats)
        setOwners(own)
        setAccounts(acc)
        setRule(state.mode === 'edit' ? rules.find(item => item.id === state.ruleId) || null : null)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    loadModalData()
    return () => { cancelled = true }
  }, [state])

  if (!state) return null

  async function handleSave(data) {
    const { applyToExisting, ...ruleData } = data
    if (state.mode === 'edit') {
      await api.updateRule(state.ruleId, ruleData)
      if (applyToExisting) await api.applyRule(state.ruleId)
      onSaved?.({ applyToExisting, mode: 'edit', ruleId: state.ruleId })
      onClose()
      return
    }

    const created = await api.createRule(ruleData)
    if (applyToExisting) {
      await api.applyRule(created.id)
    }
    onSaved?.({ applyToExisting, mode: 'create', ruleId: created.id })
    onClose()
  }

  const initialValues = state.mode === 'edit'
    ? (rule ? {
      keyword: rule.keyword,
      amount_min: rule.amount_min ?? null,
      amount_max: rule.amount_max ?? null,
      debit_credit: rule.debit_credit || 'both',
      owner_id: rule.owner_id || '',
      account_id: rule.account_id || '',
      catId: rule.category_id,
      cleanName: rule.clean_name || '',
      tagIds: rule.tag_ids || [],
    } : null)
    : {
      keyword: (state.keywordSource || '').toLowerCase().trim(),
      cleanName: '',
      catId: state.categoryId || '',
      tagIds: [],
    }

  return (
    <OverlayBackdrop zIndex={950} tint="rgba(10, 15, 26, 0.32)">
      <FloatingPanel style={{ width: 640, maxWidth: '94vw', maxHeight: '90vh' }}>
        <FloatingPanelHeader style={{ padding: '14px 20px' }}>
          <div style={{ fontSize: 15, fontWeight: 600 }}>
            {state.mode === 'edit' ? 'Edit matching rule' : 'Create rule'}
          </div>
          <button onClick={onClose} style={{
            background: 'none', border: 'none', color: 'var(--muted)',
            cursor: 'pointer', fontSize: 20, lineHeight: 1, padding: 2,
          }}>×</button>
        </FloatingPanelHeader>
        <div style={{ maxHeight: 'calc(90vh - 56px)', overflowY: 'auto' }}>
          {loading || !initialValues ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}>
              {state.mode === 'edit' ? 'Loading rule…' : 'Loading…'}
            </div>
          ) : (
            <RuleForm
              initialValues={initialValues}
              categories={categories}
              owners={owners}
              accounts={accounts}
              onSave={handleSave}
              onCancel={onClose}
              saveLabel={state.mode === 'edit' ? 'Save changes' : 'Save rule'}
              transactionData={state.mode === 'create' ? state.transactionData : null}
            />
          )}
        </div>
      </FloatingPanel>
    </OverlayBackdrop>
  )
}

export default function Transactions() {
  const initialSessionStateRef = useRef(loadTransactionsSessionState())
  const { dbInstanceId, preferenceSubjectId: userId } = useAppSession()
  const { preferences } = useUserPreferences()
  const { filters } = useFilters()
  const location = useLocation()
  const [categories, setCategories] = useState([])
  const [data, setData] = useState({ transactions: [], total: 0, offset: 0, limit: TRANSACTIONS_BASE_PAGE_SIZE })
  const [initialLoading, setInitialLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [detailPanels, setDetailPanels] = useState([])
  const [batchDetailPanels, setBatchDetailPanels] = useState([])
  const [editId, setEditId] = useState(null)
  const { menu, onContextMenu, close: closeMenu } = useContextMenu()
  const [categoryHeaderMenu, setCategoryHeaderMenu] = useState(null)
  const [noteTarget, setNoteTarget] = useState(null)
  const [rulePrompt, setRulePrompt] = useState(null)
  const [quickFilter, setQuickFilter] = useState(() => initialSessionStateRef.current?.quickFilter || '')
  const [debouncedQuickFilter, setDebouncedQuickFilter] = useState(() => initialSessionStateRef.current?.quickFilter?.trim() || '')
  const [contextRuleMatch, setContextRuleMatch] = useState({ txnId: null, loading: false, ruleId: null })
  const [ruleModalState, setRuleModalState] = useState(null)
  const isFirstLoad = useRef(true)
  const listScrollRef = useRef(null)
  const categoryHeaderMenuRef = useRef(null)
  const latestRequestKeyRef = useRef('')
  const [cols, setCols] = useState(() => defaultColumnConfig())
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
    setCols(newCols)
    saveColumnConfig(dbInstanceId, userId, newCols)
    api.saveUserPreference(TXN_COLUMNS_PREF_KEY, newCols).catch(() => { })
  }

  const [uncategorizedOnly, setUncategorizedOnly] = useState(
    () => new URLSearchParams(location.search).get('uncategorized') === '1'
  )

  useEffect(() => {
      const saved = preferences?.[TXN_COLUMNS_PREF_KEY]
      const normalizedSaved = normalizeColumnConfig(saved)
      if (normalizedSaved) {
        setCols(normalizedSaved)
        saveColumnConfig(dbInstanceId, userId, normalizedSaved)
        return
      }
      const local = loadColumnConfig(dbInstanceId, userId)
      if (local) {
        setCols(local)
        return
      }
      setCols(defaultColumnConfig())
  }, [dbInstanceId, preferences, userId])

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
  }, [filters, uncategorizedOnly, debouncedQuickFilter, sortState])

  useEffect(() => {
    isFirstLoad.current = true
    setLoadingMore(false)
    load({ append: false }).catch(() => {
      setInitialLoading(false)
      setLoadingMore(false)
      isFirstLoad.current = false
    })
  }, [load])

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

  useEffect(() => {
    if (!menu?.txn?.id) {
      setContextRuleMatch({ txnId: null, loading: false, ruleId: null })
      return
    }
    let cancelled = false
    setContextRuleMatch({ txnId: menu.txn.id, loading: true, ruleId: null })
    api.getMatchingRuleForTransaction(menu.txn.id)
      .then(result => {
        if (cancelled) return
        setContextRuleMatch({ txnId: menu.txn.id, loading: false, ruleId: result.rule_id || null })
      })
      .catch(() => {
        if (cancelled) return
        setContextRuleMatch({ txnId: menu.txn.id, loading: false, ruleId: null })
      })
    return () => { cancelled = true }
  }, [menu?.txn?.id])

  function saveCategory(txnId, catId, catObj) {
    const cat = catObj || categories.find(c => c.id === catId)
    if (catObj && !categories.find(c => c.id === catObj.id)) {
      setCategories(prev => [...prev, catObj])
    }
    setData(prev => {
      // In "uncategorized only" mode, recategorizing a row should remove it from the
      // list immediately instead of waiting for a refetch.
      if (uncategorizedOnly) {
        return {
          ...prev,
          total: prev.total - 1,
          transactions: prev.transactions.filter(t => t.id !== txnId),
        }
      }
      return {
        ...prev,
        transactions: prev.transactions.map(t =>
          t.id === txnId ? {
            ...t,
            category_id: catId,
            category_name: cat?.name ?? null,
            category_color: null,
            category_overridden: 1,
          } : t
        ),
      }
    })
    setEditId(null)
    api.overrideCategory(txnId, catId).then(refreshTaskBadge)
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
        const accountLabel = txn.category_name
          ? `${txn.category_name} — click to view spending history`
          : 'Uncategorized'
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
          />
        )
      default:
        return null
    }
  }

  function openRuleFromTransaction(txn) {
    if (contextRuleMatch.loading && contextRuleMatch.txnId === txn.id) return
    const matchedRuleId = contextRuleMatch.txnId === txn.id ? contextRuleMatch.ruleId : null
    const merchantName = getTxnMerchantLabel(txn)
    const keywordSource = txn.merchant_name || txn.raw_name || merchantName
    closeMenu()
    if (matchedRuleId) {
      setRuleModalState({ mode: 'edit', ruleId: matchedRuleId, txnId: txn.id })
      return
    }
    setRuleModalState({
      mode: 'create',
      txnId: txn.id,
      categoryId: txn.category_id || '',
      keywordSource,
      transactionData: {
        amount: txn.amount,
      },
    })
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
              title="Quick filter can match date, merchant, category, account, or amount."
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
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
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
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>
              {data.total} transactions
            </span>
          </div>
        </div>

        <Card style={{ padding: 0, overflowX: 'auto', overflowY: 'hidden', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <PillGridTable
            columns={tableColumns}
            onColumnsChange={handleColUpdate}
            sortState={sortState}
            onSort={toggleSort}
            fillHeight
            renderBody={({ columns: activeColumns, gridTemplateColumns }) => (
              <div
                ref={listScrollRef}
                onScroll={maybeLoadMore}
                onCopy={handleTransactionCopy}
                style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}
              >
                {initialLoading ? <Spinner /> : data.transactions.length === 0 ? (
                  <EmptyState message={quickFilter.trim() ? 'No matching transactions' : 'No transactions found'} />
                ) : (
                  data.transactions.map(txn => (
                    <div
                      key={txn.id}
                      data-txn-copy-row={txn.id}
                      onContextMenu={e => onContextMenu(e, txn)}
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
                            overflow: 'hidden',
                            minWidth: 0,
                            ...(col.key === 'amount' ? {} : { textOverflow: 'ellipsis', whiteSpace: 'nowrap' }),
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
        </Card>

        {menu && (
          <ContextMenu
            menu={menu}
            onClose={closeMenu}
            onOpenDetail={txn => { openDetailPanel('txn', txn); closeMenu() }}
            onEditNote={txn => { setNoteTarget(txn); closeMenu() }}
            onOpenRule={openRuleFromTransaction}
            ruleActionLabel={
              contextRuleMatch.loading
                ? '⚙ Loading rule…'
                : contextRuleMatch.ruleId
                  ? '⚙ Open matching rule'
                  : '⚙ Create rule'
            }
          />
        )}

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

        {noteTarget && (
          <div style={{
            position: 'fixed', inset: 0, zIndex: 400,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(0,0,0,0.3)',
          }} onClick={() => setNoteTarget(null)}>
            <div onClick={e => e.stopPropagation()}>
              <NotePopover
                txn={noteTarget}
                onSave={async val => {
                  await api.updateNotes(noteTarget.id, val)
                  updateNote(noteTarget.id, val)
                  setNoteTarget(null)
                }}
                onClose={() => setNoteTarget(null)}
              />
            </div>
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
              if (applyToExisting) {
                isFirstLoad.current = true
                load()
              }
            }}
            onDismiss={() => setRulePrompt(null)}
          />
        )}

        {ruleModalState && (
          <RuleActionModal
            state={ruleModalState}
            onClose={() => setRuleModalState(null)}
            onSaved={({ applyToExisting }) => {
              if (applyToExisting) {
                isFirstLoad.current = true
                load()
              }
            }}
          />
        )}
      </div>
    </div>
  )
}
