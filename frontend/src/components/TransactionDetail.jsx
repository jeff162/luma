// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api.js'
import { txnMutations, reconcileRowsAfterRuleApply, makeRowReconciler, applyCategoryChange } from '../lib/txnMutations.js'
import { formatCurrency } from '../lib/utils.js'
import { AppConfirmDialog, AppNoticeDialog, Spinner } from './ui.jsx'
import RuleActionModal from './RuleActionModal.jsx'
import { CategoryCell, NamelessMerchant, getTxnMerchantLabel, getTxnName } from './TransactionRow.jsx'
import SplitEditorDialog from './SplitEditorDialog.jsx'
import { OriginRow } from './OriginFields.jsx'
import { getTxnOriginRows } from '../lib/importSourceFields.js'
import TransientTextInput from './TransientTextInput.jsx'
import NoteEditor from './NoteEditor.jsx'
import TransactionAmountEditor from './TransactionAmountEditor.jsx'
import DocumentsPanel from './DocumentsPanel.jsx'
import PurchasePanel from './PurchasePanel.jsx'
import ReimbursementPanel from './ReimbursementPanel.jsx'
import { purchaseRowSummary } from '../lib/purchaseLinks.js'
import FeatureExplainer from '../help/FeatureExplainer.jsx'
import RuleSuggestionToast from './RuleSuggestionToast.jsx'
import { useTransientTextEdit } from '../lib/uiInteractions.js'
import TransactionListTable from './TransactionListTable.jsx'
import { isSplitPartRow } from '../lib/splitRows.js'
import CopyTransactionsButton from './CopyTransactionsButton.jsx'
import TransactionListToolbar from './TransactionListToolbar.jsx'
import { useBulkTransactionEditing, BulkEditChrome } from '../lib/useBulkTransactionEditing.jsx'
import { useTransactionTableLayout } from '../lib/transactionTablePreferences.js'
import { TagBadge } from './TagUi.jsx'
import TagPickerWithCreate from './TagPickerWithCreate.jsx'
import {
  DETAIL_LIST_MAX_HEIGHT,
  getDetailMonthSectionHeight,
  DetailPanelShell,
  DetailTrendChart,
  DetailRangeControl,
  computeDetailRange,
  detailRangeStableKey,
  detailRangeActiveMonth,
  useDetailPanelChrome,
  usePagedTransactions,
  usePanelReveal,
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
// `onReconcile(txnId, patch | null)` is the single host-reconcile callback: the panel emits the
// changed fields to merge into the host's row (category / notes / tags), or `null` when the row was
// trashed. Hosts wire it once (usually via makeRowReconciler) and never need to change when a new
// reconciled field is added here. See lib/txnMutations.js.
export default function TransactionDetail({ txn, categories, onClose, onReconcile, onRulePrompt: externalRulePrompt, forceFloating = false, stackIndex = 0, isTopmost = true, dateStart = null, dateEnd = null, showPayeeActivity = true, availableTags: providedAvailableTags = null }) {
  // Date scope is the caller's call: Dashboard/Transactions pass their global filter; pages without a
  // filter bar pass nothing, in which case the payee trend defaults to the merchant's full history.
  const navigate = useNavigate()
  const { pos, size, panelRef, onDragStart, onResizeStart } = useDetailPanelChrome(onClose, { forceFloating, stackIndex })
  const [trend, setTrend]               = useState([])
  const [displayName, setDisplayName]   = useState(getTxnName(txn))
  const [selectedMonth, setSelectedMonth] = useState(null)
  const [trendLoading, setTrendLoading] = useState(true)
  const [rulePrompt, setRulePrompt]     = useState(null)
  const [detailCategories, setDetailCategories] = useState(categories)
  const [detailTxn, setDetailTxn] = useState(txn)
  const [availableTags, setAvailableTags] = useState(providedAvailableTags || [])
  const [tagsLoading, setTagsLoading] = useState(!providedAvailableTags)
  // Hold the panel invisible until its geometry settles, so it fades in fully formed rather than
  // visibly growing as the payee trend and tags land (see usePanelReveal).
  const revealed = usePanelReveal(panelRef, !trendLoading && !tagsLoading)
  const [trashConfirmOpen, setTrashConfirmOpen] = useState(false)
  // A failed trash, surfaced rather than logged: the panel stays open and the row is untouched (the
  // close/reconcile happen only after the delete resolves), which without a notice reads as a dead button.
  const [trashError, setTrashError] = useState('')
  const [originExpanded, setOriginExpanded] = useState(false)
  // The editor's general rule affordance (create, or open the rule that already matches this row) — the
  // editor lacked one, forcing users through the category→toast path to author a rule.
  const [ruleModalState, setRuleModalState] = useState(null)
  // A row's pencil / "Edit transaction" in the payee activity list opens that transaction's own editor
  // as a child panel (same as the other detail panels host a child editor), so the merchant report can
  // edit a specific row in full without losing its place.
  const [childTxn, setChildTxn] = useState(null)

  // The merchant `↗` opens this panel as a merchant *report* (activity only) via a payload marker; the
  // pencil / "Edit transaction" opens it unmarked as the full editor. `showPayeeActivity` independently
  // gates the bottom (the import rule-suggestions screen shows the editor with no activity).
  const isMerchantReport = !!txn?._merchantReport
  const showEditorCard = !isMerchantReport

  async function confirmTrash() {
    setTrashConfirmOpen(false)
    try {
      await txnMutations.trashTransaction(txn.id)
      onReconcile?.(txn.id, null)
      onClose?.()
    } catch (err) {
      setTrashError(`${err?.message || 'The transaction could not be sent to trash.'} Nothing was changed.`)
    }
  }
  const [columnConfig, setColumnConfig] = useTransactionTableLayout({
    preferenceKey: TRANSACTION_DETAIL_TABLE_PREF_KEY,
  })

  // Open the rule editor for this transaction: edit the rule that already matches it, else create one
  // seeded from its merchant/category. (Recurring is a checkbox inside that same editor.)
  async function openRuleEditor() {
    try {
      const res = await api.getMatchingRuleForTransaction(detailTxn.id)
      if (res?.rule_id) {
        setRuleModalState({ mode: 'edit', ruleId: res.rule_id, txnId: detailTxn.id })
        return
      }
    } catch { /* fall through to create */ }
    const merchantName = getTxnMerchantLabel(detailTxn)
    setRuleModalState({
      mode: 'create', txnId: detailTxn.id, categoryId: detailTxn.category_id || '',
      keywordSource: detailTxn.merchant_name || detailTxn.raw_name || merchantName,
      transactionData: { ...detailTxn },
    })
  }

  const payee    = getTxnMerchantLabel(detailTxn)
  useEffect(() => {
    setDetailCategories(categories)
  }, [categories])
  // Resync when the host hands over a different row — and, where that row is one *allocation* of a
  // split, replace it with the transaction behind it.
  //
  // A category-scoped list expands splits, so the row it hands over has had the part's amount and
  // category substituted in by the seam, while its id — and therefore everything this panel fetches by
  // id: documents, purchase, reimbursement — still speaks for the whole transaction. Unresolved, the
  // panel describes a part in its header and the transaction in its body, which is how a $10 allocation
  // came to sit above a $250 receivable. It is fetched rather than reconstructed from the row because
  // the transaction's own category is genuinely not in the payload, and because a field added to the
  // seam's substitution list later would silently reintroduce this. Only part rows pay for the request;
  // every other row opens straight off the object it was handed, as before.
  //
  // Setting `detailTxn` cannot re-trigger this — it keys on the `txn` prop, which is the host's — so
  // there is no fetch loop. See lib/splitRows.js.
  useEffect(() => {
    setDetailTxn(txn)
    if (!isSplitPartRow(txn)) return undefined
    let cancelled = false
    api.getTransactions({ ids: txn.id, limit: 1 })
      .then(resp => {
        const whole = resp?.transactions?.[0]
        if (!cancelled && whole) setDetailTxn(whole)
      })
      // Left as handed over if the fetch fails: the header keeps the part's figures, which is wrong but
      // still usable, and is better than a panel that refuses to describe the row at all.
      .catch(() => {})
    return () => { cancelled = true }
  }, [txn])
  // The report opens on the month of the transaction it was opened from, so that row is in the list. That
  // month need not be a bar: the trend leaves pending rows out like every summary, while the list is the
  // lossless feed, so a month holding only a pending charge is selected with no bar and still lists it. A
  // row outside the caller's date scope has no place in this report, so it falls back to the newest bar.
  const openedMonth = txn?.date
    && (!dateStart || txn.date >= dateStart) && (!dateEnd || txn.date <= dateEnd)
    ? txn.date.slice(0, 7) : null
  // The transaction list defaults to the selected month but can widen to that bar's year or the whole
  // charted span (DetailRangeControl). `range` derives the fetch window + count/total; `rangeKey` keeps
  // the memo/fetch stable so re-clicking a bar inside the same window doesn't reload identical rows.
  const [rangeMode, setRangeMode] = useState('month')
  const rangeKey = detailRangeStableKey(rangeMode, selectedMonth)
  const range = useMemo(
    () => computeDetailRange(rangeMode, selectedMonth, trend, openedMonth),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rangeKey subsumes selectedMonth; recomputing on every anchor click would refetch identical rows in year/all-time mode
    [rangeMode, rangeKey, trend, openedMonth],
  )
  const anchorReady = rangeMode === 'all' ? (trend.length > 0 || !!openedMonth) : !!selectedMonth
  const activeKey = anchorReady ? `${payee}|${rangeMode}|${rangeKey}` : null
  // The window + payee: what the list fetches, what "select all matching" resolves, and what a download of
  // the list exports.
  const listParams = useMemo(() => ({ ...range.params, payees: payee }), [range, payee])
  const loadPage = useCallback((offset, limit, sort) => (
    api.getTransactions({ ...listParams, limit, offset, sort_by: sort.key, sort_dir: sort.dir })
  ), [listParams])
  const {
    rows: monthTxns,
    setRows: setMonthTxns,
    loading: txnLoading,
    reload,
    reloading,
    paging,
    sortState,
    onSort,
    copy,
  } = usePagedTransactions({ activeKey, loadPage, exportParams: listParams })

  useEffect(() => {
    // When the caller already has the tag list (e.g. a host that loaded it), use it and skip the fetch
    // so the Tags picker is ready at first paint instead of settling in after the panel is shown.
    if (providedAvailableTags) {
      setAvailableTags(providedAvailableTags)
      setTagsLoading(false)
      return
    }
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
  }, [providedAvailableTags])

  useEffect(() => {
    // When the caller hides the payee-activity section (e.g. the import rule-suggestions report, where
    // all-time activity would include transactions outside the curated files), skip the trend fetch
    // entirely — it isn't shown, and skipping it also removes an extra paint stage.
    if (!showPayeeActivity) { setTrendLoading(false); return }
    let cancelled = false
    setTrendLoading(true)
    api.getPayeeTrend(payee, dateStart || undefined, dateEnd || undefined).then(rows => {
      if (cancelled) return
      setTrend(rows)
      setTrendLoading(false)
      if (openedMonth) {
        setSelectedMonth(openedMonth)
      } else if (rows.length > 0) {
        setSelectedMonth(rows[rows.length - 1].month)
      }
    }).catch(() => {
      if (cancelled) return
      // Cleared for the same reason as the account trend: the effect re-runs per payee, so a kept series
      // would be shown under a different payee's name.
      setTrend([])
      setTrendLoading(false)
    })
    return () => { cancelled = true }
  }, [payee, dateStart, dateEnd, showPayeeActivity, openedMonth])

  // Keep the visible month in sync with the just-saved override so the drawer reflects the manual fix immediately.
  function handleCatSaved(txnId, patch) {
    if (txnId === detailTxn.id) {
      setDetailTxn(prev => ({ ...prev, ...patch }))
    }
    setMonthTxns(prev => prev.map(t =>
      t.id !== txnId ? t : { ...t, ...patch }
    ))
  }

  // Panel state and the host's row, always together. Everything routed through here has already been
  // written to the database, so a host left holding the old value is displaying something untrue — and
  // the panel re-seeds from that row when it is reopened, which turns the staleness into an apparent
  // *rejection*: the rename saved, showed correctly, and came back wrong on the next open.
  //
  // The reconcile lives here rather than at each call site because that is what it took to lose one.
  // Notes and tags each carried their own copy of it with a comment explaining why; the rename did not,
  // and nothing in the shape of the code said a caller owed one.
  function patchDetailTxn(patch) {
    setDetailTxn(prev => ({ ...prev, ...patch }))
    setMonthTxns(prev => prev.map(row => (
      row.id === detailTxn.id ? { ...row, ...patch } : row
    )))
    onReconcile?.(detailTxn.id, patch)
  }

  // The split editor is opened from the category field and reconciles back into the panel's own row, so
  // the marker and the "manual/imported" note beside it reflect the save without a re-fetch.
  const [splitEditorOpen, setSplitEditorOpen] = useState(false)

  function handleSplitSaved({ is_split, parts }) {
    const patch = {
      is_split,
      split_part_count: parts?.length || 0,
      category_source: is_split ? 'split' : 'manual',
      category_overridden: 1,
    }
    setDetailTxn(prev => (prev ? { ...prev, ...patch } : prev))
    onReconcile?.(detailTxn.id, patch)
  }

  function handleAddCategory(cat) {
    setDetailCategories(prev => prev.some(existing => existing.id === cat.id) ? prev : [...prev, cat])
  }

  async function handleOverrideCategory(txnId, catId, catObj) {
    const resolvedCat = catObj || detailCategories.find(c => c.id === catId) || null
    // Both phases go to both places: the panel's own copy and the host's row (e.g. the Transactions
    // list) — otherwise the change lives only in the panel and the page behind it stays stale.
    await applyCategoryChange(txnId, resolvedCat, (patch, id) => {
      if (id === txnId) handleCatSaved(id, patch)
      onReconcile?.(id, patch)
    })
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
    if (!editingName) setDisplayName(getTxnName(detailTxn))
    // Listing the three fields getTxnName reads (not detailTxn itself) is
    // deliberate: notes/tags edits patch detailTxn too and we don't want them to
    // reset displayName mid-edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailTxn.display_name, detailTxn.merchant_name, detailTxn.raw_name, editingName])

  // Kept stable, deliberately. `DocumentsPanel` reports its documents so the ledger's document marker updates
  // without refetching the page, and that report patches the host row — which re-renders this panel. An
  // inline arrow here would hand the panel a new identity on each of those renders, and the panel would
  // refetch on every one, looping between loading and loaded. See the ref in DocumentsPanel for the
  // other half of the same rule.
  //
  // The whole list travels, not just its length: the row *opens* documents from its own copy, so a
  // stale id there is a click that opens the wrong thing (or nothing) rather than merely a wrong count.
  const handleDocumentsChange = useCallback(documents => {
    const patch = { documents, document_count: documents.length }
    setDetailTxn(prev => (prev ? { ...prev, ...patch } : prev))
    onReconcile?.(txn.id, patch)
  }, [onReconcile, txn.id])

  // Stable for the same reason `handleDocumentsChange` is — see the comment above it. What travels is
  // the *summary* the ledger row's marker draws from, so a purchase edited or ungrouped here updates
  // the marker behind the panel without a refetch, and `null` removes it.
  const handlePurchaseChange = useCallback(purchase => {
    const patch = { purchase: purchaseRowSummary(purchase, txn.id) }
    setDetailTxn(prev => (prev ? { ...prev, ...patch } : prev))
    onReconcile?.(txn.id, patch)
  }, [onReconcile, txn.id])

  // Stable for the same reason the two above are. A *list* travels, because one row may have shares in
  // several reimbursements — a charge split between two friends, a deposit repaying both. Reported
  // as-is rather than reduced to a row summary: nothing in the ledger renders it yet, and inventing a
  // projection before there is a marker to feed would be a second definition of the reading.
  const handleReimbursementsChange = useCallback(reimbursements => {
    const patch = { reimbursements: reimbursements || [] }
    setDetailTxn(prev => (prev ? { ...prev, ...patch } : prev))
    onReconcile?.(txn.id, patch)
  }, [onReconcile, txn.id])

  // Persistence for the shared NoteEditor: write through, then patch — which reconciles the host's row
  // as well, so the saved note shows behind the panel.
  async function handleSaveNote(nextNotes) {
    await api.updateNotes(detailTxn.id, nextNotes)
    patchDetailTxn({ notes: nextNotes })
  }

  // Persistence for the amount editor, in the same write-through-then-patch shape as the note. What
  // travels back is more than the figure: an amount is a rule condition, so the server re-runs the rules
  // and may hand back a different category — patching only the amount would leave the category badge
  // beside it stating the old one until something refetched.
  async function handleSaveAmount(nextAmount) {
    const updated = await txnMutations.updateAmount(detailTxn.id, nextAmount)
    patchDetailTxn({
      amount: updated.amount,
      category_id: updated.category_id,
      category_name: updated.category_name,
    })
  }

  async function handleToggleTag(tag, present) {
    const result = await txnMutations.setTag(detailTxn.id, tag.id, present)
    patchDetailTxn({ tags: result.tags || [], blocked_tags: result.blocked_tags || [] })
  }

  // Reserve the full 7-row list height for the wider (year/all-time) ranges, whose lists scroll at
  // DETAIL_LIST_MAX_HEIGHT regardless of any single month's count; month mode sizes to its busiest bar.
  const monthSectionHeight = getDetailMonthSectionHeight(rangeMode === 'month' ? trend : [{ count: 999 }])
  // Bulk edit over the current window's rows for this payee, matching the other activity reports. The
  // filter mirrors the list fetch (window params + payee) so "select all matching" resolves the whole
  // window server-side even when the list is paged; the count comes from the same trend sum.
  const bulk = useBulkTransactionEditing({
    rows: monthTxns,
    setRows: setMonthTxns,
    total: range.count || monthTxns.length,
    filterParams: listParams,
    categories: detailCategories,
  })
  const visibleTags = Array.isArray(detailTxn.tags) ? detailTxn.tags : []
  const visibleTagIds = new Set(visibleTags.map(tag => tag.id))
  const inheritedTagIds = new Set(visibleTags.filter(tag => tag.source && tag.source !== 'direct').map(tag => tag.id))
  const blockedTagIds = new Set((Array.isArray(detailTxn.blocked_tags) ? detailTxn.blocked_tags : []).map(tag => tag.id))
  const originRows = getTxnOriginRows(detailTxn)
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
          <div style={{ fontSize: 17, fontWeight: 600 }}>{displayName || <NamelessMerchant txn={detailTxn} />}</div>
          <button
            onClick={() => beginEditingName(displayName)}
            title="Edit merchant name"
            style={{
              background: 'none', border: 'none', color: 'var(--muted)',
              cursor: 'pointer', fontSize: 13, padding: '2px 4px',
            }}
          >✎</button>
          {/* Copy + trash target the single entry-point transaction, so they only belong in editor mode.
              In the merchant-activity report there is no one "this transaction" (the entry row may not
              even be in the visible window), so both would be ambiguous — the report offers a list-level
              copy instead, and rows keep their own trash via the row menu and Bulk Edit. */}
          {showEditorCard && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 'auto' }}>
              <CopyTransactionsButton txn={detailTxn} title="Copy transaction" />
              <button
                onClick={() => setTrashConfirmOpen(true)}
                title="Send transaction to trash"
                style={{
                  background: 'none', border: 'none', color: 'var(--muted)',
                  cursor: 'pointer', fontSize: 13, padding: '2px 4px',
                }}
              >🗑</button>
            </div>
          )}
        </div>
      )}
      <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2 }}>
        {/* The panel doubles as the single-transaction editor (opened via the pencil) and the
            merchant activity report (opened via the ↗). The subtitle names whichever the user asked
            for so the editor doesn't misleadingly read as a report; the date range only qualifies the
            activity scope, so it stays on the report label. */}
        {showEditorCard
          ? 'Edit transaction'
          : `Activity history${dateStart || dateEnd
              ? ` · ${dateStart ? dateStart.slice(0, 7) : ''}${dateStart && dateEnd ? ' – ' : ''}${dateEnd ? dateEnd.slice(0, 7) : ''}`
              : ' · all time'}`}
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
          {showEditorCard ? (
          <div style={{
            display: 'grid',
            gap: 16,
            padding: 14,
            border: '1px solid var(--border)',
            borderRadius: 12,
            background: 'var(--surface2)',
            marginBottom: 18,
          }}>
            {/* Editor toolbar: recurring membership status (links to its card on the Recurring page) on
                the left, and a general Rule affordance on the right — one button, since recurring lives
                inside the same rule editor. */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, minHeight: 24 }}>
              <div style={{ minWidth: 0 }}>
                {detailTxn.recurring_series_id ? (
                  <button
                    type="button"
                    onClick={() => navigate(`/recurring?series=${detailTxn.recurring_series_id}`)}
                    title="View this recurring series"
                    style={{
                      background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                      color: 'var(--accent2)', fontSize: 12.5, fontWeight: 600,
                      display: 'inline-flex', alignItems: 'center', gap: 5, maxWidth: '100%',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}
                  >
                    ↻ Part of {detailTxn.recurring_series_name || 'a recurring series'}
                  </button>
                ) : null}
              </div>
              <button
                type="button"
                onClick={openRuleEditor}
                style={{
                  background: 'none', border: '1px solid var(--border)', borderRadius: 6,
                  color: 'var(--muted)', cursor: 'pointer', fontSize: 12, padding: '3px 10px', flexShrink: 0,
                }}
              >⚙ Rule…</button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>
                  Transaction
                </div>
                <TransactionAmountEditor txn={detailTxn} onSave={handleSaveAmount} />
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
                    onOpenSplit={() => setSplitEditorOpen(true)}
                    onRulePrompt={p => {
                      setRulePrompt(p)
                      externalRulePrompt?.(p)
                    }}
                  />
                  {detailTxn.category_overridden && !detailTxn.is_split ? (
                    <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                      manual
                    </span>
                  ) : null}
                  {!detailTxn.is_split ? (
                    <button
                      type="button"
                      onClick={() => setSplitEditorOpen(true)}
                      title="Divide this transaction's amount across several categories"
                      style={{
                        background: 'none', border: '1px solid var(--border)', borderRadius: 6,
                        color: 'var(--muted)', cursor: 'pointer', fontSize: 11, padding: '2px 8px',
                      }}
                    >Split…</button>
                  ) : null}
                  <FeatureExplainer topic="transaction-splits" placement="bottom-left" />
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
                inheritedTagIds={inheritedTagIds}
                blockedTagIds={blockedTagIds}
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

            {/* Attached paperwork. Placed beside Notes because it answers the same kind of question —
                what this transaction was actually *for* — and the count is reconciled back to the host
                so the ledger's indicator updates without a refetch of the page. */}
            <DocumentsPanel txnId={detailTxn.id} onDocumentsChange={handleDocumentsChange} />

            {/* Renders nothing unless this transaction is one payment of a multi-payment purchase, so
                the section appears only where it has something to say. Placed beside Documents because
                it answers the same question those do — what this transaction was actually part of. */}
            <PurchasePanel txnId={detailTxn.id} onPurchaseChange={handlePurchaseChange} />

            {/* Renders only where there is unclaimed money in the Reimbursable group or a
                reimbursement already tracked — so, like the two above, it appears where it has
                something to say. Unlike them it also speaks for an *unclaimed* row, because money
                allocated to that group is a receivable whether or not a repayment has been found, and
                it lists rather than picks: one row can be a share of several reimbursements. */}
            <ReimbursementPanel
              txnId={detailTxn.id}
              categories={detailCategories}
              onAddCategory={handleAddCategory}
              onReimbursementsChange={handleReimbursementsChange}
            />

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
                {/* Origin rows come from the shared import-source-field registry so the panel and the
                    merchant hover render the same captured detail (lib/importSourceFields.js). The
                    `always` rows show unconditionally; the rest reveal under Show more. */}
                {originRows.filter(row => row.always).map(row => <OriginRow key={row.key} row={row} />)}
                {originExpanded
                  ? originRows.filter(row => !row.always).map(row => <OriginRow key={row.key} row={row} />)
                  : null}
              </div>
            </div>
          </div>
          ) : null}

          {showPayeeActivity ? (
          <>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>
            Activity at {payee}{dateStart || dateEnd ? '' : ' — all time'}
          </div>

          {trendLoading && trend.length === 0 ? <Spinner /> : trend.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--muted)', padding: '16px 0' }}>
              No history found for this payee.
            </div>
          ) : (
            <DetailTrendChart
              trend={trend}
              selectedMonth={selectedMonth}
              onSelectMonth={setSelectedMonth}
              isMonthActive={detailRangeActiveMonth(rangeMode, selectedMonth)}
            />
          )}

          {anchorReady && (
            <div style={{ marginTop: 24, minHeight: monthSectionHeight }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>
                  {range.label} · {payee}
                </div>
                <DetailRangeControl mode={rangeMode} onChange={setRangeMode} />
              </div>

              {txnLoading && monthTxns.length === 0 ? <Spinner /> : monthTxns.length === 0 ? (
                <div style={{ fontSize: 13, color: 'var(--muted)' }}>No transactions found.</div>
              ) : (
                <div>
                  <TransactionListToolbar rows={monthTxns} copy={copy} title={`${range.label} · ${payee}`} bulk={bulk} onRefresh={reload} refreshing={reloading} />
                  <BulkEditChrome controller={bulk} />
                  <TransactionListTable
                    rows={monthTxns}
                    categories={detailCategories}
                    {...bulk.tableProps}
                    onCategorySave={handleOverrideCategory}
                    onAddCategory={handleAddCategory}
                    onTransactionOpenDetail={setChildTxn}
                    onTrashed={txnId => setChildTxn(prev => (prev && prev.id === txnId ? null : prev))}
                    // Every row here is the same payee, so the merchant report ↗ would be self-referential;
                    // the pencil + row menu (which edit a specific row) stay.
                    showMerchantReport={false}
                    onRowsChange={setMonthTxns}
                    columnConfig={columnConfig}
                    onColumnConfigChange={setColumnConfig}
                    maxHeight={DETAIL_LIST_MAX_HEIGHT}
                    paging={paging}
                    sortState={sortState}
                    onSort={onSort}
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
                    {range.count ? `${range.count} matching · ` : ''}
                    Total: {formatCurrency(range.count ? range.total : monthTxns.reduce((s, t) => s + t.amount, 0))}
                  </div>
                </div>
              )}
            </div>
          )}
          </>
          ) : null}
      </DetailPanelShell>
      {trashConfirmOpen && (
        <AppConfirmDialog
          title="Send transaction to trash?"
          description={`Send "${getTxnMerchantLabel(detailTxn)}" (${detailTxn.date}) to the trash? You can restore it later from Settings → Trash.`}
          confirmLabel="Send to trash"
          confirmVariant="danger"
          borderColor="color-mix(in srgb, var(--danger) 35%, var(--border))"
          onConfirm={confirmTrash}
          onCancel={() => setTrashConfirmOpen(false)}
          width="min(520px, 100%)"
        />
      )}
      {trashError ? (
        <AppNoticeDialog
          title="Could not send to trash"
          description={trashError}
          onClose={() => setTrashError('')}
        />
      ) : null}
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
      {childTxn && (
        <TransactionDetail
          txn={childTxn}
          categories={detailCategories}
          onClose={() => setChildTxn(null)}
          onReconcile={makeRowReconciler(setMonthTxns)}
          forceFloating
          stackIndex={stackIndex + 1}
          dateStart={dateStart}
          dateEnd={dateEnd}
        />
      )}
      {ruleModalState && (
        <RuleActionModal
          state={ruleModalState}
          onClose={() => setRuleModalState(null)}
          onSaved={() => setRuleModalState(null)}
        />
      )}
      {splitEditorOpen && detailTxn && (
        <SplitEditorDialog
          txn={detailTxn}
          categories={detailCategories}
          onAddCategory={handleAddCategory}
          onClose={() => setSplitEditorOpen(false)}
          onSaved={handleSplitSaved}
        />
      )}
    </>
  )
}
