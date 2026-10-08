// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * How much history the Dashboard's multi-period charts draw — the single-period Trend card, the Trends
 * report's Annual totals chart, and the cash-flow frame's Yearly trend. All three used to run back to
 * the first transaction in the ledger, which is both unreadable at twenty years of bars and the wrong
 * denominator for someone asking what a typical recent year looks like.
 *
 * **This is a span, not a period.** The date filter picks the slice being reported on; this picks how
 * far back the charts *around* that slice reach. They are independent: a selection older than the span
 * still appears on the single-period trend, because a chart that cannot show the period it is captioned
 * with is broken (`calendarTrendBuckets` widens to the selection, which is what implements that).
 *
 * **One setting across the three charts**, persisted under `TREND_SPAN_PREF_KEY`: "how much history do
 * I want to look at" is one answer, and three charts that each remembered their own would let the
 * reports disagree about what "average" covers.
 *
 * **The span resolves to a floor month, counted in whole buckets of the grain being drawn.** "Last 3
 * years" is the 3 most recent years, the 12 most recent quarters or the 36 most recent months — the same
 * stretch of history in each case, and no partial bucket at the old end. Counting in months and letting
 * the chart snap outwards instead draws four year-bars for a three-year span, three of them whole years
 * and one of them most of a year that was not asked for.
 *
 * A `since:` month is exact and so cannot be whole-bucket: the bucket containing it is drawn, whole. A
 * floor is a floor and never a filter on the figures, so that is safe — every average divides by the
 * days the rows actually span (`periodAverage.js`), and a boundary bucket counts as the days it holds.
 *
 * **"Last N years" is anchored on the data's last month, not on today.** They coincide for a ledger in
 * use, and they differ exactly where anchoring on today would be useless: a ledger that stops in 2020
 * would answer "Last 5 years" with an empty chart. This is the same choice `resolveTrendsWindowKey`
 * makes for the Trends window.
 */

import { monthLabel } from './utils.js'
import { shiftMonth } from './trendBuckets.js'

export const TREND_SPAN_PREF_KEY = 'ui.dashboard.trendSpan'

export const TREND_SPAN_ALL = 'all'
export const TREND_SPAN_SINCE_PREFIX = 'since:'

// The chooser's fixed entries. Anything between them is expressible as a `since:` month, which the
// chooser spells out in its own fields rather than as an entry here.
export const TREND_SPAN_PRESET_OPTIONS = [
  { value: TREND_SPAN_ALL, label: 'All data' },
  ...[3, 5, 10].map(years => ({ value: `${years}y`, label: `Last ${years} years` })),
]

const YEARS_PATTERN = /^(\d{1,2})y$/
const SINCE_PATTERN = /^since:(\d{4}-(?:0[1-9]|1[0-2]))$/

export function trendSpanSince(month) {
  return `${TREND_SPAN_SINCE_PREFIX}${month}`
}

/*
 * A stored value as its meaning: `{ kind: 'all' }`, `{ kind: 'years', years }` or
 * `{ kind: 'since', month }`. Anything unrecognised — a value from a newer build, a hand-edited
 * preference — reads as all data, so a bad setting shows too much rather than nothing.
 */
export function parseTrendSpan(value) {
  const raw = typeof value === 'string' ? value.trim() : ''
  const years = YEARS_PATTERN.exec(raw)
  if (years) {
    const count = Number(years[1])
    if (count >= 1) return { kind: 'years', years: count }
  }
  const since = SINCE_PATTERN.exec(raw)
  if (since) return { kind: 'since', month: since[1] }
  return { kind: 'all' }
}

// Bucket widths in months, by the grain names the trend charts use. Same-span buckets have no fixed
// width, so that mode counts its history in plain months.
const GRAIN_MONTHS = { month: 1, quarter: 3, year: 12 }

// The first month of the `size`-month bucket containing `month`, on the calendar boundaries the charts
// snap their buckets to (quarters from January, years from January).
function bucketStart(month, size) {
  const [year, index] = month.split('-').map(Number)
  const aligned = index - ((index - 1) % size)
  return `${year}-${String(aligned).padStart(2, '0')}`
}

/*
 * The earliest month a chart should draw, or `null` for all data. `anchorMonth` is the last month the
 * chart has data for, and `grain` the bucket the chart draws — a span of N years is N*12 months of
 * whole buckets of that grain, so the oldest bar is never a fragment of a period nobody asked for.
 *
 * A span of N years with no anchor has nothing to count back from and so means all data rather than a
 * guess.
 */
export function trendSpanFloorMonth(value, anchorMonth, grain = 'month') {
  const span = parseTrendSpan(value)
  if (span.kind === 'since') return span.month
  if (span.kind !== 'years' || !anchorMonth) return null
  const size = GRAIN_MONTHS[grain] || 1
  const buckets = Math.max(1, Math.round((span.years * 12) / size))
  return shiftMonth(bucketStart(anchorMonth, size), -(buckets - 1) * size)
}

// The floor for a whole-year chart, as a year: N calendar years counted back from the anchor's year, or
// the year a `since:` month falls in — that year's bar is drawn whole either way.
export function trendSpanFloorYear(value, anchorMonth) {
  const floor = trendSpanFloorMonth(value, anchorMonth, 'year')
  return floor ? floor.slice(0, 4) : null
}

// The same value as a phrase for a chart's subtitle, which already names what is being totalled.
export function describeTrendSpan(value) {
  const span = parseTrendSpan(value)
  if (span.kind === 'years') return `across the last ${span.years} years`
  if (span.kind === 'since') return `since ${monthLabel(span.month)}`
  return 'across all data'
}
