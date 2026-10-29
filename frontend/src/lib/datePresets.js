// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * The FilterBar's named periods. A preset is relative: its range is worked out from today each time it
 * is applied, and the date filter carries the preset's label so a saved filter can name "Year to date"
 * and get this year's range whenever it is applied, rather than the range in force when it was saved.
 */

import { format, subDays, subMonths, subYears, startOfMonth, endOfMonth, startOfYear, endOfYear } from 'date-fns'

const fmt = d => format(d, 'yyyy-MM-dd')

export const DATE_PRESETS = [
  { label: 'Month to date',  range: now => ({ start: fmt(startOfMonth(now)), end: fmt(now) }) },
  { label: 'Last month',     range: now => ({ start: fmt(startOfMonth(subMonths(now, 1))), end: fmt(endOfMonth(subMonths(now, 1))) }) },
  { label: 'Year to date',   range: now => ({ start: fmt(startOfYear(now)), end: fmt(now) }) },
  { label: 'Last year',      range: now => ({ start: fmt(startOfYear(subYears(now, 1))), end: fmt(endOfYear(subYears(now, 1))) }) },
  { label: 'Past 12 months', range: now => ({ start: fmt(subYears(now, 1)), end: fmt(now) }) },
  { label: 'Last 30 days',   range: now => ({ start: fmt(subDays(now, 29)), end: fmt(now) }) },
  { label: 'Last 60 days',   range: now => ({ start: fmt(subDays(now, 59)), end: fmt(now) }) },
  { label: 'Last 90 days',   range: now => ({ start: fmt(subDays(now, 89)), end: fmt(now) }) },
  // Explicit all-time: a truthy value with no range, so it *overrides* a page's default period (unlike
  // "unset", which falls back to the default).
  { label: 'All time',       range: () => ({ start: null, end: null }) },
]

/** The date filter for a preset as of `now`, or null for a label that is not a preset. */
export function datePresetFilter(label, now = new Date()) {
  const preset = DATE_PRESETS.find(p => p.label === label)
  return preset ? { ...preset.range(now), preset: preset.label } : null
}
