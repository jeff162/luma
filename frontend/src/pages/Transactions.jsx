import { useState, useEffect, useCallback, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { api } from '../lib/api.js'
import { refreshTaskBadge } from '../App.jsx'
import { formatCurrency, formatDate } from '../lib/utils.js'
import { Card, PageHeader, Spinner, EmptyState } from '../components/ui.jsx'
import TransactionDetail from '../components/TransactionDetail.jsx'
import { buildGroups, InlineCategorySelect, MerchantCell, CategoryCell, ContextMenu, useContextMenu, NotePopover } from '../components/TransactionRow.jsx'
import RuleSuggestionToast from '../components/RuleSuggestionToast.jsx'
import { useFilters } from '../lib/FilterContext.jsx'

const NEW_CATEGORY_SENTINEL = '__new__'

const NEW_CAT_COLORS = [
  '#6366f1','#ec4899','#f97316','#eab308','#22c55e',
  '#14b8a6','#3b82f6','#a855f7','#ef4444','#64748b',
]

export default function Transactions() {
  const { filters } = useFilters()
  const location = useLocation()
  const [categories, setCategories] = useState([])
  const [data, setData]             = useState({ transactions: [], total: 0 })
  const [initialLoading, setInitialLoading] = useState(true)
  const [detailTxn, setDetailTxn]   = useState(null)
  const [editId, setEditId]         = useState(null)
  const { menu, onContextMenu, close: closeMenu } = useContextMenu()
  const [noteTarget, setNoteTarget] = useState(null)
  const [rulePrompt, setRulePrompt] = useState(null)
  const isFirstLoad = useRef(true)

  // Seed from ?uncategorized=1 link (e.g. from Tasks page)
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
      // __uncategorized__ must go via category_id (singular) — the backend
      // handles the sentinel there; category_ids does a literal IN() and misses it
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
        // Remove the row — it's now categorized
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
    // Add a newly created group/category to the local list without assigning it
    setCategories(prev => prev.find(c => c.id === cat.id) ? prev : [...prev, cat])
  }

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
        <div style={{
          display: 'grid',
          gridTemplateColumns: '100px 1fr 160px 160px 120px',
          padding: '10px 16px',
          fontSize: 12, fontWeight: 600, color: 'var(--muted)',
          borderBottom: '1px solid var(--border)',
          textTransform: 'uppercase', letterSpacing: '0.05em',
        }}>
          <span>Date</span>
          <span>Merchant</span>
          <span>Account</span>
          <span>Category</span>
          <span style={{ textAlign: 'right' }}>Amount</span>
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
                gridTemplateColumns: '100px 1fr 160px 160px 120px',
                padding: '11px 16px', alignItems: 'center',
                borderBottom: '1px solid var(--border)',
                fontSize: 14,
                background: editId === txn.id ? 'var(--surface2)' : 'transparent',
              }}>
              <span style={{ color: 'var(--muted)', fontSize: 13 }}>
                {formatDate(txn.date)}
              </span>

              <MerchantCell
                txn={txn}
                onOpenDetail={setDetailTxn}
                onRename={(id, name) => setData(prev => ({
                  ...prev,
                  transactions: prev.transactions.map(t => t.id === id ? { ...t, merchant_name: name } : t)
                }))}
                onUpdateNote={updateNote}
              />

              <span style={{ color: 'var(--muted)', fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {txn.account_name}{txn.account_mask ? ` ···${txn.account_mask}` : ''}
              </span>

              <CategoryCell
                txn={txn}
                categories={categories}
                onSave={(txnId, catId, catObj) => saveCategory(txnId, catId, catObj)}
                onAddCategory={addCategory}
                onRulePrompt={setRulePrompt}
              />

              <span style={{
                textAlign: 'right', fontWeight: 600,
                color: txn.amount < 0 ? 'var(--success)' : 'var(--text)',
              }}>
                {txn.amount < 0 ? '+' : null}{formatCurrency(txn.amount)}
              </span>
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

      {/* Note editor triggered from context menu — fixed position modal */}
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

      {detailTxn && (
        <TransactionDetail
          txn={detailTxn}
          categories={categories}
          onClose={() => setDetailTxn(null)}
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
