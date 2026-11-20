// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/* eslint-disable react-refresh/only-export-components -- the controller hook and its companion chrome component are one cohesive unit by design */

/*
 * Shared controller for a transaction list's right-click row menu and the editors it launches
 * (edit · create/open rule · split · note · tags · send to trash). Both the Transactions ledger (which
 * renders its own rows) and the shared TransactionListTable (every report/detail list) consume
 * this, so the row actions have one implementation rather than two copies that drift.
 *
 * Mirrors the useBulkTransactionEditing pattern: the hook owns all the menu/editor state and
 * handlers; the host attaches `onContextMenu` to its rows and renders <TransactionRowActionsChrome
 * controller={...}/> once. The host stays the source of truth for its rows, so it passes:
 *   - onOpenDetail(txn)        open the transaction editor for "Edit transaction…"
 *   - reconcileRow(id, patch)  patch a row in place after a note/tag edit
 *   - removeRow(id)            drop a row after it is trashed (and adjust any total/panels)
 *   - onRuleSaved(info)        optional: react to a rule create/apply from the menu
 *   - onSplitSaved(id, result) optional: a split was rewritten — refetch if the list shows allocations
 *   - onMembershipChange(info) optional: a row left or rejoined a recurring series from the menu or its
 *                              toast — { txnId, row, seriesId, state: 'excluded'|'clear', series }, where
 *                              `row` is the patched row (absent on Undo) and `series` the server's
 *                              recomputed series. For a host showing series counts beside the rows.
 *   - categories / onAddCategory  the category list the split editor's pickers render. Passing
 *                              a non-empty `categories` is what turns the split action on: without
 *                              one the menu
 *                              omits Split… rather than opening an editor with an empty picker, and
 *                              `openSplitFromMenu` is also what a host hands its CategoryCell as
 *                              `onOpenSplit` so a split row's marker opens this same editor.
 */

import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from './api.js'
import { useTags } from './useTags.js'
import { useBusyIndicator, PAINT_GATE_DELAY_MS } from './useBusyIndicator.js'
import { txnMutations } from './txnMutations.js'
import { useContextMenu, ContextMenu, NotePopover, getTxnMerchantLabel } from '../components/TransactionRow.jsx'
import TagPickerWithCreate from '../components/TagPickerWithCreate.jsx'
import RuleActionModal from '../components/RuleActionModal.jsx'
import SplitEditorDialog from '../components/SplitEditorDialog.jsx'
import { wholeTransactionRow } from './splitRows.js'
import { UndoToast } from '../components/CategoryTreePrimitives.jsx'
import { AppConfirmDialog, AppNoticeDialog, FloatingPanel } from '../components/ui.jsx'
import { MerchantOriginHoverCard } from '../components/OriginFields.jsx'
import { useVisibleViewport, visibleLayerBox } from './visibleViewport.js'
import { useCoarsePointer } from './deviceLayout.js'
import { useEscapeAction } from './uiInteractions.js'
import { formatDate } from './utils.js'

export function useTransactionRowActions({ onOpenDetail, reconcileRow, removeRow, onRuleSaved, onSplitSaved, onMembershipChange, categories, onAddCategory } = {}) {
  const { menu, onContextMenu, close: closeMenu } = useContextMenu()
  const navigate = useNavigate()
  const [noteTarget, setNoteTarget] = useState(null)
  const [tagTarget, setTagTarget] = useState(null)
  const [sourceDetailTarget, setSourceDetailTarget] = useState(null)
  const [pendingTrash, setPendingTrash] = useState(null)
  // Shared tag list for the row's Tags modal (loaded once app-wide; see useTags).
  const { tags: tagModalAllTags, loading: tagsLoading, addTag: addTagToCache } = useTags()
  const [contextRuleMatch, setContextRuleMatch] = useState({ txnId: null, loading: false, ruleId: null })
  const [ruleModalState, setRuleModalState] = useState(null)
  // Pre-removal membership snapshot backing the "Removed from recurring series · Undo" toast.
  const [recurringUndo, setRecurringUndo] = useState(null)
  // The row last marked reviewed, backing the "Marked reviewed · Undo" toast. Only the latest: reviewing
  // down a list replaces it on each click, and an older one can be re-flagged from bulk edit.
  const [reviewUndo, setReviewUndo] = useState(null)
  // The transaction whose split is being edited. Owned here rather than per host so the ledger, every
  // detail list, and the row menu all reach one editor — and so a host wires it by passing
  // `openSplitFromMenu` to its CategoryCell rather than repeating the dialog.
  const [splitTarget, setSplitTarget] = useState(null)
  // A failed row action, surfaced by the chrome. Every action below patches the list only *after* its
  // write resolves, so a failure has genuinely changed nothing — but silence is indistinguishable from
  // the button not working, which is what this exists to say out loud.
  const [actionError, setActionError] = useState(null)

  function reportActionFailure(title, err) {
    setActionError({
      title,
      description: `${err?.message || 'The change could not be saved.'} Nothing was changed.`,
    })
  }

  // Look up whether an existing rule already matches the right-clicked transaction, so the menu can
  // offer "Open matching rule" instead of "Create rule". The menu only opens when the host attaches
  // onContextMenu, so keying on menu?.txn?.id is enough to run this exactly when a menu is open.
  useEffect(() => {
    if (!menu?.txn?.id) {
      setContextRuleMatch({ txnId: null, loading: false, ruleId: null })
      return undefined
    }
    let cancelled = false
    setContextRuleMatch({ txnId: menu.txn.id, loading: true, ruleId: null })
    api.getMatchingRuleForTransaction(menu.txn.id)
      .then(result => { if (!cancelled) setContextRuleMatch({ txnId: menu.txn.id, loading: false, ruleId: result.rule_id || null }) })
      .catch(() => { if (!cancelled) setContextRuleMatch({ txnId: menu.txn.id, loading: false, ruleId: null }) })
    return () => { cancelled = true }
  }, [menu?.txn?.id])


  function openRuleFromMenu(txn) {
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
      // Pass the whole row so the rule editor can show its captured source text; only `amount` and
      // the origin fields are read.
      transactionData: { ...txn },
    })
  }

  async function handleNoteSave(val) {
    if (!noteTarget) return
    await api.updateNotes(noteTarget.id, val)
    reconcileRow?.(noteTarget.id, { notes: val })
    setNoteTarget(null)
  }

  async function toggleTagFromModal(tag, present) {
    if (!tagTarget) return
    const targetId = tagTarget.id
    const result = await txnMutations.setTag(targetId, tag.id, present)
    reconcileRow?.(targetId, { tags: result.tags || [], blocked_tags: result.blocked_tags || [] })
    setTagTarget(prev => (prev && prev.id === targetId
      ? { ...prev, tags: result.tags || [], blocked_tags: result.blocked_tags || [] }
      : prev))
  }

  async function confirmTrash() {
    if (!pendingTrash) return
    const target = pendingTrash
    setPendingTrash(null)
    try {
      await txnMutations.trashTransaction(target.id)
      // Trashing drops the row immediately (the one deliberate non-linger case — see ui-patterns).
      removeRow?.(target.id)
    } catch (err) {
      reportActionFailure('Could not send to trash', err)
    }
  }

  async function markReviewed(target) {
    if (!target) return
    try {
      await txnMutations.markReviewed(target.id)
      // The row lingers in place (per the linger pattern); patching the flag clears its marker.
      reconcileRow?.(target.id, { needs_review: 0 })
      setReviewUndo({ txnId: target.id, label: getTxnMerchantLabel(target) })
    } catch (err) {
      reportActionFailure('Could not mark as reviewed', err)
    }
  }

  async function undoMarkReviewed() {
    const snap = reviewUndo
    if (!snap) return
    setReviewUndo(null)
    try {
      await txnMutations.markNeedsReview(snap.txnId)
      reconcileRow?.(snap.txnId, { needs_review: 1 })
    } catch (err) {
      reportActionFailure('Could not flag for review again', err)
    }
  }

  // UndoToast keys its auto-dismiss timer on this callback, so it has to be stable.
  const closeReviewUndo = useCallback(() => setReviewUndo(null), [])

  // "Mark as recurring" routes through the rule editor (recurring series are rule-backed): an existing
  // rule-backed member edits that rule; a non-rule detected member jumps to its card on the Recurring
  // page; a not-yet-recurring row opens the rule editor pre-checked to declare a recurring rule from it.
  function markRecurringFromMenu(txn) {
    closeMenu()
    if (txn.recurring_rule_id) {
      setRuleModalState({ mode: 'edit', ruleId: txn.recurring_rule_id, txnId: txn.id })
      return
    }
    if (txn.recurring_series_id) {
      navigate(`/recurring?series=${txn.recurring_series_id}`)
      return
    }
    const merchantName = getTxnMerchantLabel(txn)
    const keywordSource = txn.merchant_name || txn.raw_name || merchantName
    setRuleModalState({
      mode: 'create', txnId: txn.id, categoryId: txn.category_id || '',
      keywordSource, transactionData: { ...txn }, recurringDefault: true,
    })
  }

  async function removeFromRecurring(txn) {
    if (!txn?.recurring_series_id) return
    // Snapshot the membership so the toast can restore it (the exclude override is what removal writes).
    const snapshot = {
      txnId: txn.id,
      seriesId: txn.recurring_series_id,
      seriesName: txn.recurring_series_name || null,
      ruleId: txn.recurring_rule_id || null,
    }
    try {
      const series = await api.setRecurringMembership(txn.recurring_series_id, txn.id, 'excluded')
      // The row lingers; clear the membership fields (drops its ↻ marker) and record which series it was
      // removed from, so its menu immediately offers "Restore to recurring series" (not just the toast).
      const patch = {
        recurring_series_id: null, recurring_series_name: null, recurring_rule_id: null,
        recurring_excluded_series_id: txn.recurring_series_id,
        recurring_excluded_series_name: txn.recurring_series_name || null,
      }
      reconcileRow?.(txn.id, patch)
      onMembershipChange?.({ txnId: txn.id, row: { ...txn, ...patch }, seriesId: snapshot.seriesId, state: 'excluded', series })
      setRecurringUndo(snapshot)
    } catch (err) {
      reportActionFailure('Could not remove from the recurring series', err)
    }
  }

  // Right-click restore of a row the user previously removed: clear the exclude on the series it was
  // removed from (carried on the row as recurring_excluded_series_id) so it re-matches and rejoins.
  async function restoreToRecurring(txn) {
    const seriesId = txn?.recurring_excluded_series_id
    if (!seriesId) return
    closeMenu()
    try {
      const series = await api.setRecurringMembership(seriesId, txn.id, 'clear')
      const patch = {
        recurring_series_id: seriesId,
        recurring_series_name: txn.recurring_excluded_series_name || null,
        // rule_id is unknown here; the ↻ marker still shows, and a refetch/scan fills the exact link.
        recurring_rule_id: null,
        recurring_excluded_series_id: null,
        recurring_excluded_series_name: null,
      }
      reconcileRow?.(txn.id, patch)
      onMembershipChange?.({ txnId: txn.id, row: { ...txn, ...patch }, seriesId, state: 'clear', series })
    } catch (err) {
      reportActionFailure('Could not restore to the recurring series', err)
    }
  }

  // Undo a removal: clear the exclude override so the row re-matches and rejoins (link_series_members
  // runs server-side), then restore its marker optimistically.
  async function undoRemoveFromRecurring() {
    const snap = recurringUndo
    if (!snap) return
    setRecurringUndo(null)
    try {
      const series = await api.setRecurringMembership(snap.seriesId, snap.txnId, 'clear')
      reconcileRow?.(snap.txnId, {
        recurring_series_id: snap.seriesId,
        recurring_series_name: snap.seriesName,
        recurring_rule_id: snap.ruleId,
        recurring_excluded_series_id: null,
        recurring_excluded_series_name: null,
      })
      onMembershipChange?.({ txnId: snap.txnId, seriesId: snap.seriesId, state: 'clear', series })
    } catch (err) {
      reportActionFailure('Could not restore to the recurring series', err)
    }
  }

  const ruleActionLabel = contextRuleMatch.loading
    ? '⚙ Loading rule…'
    : contextRuleMatch.ruleId
      ? '⚙ Open matching rule'
      : '⚙ Create rule'

  // The menu waits for the rule lookup rather than painting and then rewriting one of its own items.
  //
  // "Create rule" and "Open matching rule" are different actions, so a menu that opens on one and
  // silently becomes the other is showing something untrue — and the lookup is usually fast enough that
  // the swap is over before it can be read, which leaves the user with a menu they cannot trust and no
  // idea why. Holding the paint costs nothing at that speed: nothing is on screen to flicker yet.
  //
  // The readiness test includes the transaction id deliberately. `contextRuleMatch` still describes the
  // *previously* opened row for one render after a right-click (the effect that resets it runs after
  // render), so a check on `loading` alone would paint the new menu carrying the old row's verdict.
  //
  // `useBusyIndicator` supplies the escape hatch on the same threshold the rest of the app announces
  // slowness at: if the lookup has not settled in ~150ms the menu opens anyway, showing "Loading rule…"
  // — because at that point an unresponsive right-click is the worse defect, and a label the user has
  // actually had time to read is allowed to change.
  const ruleMatchReady = Boolean(menu?.txn?.id)
    && contextRuleMatch.txnId === menu.txn.id
    && !contextRuleMatch.loading
  const ruleMatchSlow = useBusyIndicator(Boolean(menu?.txn?.id) && !ruleMatchReady, { delayMs: PAINT_GATE_DELAY_MS })
  const menuReady = Boolean(menu) && (ruleMatchReady || ruleMatchSlow)

  // The editor edits the *purchase*, so a row that is one expanded allocation is restored to the whole
  // transaction on the way in — otherwise it would reconcile the full allocation set against one part's
  // amount and refuse every save. See lib/splitRows.js.
  function openSplitFromMenu(txn) {
    setSplitTarget(wholeTransactionRow(txn))
  }

  // A saved split changes what the row reports (its marker, its part count, its provenance), so the
  // host's copy is patched through the same reconcile seam every other row action uses.
  function handleSplitSaved(txnId, { is_split, parts }) {
    reconcileRow?.(txnId, {
      is_split,
      // The allocations themselves, not just how many. Patching the count alone left the row holding
      // the *previous* split: its hover listed categories and amounts that had since been rewritten,
      // and stayed wrong until something refetched the page. The saved parts arrive here already —
      // they were simply not passed on.
      split_parts: parts || [],
      split_part_count: parts?.length || 0,
      category_source: is_split ? 'split' : 'manual',
      category_overridden: 1,
    })
    // A list showing *expanded* allocations cannot be corrected by a row patch: its rows carry the
    // parts' own categories and amounts, and a rewritten split may put them in a different category or
    // out of the list entirely. Only the host can resolve that, by refetching its scope.
    onSplitSaved?.(txnId, { is_split, parts: parts || [] })
  }

  return {
    onContextMenu,
    closeMenu,
    menu,
    menuReady,
    splitTarget,
    setSplitTarget,
    openSplitFromMenu,
    handleSplitSaved,
    categories,
    onAddCategory,
    noteTarget,
    setNoteTarget,
    tagTarget,
    setTagTarget,
    sourceDetailTarget,
    setSourceDetailTarget,
    pendingTrash,
    setPendingTrash,
    tagModalAllTags,
    tagsLoading,
    addTagToCache,
    ruleModalState,
    setRuleModalState,
    ruleActionLabel,
    openRuleFromMenu,
    markRecurringFromMenu,
    removeFromRecurring,
    restoreToRecurring,
    recurringUndo,
    setRecurringUndo,
    undoRemoveFromRecurring,
    reviewUndo,
    undoMarkReviewed,
    closeReviewUndo,
    actionError,
    setActionError,
    handleNoteSave,
    toggleTagFromModal,
    confirmTrash,
    markReviewed,
    onOpenDetail,
    onRuleSaved,
  }
}

// The centered overlay a row menu opens its note or tag editor in. It covers the visible area, which
// ends at an on-screen keyboard, and its own scroll keeps an editor taller than that reachable; the
// editor's auto margins centre it only while it fits.
function MenuEditorOverlay({ onClose, children }) {
  const area = useVisibleViewport()
  return (
    <div
      data-modal-overlay=""
      style={{
        position: 'fixed', ...visibleLayerBox(area), zIndex: 1000,
        display: 'flex', overflowY: 'auto', padding: 16,
        background: 'rgba(0,0,0,0.3)',
      }}
      onClick={onClose}
    >
      <div style={{ margin: 'auto' }} onClick={e => e.stopPropagation()}>
        {children}
      </div>
    </div>
  )
}

// The merchant name's hover card opened from the row menu, for a touch screen, where there is no hover to
// open it. Escape is handled here because the overlay only closes on a tap outside the card.
function SourceDetailOverlay({ txn, onClose }) {
  useEscapeAction(onClose)
  return (
    <MenuEditorOverlay onClose={onClose}>
      <FloatingPanel radius={10} style={{ padding: 12 }}>
        <MerchantOriginHoverCard txn={txn} copyable />
      </FloatingPanel>
    </MenuEditorOverlay>
  )
}

export function TransactionRowActionsChrome({ controller }) {
  const {
    menu, menuReady, closeMenu, onOpenDetail,
    setNoteTarget, setTagTarget, setPendingTrash,
    noteTarget, tagTarget, pendingTrash,
    sourceDetailTarget, setSourceDetailTarget,
    tagModalAllTags, tagsLoading, addTagToCache,
    ruleModalState, setRuleModalState,
    ruleActionLabel, openRuleFromMenu, markRecurringFromMenu, removeFromRecurring, restoreToRecurring,
    recurringUndo, setRecurringUndo, undoRemoveFromRecurring,
    reviewUndo, undoMarkReviewed, closeReviewUndo,
    actionError, setActionError,
    handleNoteSave, toggleTagFromModal, confirmTrash, markReviewed,
    onRuleSaved,
    splitTarget, setSplitTarget, openSplitFromMenu, handleSplitSaved, categories, onAddCategory,
  } = controller
  // With a mouse the merchant name's hover already shows this card, so the menu offers it only on touch.
  const coarsePointer = useCoarsePointer()

  return (
    <>
      {menu && menuReady ? (
        <ContextMenu
          menu={menu}
          onClose={closeMenu}
          onOpenDetail={txn => { onOpenDetail?.(txn); closeMenu() }}
          onShowSourceDetail={coarsePointer ? txn => { setSourceDetailTarget(txn); closeMenu() } : undefined}
          onEditNote={txn => { setNoteTarget(txn); closeMenu() }}
          onEditTags={txn => { setTagTarget(txn); closeMenu() }}
          onMarkReviewed={txn => { markReviewed(txn); closeMenu() }}
          onTrash={txn => { setPendingTrash(txn); closeMenu() }}
          onOpenRule={openRuleFromMenu}
          onOpenSplit={categories?.length ? txn => { openSplitFromMenu(txn); closeMenu() } : undefined}
          onMarkRecurring={markRecurringFromMenu}
          onRemoveFromRecurring={txn => { removeFromRecurring(txn); closeMenu() }}
          onRestoreRecurring={restoreToRecurring}
          ruleActionLabel={ruleActionLabel}
        />
      ) : null}
      {/* Menu-driven note / tag editors render as centered overlays above the floating-panel stack
        (zIndex 1000 clears the 401+ detail panels these lists also live inside; data-modal-overlay
        lets an underlying panel yield Escape to them). The inline note/tag affordances in
        TransactionMarkersCell stay the primary entry point; this mirrors them for the menu path. */}
      {noteTarget ? (
        <MenuEditorOverlay onClose={() => setNoteTarget(null)}>
          <NotePopover
            txn={noteTarget}
            positioning="relative"
            onSave={handleNoteSave}
            onClose={() => setNoteTarget(null)}
          />
        </MenuEditorOverlay>
      ) : null}
      {tagTarget ? (
        <MenuEditorOverlay onClose={() => setTagTarget(null)}>
          <TagPickerWithCreate
            allTags={tagModalAllTags}
            selectedTagIds={new Set((tagTarget.tags || []).map(t => t.id))}
            inheritedTagIds={new Set(
              (tagTarget.tags || [])
                .filter(t => t.source && t.source !== 'direct')
                .map(t => t.id),
            )}
            blockedTagIds={new Set((tagTarget.blocked_tags || []).map(t => t.id))}
            loading={tagsLoading}
            positioning="relative"
            onToggleTag={toggleTagFromModal}
            onTagCreated={addTagToCache}
            onClose={() => setTagTarget(null)}
          />
        </MenuEditorOverlay>
      ) : null}
      {sourceDetailTarget ? (
        <SourceDetailOverlay txn={sourceDetailTarget} onClose={() => setSourceDetailTarget(null)} />
      ) : null}
      {pendingTrash ? (
        <AppConfirmDialog
          title="Send transaction to trash?"
          description={`Send "${getTxnMerchantLabel(pendingTrash)}" (${formatDate(pendingTrash.date)}) to the trash? You can restore it later from Settings → Trash.`}
          confirmLabel="Send to trash"
          confirmVariant="danger"
          borderColor="color-mix(in srgb, var(--danger) 35%, var(--border))"
          onConfirm={confirmTrash}
          onCancel={() => setPendingTrash(null)}
          width="min(520px, 100%)"
        />
      ) : null}
      {ruleModalState ? (
        <RuleActionModal
          state={ruleModalState}
          onClose={() => setRuleModalState(null)}
          onSaved={info => { setRuleModalState(null); onRuleSaved?.(info) }}
        />
      ) : null}
      {recurringUndo ? (
        <UndoToast
          title="Removed from recurring series"
          description={recurringUndo.seriesName
            ? `“${recurringUndo.seriesName}” won't count this transaction. It stays out across future scans.`
            : "This transaction won't count toward the series across future scans."}
          onUndo={undoRemoveFromRecurring}
          onDismiss={() => setRecurringUndo(null)}
        />
      ) : null}
      {reviewUndo ? (
        // Keyed on the row so each new review restarts the countdown rather than inheriting the last.
        <UndoToast
          key={reviewUndo.txnId}
          title="Marked reviewed"
          description={`“${reviewUndo.label}” no longer needs review.`}
          onUndo={undoMarkReviewed}
          onDismiss={closeReviewUndo}
        />
      ) : null}
      {actionError ? (
        <AppNoticeDialog
          title={actionError.title}
          description={actionError.description}
          onClose={() => setActionError(null)}
        />
      ) : null}
      {splitTarget ? (
        <SplitEditorDialog
          txn={splitTarget}
          categories={categories}
          onAddCategory={onAddCategory}
          onClose={() => setSplitTarget(null)}
          onSaved={result => handleSplitSaved(splitTarget.id, result)}
        />
      ) : null}
    </>
  )
}
