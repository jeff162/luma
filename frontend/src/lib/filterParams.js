// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * Turning the FilterBar's chip row into API parameters — once, for every page that reads it.
 *
 * `FilterContext.selections` is the only place a chip lives, so it was always the single source of
 * truth; what was duplicated was the *translation*. Three pages each wrote their own version of the
 * same function (`ofType` on Transactions, `incSel`/`excSel` on the Dashboard, `idsOf` on the export
 * tab), which meant a new facet had to be threaded into three places and the copies could disagree
 * about what a chip means. They had already drifted in their comments, all three of which claimed tags
 * were include-only long after "is not" shipped for them.
 *
 * So the facet table below is the frontend counterpart of `services/transaction_facets.py`: the two
 * describe the same axes, and adding one means a row in each. Everything else — splitting a selection
 * by mode, choosing which field carries the value, joining with the right separator — follows from the
 * table rather than from what a given page remembered to do.
 *
 * **Splitting by mode is the part that must not be skipped.** A chip carries `mode: 'include' |
 * 'exclude'`, and feeding an exclude selection into an include parameter does not narrow differently —
 * it inverts the user's meaning. That is why the split happens here rather than at each call site.
 */

// Payee is the one facet keyed by label rather than id (the chips are canonicalized merchant names) and
// the one joined with `|`, because a payee name may legitimately contain a comma.
export const FILTER_FACETS = [
  { type: 'account',  include: 'account_ids',  exclude: 'exclude_account_ids' },
  // Every account of a type. The backend ORs it with `account_ids`, so "credit cards plus this checking
  // account" is one selection; the type value travels in its own field because the id must stay unique
  // among all chips.
  { type: 'account_type', include: 'account_types', exclude: 'exclude_account_types', valueKey: 'value' },
  { type: 'group',    include: 'group_ids',    exclude: 'exclude_group_ids' },
  { type: 'category', include: 'category_ids', exclude: 'exclude_category_ids' },
  { type: 'owner',    include: 'owner_ids',    exclude: 'exclude_owner_ids' },
  { type: 'payee',    include: 'payees',       exclude: 'exclude_payees', valueKey: 'label', sep: '|' },
  // The same axis named by a fragment of the payee name rather than by a whole one. The backend ORs it
  // with `payees`; the chip's label is a phrase, so the fragment travels in its own field.
  { type: 'payee_contains', include: 'payee_contains', exclude: 'exclude_payee_contains', valueKey: 'value', sep: '|' },
  { type: 'tag',      include: 'tag_ids',      exclude: 'exclude_tag_ids' },
  // What a row *is* rather than what it is filed under. Its values are the keys served by
  // `GET /transactions/filter-attributes`, not ids of anything stored.
  { type: 'attribute', include: 'attribute_ids', exclude: 'exclude_attribute_ids' },
]

/** The selections of one facet in one mode, as selection objects. */
export function selectionsOfType(selections, type, { exclude = false } = {}) {
  return (selections || []).filter(s => (
    s && s.type === type && (exclude ? s.mode === 'exclude' : s.mode !== 'exclude')
  ))
}

/**
 * The chip row as API parameters.
 *
 * Every facet yields its include parameter and its `exclude_*` mirror; an empty facet yields
 * `undefined` rather than an empty string, so a caller can spread the result straight into a request
 * without an unset filter arriving as a value the backend has to interpret.
 */
export function selectionsToParams(selections) {
  const params = {}
  for (const facet of FILTER_FACETS) {
    const key = facet.valueKey || 'id'
    const sep = facet.sep || ','
    for (const [param, exclude] of [[facet.include, false], [facet.exclude, true]]) {
      const values = selectionsOfType(selections, facet.type, { exclude }).map(s => s[key])
      params[param] = values.length ? values.join(sep) : undefined
    }
  }
  return params
}

/*
 * The FilterBar's amount filter: a debit/credit side and a magnitude range, shaped like the rule editor's
 * amount condition. It is one value beside the chips rather than a chip, and it reaches the same
 * endpoints the chips do (`AmountFilter` in `services/transaction_facets.py`).
 */
export const EMPTY_AMOUNT_FILTER = { low: null, lowOp: '>=', high: null, highOp: '<=', side: 'both' }

// A bare `both` with no bounds constrains nothing, so it is not worth carrying as a filter.
export function amountFilterIsActive(f) {
  return !!f && (f.low != null || f.high != null || (f.side && f.side !== 'both'))
}

// What to store: an active filter, or null.
export function normalizeAmountFilter(f) {
  return amountFilterIsActive(f) ? { ...EMPTY_AMOUNT_FILTER, ...f } : null
}

/** The amount filter as API parameters, `undefined` where unset, like `selectionsToParams`. */
export function amountFilterParams(f) {
  if (!f) return {}
  return {
    amount_min: f.low != null ? f.low : undefined,
    amount_max: f.high != null ? f.high : undefined,
    amount_min_op: f.low != null ? f.lowOp : undefined,
    amount_max_op: f.high != null ? f.highOp : undefined,
    direction: f.side && f.side !== 'both' ? f.side : undefined,
  }
}
