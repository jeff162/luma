// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * The transaction-list filter behind a Dashboard period report (PeriodDetail): a date range, the frame
 * (`view`), the page's filters, and optionally one slice of the breakdown the report was opened from —
 * `scope` is `{ kind: 'category' | 'group', id, name }`.
 *
 * The slice travels in the list feed's scope params (`category_id`, `group_id`), never in the filter's
 * `category_ids` / `group_ids`: those two OR with each other as one facet, so a slice folded into them
 * would widen the report past the slice. A scope param ANDs with the whole filter, which is exactly the
 * rows behind the slice's figure.
 */

function scopeParams(scope) {
  if (!scope?.id) return {}
  return scope.kind === 'group' ? { group_id: scope.id } : { category_id: scope.id }
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
