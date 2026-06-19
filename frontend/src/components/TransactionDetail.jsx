// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

import { useState, useEffect, useCallback } from 'react'
import { api } from '../lib/api.js'
import { txnMutations, reconcileRowsAfterRuleApply } from '../lib/txnMutations.js'
import { formatCurrency, monthLabel } from '../lib/utils.js'
import { AppConfirmDialog, Spinner } from './ui.jsx'
import { CategoryCell, getTxnMerchantLabel } from './TransactionRow.jsx'
import TransientTextInput from './TransientTextInput.jsx'
import NoteEditor from './NoteEditor.jsx'
import RuleSuggestionToast from './RuleSuggestionToast.jsx'
import { useTransientTextEdit } from '../lib/uiInteractions.js'
import TransactionListTable from './TransactionListTable.jsx'
import { useTransactionTableLayout } from '../lib/transactionTablePreferences.js'
import { TagBadge } from './TagUi.jsx'
import TagPickerWithCreate from './TagPickerWithCreate.jsx'
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
const TRANSACTION_DETAIL_TABLE_PREF_KEY = 'ui.transactionDetail.transactions.columns'

/*
 * This drawer treats one transaction as the entry point into a payee's history. It keeps the visible month
 * locally editable, but it can also branch straight into rule creation when a manual recategorization looks
 * like the start of a repeatable pattern.
 */
export default function TransactionDetail({ txn, categories, onClose, onTrashed, onCategorized, onNotesSaved, onTagsChanged, onRulePrompt: externalRulePrompt, forceFloating = false, stackIndex = 0, isTopmost = true, dateStart = null, dateEnd = null }) {
  // Date scope is the caller's call: Dashboard/Transactions pass their global filter; pages without a
  // filter bar pass nothing, in which case the payee trend defaults to the merchant's full history.
  const { pos, size, dragging, resizing, panelRef, onDragStart, onResizeStart } = useDetailPanelChrome(onClose, { forceFloating, stackIndex })
  const [trend, setTrend]               = useState([])
  const [displayName, setDisplayName]   = useState(getTxnMerchantLabel(txn))
  const [selectedMonth, setSelectedMonth] = useState(null)
  const [trendLoading, setTrendLoading] = useState(true)
  const [rulePrompt, setRulePrompt]     = useState(null)
  const [detailCategories, setDetailCategories] = useState(categories)
  const [detailTxn, setDetailTxn] = useState(txn)
  const [availableTags, setAvailableTags] = useState([])
  const [tagsLoading, setTagsLoading] = useState(true)
  const [trashConfirmOpen, setTrashConfirmOpen] = useState(false)
  const [originExpanded, setOriginExpanded] = useState(false)

  async function confirmTrash() {
    setTrashConfirmOpen(false)
    try {
      await txnMutations.trashTransaction(txn.id)
      onTrashed?.(txn.id)
      onClose?.()
    } catch (err) {
      console.error('Failed to send transaction to trash', err)
    }
  }
  const [columnConfig, setColumnConfig] = useTransactionTableLayout({
    preferenceKey: TRANSACTION_DETAIL_TABLE_PREF_KEY,
  })

  const payee    = getTxnMerchantLabel(detailTxn)
  useEffect(() => {
    setDetailCategories(categories)
  }, [categories])
  useEffect(() => {
    setDetailTxn(txn)
  }, [txn])
  const loadMonthPage = useCallback((month, offset, limit) => (
    api.getTransactions({
      month,
      payees: payee,
      limit,
      offset,
    })
  ), [payee])
  const {
    rows: monthTxns,
    setRows: setMonthTxns,
    loading: txnLoading,
    listRef,
  } = usePagedMonthTransactions({ selectedMonth, loadPage: loadMonthPage })

  useEffect(() => {
    let cancelled = false
    setTagsLoading(true)
    api.getTags()
      .then(rows => {
        if (!cancelled) setAvailableTags(rows)
      })
      .catch(() => {
        if (!cancelled) setAvailableTags([])
      })
      .finally(() => {
        if (!cancelled) setTagsLoading(false)
      })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    setTrendLoading(true)
    api.getPayeeTrend(payee, dateStart || undefined, dateEnd || undefined).then(rows => {
      setTrend(rows)
      setTrendLoading(false)
      if (rows.length > 0) {
        setSelectedMonth(rows[rows.length - 1].month)
      }
    })
  }, [payee, dateStart, dateEnd])

  // Keep the visible month in sync with the just-saved override so the drawer reflects the manual fix immediately.
  function handleCatSaved(txnId, cat) {
    if (txnId === detailTxn.id) {
      setDetailTxn(prev => ({
        ...prev,
        category_id: cat?.id ?? null,
        category_name: cat?.name ?? null,
        category_color: null,
        category_overridden: 1,
      }))
    }
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

  function patchDetailTxn(patch) {
    setDetailTxn(prev => ({ ...prev, ...patch }))
    setMonthTxns(prev => prev.map(row => (
      row.id === detailTxn.id ? { ...row, ...patch } : row
    )))
  }

  function handleAddCategory(cat) {
    setDetailCategories(prev => prev.some(existing => existing.id === cat.id) ? prev : [...prev, cat])
  }

  async function handleOverrideCategory(txnId, catId, catObj) {
    await txnMutations.setCategory(txnId, catId)
    const resolvedCat = catObj || detailCategories.find(c => c.id === catId)
    handleCatSaved(txnId, resolvedCat || null)
    // Notify the host (e.g. the Transactions list) so it can reconcile the row that was
    // categorized from inside this panel — otherwise the change only lives in the panel's
    // local state and the page behind it stays stale.
    onCategorized?.(txnId, resolvedCat || null)
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
      await api.updateMerchant(detailTxn.id, nextName)
      setDisplayName(nextName)
      patchDetailTxn({ display_name: nextName })
    },
  })

  useEffect(() => {
    if (!editingName) setDisplayName(getTxnMerchantLabel(detailTxn))
    // Listing the three fields getTxnMerchantLabel reads (not detailTxn itself) is
    // deliberate: notes/tags edits patch detailTxn too and we don't want them to
    // reset displayName mid-edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailTxn.display_name, detailTxn.merchant_name, detailTxn.raw_name, editingName])

  // Persistence for the shared NoteEditor: write through, patch the panel's own copy, and
  // reconcile the host's row so the saved note shows behind the panel (otherwise the note
  // persists to the DB but the page keeps reading its stale copy and shows no note marker).
  async function handleSaveNote(nextNotes) {
    await api.updateNotes(detailTxn.id, nextNotes)
    patchDetailTxn({ notes: nextNotes })
    onNotesSaved?.(detailTxn.id, nextNotes)
  }

  async function handleToggleTag(tag, present) {
    const result = await api.updateTransactionTag(detailTxn.id, tag.id, present)
    patchDetailTxn({ tags: result.tags || [] })
    // Reconcile the host's row too, otherwise the tag persists to the DB but the surface behind the
    // panel keeps reading its stale copy and shows no tag marker (same contract as onCategorized/onNotesSaved).
    onTagsChanged?.(detailTxn.id, result.tags || [])
  }

  const selectedMonthRow = trend.find(r => r.month === selectedMonth)
  const monthSectionHeight = getDetailMonthSectionHeight(trend)
  const visibleTags = Array.isArray(detailTxn.tags) ? detailTxn.tags : []
  const visibleTagIds = new Set(visibleTags.map(tag => tag.id))
  const renamed = Boolean(detailTxn.display_name && detailTxn.display_name !== (detailTxn.merchant_name || detailTxn.raw_name || detailTxn.display_name))
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
          <button
            onClick={() => setTrashConfirmOpen(true)}
            title="Send transaction to trash"
            style={{
              background: 'none', border: 'none', color: 'var(--muted)',
              cursor: 'pointer', fontSize: 13, padding: '2px 4px', marginLeft: 'auto',
            }}
          >🗑</button>
        </div>
      )}
      <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2 }}>
        Activity history{dateStart || dateEnd
          ? ` · ${dateStart ? dateStart.slice(0, 7) : ''}${dateStart && dateEnd ? ' – ' : ''}${dateEnd ? dateEnd.slice(0, 7) : ''}`
          : ' · all time'}
      </div>
    </>
  )

  return (
    <>
      <DetailPanelShell
        pos={pos}
        size={size}
        dragging={dragging}
        resizing={resizing}
        panelRef={panelRef}
        onDragStart={onDragStart}
        onResizeStart={onResizeStart}
        onClose={onClose}
        header={header}
        isTopmost={isTopmost}
      >
          <div style={{
            display: 'grid',
            gap: 16,
            padding: 14,
            border: '1px solid var(--border)',
            borderRadius: 12,
            background: 'var(--surface2)',
            marginBottom: 18,
          }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>
                  Transaction
                </div>
                <div style={{ fontSize: 14, fontWeight: 600 }}>{formatCurrency(detailTxn.amount)}</div>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{detailTxn.date}</div>
              </div>
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>
                  Category
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <CategoryCell
                    txn={detailTxn}
                    categories={detailCategories}
                    onSave={handleOverrideCategory}
                    onAddCategory={handleAddCategory}
                    onRulePrompt={p => {
                      setRulePrompt(p)
                      externalRulePrompt?.(p)
                    }}
                  />
                  {detailTxn.category_overridden ? (
                    <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                      {detailTxn.category_source === 'import' ? 'imported' : 'manual'}
                    </span>
                  ) : null}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>
                  Account
                </div>
                <div style={{ fontSize: 13 }}>
                  {detailTxn.account_name}{detailTxn.account_mask ? ` ···${detailTxn.account_mask}` : ''}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>
                  Source
                </div>
                <div style={{ fontSize: 13, color: detailTxn.import_batch_filename ? 'var(--text)' : 'var(--muted)' }}>
                  {detailTxn.import_batch_filename || 'Not imported from file'}
                </div>
              </div>
            </div>

            <div style={{ display: 'grid', gap: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Tags
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {visibleTags.length > 0 ? visibleTags.map(tag => (
                  <TagBadge key={tag.id} tag={tag} />
                )) : (
                  <span style={{ fontSize: 12, color: 'var(--muted)' }}>No tags on this transaction.</span>
                )}
              </div>
              {/* Shared picker: existing tags as checkboxes plus an inline "+ New tag" so a tag can be
                  invented and attached here without hopping to Settings (same affordance as the
                  transaction rows, Categories panel, and rule editor). Rendered inline (relative). */}
              <TagPickerWithCreate
                allTags={availableTags}
                selectedTagIds={visibleTagIds}
                onToggleTag={(tag, present) => handleToggleTag(tag, present)}
                onTagCreated={created => setAvailableTags(prev => (
                  prev.some(tag => tag.id === created.id) ? prev : [...prev, created]
                ))}
                onClose={() => {}}
                loading={tagsLoading}
                positioning="relative"
              />
            </div>

            <div style={{ display: 'grid', gap: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Notes
              </div>
              <NoteEditor value={detailTxn.notes} onSave={handleSaveNote} />
            </div>

            <div style={{ display: 'grid', gap: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Origin
                </div>
                <button
                  type="button"
                  onClick={() => setOriginExpanded(v => !v)}
                  style={{
                    background: 'none', border: 'none', cursor: 'pointer',
                    color: 'var(--accent)', fontSize: 11, padding: 0,
                  }}
                >
                  {originExpanded ? 'Show less' : 'Show more'}
                </button>
              </div>
              <div style={{ display: 'grid', gap: 6, fontSize: 12 }}>
                <div><span style={{ color: 'var(--muted)' }}>Visible merchant:</span> {getTxnMerchantLabel(detailTxn)}</div>
                {renamed ? (
                  <div><span style={{ color: 'var(--muted)' }}>Imported merchant:</span> {detailTxn.merchant_name || '—'}</div>
                ) : null}
                <div><span style={{ color: 'var(--muted)' }}>Raw source text:</span> {detailTxn.raw_name || '—'}</div>
                {originExpanded ? (
                  <>
                    {detailTxn.import_batch_filename ? (
                      <div>
                        <span style={{ color: 'var(--muted)' }}>Source file:</span>{' '}
                        <span title={detailTxn.import_batch_filename}>{detailTxn.import_batch_filename}</span>
                        {detailTxn.import_batch_imported_at ? (
                          <span style={{ color: 'var(--muted)' }}> · imported {(detailTxn.import_batch_imported_at || '').slice(0, 16).replace('T', ' ')}</span>
                        ) : null}
                      </div>
                    ) : (
                      <div><span style={{ color: 'var(--muted)' }}>Source file:</span> — (not from an import)</div>
                    )}
                    {detailTxn.imported_category ? (
                      <div>
                        <span style={{ color: 'var(--muted)' }}>Imported category:</span>{' '}
                        {detailTxn.imported_category}
                      </div>
                    ) : null}
                    {(() => {
                      // import_evidence_json stores a compact subset of the original CSV row —
                      // the account column the source called it, the raw description, and any
                      // extra source-text fields (e.g. "Original Statement"). Surfacing these
                      // closes "what did the bank statement actually say?" without making the
                      // user dig through the source CSV.
                      let evidence = null
                      try {
                        evidence = detailTxn.import_evidence_json
                          ? JSON.parse(detailTxn.import_evidence_json)
                          : null
                      } catch {
                        evidence = null
                      }
                      if (!evidence) return null
                      const out = []
                      if (evidence.account?.value) {
                        out.push(
                          <div key="src-acct">
                            <span style={{ color: 'var(--muted)' }}>Source account label ({evidence.account.header || 'Account'}):</span>{' '}
                            {evidence.account.value}
                          </div>
                        )
                      }
                      if (evidence.description?.value && evidence.description.value !== detailTxn.raw_name) {
                        out.push(
                          <div key="src-desc">
                            <span style={{ color: 'var(--muted)' }}>Source description ({evidence.description.header || 'Description'}):</span>{' '}
                            {evidence.description.value}
                          </div>
                        )
                      }
                      const extras = Array.isArray(evidence.extra_text_fields) ? evidence.extra_text_fields : []
                      extras.forEach((field, idx) => {
                        if (field?.value) {
                          out.push(
                            <div key={`extra-${idx}`}>
                              <span style={{ color: 'var(--muted)' }}>{field.header || 'Other'}:</span>{' '}
                              {field.value}
                            </div>
                          )
                        }
                      })
                      return out
                    })()}
                    {detailTxn.category_source ? (
                      <div>
                        <span style={{ color: 'var(--muted)' }}>Categorized by:</span>{' '}
                        {detailTxn.category_source === 'rule'   ? 'a categorization rule'
                          : detailTxn.category_source === 'import' ? 'category present in the source data'
                          : detailTxn.category_source === 'manual' ? 'manual edit'
                          : detailTxn.category_source}
                      </div>
                    ) : null}
                  </>
                ) : null}
              </div>
            </div>
          </div>

          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>
            Activity at {payee}{dateStart || dateEnd ? '' : ' — all time'}
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
                <div>
                  <TransactionListTable
                    rows={monthTxns}
                    categories={detailCategories}
                    onCategorySave={handleOverrideCategory}
                    onAddCategory={handleAddCategory}
                    onRulePrompt={p => {
                      setRulePrompt(p)
                      externalRulePrompt?.(p)
                    }}
                    onRowsChange={setMonthTxns}
                    columnConfig={columnConfig}
                    onColumnConfigChange={setColumnConfig}
                    maxHeight={DETAIL_LIST_MAX_HEIGHT}
                    scrollRef={listRef}
                    getRowStyle={row => (
                      row.id === txn.id
                        ? { background: 'color-mix(in srgb, var(--accent) 8%, transparent)' }
                        : undefined
                    )}
                  />
                  <div style={{
                    padding: '8px 14px', fontSize: 13, fontWeight: 600,
                    textAlign: 'right', borderTop: '1px solid var(--border)',
                    background: 'var(--surface2)',
                    borderLeft: '1px solid var(--border)',
                    borderRight: '1px solid var(--border)',
                    borderBottom: '1px solid var(--border)',
                    borderBottomLeftRadius: 8,
                    borderBottomRightRadius: 8,
                  }}>
                    {selectedMonthRow?.count ? `${selectedMonthRow.count} matching · ` : ''}
                    Total: {formatCurrency(selectedMonthRow?.total ?? monthTxns.reduce((s, t) => s + t.amount, 0))}
                  </div>
                </div>
              )}
            </div>
          )}
      </DetailPanelShell>
      {trashConfirmOpen && (
        <AppConfirmDialog
          title="Send transaction to trash?"
          description={`Send "${displayName}" (${detailTxn.date}) to the trash? You can restore it later from Settings → Trash.`}
          confirmLabel="Send to trash"
          confirmVariant="danger"
          borderColor="color-mix(in srgb, var(--danger) 35%, var(--border))"
          onConfirm={confirmTrash}
          onCancel={() => setTrashConfirmOpen(false)}
          width="min(520px, 100%)"
        />
      )}
      {rulePrompt && (
        <RuleSuggestionToast
          prompt={rulePrompt}
          onSaved={({ applyToExisting, transactionIds }) => {
            // Applying the rule can recategorize several rows in this month; patch exactly those in place
            // (re-fetched by id) so they show the new category without re-fetching the whole drawer.
            if (applyToExisting) {
              reconcileRowsAfterRuleApply(monthTxns, transactionIds, setMonthTxns)
            }
          }}
          onDismiss={() => setRulePrompt(null)}
        />
      )}
    </>
  )
}
