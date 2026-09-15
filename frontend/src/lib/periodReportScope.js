// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * The transaction-list filter behind a Dashboard period report (PeriodDetail): a date range, the frame
 * (`view`), the page's filters, and optionally one slice of the breakdown the report was opened from —
 * `scope` is `{ kind: 'category' | 'group', id, name }`. Kept out of the component so the one rule that
 * is easy to get wrong here is stated, and tested, in one place.
 *
 * That rule: the scope *replaces* a category or group include filter of the same kind rather than
 * joining it. Both facets are single comma-separated params, so joining would mean an OR (widening the
 * report past the slice) and appending a second param is not something the endpoint reads. Replacing is
 * exact for every report that can be opened: a slice only has a figure if it survived the page's include
 * filter, so the filter intersected with the slice *is* the slice. Exclusions and every other facet ride
 * along untouched and still AND.
 */

function scopeParams(scope) {
  if (!scope?.id) return {}
  return scope.kind === 'group' ? { group_ids: scope.id } : { category_ids: scope.id }
}

export function periodReportParams({ start, end, view, accountId, tagIds, ownerIds, filters = {}, scope = null }) {
  return {
    date_start: start,
    date_end: end,
    ...(accountId ? { account_id: accountId } : {}),
    ...(tagIds ? { tag_ids: tagIds } : {}),
    ...(ownerIds ? { owner_ids: ownerIds } : {}),
    ...filters,
    ...scopeParams(scope),
    ...(view ? { view } : {}),
  }
}

// One open report per range + frame + slice: reopening the same one brings it forward instead of
// stacking a duplicate, while the same month opened for the whole frame and for one group are two.
export function periodReportKey({ start, end, view, scope = null }) {
  const slice = scope?.id ? `::${scope.kind}:${scope.id}` : ''
  return `${start}::${end}::${view || 'spending'}${slice}`
}
