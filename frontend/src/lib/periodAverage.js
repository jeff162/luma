// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * "Average per month" and "average per year", computed one way for every chart that shows one.
 *
 * **The denominator is elapsed days, not a count of buckets.** Averaging a series of month or year
 * totals divides by however many buckets the chart drew, which is wrong in three ways at once: a
 * partial bucket at either end counts as a whole one (a ledger ending in March divides that year by
 * 12), a bucket manufactured to fill a gap in the axis counts as a real observation, and even the full
 * buckets are uneven — February and July are not the same amount of time, so treating them as equal
 * terms in a *rate* is an error with no partial-period excuse.
 *
 * Days are the right atom because they are the finest grain the data has: `txn.date` is a calendar day
 * with no time component, so a day-based denominator has no rounding artifact to argue about. The
 * bucket bookkeeping then disappears, and with it the question of whether an empty month inside the
 * span should count — it does, automatically, because it is one of the days between the first
 * transaction and the last.
 *
 * **The span is the first and last transaction in the window**, inclusive, which is why the summary
 * endpoints return `first_date` / `last_date` beside each bucket's totals rather than leaving the
 * caller to infer dates from bucket keys. A bucket key cannot say when within itself the data starts:
 * on an annual chart whose first year holds one December transaction, the bucket says "this year" and
 * the truth is one month. Absence at either end therefore shortens the span, while a gap in the middle
 * does not — the one rule covers both.
 *
 * **A rate is only shown for a unit the window actually covers.** Less than a year of data, no
 * per-year figure; less than a month, no per-month figure. The unit is whichever one the surface
 * states or draws — a trend chart at quarterly grain averages per quarter. Dividing four months of spending into a
 * yearly rate is not a summary of what happened but a forecast of what has not, and the app does not
 * make one silently. That is what the `null` return means, and a caller must hide its figure — and any
 * reference line drawn at it — rather than render a zero.
 */

import { addMonths, addQuarters, addYears, differenceInCalendarDays, parseISO, subDays } from 'date-fns'

// Mean Gregorian lengths. The scaling is a rate conversion, not calendar arithmetic — the calendar
// question (does the span cover a whole unit?) is answered separately, and exactly, below.
const UNIT_DAYS = { month: 30.436875, quarter: 91.310625, year: 365.2425 }
const ADD_UNIT = { month: addMonths, quarter: addQuarters, year: addYears }

function toDate(value) {
  if (!value || typeof value !== 'string') return null
  const parsed = parseISO(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

/** Inclusive day count of a window, or null if either end is missing or they are the wrong way round. */
export function spanDays(firstDate, lastDate) {
  const first = toDate(firstDate)
  const last = toDate(lastDate)
  if (!first || !last) return null
  const days = differenceInCalendarDays(last, first) + 1
  return days > 0 ? days : null
}

/** Does the window cover at least one whole `unit`? Calendar arithmetic, so a short February counts. */
export function spansWholeUnit(firstDate, lastDate, unit) {
  const first = toDate(firstDate)
  const last = toDate(lastDate)
  const add = ADD_UNIT[unit]
  if (!first || !last || !add) return false
  return last >= subDays(add(first, 1), 1)
}

/**
 * The average of `total` over the window, per `unit` ('month' | 'year') — or **null** where the window
 * does not cover a whole unit, which callers render as no figure at all rather than as zero.
 */
export function periodAverage(total, firstDate, lastDate, unit) {
  const days = spanDays(firstDate, lastDate)
  const unitDays = UNIT_DAYS[unit]
  if (days === null || !unitDays) return null
  if (!spansWholeUnit(firstDate, lastDate, unit)) return null
  const amount = Number(total)
  if (!Number.isFinite(amount)) return null
  return amount / (days / unitDays)
}

/**
 * The window a series of bucket rows covers, from the real transaction dates the summary endpoints
 * return beside each bucket. Rows with no dates (an empty bucket the client filled in for the axis)
 * are skipped, which is what keeps a manufactured gap from widening the span.
 */
export function seriesDateRange(rows, { first = 'first_date', last = 'last_date' } = {}) {
  let firstDate = null
  let lastDate = null
  for (const row of rows || []) {
    const rowFirst = row?.[first]
    const rowLast = row?.[last]
    if (rowFirst && (firstDate === null || rowFirst < firstDate)) firstDate = rowFirst
    if (rowLast && (lastDate === null || rowLast > lastDate)) lastDate = rowLast
  }
  return { firstDate, lastDate }
}
