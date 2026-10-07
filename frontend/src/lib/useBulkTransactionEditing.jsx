// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/* eslint-disable react-refresh/only-export-components -- the controller hook and its companion chrome component are one cohesive unit by design */

/*
 * Shared bulk-transaction-editing controller.
 *
 * Every transaction table that offers bulk edit behaves the same way: a "Bulk Edit" toggle reveals a
 * leading select column, an action bar offers Edit… (a `BulkEditPanel`) and Move to trash, and Apply
 * reconciles the loaded rows in place so the user's sort/scroll survive. This hook owns that behavior so
 * each host is a prop-pass instead of a re-implementation. The host still renders its own toggle button
 * (placement/style is page-contextual) and spreads `tableProps` onto its `TransactionListTable`; the
 * `<BulkEditChrome>` companion renders the action bar plus the panel/confirm/notice dialogs.
 *
 * Select-all has two strategies, because not every visible list maps to a server filter:
 *   - 'filter' (default): the header checkbox flips to "all matching the current filter"; the bulk API
 *     resolves the set server-side from `filterParams`, so it covers rows past the loaded page. Used by
 *     every list whose scope is a server-expressible filter (date / category / group / account / batch…).
 *   - 'loaded': the visible rows are a client-side subset no server filter can re-resolve (TagDetail's
 *     exact tag-signature list). The rows are already fully in memory, so select-all just checks every
 *     loaded id (ids mode) — see `selectAll` in useTransactionSelection.
 *
 * Apply reconciliation: hosts that hold their rows in local state pass `setRows` (+ optional
 * `onRowsTrashed` to decrement a separately-tracked total) for in-place patching; a host whose source of
 * truth is a paginated re-fetch passes `onReload` instead.
 *
 * A large selection is confirmed before it runs (BULK_CONFIRM_THRESHOLD). The gate lives in the
 * controller rather than in the action bar so no host and no future action can route around it, and it
 * names the count and what is about to happen — the point is to make the size of the selection readable
 * *before* the fact, since "all matching" resolves server-side and a filter that quietly failed to
 * narrow looks exactly like one that worked until the result lands.
 */

import { useCallback, useMemo, useState } from 'react'
import { useTags } from './useTags.js'
import { useTransactionSelection } from './useTransactionSelection.js'
import { categoryReconcilePatch, reconcileRowsAfterRuleApply, txnMutations } from './txnMutations.js'
import BulkEditPanel from '../components/BulkEditPanel.jsx'
import { AppConfirmDialog, AppNoticeDialog, Button } from '../components/ui.jsx'

// Above this many rows, an apply is confirmed first. Chosen to sit above ordinary work and below a
// runaway: recategorizing a merchant or tagging a trip is tens of rows, and marking a freshly imported
// batch reviewed is hundreds, so a lower bar would train the user to click through it — while anything
// that has quietly widened to a whole ledger is orders of magnitude past this.
export const BULK_CONFIRM_THRESHOLD = 500

const BULK_ACTION_LABELS = {
  set_category: 'Set category',
  add_tags: 'Add tags',
  remove_tags: 'Remove tags',
  set_notes: 'Set notes',
  set_merchant: 'Set merchant',
  set_date: 'Set date',
  mark_reviewed: 'Mark reviewed',
  set_review_status: 'Change review status',
  trash: 'Move to trash',
}

export function describeBulkActions(actions = []) {
  return actions.map(action => BULK_ACTION_LABELS[action.type] || action.type).join(' · ')
}

export function useBulkTransactionEditing({
  rows = [],
  setRows = null,
  onReload = null,
  total = 0,
  filterParams = {},
  selectAllStrategy = 'filter',
  categories = [],
  availableTags = [],
  getRowId = row => row.id,
  onRowsTrashed = null,
}) {
  const [bulkMode, setBulkMode] = useState(false)
  const [showPanel, setShowPanel] = useState(false)
  const [applying, setApplying] = useState(false)
  const [pendingTrash, setPendingTrash] = useState(false)
  // Actions held back at the size gate, waiting for the user to confirm the count.
  const [pendingConfirm, setPendingConfirm] = useState(null)
  const [notice, setNotice] = useState('')
  const selection = useTransactionSelection()

  // The in-place reconcile needs tag metadata (name/color) to render freshly-added chips. Hosts that
  // already hold the tag list pass it; for those that don't, fall back to the shared tag cache
  // (loaded once app-wide, see useTags) rather than each list issuing its own tags request.
  const { tags: sharedTags } = useTags()
  const effectiveTags = availableTags.length ? availableTags : sharedTags

  const loadedIds = useMemo(() => rows.map(getRowId), [rows, getRowId])

  // For the 'loaded' strategy the table header's select-all must check every loaded id (ids mode), not
  // flip to server all-matching. Wrap the selection so TransactionListTable's header hook, which calls
  // selectAllMatching(), routes to selectAll(loadedIds) instead.
  const tableSelection = useMemo(() => (
    selectAllStrategy === 'loaded'
      ? { ...selection, selectAllMatching: () => selection.selectAll(loadedIds) }
      : selection
  ), [selection, selectAllStrategy, loadedIds])

  const bulkTotal = selectAllStrategy === 'loaded' ? rows.length : total
  const selectedCount = selection.selectedCount(bulkTotal)

  const toggle = useCallback(() => {
    setBulkMode(v => !v)
    selection.clear()
  }, [selection])

  // Reconcile the loaded rows in place after a bulk apply instead of re-fetching — a reload resets to
  // page 1 and throws away the user's sort order and scroll position. Mirrors the per-row handlers:
  // re-categorized rows linger (a mis-tap stays correctable; a Refresh prunes rows that no longer match),
  // trashed rows drop. "All matching" selections may touch unloaded rows too, but only the loaded ones
  // are on screen, so only those are patched.
  const reconcile = useCallback((actions, affectedIds) => {
    if (!affectedIds.size || !setRows) return
    const tagsById = new Map(effectiveTags.map(tag => [tag.id, tag]))
    let trashedCount = 0
    setRows(prev => {
      let next = prev
      for (const action of actions) {
        if (action.type === 'trash') {
          const before = next.length
          next = next.filter(txn => !affectedIds.has(getRowId(txn)))
          trashedCount += before - next.length
          continue
        }
        next = next.map(txn => {
          if (!affectedIds.has(getRowId(txn))) return txn
          switch (action.type) {
            case 'set_category': {
              const cat = categories.find(c => c.id === action.category_id)
              // Bulk set_category always writes category_source='manual' and clears needs_review on the
              // backend — even the null (bulk uncategorize) case — so force the marker off unconditionally
              // rather than leaving the helper's assign-only clear to decide. Inherited tags move with the
              // category and cannot be patched from here (one response, many rows), so the rows are
              // refetched after the apply — see the set_category branch in runActions.
              return { ...txn, ...categoryReconcilePatch(cat), needs_review: 0 }
            }
            case 'set_notes':
              return { ...txn, notes: action.notes || null }
            case 'set_merchant':
              return { ...txn, display_name: action.merchant }
            case 'set_date':
              return { ...txn, date: action.date }
            case 'mark_reviewed':
              return { ...txn, needs_review: 0 }
            case 'set_review_status':
              return { ...txn, needs_review: action.needs_review ? 1 : 0 }
            case 'add_tags': {
              const present = new Set((txn.tags || []).map(tag => tag.id))
              const additions = action.tag_ids
                .filter(id => !present.has(id))
                .map(id => {
                  const meta = tagsById.get(id)
                  return { id, name: meta?.name ?? '', color: meta?.color ?? null, source: 'direct' }
                })
              return additions.length ? { ...txn, tags: [...(txn.tags || []), ...additions] } : txn
            }
            case 'remove_tags': {
              const removing = new Set(action.tag_ids)
              // Only drop the *direct* attachment; an inherited tag stays (the backend keeps it too).
              return { ...txn, tags: (txn.tags || []).filter(tag => !(removing.has(tag.id) && tag.source === 'direct')) }
            }
            default:
              return txn
          }
        })
      }
      return next
    })
    if (trashedCount && onRowsTrashed) onRowsTrashed(trashedCount)
  }, [setRows, effectiveTags, categories, getRowId, onRowsTrashed])

  // `confirmed` is set by the size-gate dialog and by the trash confirm, which names the count itself —
  // a second dialog saying the same thing would read as a stutter rather than as a check.
  const runActions = useCallback(async (actions, { confirmed = false } = {}) => {
    if (!actions.length) return
    if (!confirmed && selectedCount >= BULK_CONFIRM_THRESHOLD) {
      setPendingConfirm(actions)
      return
    }
    setApplying(true)
    // Snapshot which loaded rows the selection covers *before* clearing it, so the in-place patch
    // reconciles exactly those. Works in both modes: isSelected() is true for every non-excluded loaded
    // row when "all matching" is active.
    const affectedIds = new Set(rows.filter(txn => tableSelection.isSelected(getRowId(txn))).map(getRowId))
    try {
      const result = await txnMutations.bulkUpdate(selection.toSelectionPayload(filterParams), actions)
      selection.clear()
      setShowPanel(false)
      setBulkMode(false)
      setNotice(`Updated ${result.updated_count} transaction${result.updated_count === 1 ? '' : 's'}.`)
      if (onReload) await onReload()
      else {
        reconcile(actions, affectedIds)
        // A category change moves the row's *inherited* tags, and which tags those are is resolved per
        // transaction from the category, its group, the account and the row's own blocks — so unlike
        // every other action here it cannot be patched from the action itself. The per-row endpoint
        // answers with the resolved set; the bulk one cannot (one response, many rows), so the loaded
        // rows it touched are refetched by id instead. Only for set_category: the other actions already
        // patch exactly, and a refetch would cost a request per bulk edit for nothing. The refunds that
        // followed a recategorized payment (`followed_ids`) moved too without being selected, so they
        // ride the same refetch.
        if (setRows && actions.some(action => action.type === 'set_category')) {
          await reconcileRowsAfterRuleApply(rows, [...affectedIds, ...(result.followed_ids || [])], setRows)
        }
      }
    } catch (error) {
      setNotice(error?.message || 'Bulk update failed.')
    } finally {
      setApplying(false)
    }
  }, [rows, setRows, tableSelection, getRowId, selection, selectedCount, filterParams, onReload, reconcile])

  return {
    bulkMode,
    toggle,
    tableProps: { bulkActive: bulkMode, bulkSelection: tableSelection, bulkTotal },
    selectedCount,
    selection,
    // Consumed by <BulkEditChrome>.
    categories,
    showPanel,
    setShowPanel,
    applying,
    pendingTrash,
    setPendingTrash,
    pendingConfirm,
    setPendingConfirm,
    notice,
    setNotice,
    runActions,
  }
}

// Action bar (shown in bulk mode) plus the edit/confirm/notice dialogs. Render once next to the table;
// the dialogs self-gate on their own open state, so the notice still shows after bulk mode exits.
// `actions` is an optional slot for surface-specific bulk actions, rendered before Clear. Only the
// Transactions ledger uses it so far (Copy as CSV, which needs that page's column set to build the
// rows); everything shared stays in the bar itself so the common surfaces keep one identical set.
export function BulkEditChrome({ controller, barStyle, actions = null }) {
  const {
    bulkMode, selectedCount, selection, categories,
    showPanel, setShowPanel, applying, pendingTrash, setPendingTrash,
    pendingConfirm, setPendingConfirm, notice, setNotice, runActions,
  } = controller
  return (
    <>
      {bulkMode ? (
        <div style={{
          padding: '8px 12px', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
          border: '1px solid color-mix(in srgb, var(--accent) 32%, var(--border))',
          background: 'color-mix(in srgb, var(--accent) 8%, var(--surface2))', borderRadius: 8,
          ...barStyle,
        }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>
            {selectedCount > 0
              ? `${selectedCount} selected${selection.allMatching ? ' · all matching' : ''}`
              : 'Select transactions to edit, or use the header checkbox to select all.'}
          </span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <Button small onClick={() => setShowPanel(true)} disabled={selectedCount === 0}>Edit…</Button>
            <Button small variant="ghost" onClick={() => runActions([{ type: 'mark_reviewed' }])} disabled={selectedCount === 0 || applying}>Mark reviewed</Button>
            <Button small variant="ghost" onClick={() => setPendingTrash(true)} disabled={selectedCount === 0}>Move to trash</Button>
            {actions}
            {selectedCount > 0 ? (
              <Button small variant="ghost" onClick={() => selection.clear()}>Clear</Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {showPanel ? (
        <BulkEditPanel
          count={selectedCount}
          categories={categories}
          applying={applying}
          onApply={runActions}
          onCancel={() => setShowPanel(false)}
        />
      ) : null}

      {pendingTrash ? (
        <AppConfirmDialog
          title={`Move ${selectedCount} transaction${selectedCount === 1 ? '' : 's'} to trash?`}
          description="They are removed from all views but recoverable from Settings → Trash."
          confirmLabel={applying ? 'Moving…' : 'Move to trash'}
          confirmVariant="danger"
          confirmDisabled={applying}
          borderColor="color-mix(in srgb, var(--danger) 35%, var(--border))"
          onConfirm={async () => { setPendingTrash(false); await runActions([{ type: 'trash' }], { confirmed: true }) }}
          onCancel={() => setPendingTrash(false)}
          width="min(520px, 100%)"
        />
      ) : null}

      {pendingConfirm ? (
        <AppConfirmDialog
          title={`Apply to ${selectedCount} transactions?`}
          description={`${describeBulkActions(pendingConfirm)} — ${selection.allMatching
            ? 'this runs on every row matching the current filter, not only the rows loaded on screen.'
            : 'this runs on every selected row.'} A bulk edit cannot be undone in one step.`}
          confirmLabel={applying ? 'Applying…' : `Apply to ${selectedCount}`}
          confirmDisabled={applying}
          onConfirm={async () => {
            const actions = pendingConfirm
            setPendingConfirm(null)
            await runActions(actions, { confirmed: true })
          }}
          onCancel={() => setPendingConfirm(null)}
          width="min(520px, 100%)"
        />
      ) : null}

      {notice ? (
        <AppNoticeDialog
          title="Bulk edit"
          description={notice}
          onClose={() => setNotice('')}
        />
      ) : null}
    </>
  )
}
