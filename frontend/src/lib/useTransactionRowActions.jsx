// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

/* eslint-disable react-refresh/only-export-components -- the controller hook and its companion chrome component are one cohesive unit by design */

/*
 * Shared controller for a transaction list's right-click row menu and the editors it launches
 * (edit · create/open rule · note · tags · send to trash). Both the Transactions ledger (which
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
 */

import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from './api.js'
import { txnMutations } from './txnMutations.js'
import { useContextMenu, ContextMenu, NotePopover, getTxnMerchantLabel } from '../components/TransactionRow.jsx'
import TagPickerWithCreate from '../components/TagPickerWithCreate.jsx'
import RuleActionModal from '../components/RuleActionModal.jsx'
import { AppConfirmDialog } from '../components/ui.jsx'

export function useTransactionRowActions({ onOpenDetail, reconcileRow, removeRow, onRuleSaved } = {}) {
  const { menu, onContextMenu, close: closeMenu } = useContextMenu()
  const navigate = useNavigate()
  const [noteTarget, setNoteTarget] = useState(null)
  const [tagTarget, setTagTarget] = useState(null)
  const [pendingTrash, setPendingTrash] = useState(null)
  // null sentinel = tags not fetched yet; fetched lazily when the tag modal first opens.
  const [tagModalAllTags, setTagModalAllTags] = useState(null)
  const [contextRuleMatch, setContextRuleMatch] = useState({ txnId: null, loading: false, ruleId: null })
  const [ruleModalState, setRuleModalState] = useState(null)

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

  useEffect(() => {
    if (!tagTarget || tagModalAllTags !== null) return undefined
    let cancelled = false
    api.getTags()
      .then(tags => { if (!cancelled) setTagModalAllTags(Array.isArray(tags) ? tags : []) })
      .catch(() => { if (!cancelled) setTagModalAllTags([]) })
    return () => { cancelled = true }
  }, [tagTarget, tagModalAllTags])

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
    const result = await api.updateTransactionTag(targetId, tag.id, present)
    reconcileRow?.(targetId, { tags: result.tags || [] })
    setTagTarget(prev => (prev && prev.id === targetId ? { ...prev, tags: result.tags || [] } : prev))
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
      console.error('Failed to send transaction to trash', err)
    }
  }

  async function markReviewed(target) {
    if (!target) return
    try {
      await txnMutations.markReviewed(target.id)
      // The row lingers in place (per the linger pattern); patching the flag clears its marker.
      reconcileRow?.(target.id, { needs_review: 0 })
    } catch (err) {
      console.error('Failed to mark transaction reviewed', err)
    }
  }

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
    try {
      await api.setRecurringMembership(txn.recurring_series_id, txn.id, 'excluded')
      // The row lingers; clearing the membership fields drops its ↻ marker.
      reconcileRow?.(txn.id, { recurring_series_id: null, recurring_series_name: null, recurring_rule_id: null })
    } catch (err) {
      console.error('Failed to remove transaction from recurring series', err)
    }
  }

  const ruleActionLabel = contextRuleMatch.loading
    ? '⚙ Loading rule…'
    : contextRuleMatch.ruleId
      ? '⚙ Open matching rule'
      : '⚙ Create rule'

  return {
    onContextMenu,
    closeMenu,
    menu,
    noteTarget,
    setNoteTarget,
    tagTarget,
    setTagTarget,
    pendingTrash,
    setPendingTrash,
    tagModalAllTags,
    setTagModalAllTags,
    ruleModalState,
    setRuleModalState,
    ruleActionLabel,
    openRuleFromMenu,
    markRecurringFromMenu,
    removeFromRecurring,
    handleNoteSave,
    toggleTagFromModal,
    confirmTrash,
    markReviewed,
    onOpenDetail,
    onRuleSaved,
  }
}

export function TransactionRowActionsChrome({ controller }) {
  const {
    menu, closeMenu, onOpenDetail,
    setNoteTarget, setTagTarget, setPendingTrash,
    noteTarget, tagTarget, pendingTrash,
    tagModalAllTags, setTagModalAllTags,
    ruleModalState, setRuleModalState,
    ruleActionLabel, openRuleFromMenu, markRecurringFromMenu, removeFromRecurring,
    handleNoteSave, toggleTagFromModal, confirmTrash, markReviewed,
    onRuleSaved,
  } = controller

  return (
    <>
      {menu ? (
        <ContextMenu
          menu={menu}
          onClose={closeMenu}
          onOpenDetail={txn => { onOpenDetail?.(txn); closeMenu() }}
          onEditNote={txn => { setNoteTarget(txn); closeMenu() }}
          onEditTags={txn => { setTagTarget(txn); closeMenu() }}
          onMarkReviewed={txn => { markReviewed(txn); closeMenu() }}
          onTrash={txn => { setPendingTrash(txn); closeMenu() }}
          onOpenRule={openRuleFromMenu}
          onMarkRecurring={markRecurringFromMenu}
          onRemoveFromRecurring={txn => { removeFromRecurring(txn); closeMenu() }}
          ruleActionLabel={ruleActionLabel}
        />
      ) : null}
      {/* Menu-driven note / tag editors render as centered overlays above the floating-panel stack
        (zIndex 1000 clears the 401+ detail panels these lists also live inside; data-modal-overlay
        lets an underlying panel yield Escape to them). The inline note/tag affordances in
        TransactionAmountCell stay the primary entry point; this mirrors them for the menu path. */}
      {noteTarget ? (
        <div
          data-modal-overlay=""
          style={{
            position: 'fixed', inset: 0, zIndex: 1000,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(0,0,0,0.3)',
          }}
          onClick={() => setNoteTarget(null)}
        >
          <div onClick={e => e.stopPropagation()}>
            <NotePopover
              txn={noteTarget}
              positioning="relative"
              onSave={handleNoteSave}
              onClose={() => setNoteTarget(null)}
            />
          </div>
        </div>
      ) : null}
      {tagTarget ? (
        <div
          data-modal-overlay=""
          style={{
            position: 'fixed', inset: 0, zIndex: 1000,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(0,0,0,0.3)',
          }}
          onClick={() => setTagTarget(null)}
        >
          <div onClick={e => e.stopPropagation()}>
            <TagPickerWithCreate
              allTags={tagModalAllTags || []}
              selectedTagIds={new Set((tagTarget.tags || []).map(t => t.id))}
              inheritedTagIds={new Set(
                (tagTarget.tags || [])
                  .filter(t => t.source && t.source !== 'direct')
                  .map(t => t.id),
              )}
              loading={tagModalAllTags === null}
              positioning="relative"
              onToggleTag={toggleTagFromModal}
              onTagCreated={tag => setTagModalAllTags(prev => (prev || []).some(t => t.id === tag.id) ? prev : [...(prev || []), tag])}
              onClose={() => setTagTarget(null)}
            />
          </div>
        </div>
      ) : null}
      {pendingTrash ? (
        <AppConfirmDialog
          title="Send transaction to trash?"
          description={`Send "${getTxnMerchantLabel(pendingTrash)}" (${pendingTrash.date}) to the trash? You can restore it later from Settings → Trash.`}
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
    </>
  )
}
