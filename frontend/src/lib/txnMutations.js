// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

/*
 * Transaction mutation layer.
 *
 * Every write that can change a transaction's categorization or trashed state — and therefore the
 * derived counts the app shows (today the Tasks "uncategorized" badge; more views over time) —
 * goes through here instead of calling the matching `api.*` method directly. Centralizing the
 * write means callers express intent ("set this category") and stay ignorant of what is now
 * stale; `notifyTransactionsChanged` below is the single place that decides what to invalidate.
 *
 * Callers still own their own optimistic UI updates (reconciling their local row list). This layer
 * only handles the cross-cutting invalidation that an individual page can't see. The dispatch used
 * to live at each call site and was repeatedly forgotten — categorizing from the dashboard, an
 * account panel, or a detail drawer all left the Tasks badge stale — which is the whole reason it
 * moved down here. An eslint `no-restricted-properties` rule forbids calling the wrapped `api`
 * methods directly outside this module so the notification can't be skipped again.
 */

import { api } from './api.js'
import { refreshTaskBadge } from '../App.jsx'

// The single invalidation seam. As more derived views gain event subscriptions (dashboard totals,
// the Categories page's uncategorized counts, reports), add their refreshes here — callers never
// need to know which views a given mutation affects.
function notifyTransactionsChanged() {
  refreshTaskBadge()
}

export const txnMutations = {
  async setCategory(txnId, categoryId, notes) {
    const result = await api.overrideCategory(txnId, categoryId, notes)
    notifyTransactionsChanged()
    return result
  },

  async uncategorize(txnId) {
    const result = await api.clearOverride(txnId)
    notifyTransactionsChanged()
    return result
  },

  async applyRule(ruleId) {
    const result = await api.applyRule(ruleId)
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
