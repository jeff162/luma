// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

import { useState, useEffect, useCallback } from 'react'
import { api } from '../lib/api.js'
import { formatCurrency, formatDate, monthLabel } from '../lib/utils.js'
import { Spinner, Badge } from './ui.jsx'
import { MerchantCell, CategoryCell, getTxnMerchantLabel } from './TransactionRow.jsx'
import AmountDisplay from './AmountDisplay.jsx'
import CategoryDisplay from './CategoryDisplay.jsx'
import TransientTextInput from './TransientTextInput.jsx'
import { useFilters } from '../lib/FilterContext.jsx'
import RuleSuggestionToast from './RuleSuggestionToast.jsx'
import { useTransientTextEdit } from '../lib/uiInteractions.js'
import {
  DETAIL_LIST_MAX_HEIGHT,
  getDetailMonthSectionHeight,
  DetailPanelShell,
  DetailTrendChart,
  useDetailPanelChrome,
  usePagedMonthTransactions,
} from './detailShared.jsx'

const inputStyle = {
  background: 'var(--surface2)', color: 'var(--text)',
  border: '1px solid var(--border)', borderRadius: 6,
  padding: '5px 8px', fontSize: 13, outline: 'none',
}

/*
 * This drawer treats one transaction as the entry point into a payee's history. It keeps the visible month
 * locally editable, but it can also branch straight into rule creation when a manual recategorization looks
 * like the start of a repeatable pattern.
 */
export default function TransactionDetail({ txn, categories, onClose, onRulePrompt: externalRulePrompt, forceFloating = false, stackIndex = 0, isTopmost = true }) {
  const { filters } = useFilters()
  const dateStart = filters.date?.start || null
  const dateEnd   = filters.date?.end   || null
  const { pos, dragging, panelRef, onDragStart } = useDetailPanelChrome(onClose, { forceFloating, stackIndex })
  const [trend, setTrend]               = useState([])
  const [displayName, setDisplayName]   = useState(getTxnMerchantLabel(txn))
  const [selectedMonth, setSelectedMonth] = useState(null)
  const [trendLoading, setTrendLoading] = useState(true)
  const [rulePrompt, setRulePrompt]     = useState(null)
  const [detailCategories, setDetailCategories] = useState(categories)

  const payee    = getTxnMerchantLabel(txn)
  useEffect(() => {
    setDetailCategories(categories)
  }, [categories])
  const loadMonthPage = useCallback((month, offset, limit) => (
    api.getTransactions({
      month,
      payees: payee,
      direction: 'debit',
      limit,
      offset,
    })
  ), [payee])
  const {
    rows: monthTxns,
    setRows: setMonthTxns,
    loading: txnLoading,
    loadingMore: txnLoadingMore,
    listRef,
  } = usePagedMonthTransactions({ selectedMonth, loadPage: loadMonthPage })

  useEffect(() => {
    setTrendLoading(true)
    api.getPayeeTrend(payee, dateStart, dateEnd).then(rows => {
      setTrend(rows)
      setTrendLoading(false)
      if (rows.length > 0) {
        setSelectedMonth(rows[rows.length - 1].month)
      }
    })
  }, [payee, dateStart, dateEnd])

  // Keep the visible month in sync with the just-saved override so the drawer reflects the manual fix immediately.
  function handleCatSaved(txnId, cat) {
    setMonthTxns(prev => prev.map(t =>
      t.id !== txnId ? t : {
        ...t,
        category_id:    cat?.id    ?? null,
        category_name:  cat?.name  ?? null,
        category_color: null,
        category_overridden: 1,
      }
    ))
  }

  function handleAddCategory(cat) {
    setDetailCategories(prev => prev.some(existing => existing.id === cat.id) ? prev : [...prev, cat])
  }

  async function handleOverrideCategory(txnId, catId, catObj) {
    await api.overrideCategory(txnId, catId)
    const resolvedCat = catObj || detailCategories.find(c => c.id === catId)
    handleCatSaved(txnId, resolvedCat || null)
  }

  const {
    editing: editingName,
    draft: nameDraft,
    setDraft: setNameDraft,
    beginEdit: beginEditingName,
    cancelEdit: cancelEditingName,
    commitEdit: commitEditingName,
  } = useTransientTextEdit(displayName, {
    onCommit: async nextName => {
      await api.updateMerchant(txn.id, nextName)
      setDisplayName(nextName)
      setMonthTxns(prev => prev.map(row => row.id === txn.id ? { ...row, display_name: nextName } : row))
    },
  })

  useEffect(() => {
    if (!editingName) setDisplayName(getTxnMerchantLabel(txn))
  }, [txn.display_name, txn.merchant_name, txn.raw_name, editingName])

  const selectedMonthRow = trend.find(r => r.month === selectedMonth)
  const monthSectionHeight = getDetailMonthSectionHeight(trend)
  const header = (
    <>
      {editingName ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <TransientTextInput
            value={nameDraft}
            onChange={setNameDraft}
            onCommit={commitEditingName}
            onCancel={cancelEditingName}
            restoreOnEscape
            onBlurCommit={false}
            style={{
              ...inputStyle,
              fontSize: 17,
              fontWeight: 600,
              border: '1px solid var(--accent)',
              minWidth: 220,
            }}
          />
          <button onClick={commitEditingName} style={{
            background: 'var(--accent)', color: '#fff', border: 'none',
            borderRadius: 6, padding: '4px 12px', fontSize: 13, cursor: 'pointer',
          }}>Save</button>
          <button onClick={cancelEditingName} style={{
            background: 'none', border: '1px solid var(--border)', color: 'var(--muted)',
            borderRadius: 6, padding: '4px 10px', fontSize: 13, cursor: 'pointer',
          }}>Cancel</button>
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ fontSize: 17, fontWeight: 600 }}>{displayName}</div>
          <button
            onClick={() => beginEditingName(displayName)}
            title="Edit merchant name"
            style={{
              background: 'none', border: 'none', color: 'var(--muted)',
              cursor: 'pointer', fontSize: 13, padding: '2px 4px',
            }}
          >✎</button>
        </div>
      )}
      <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2 }}>
        Spending history{dateStart || dateEnd
          ? ` · ${dateStart ? dateStart.slice(0, 7) : ''}${dateStart && dateEnd ? ' – ' : ''}${dateEnd ? dateEnd.slice(0, 7) : ''}`
          : ' · all time'}
      </div>
    </>
  )

  return (
    <>
      <DetailPanelShell
        pos={pos}
        dragging={dragging}
        panelRef={panelRef}
        onDragStart={onDragStart}
        onClose={onClose}
        header={header}
        isTopmost={isTopmost}
      >
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>
            Spending at {payee}{dateStart || dateEnd ? '' : ' — all time'}
          </div>

          {trendLoading ? <Spinner /> : trend.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--muted)', padding: '16px 0' }}>
              No history found for this payee.
            </div>
          ) : (
            <DetailTrendChart trend={trend} selectedMonth={selectedMonth} onSelectMonth={setSelectedMonth} />
          )}

          {selectedMonth && (
            <div style={{ marginTop: 24, height: monthSectionHeight }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>
                {monthLabel(selectedMonth)} · {payee}
              </div>

              {txnLoading && monthTxns.length === 0 ? <Spinner /> : monthTxns.length === 0 ? (
                <div style={{ fontSize: 13, color: 'var(--muted)' }}>No transactions found.</div>
              ) : (
                <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                  <div style={{
                    display: 'grid', gridTemplateColumns: '110px 1fr 140px 160px 110px',
                    padding: '7px 14px', fontSize: 11, fontWeight: 600,
                    color: 'var(--muted)', textTransform: 'uppercase',
                    letterSpacing: '0.05em', background: 'var(--surface2)',
                    borderBottom: '1px solid var(--border)',
                  }}>
                    <span>Date</span>
                    <span>Description</span>
                    <span>Account</span>
                    <span>Category</span>
                    <span style={{ textAlign: 'right' }}>Amount</span>
                  </div>

                  <div ref={listRef} style={{ maxHeight: DETAIL_LIST_MAX_HEIGHT, overflowY: 'auto' }}>
                    {monthTxns.map(t => (
                      <div key={t.id} style={{
                        display: 'grid', gridTemplateColumns: '110px 1fr 140px 160px 110px',
                        padding: '9px 14px', alignItems: 'center', fontSize: 13,
                        borderBottom: '1px solid var(--border)',
                        background: t.id === txn.id
                          ? 'color-mix(in srgb, var(--accent) 8%, transparent)'
                          : 'transparent',
                      }}>
                        <span style={{ color: 'var(--muted)', fontSize: 12 }}>{formatDate(t.date)}</span>
                        <MerchantCell
                          txn={t}
                          onRename={(id, name) => setMonthTxns(prev =>
                            prev.map(x => x.id === id ? { ...x, display_name: name } : x)
                          )}
                        />
                        <span style={{ color: 'var(--muted)', fontSize: 12,
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {t.account_name}{t.account_mask ? ` ···${t.account_mask}` : ''}
                        </span>
                        <CategoryCell
                          txn={t}
                          categories={detailCategories}
                          onSave={handleOverrideCategory}
                          onAddCategory={handleAddCategory}
                          onRulePrompt={p => {
                            setRulePrompt(p)
                            externalRulePrompt?.(p)
                          }}
                        />
                        <AmountDisplay amount={t.amount} isPending={!!t.is_pending} />
                      </div>
                    ))}
                  </div>

                  <div style={{
                    padding: '8px 14px', fontSize: 13, fontWeight: 600,
                    textAlign: 'right', borderTop: '1px solid var(--border)',
                    background: 'var(--surface2)',
                  }}>
                    {selectedMonthRow?.count ? `${selectedMonthRow.count} matching · ` : ''}
                    Total: {formatCurrency(selectedMonthRow?.total ?? monthTxns.reduce((s, t) => s + t.amount, 0))}
                  </div>
                </div>
              )}
            </div>
          )}
      </DetailPanelShell>
      {rulePrompt && (
        <RuleSuggestionToast
          prompt={rulePrompt}
          onSaved={({ applyToExisting }) => {
            if (applyToExisting) {
              // Applying the new rule can recategorize many rows in the current month, so refresh the drawer instead of patching only the clicked row.
              api.getTransactions({
                month: selectedMonth,
                payees: payee,
                direction: 'debit',
                limit: monthTxns.length || 100,
                offset: 0,
              }).then(d => setMonthTxns(d.transactions))
            }
          }}
          onDismiss={() => setRulePrompt(null)}
        />
      )}
    </>
  )
}
