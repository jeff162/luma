import { useState, useEffect, useCallback, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { api } from '../lib/api.js'
import { refreshTaskBadge } from '../App.jsx'
import { formatCurrency, formatDate } from '../lib/utils.js'
import { Card, PageHeader, Spinner, EmptyState } from '../components/ui.jsx'
import TransactionDetail from '../components/TransactionDetail.jsx'
import CategoryDetail from '../components/CategoryDetail.jsx'
import AccountDetail from '../components/AccountDetail.jsx'
import { buildGroups, InlineCategorySelect, MerchantCell, CategoryCell, ContextMenu, useContextMenu, NotePopover } from '../components/TransactionRow.jsx'
import RuleSuggestionToast from '../components/RuleSuggestionToast.jsx'
import { useFilters } from '../lib/FilterContext.jsx'

const NEW_CATEGORY_SENTINEL = '__new__'

const NEW_CAT_COLORS = [
  '#6366f1','#ec4899','#f97316','#eab308','#22c55e',
  '#14b8a6','#3b82f6','#a855f7','#ef4444','#64748b',
]

// ── Column configuration ───────────────────────────────────────────────────────
//
// Each column has: key, label, defaultWidth (px), minWidth (px).
// The user can reorder and resize. Config is persisted to localStorage.
// "merchant" and "amount" are always present and cannot be removed.

const COLUMN_DEFS = [
  { key: 'date',     label: 'Date',     defaultWidth: 100, minWidth: 70  },
  { key: 'merchant', label: 'Merchant', defaultWidth: 220, minWidth: 120 },
  { key: 'category', label: 'Category', defaultWidth: 150, minWidth: 100 },
  { key: 'account',  label: 'Account',  defaultWidth: 150, minWidth: 100 },
  { key: 'amount',   label: 'Amount',   defaultWidth: 110, minWidth: 70  },
]

const DEFAULT_ORDER = ['date', 'merchant', 'category', 'account', 'amount']
const STORAGE_KEY   = 'fintrack:txn-columns'

function loadColumnConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    return JSON.parse(raw)
  } catch { return null }
}

function saveColumnConfig(cfg) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg)) } catch {}
}

function buildGridTemplate(cols) {
  return cols.map(c => `${c.width}px`).join(' ')
}

// ── Transactions page ─────────────────────────────────────────────────────────

export default function Transactions() {
  const { filters } = useFilters()
  const location = useLocation()
  const [categories, setCategories] = useState([])
  const [data, setData]             = useState({ transactions: [], total: 0 })
  const [initialLoading, setInitialLoading] = useState(true)
  const [detailTxn, setDetailTxn]   = useState(null)
  const [detailCategory, setDetailCategory] = useState(null)  // { id, name, color, icon }
  const [detailAccount, setDetailAccount]   = useState(null)  // { id, name, mask }
  const [editId, setEditId]         = useState(null)
  const { menu, onContextMenu, close: closeMenu } = useContextMenu()
  const [noteTarget, setNoteTarget] = useState(null)
  const [rulePrompt, setRulePrompt] = useState(null)
  const isFirstLoad = useRef(true)
  const dragColKey = useRef(null)
  const resizeState = useRef(null)

  // ── Column config (persisted) ──────────────────────────────────────────────

  const [cols, setCols] = useState(() => {
    const saved = loadColumnConfig()
    if (saved && Array.isArray(saved) && saved.length === DEFAULT_ORDER.length) return saved
    return DEFAULT_ORDER.map(key => {
      const def = COLUMN_DEFS.find(d => d.key === key)
      return { key, width: def.defaultWidth }
    })
  })

  function handleColUpdate(newCols) {
    setCols(newCols)
    saveColumnConfig(newCols)
  }

  const gridTemplate = buildGridTemplate(cols)

  // ── Seed from ?uncategorized=1 ─────────────────────────────────────────────

  const [uncategorizedOnly, setUncategorizedOnly] = useState(
    () => new URLSearchParams(location.search).get('uncategorized') === '1'
  )

  useEffect(() => {
    api.getCategories().then(setCategories)
  }, [])

  const load = useCallback(() => {
    if (isFirstLoad.current) setInitialLoading(true)
    const accountSel  = filters.selections.filter(s => s.type === 'account').map(s => s.id)
    const groupSel    = filters.selections.filter(s => s.type === 'group').map(s => s.id)
    const categorySel = filters.selections.filter(s => s.type === 'category').map(s => s.id)
    const payeeSel    = filters.selections.filter(s => s.type === 'payee').map(s => s.label)
    const ownerSel    = filters.selections.filter(s => s.type === 'owner').map(s => s.id)
    api.getTransactions({
      date_start:   filters.date?.start || undefined,
      date_end:     filters.date?.end   || undefined,
      account_ids:  accountSel.length   ? accountSel.join(',')   : undefined,
      group_ids:    groupSel.length     ? groupSel.join(',')     : undefined,
      category_id:  uncategorizedOnly   ? '__uncategorized__'    : undefined,
      category_ids: !uncategorizedOnly && categorySel.length ? categorySel.join(',') : undefined,
      payees:       payeeSel.length     ? payeeSel.join('|')     : undefined,
      owner_ids:    ownerSel.length     ? ownerSel.join(',')     : undefined,
      limit: 500,
    }).then(d => {
      setData(d)
      setInitialLoading(false)
      isFirstLoad.current = false
    })
  }, [filters, uncategorizedOnly])

  useEffect(() => {
    isFirstLoad.current = true
    load()
  }, [load])

  function saveCategory(txnId, catId, catObj) {
    const cat = catObj || categories.find(c => c.id === catId)
    if (catObj && !categories.find(c => c.id === catObj.id)) {
      setCategories(prev => [...prev, catObj])
    }
    setData(prev => {
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
            category_id:         catId,
            category_name:       cat?.name  ?? null,
            category_color:      cat?.color ?? null,
            category_icon:       cat?.icon  ?? null,
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

  function addCategory(cat) {
    setCategories(prev => prev.find(c => c.id === cat.id) ? prev : [...prev, cat])
  }

  useEffect(() => {
    function onMove(e) {
      if (!resizeState.current) return
      const { key, startX, startWidth } = resizeState.current
      const def = COLUMN_DEFS.find(col => col.key === key)
      const nextWidth = Math.max(def?.minWidth ?? 60, Math.min(640, startWidth + (e.clientX - startX)))
      handleColUpdate(cols.map(col => col.key === key ? { ...col, width: nextWidth } : col))
    }
    function onUp() {
      resizeState.current = null
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [cols])

  function handleHeaderDragStart(key) {
    dragColKey.current = key
  }

  function handleHeaderDrop(targetKey) {
    const sourceKey = dragColKey.current
    dragColKey.current = null
    if (!sourceKey || sourceKey === targetKey) return
    const next = [...cols]
    const sourceIndex = next.findIndex(col => col.key === sourceKey)
    const targetIndex = next.findIndex(col => col.key === targetKey)
    if (sourceIndex === -1 || targetIndex === -1) return
    const [moved] = next.splice(sourceIndex, 1)
    next.splice(targetIndex, 0, moved)
    handleColUpdate(next)
  }

  function startResize(e, col) {
    e.preventDefault()
    e.stopPropagation()
    resizeState.current = {
      key: col.key,
      startX: e.clientX,
      startWidth: col.width,
    }
  }

  // ── Cell renderers keyed by column ────────────────────────────────────────

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
            onOpenDetail={setDetailTxn}
            onRename={(id, name) => setData(prev => ({
              ...prev,
              transactions: prev.transactions.map(t => t.id === id ? { ...t, merchant_name: name } : t),
            }))}
            onUpdateNote={updateNote}
          />
        )
      case 'category': {
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
            onOpenDetail={txn.category_id ? () => setDetailCategory({
              id:    txn.category_id,
              name:  txn.category_name,
              color: txn.category_color,
              icon:  txn.category_icon,
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
                setDetailAccount({ id: txn.account_id, name: txn.account_name, mask: txn.account_mask })
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
          <span style={{
            textAlign: 'right', fontWeight: 600,
            color: txn.amount < 0 ? 'var(--success)' : 'var(--text)',
            display: 'block',
          }}>
            {txn.amount < 0 ? '+' : null}{formatCurrency(txn.amount)}
          </span>
        )
      default:
        return null
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ padding: '32px 32px 0', flexShrink: 0 }}>
        <PageHeader title="Transactions">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button
              onClick={() => { setUncategorizedOnly(v => !v); isFirstLoad.current = true }}
              style={{
                padding: '5px 12px', borderRadius: 6, fontSize: 13, cursor: 'pointer',
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
            <span style={{ fontSize: 13, color: 'var(--muted)' }}>
              {data.total} transactions
            </span>
          </div>
        </PageHeader>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 32px 32px' }}>

        <Card style={{ padding: 0, overflow: 'hidden' }}>
          {/* Header row */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: gridTemplate,
            padding: '10px 16px',
            fontSize: 12, fontWeight: 600, color: 'var(--muted)',
            borderBottom: '1px solid var(--border)',
            textTransform: 'uppercase', letterSpacing: '0.05em',
          }}>
            {cols.map(col => {
              const def = COLUMN_DEFS.find(d => d.key === col.key)
              return (
                <div
                  key={col.key}
                  draggable
                  onDragStart={() => handleHeaderDragStart(col.key)}
                  onDragOver={e => e.preventDefault()}
                  onDrop={() => handleHeaderDrop(col.key)}
                  style={{
                    position: 'relative',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: col.key === 'amount' ? 'flex-end' : 'space-between',
                    gap: 8,
                    minWidth: 0,
                    cursor: 'grab',
                    ...(col.key === 'amount' ? { textAlign: 'right' } : {
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }),
                  }}
                >
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {def?.label ?? col.key}
                  </span>
                  <span style={{ fontSize: 10, opacity: 0.55, flexShrink: 0 }}>
                    ↔
                  </span>
                  <button
                    onMouseDown={e => startResize(e, col)}
                    title={`Resize ${def?.label ?? col.key}`}
                    style={{
                      position: 'absolute',
                      top: -10,
                      right: -8,
                      bottom: -10,
                      width: 16,
                      cursor: 'col-resize',
                      border: 'none',
                      background: 'transparent',
                      padding: 0,
                    }}
                  />
                </div>
              )
            })}
          </div>

          {initialLoading ? <Spinner /> : data.transactions.length === 0 ? (
            <EmptyState message="No transactions found" />
          ) : (
            data.transactions.map(txn => (
              <div
                key={txn.id}
                onContextMenu={e => onContextMenu(e, txn)}
                style={{
                  display: 'grid',
                  gridTemplateColumns: gridTemplate,
                  padding: '11px 16px', alignItems: 'center',
                  borderBottom: '1px solid var(--border)',
                  fontSize: 14,
                  background: editId === txn.id ? 'var(--surface2)' : 'transparent',
                  minWidth: 0,
                }}
              >
                {cols.map(col => (
                  <div
                    key={col.key}
                    style={{
                      overflow: 'hidden',
                      minWidth: 0,
                      // amount column needs no overflow constraint (it's a number)
                      ...(col.key === 'amount' ? {} : { textOverflow: 'ellipsis', whiteSpace: 'nowrap' }),
                    }}
                  >
                    {renderCell(col, txn)}
                  </div>
                ))}
              </div>
            ))
          )}
        </Card>

        {/* Context menu */}
        {menu && (
          <ContextMenu
            menu={menu}
            onClose={closeMenu}
            onOpenDetail={txn => { setDetailTxn(txn); closeMenu() }}
            onEditNote={txn => { setNoteTarget(txn); closeMenu() }}
          />
        )}

        {/* Note editor */}
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

        {/* Merchant detail panel */}
        {detailTxn && (
          <TransactionDetail
            txn={detailTxn}
            categories={categories}
            onClose={() => setDetailTxn(null)}
          />
        )}

        {/* Category detail panel */}
        {detailCategory && (
          <CategoryDetail
            category={detailCategory}
            categories={categories}
            onClose={() => setDetailCategory(null)}
          />
        )}

        {/* Account detail panel */}
        {detailAccount && (
          <AccountDetail
            account={detailAccount}
            categories={categories}
            onClose={() => setDetailAccount(null)}
          />
        )}

        {rulePrompt && (
          <RuleSuggestionToast
            prompt={rulePrompt}
            onDismiss={() => setRulePrompt(null)}
          />
        )}
      </div>
    </div>
  )
}
