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

  // Attach or detach one tag on one transaction (`present: false` on an inherited tag writes the
  // per-transaction block — see data-model.md). A tag is a reporting dimension, so this moves the
  // dashboard's tag-report buckets and, whenever a tag filter is active, every other aggregate on the
  // page as well. Answers with the row's resolved tags + blocks, which callers patch onto their row.
  async setTag(txnId, tagId, present) {
    const result = await api.updateTransactionTag(txnId, tagId, present)
    notifyTransactionsChanged()
    return result
  },

  // The bulk write behind every transaction list's bulk-edit bar. Its actions span categorization,
  // tags, review state and trash, so it invalidates at least as much as the single-row writes above.
  async bulkUpdate(selection, actions) {
    const result = await api.bulkUpdateTransactions(selection, actions)
    notifyTransactionsChanged()
    return result
  },

  async applyRule(ruleId, options) {
    const result = await api.applyRule(ruleId, options)
    notifyTransactionsChanged()
    return result
  },

  // A rule edit re-derives transactions when it changes the rule's priority or asks to reconcile, so it
  // invalidates like an apply.
  async updateRule(ruleId, data, options) {
    const result = await api.updateRule(ruleId, data, options)
    notifyTransactionsChanged()
    return result
  },

  // A delete with `reconcile` re-derives the transactions the rule categorized.
  async deleteRule(ruleId, options) {
    const result = await api.deleteRule(ruleId, options)
    notifyTransactionsChanged()
    return result
  },

  // Move one of a rule's amount bounds out to a charge and re-apply the rule, as one request.
  async widenRuleRange(ruleId, bound, amount) {
    const result = await api.widenRuleRange(ruleId, bound, amount)
    notifyTransactionsChanged()
    return result
  },

  // The Generate Rules review actions: each is one transaction that may claim, settle or restore rows, and
  // each answers with an `undo` payload that undoRuleSuggestionAction reverses.
  async acceptRuleSuggestions(scope, items) {
    const result = await api.acceptRuleSuggestions(scope, items)
    notifyTransactionsChanged()
    return result
  },

  async setRuleSuggestionStatus(scope, items, status, options) {
    const result = await api.setRuleSuggestionStatus(scope, items, status, options)
    notifyTransactionsChanged()
    return result
  },

  async resolveRuleSuggestionConflictSet(scope, members, winnerId) {
    const result = await api.resolveRuleSuggestionConflictSet(scope, members, winnerId)
    notifyTransactionsChanged()
    return result
  },

  async applyRuleSuggestionRules(scope, ruleIds) {
    const result = await api.applyRuleSuggestionRules(scope, ruleIds)
    notifyTransactionsChanged()
    return result
  },

  async undoRuleSuggestionAction(scope, undo) {
    const result = await api.undoRuleSuggestionAction(scope, undo)
    notifyTransactionsChanged()
    return result
  },

  // Clear the needs-review flag on a single row. Reuses the bulk endpoint (there is no per-row
  // review endpoint) with a one-id selection.
  async markReviewed(txnId) {
    return txnMutations.bulkUpdate({ mode: 'ids', ids: [txnId] }, [{ type: 'mark_reviewed' }])
  },

  // Flag a single row as needing review again — the undo behind "Marked reviewed". Same bulk endpoint,
  // through its `set_review_status` action.
  async markNeedsReview(txnId) {
    return txnMutations.bulkUpdate(
      { mode: 'ids', ids: [txnId] },
      [{ type: 'set_review_status', needs_review: true }],
    )
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

  async createTransaction(body) {
    const result = await api.createTransaction(body)
    notifyTransactionsChanged()
    return result
  },

  // A split moves the row's money between categories, so every category total it touches moves too.
  async saveSplit(txnId, parts) {
    const result = await api.saveSplit(txnId, parts)
    notifyTransactionsChanged()
    return result
  },

  async deleteSplit(txnId) {
    const result = await api.deleteSplit(txnId)
    notifyTransactionsChanged()
    return result
  },

  // An amount is a rule condition, so the server re-runs the rules and may move the row's category too.
  async updateAmount(txnId, amount) {
    const result = await api.updateAmount(txnId, amount)
    notifyTransactionsChanged()
    return result
  },

  // Completing settles a residual by rewriting a member's allocations, and reopening restores them. The
  // other reimbursement writes change only the link's claims, which no aggregate reads.
  async completeReimbursement(linkId, body) {
    const result = await api.completeReimbursement(linkId, body)
    notifyTransactionsChanged()
    return result
  },

  async reopenReimbursement(linkId) {
    const result = await api.reopenReimbursement(linkId)
    notifyTransactionsChanged()
    return result
  },
}

// Build the in-place row patch for an inline single-row category edit, so every categorize surface
// (the ledger, the detail panels, the dashboard drills, the import-batch report, …) reconciles the
// edited row identically instead of each hand-rolling the same object. `cat` is the resolved category
// object being assigned, or null/undefined for the picker's "Uncategorized" clear. Assigning a category
// clears `needs_review` to mirror the backend: a manual `override_category` sets `needs_review = 0`
// (a hand edit counts as reviewing the row), so the amber `R` marker must drop from the row in place
// rather than lingering until a Refresh. Clearing to uncategorized is NOT a review on the backend
// (`clearOverride` leaves `needs_review` untouched), so the flag is left as-is in that case.
export function categoryReconcilePatch(cat, resolved = null) {
  return {
    category_id: cat?.id ?? null,
    category_name: cat?.name ?? null,
    category_color: null,
    category_overridden: 1,
    ...(cat ? { needs_review: 0 } : {}),
    // Tags are inherited from the category (and its group), so changing the category changes them — but
    // only the server can say to what, since resolution also spans the account and this row's own
    // blocks. They come from the write's own response; without it the row keeps the *previous*
    // category's inherited tags and nothing on the page refetches to correct that.
    ...(Array.isArray(resolved?.tags)
      ? { tags: resolved.tags, blocked_tags: resolved.blocked_tags ?? [] }
      : {}),
  }
}

/*
 * The two-phase reconcile a category change needs, in one call so no surface can implement half of it.
 *
 * Phase one paints the caller's optimistic patch — the picker has to feel immediate, and the category
 * itself is known client-side. Phase two applies the same patch again once the write answers, this time
 * carrying the tags the server resolved for the new category. `applyPatch(patch, id)` merges a patch into
 * the row with that id; it is called twice for the edited row (both phases carry the category, so a
 * caller that only handles one still shows the right category), and once more for each row the write
 * moved as well — a refund follows the category of the payment it returns (services/refund_links.py),
 * and the write names those rows so they are refetched rather than left showing the old category. A
 * surface not showing one simply matches nothing. `write` names the mutation, since "clear the override"
 * and "set the category to nothing" are different intents that answer the same way.
 */
export async function applyCategoryChange(txnId, cat, applyPatch, write = null) {
  applyPatch(categoryReconcilePatch(cat), txnId)
  const resolved = await (write ? write() : txnMutations.setCategory(txnId, cat?.id ?? null))
  applyPatch(categoryReconcilePatch(cat, resolved), txnId)
  const followedIds = resolved?.followed_ids || []
  if (followedIds.length) {
    const resp = await api.getTransactions({ ids: followedIds.join(','), limit: followedIds.length })
    for (const row of resp?.transactions || []) applyPatch(row, row.id)
  }
  return resolved
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
