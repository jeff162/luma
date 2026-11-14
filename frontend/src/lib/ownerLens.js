// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * The owner lens: a per-user view filter that narrows the scoped pages to the owners a user calls "Mine"
 * (`docs/data-model.md` → *Owner lens*). It is a lens and not a permission: anyone can switch it off,
 * and it never changes what a write does.
 *
 * Two halves read it. A paged or aggregated transaction read sends it to the server as `owner_lens`,
 * which ANDs with the FilterBar's owner chip (`services/transaction_facets.py`). A list the page holds
 * whole (accounts, rules, recurring series) is filtered here by `ownerLensAdmits`, against the owners each
 * item reaches. The two agree on one rule: an item shows when it reaches a lens owner, and an item that
 * reaches no one yet (an empty series, a rule matching nothing) shows to everyone.
 */

// The owner facet's bucket for rows with no owner, as the server spells it.
export const UNASSIGNED_OWNER_ID = 'unassigned'

// The pages the lens narrows. Categories, imports and settings are not scoped by owner, so the control is
// not shown there and a report opened there is not narrowed.
export const OWNER_LENS_ROUTES = ['/', '/transactions', '/accounts', '/rules', '/recurring', '/tasks']

export const OWNER_LENS_PREF_KEY = 'ui.ownerLens'
// `ownerIds` null is "never chosen", which starts with Unassigned ticked.
export const DEFAULT_OWNER_LENS = { on: false, ownerIds: null }

/** The stored choice, kept to owners that still exist (and Unassigned). */
export function lensOwnerIds(stored, owners) {
  const chosen = Array.isArray(stored?.ownerIds) ? stored.ownerIds : [UNASSIGNED_OWNER_ID]
  const known = new Set([UNASSIGNED_OWNER_ID, ...owners.map(owner => owner.id)])
  return chosen.filter(id => known.has(id))
}

/**
 * The owner ids the lens narrows to, or null when it narrows nothing. Mine needs a real owner: Unassigned
 * on its own is never what someone means by their own view, so until one is ticked the lens stays open.
 */
export function effectiveLens({ on, ownerIds }) {
  if (!on || !ownerIds.some(id => id !== UNASSIGNED_OWNER_ID)) return null
  return ownerIds
}

/** Whether an item reaching these owners shows under the lens. */
export function ownerLensAdmits(itemOwnerIds, lens) {
  if (!lens || !itemOwnerIds || itemOwnerIds.length === 0) return true
  return itemOwnerIds.some(id => lens.includes(id))
}

/** One owner reference (`null` for none) as the id the lens compares. */
export function ownerKey(ownerId) {
  return ownerId || UNASSIGNED_OWNER_ID
}
