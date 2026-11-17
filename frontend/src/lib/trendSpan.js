// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * How much history the Dashboard's multi-period charts draw — the single-period Trend card, the Trends
 * report's Annual totals chart, and the cash-flow frame's Yearly trend. All three used to run back to
 * the first transaction in the ledger, which is both unreadable at twenty years of bars and the wrong
 * denominator for someone asking what a typical recent year looks like.
 *
 * **This is a limit, not a period.** The page decides where a chart ends; the span only says how far
 * back from that end it reaches. The single-period trend ends at the selected period (or at the data's
 * last month when nothing is picked), the Trends report's annual chart at the year that report shows,
 * and the cash-flow yearly trend at the data's last month. Counting back from the chart's own end is
 * what keeps the span from ever disagreeing with the selection: a selection is never older than the
 * history counted back from it. A selection longer than the span is still drawn whole, because a chart
 * that cannot show the period it is captioned with is broken (`calendarTrendBuckets` widens to it).
 *
 * **One setting across the three charts**, persisted under `TREND_SPAN_PREF_KEY`: "how much history do
 * I want to look at" is one answer, and three charts that each remembered their own would let the
 * reports disagree about what "average" covers. The average is the reason it exists at all: it is what
 * bases a chart's average on a recent stretch rather than on all the data.
 *
 * **The span resolves to a floor month, counted in whole buckets of the grain being drawn.** "3 years"
 * is the 3 years, 12 quarters or 36 months ending at the chart's end — the same stretch of history in
 * each case, and no partial bucket at the old end. Counting in months and letting the chart snap
 * outwards instead draws four year-bars for a three-year span, three of them whole years and one of
 * them most of a year that was not asked for.
 *
 * The values are presets only. A stored value from an older build that named a start month reads as
 * all data, like any value this build does not recognise.
 */

import { monthLabel } from './utils.js'
import { shiftMonth } from './trendBuckets.js'

export const TREND_SPAN_PREF_KEY = 'ui.dashboard.trendSpan'

export const TREND_SPAN_ALL = 'all'

// "3 years" rather than "Last 3 years": the years are counted back from wherever the chart ends, which
// is the selected period on the single-period trend, not today.
const SPAN_YEARS = [3, 5, 10]
export const TREND_SPAN_PRESET_OPTIONS = [
  { value: TREND_SPAN_ALL, label: 'All data' },
  ...SPAN_YEARS.map(years => ({ value: `${years}y`, label: `${years} years` })),
]

const YEARS_PATTERN = /^(\d{1,2})y$/

/*
 * A stored value as its meaning: `{ kind: 'all' }` or `{ kind: 'years', years }` for a preset. Anything
 * else — a value from another build, a hand-edited preference — reads as all data, so a bad setting
 * shows too much rather than nothing, and the chooser always has an entry for what is in force.
 */
export function parseTrendSpan(value) {
  const raw = typeof value === 'string' ? value.trim() : ''
  const years = YEARS_PATTERN.exec(raw)
  if (years) {
    const count = Number(years[1])
    if (SPAN_YEARS.includes(count)) return { kind: 'years', years: count }
  }
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
 * chart draws, and `grain` the bucket the chart draws — a span of N years is N*12 months of
 * whole buckets of that grain, so the oldest bar is never a fragment of a period nobody asked for.
 *
 * A span of N years with no anchor has nothing to count back from and so means all data rather than a
 * guess.
 */
export function trendSpanFloorMonth(value, anchorMonth, grain = 'month') {
  const span = parseTrendSpan(value)
  if (span.kind !== 'years' || !anchorMonth) return null
  const size = GRAIN_MONTHS[grain] || 1
  const buckets = Math.max(1, Math.round((span.years * 12) / size))
  return shiftMonth(bucketStart(anchorMonth, size), -(buckets - 1) * size)
}

// The floor for a whole-year chart, as a year: N calendar years counted back from the anchor's year.
export function trendSpanFloorYear(value, anchorMonth) {
  const floor = trendSpanFloorMonth(value, anchorMonth, 'year')
  return floor ? floor.slice(0, 4) : null
}

/*
 * The span as a phrase for a chart's subtitle, which already names what is being totalled. A selection
 * longer than the span widens the chart past it, so the phrase takes the chart's first bucket
 * (`firstBucket`, a `YYYY-MM` bucket start), its grain and its end (`anchorMonth`), and names where the
 * bars really start when they start earlier than the span would. A year bucket is named by its year.
 */
export function describeTrendSpan(value, { firstBucket = null, grain = 'month', anchorMonth = null } = {}) {
  const span = parseTrendSpan(value)
  if (span.kind === 'all') return 'across all data'
  const floor = trendSpanFloorMonth(value, anchorMonth, grain)
  if (firstBucket && floor && firstBucket < floor) {
    return `since ${grain === 'year' ? firstBucket.slice(0, 4) : monthLabel(firstBucket)}`
  }
  return `over ${span.years} years`
}
