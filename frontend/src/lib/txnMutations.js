// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * Transaction mutation layer.
 *
 * Every write that can change a transaction's categorization or trashed state goes through here
 * instead of calling the matching `api.*` method directly. Centralizing the write means callers
 * express intent ("set this category") and stay ignorant of what is now stale;
 * `notifyTransactionsChanged` below is the single place that decides which transaction-derived
 * views to invalidate (today the dashboard's group/category totals; more over time).
 *
 * Callers still own their own optimistic UI updates (reconciling their local row list). This layer
 * only handles the cross-cutting invalidation that an individual page can't see. The dispatch used
 * to live at each call site and was repeatedly forgotten — categorizing from the dashboard, an
 * account panel, or a detail drawer all left derived views stale — which is the whole reason it
 * moved down here. An eslint `no-restricted-properties` rule forbids calling the wrapped `api`
 * methods directly outside this module so the notification can't be skipped again.
 *
 * The nav Tasks badge is NOT refreshed here: every successful mutation emits `luma:data-mutated`
 * from the api layer (see `signalDataMutated` in api.js), which the badge and Tasks page listen for.
 * That already covers transaction writes, so this seam only fans out the transaction-specific
 * `luma:transactions-changed` event for views the global signal doesn't serve.
 */

import { api } from './api.js'

// The single invalidation seam for transaction-derived views. As more such views gain event
// subscriptions (dashboard totals, the Categories page's uncategorized counts, reports), add their
// refreshes here — callers never need to know which views a given mutation affects.
function notifyTransactionsChanged() {
  // Broadcast so derived views (e.g. the dashboard's group/category totals) can refresh in place
  // without each call site having to know which aggregates a given edit invalidated. (The nav Tasks
  // badge refreshes separately via the api layer's `luma:data-mutated` signal.)
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('luma:transactions-changed'))
  }
}

export const txnMutations = {
  async setCategory(txnId, categoryId, notes) {
    const result = await api.overrideCategory(txnId, categoryId, notes)
    notifyTransactionsChanged()
    return result
  },

  // Re-pin an imported transaction as a corrected file categorization (keeps it driving suggestions),
  // vs setCategory which marks a manual exception. Used by the import rule-suggestions matches report.
  async setImportedCategory(txnId, categoryId) {
    const result = await api.setImportedCategory(txnId, categoryId)
    notifyTransactionsChanged()
    return result
  },

  async uncategorize(txnId) {
    const result = await api.clearOverride(txnId)
    notifyTransactionsChanged()
    return result
  },

  async applyRule(ruleId, options) {
    const result = await api.applyRule(ruleId, options)
    notifyTransactionsChanged()
    return result
  },

  // Apply a rule's outputs to the specific rows that generated an accepted import-rule suggestion.
  async applyRuleToTransactions(ruleId, transactionIds) {
    const result = await api.applyRuleToTransactions(ruleId, transactionIds)
    notifyTransactionsChanged()
    return result
  },

  // Settle the rows behind a rejected suggestion: 'keep' marks them manual (category kept, or set to
  // `categoryId` when given — the conflict screen's "keep as a different category"), 'clear' discards
  // the category to the `cleared` source. Both drop the import lock and spare manual edits. Returns
  // `{ updated, rows }` where `rows` is the prior state of the changed rows (for Undo).
  async setRejectedSuggestionDisposition(transactionIds, mode, categoryId = null) {
    const result = await api.setRejectedSuggestionDisposition(transactionIds, mode, categoryId)
    notifyTransactionsChanged()
    return result
  },

  // Undo a disposition: restore rows to the prior-state snapshot returned above.
  async restoreCategorization(rows) {
    const result = await api.restoreCategorization(rows)
    notifyTransactionsChanged()
    return result
  },

  // Clear the needs-review flag on a single row. Reuses the bulk endpoint (there is no per-row
  // review endpoint) with a one-id selection.
  async markReviewed(txnId) {
    const result = await api.bulkUpdateTransactions(
      { mode: 'ids', ids: [txnId] },
      [{ type: 'mark_reviewed' }],
    )
    notifyTransactionsChanged()
    return result
  },

  async trashTransaction(txnId) {
    const result = await api.trashTransaction(txnId)
    notifyTransactionsChanged()
    return result
  },

  async restoreTransaction(txnId) {
    const result = await api.restoreTransaction(txnId)
    notifyTransactionsChanged()
    return result
  },
}

// Reconcile an in-place transaction list after a rule was applied to existing rows. The rule's apply
// returns the ids it changed (`transaction_ids`); here we re-fetch *only the affected rows that are
// currently on screen* by id and merge them back in place. Replacing the scoped list query instead would
// drop the just-recategorized rows out of a view like "uncategorized only" — the user wants them to stay
// (with their new category) so the change is visible and a mis-tap is still correctable. No-ops when the
// rule touched nothing on screen.
export async function reconcileRowsAfterRuleApply(rows, affectedIds, setRows) {
  if (!affectedIds?.length || !rows?.length) return
  const present = new Set(rows.map(row => row.id))
  const onScreen = affectedIds.filter(id => present.has(id))
  if (!onScreen.length) return
  const resp = await api.getTransactions({ ids: onScreen.join(','), limit: onScreen.length })
  const fresh = new Map((resp?.transactions || []).map(row => [row.id, row]))
  setRows(prev => prev.map(row => fresh.get(row.id) ?? row))
}

// Build the reconcile callback a detail panel (TransactionDetail) hands its host: it receives one
// `(txnId, patch)` where `patch` is the changed fields to merge, or `null` when the row was trashed
// and should drop. Panels compute the patch (category/notes/tags/…) so a host wires one prop and
// stays ignorant of which fields exist — adding a new reconciled field never touches the host again.
// `onRemoved` lets a host that tracks a separate count decrement it on trash. Hosts whose rows live
// in nested state (e.g. `{ transactions, total }`) or that need edit-specific side effects pass their
// own `(txnId, patch)` function of the same shape instead of using this builder.
export function makeRowReconciler(setRows, { onRemoved } = {}) {
  return (txnId, patch) => {
    if (patch === null) {
      setRows(prev => prev.filter(row => row.id !== txnId))
      onRemoved?.(txnId)
      return
    }
    setRows(prev => prev.map(row => (row.id === txnId ? { ...row, ...patch } : row)))
  }
}
