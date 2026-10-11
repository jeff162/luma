// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * When the Transactions ledger comes back empty, decide whether a *subtractive* filter (the date
 * window or an exclude chip) is what's hiding the user's matches — as opposed to there genuinely being
 * nothing. The honest answer needs the server: we re-run the same query with one constraint dropped
 * and see if rows appear. This module plans those probes (which constraints to drop, in what order);
 * the page runs them lazily, only on the zero-results path, so there's no cost on the normal path.
 *
 * Two rules keep the note truthful rather than noisy:
 *  - A probe *keeps* the search text and every include facet and drops only subtractive constraints,
 *    so a non-empty probe means "things matching what you actually asked for exist outside the filter."
 *  - We only probe when there's a narrowing intent to preserve (a search, an include facet, or the
 *    needs-review toggle). With only date/excludes active and no intent, dropping them just surfaces
 *    unrelated transactions — technically "hidden," but not a useful thing to say.
 */

import { FILTER_FACETS } from './filterParams.js'

export const DATE_KEYS = ['date_start', 'date_end']

// Both lists come from the facet registry rather than restating it, so a facet added there is probed
// here. Restated, they had missed the attribute filter: an excluded attribute hiding every match was
// never named as the cause.
export const EXCLUDE_KEYS = FILTER_FACETS.map(facet => facet.exclude)

// Include/intent facets — the narrowing signal a probe preserves. `quick_filter` and `needs_review`
// are handled separately (a string and a boolean); these are the id-list includes, plus the list
// feed's singular `category_id`.
export const INCLUDE_KEYS = [...FILTER_FACETS.map(facet => facet.include), 'category_id']

// The ledger's amount popover (magnitude bounds + debit/credit side via `direction`) and the recurring
// filter are narrowing intents too — like an include facet, an amount/recurring filter that yields
// nothing is genuine emptiness, so they count toward "intent to preserve" but are never *dropped* by a
// probe (only the subtractive date/exclude constraints are).
export const INTENT_FLAG_KEYS = ['amount_min', 'amount_max', 'direction', 'recurring_only']

const has = (params, keys) => keys.some(k => params[k] != null && params[k] !== '')

function without(params, keys) {
  const next = { ...params }
  for (const k of keys) delete next[k]
  return next
}

// Returns an ordered list of `{ cause, params }` probes to run against the transactions endpoint.
// First non-empty probe wins; an empty list means "don't bother" (nothing subtractive is active, or
// there's no narrowing intent to attribute the hiding to).
export function planHidingProbes(params = {}) {
  const hasDate = has(params, DATE_KEYS)
  const hasExclude = has(params, EXCLUDE_KEYS)
  if (!hasDate && !hasExclude) return []

  const hasIntent = !!params.quick_filter || !!params.needs_review
    || has(params, INCLUDE_KEYS) || has(params, INTENT_FLAG_KEYS)
  if (!hasIntent) return []

  const probes = []
  if (hasDate) probes.push({ cause: 'date', params: without(params, DATE_KEYS) })
  if (hasExclude) probes.push({ cause: 'exclude', params: without(params, EXCLUDE_KEYS) })
  // When both are active, a final probe drops both — so a combination that only hides together (neither
  // single drop is enough) still gets a generic note instead of a false silence.
  if (hasDate && hasExclude) probes.push({ cause: 'filters', params: without(params, [...DATE_KEYS, ...EXCLUDE_KEYS]) })
  return probes
}

export function hidingNoteText(cause) {
  switch (cause) {
    case 'date':
      return 'The date filter is hiding transactions that match'
    case 'exclude':
      return 'An exclusion filter (≠) is hiding transactions that match'
    case 'filters':
      return 'Your active filters are hiding transactions that match'
    default:
      return null
  }
}

export function hidingActionLabel(cause) {
  switch (cause) {
    case 'date': return 'Clear date filter'
    case 'exclude': return 'Clear exclusions'
    case 'filters': return 'Clear filters'
    default: return null
  }
}
