// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * Trend-bucket geometry for the Dashboard's charts. Pure date math, kept in its own module so it is
 * unit-testable and so the page file exports only components. Month codes are 'YYYY-MM'; the
 * single-period trend's section at the end also deals in inclusive ISO days.
 */

import { localIsoDate } from './utils.js'

// Every month code from `startYM` to `endYM`, both inclusive. Callers use it to run an axis
// continuously across a window: a month with no rows is a real answer, and closing the gap would imply
// the months either side of it were adjacent.
export function monthsInRange(startYM, endYM) {
  const months = []
  let [sy, sm] = startYM.split('-').map(Number)
  const [ey, em] = endYM.split('-').map(Number)
  while (sy < ey || (sy === ey && sm <= em)) {
    months.push(`${sy}-${String(sm).padStart(2, '0')}`)
    sm++; if (sm > 12) { sm = 1; sy++ }
  }
  return months
}

export function shiftMonth(ym, deltaMonths) {
  const [y, m] = ym.split('-').map(Number)
  const totalMonthIndex = (y * 12) + (m - 1) + deltaMonths
  const newY = Math.floor(totalMonthIndex / 12)
  const newM = (totalMonthIndex % 12) + 1
  return `${newY}-${String(newM).padStart(2, '0')}`
}

export function lastDayOfMonthISO(ym) {
  const [y, m] = ym.split('-').map(Number)
  const last = new Date(y, m, 0).getDate()
  return `${ym}-${String(last).padStart(2, '0')}`
}

// --- The Trends windows ---------------------------------------------------------------------------
//
// What the Trends forms' monthly charts and averages cover, in one vocabulary for all three frames: a
// trailing run of whole months, everything, or a calendar year ('YYYY'). The rolling entries are counted
// in months so that "Last 2 years" is the same twenty-four bars whichever month it is read in.

export const TRENDS_WINDOW_LAST_12 = 'last12'
export const TRENDS_WINDOW_ALL = 'all'

const ROLLING_TRENDS_WINDOWS = [
  { value: TRENDS_WINDOW_LAST_12, label: 'Last 12 months', months: 12 },
  { value: 'last24', label: 'Last 2 years', months: 24 },
  { value: 'last36', label: 'Last 3 years', months: 36 },
  { value: 'last60', label: 'Last 5 years', months: 60 },
]

// The chooser's entries: the rolling windows, all data, then every year given — newest first, as the
// app's other year pickers list them.
export function trendsWindowOptions(years = []) {
  return [
    ...ROLLING_TRENDS_WINDOWS.map(({ value, label }) => ({ value, label })),
    { value: TRENDS_WINDOW_ALL, label: 'All data' },
    ...[...new Set(years.map(String))].sort().reverse().map(year => ({ value: year, label: year })),
  ]
}

// How many months a rolling window reaches back, or null for a key that is not one.
export function trendsWindowRollingMonths(windowKey) {
  return ROLLING_TRENDS_WINDOWS.find(w => w.value === windowKey)?.months ?? null
}

export function isTrendsYearWindow(windowKey) {
  return /^\d{4}$/.test(String(windowKey))
}

// The first and last month a set of monthly rows (`{ month: 'YYYY-MM', … }`) reaches, or null for none.
export function rowsMonthSpan(rows) {
  const months = (rows || [])
    .map(r => r?.month)
    .filter(month => typeof month === 'string' && /^\d{4}-\d{2}$/.test(month))
  if (months.length === 0) return null
  return months.reduce(
    (span, month) => ({ first: month < span.first ? month : span.first, last: month > span.last ? month : span.last }),
    { first: months[0], last: months[0] },
  )
}

// One window as a range. A rolling window ends with `currentMonth`; all data runs across `dataSpan`
// (`rowsMonthSpan`), which is the only window that needs it — with no data it is the current month
// alone, and draws nothing. Returned both as month codes, which the charts slice their rows by, and as
// inclusive ISO dates, which a report opened from one of those figures lists by — one definition, so a
// report can never cover different months than the figure did.
export function trendsWindowRange(windowKey, currentMonth, dataSpan = null) {
  const range = (key, startMonth, endMonth, label) => ({
    key, startMonth, endMonth, start: `${startMonth}-01`, end: lastDayOfMonthISO(endMonth), label,
  })
  const rollingMonths = trendsWindowRollingMonths(windowKey)
  if (rollingMonths != null) {
    const label = ROLLING_TRENDS_WINDOWS.find(w => w.value === windowKey).label
    return range(windowKey, shiftMonth(currentMonth, -(rollingMonths - 1)), currentMonth, label)
  }
  if (windowKey === TRENDS_WINDOW_ALL) {
    return range(TRENDS_WINDOW_ALL, dataSpan?.first || currentMonth, dataSpan?.last || currentMonth, 'All data')
  }
  const year = String(windowKey)
  return range(year, `${year}-01`, `${year}-12`, year)
}

// The months a Trends window's charts and averages run across: every month of the window, so a month with
// no rows is drawn (and averaged) as nothing rather than vanishing and leaving its neighbours looking
// adjacent. Two ends are clamped, because a month outside them would read as a real zero: nothing after
// `currentMonth` (a current-year window has not had its later months yet), and nothing before
// `firstDataMonth` (a ledger that starts mid-window has no answer for the months before it). No data at all,
// or data that starts after the window, gives no months.
export function trendsWindowMonths(window, currentMonth, firstDataMonth) {
  if (!firstDataMonth) return []
  const start = firstDataMonth > window.startMonth ? firstDataMonth : window.startMonth
  const end = currentMonth < window.endMonth ? currentMonth : window.endMonth
  return start <= end ? monthsInRange(start, end) : []
}

// Which window the Trends tab shows. An explicit pick from its window chooser always wins; with none
// (`selectedWindow` null) it is the trailing twelve months when they hold any data, otherwise the most
// recent year that does, so a stale or imported ledger does not open on empty charts. `rows` are the
// tab's monthly series rows (`{ month: 'YYYY-MM', … }`).
export function resolveTrendsWindowKey(rows, selectedWindow, currentMonth) {
  if (selectedWindow != null) return String(selectedWindow)
  const months = rows
    .map(r => r?.month)
    .filter(month => typeof month === 'string' && /^\d{4}-\d{2}$/.test(month))
  const last12 = trendsWindowRange(TRENDS_WINDOW_LAST_12, currentMonth)
  if (months.length === 0 || months.some(month => month >= last12.startMonth && month <= last12.endMonth)) {
    return TRENDS_WINDOW_LAST_12
  }
  return months.reduce((latest, month) => (month > latest ? month : latest)).slice(0, 4)
}

// --- The Dashboard's single-period trend ----------------------------------------------------------
//
// The chart under the single-period breakdown answers "this kind of slice, over time", and it has two
// ways of cutting time, picked from its chooser:
//
// - **Calendar grains** (month / quarter / year) bucket the history the caller passes as `firstMonth` —
//   all of the data's, floored by the trend span (`trendSpan.js`). The selected period
//   is highlighted on every bucket it overlaps, so a period that is not itself a calendar unit — Past 12
//   months, Year to date, a custom range — lights up the run of bars it touches rather than being
//   squeezed into one. This is the default, at the grain the selection's length suggests.
// - **Same span** repeats the selected period exactly, shifted back a month, quarter or year at a time:
//   Jan 1 – Oct 7 in each prior year for Year to date, the 1st to the 7th of each month for Month to
//   date. Offered only when the selection is not already a calendar unit (where it would duplicate that
//   grain) and fits inside a year.
//
// **A bar equals what selecting it shows.** That is the invariant both modes keep, and the reason the
// second one is day-precise and reads `/summary/range-trend` rather than folding monthly rows: a span
// that does not start and end on month boundaries cannot be rebuilt from whole months, and the earlier
// model that tried — bucket width rounded from the selection's length, tiled from its start month —
// highlighted a bar covering different dates than the totals above it.
//
// Dates are inclusive ISO days ('YYYY-MM-DD'); a bucket's `start`/`end` are month codes (what the scroll
// anchoring and the monthly rows key on) and `rangeStart`/`rangeEnd` the exact days a click selects.

export const TREND_GRAINS = ['month', 'quarter', 'year']
export const TREND_GRAIN_SAME_SPAN = 'span'
const GRAIN_MONTHS = { month: 1, quarter: 3, year: 12 }
const GRAIN_LABELS = { month: 'Monthly', quarter: 'Quarterly', year: 'Yearly' }
const GRAIN_NOUNS = { 1: 'month', 3: 'quarter', 12: 'year' }

// The ceiling on same-span buckets, matching what one `/summary/range-trend` call accepts
// (`RANGE_TREND_MAX_RANGES` in backend/routers/transactions.py).
export const SAME_SPAN_MAX_BUCKETS = 64

function isBoundedDate(date) {
  return !!date?.start && !!date?.end
}

function daysInMonth(y, m) {
  return new Date(y, m, 0).getDate()
}

/*
 * Move an ISO day by whole calendar months, clamping to the target month's length. `stickToMonthEnd`
 * keeps a month's last day on the last day (Sep 30 + 1 → Oct 31), which is what a span *ending* at a
 * month end means; a start is never moved that way, or Feb 28 would start a span on Mar 31.
 */
export function shiftDateByMonths(iso, deltaMonths, { stickToMonthEnd = false } = {}) {
  const [y, m, d] = iso.split('-').map(Number)
  const [ty, tm] = shiftMonth(`${y}-${String(m).padStart(2, '0')}`, deltaMonths).split('-').map(Number)
  const lastDay = daysInMonth(ty, tm)
  const day = stickToMonthEnd && d === daysInMonth(y, m) ? lastDay : Math.min(d, lastDay)
  return `${ty}-${String(tm).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

// The calendar grain a range exactly is — one whole month, quarter or year — or null.
export function calendarGrainOf(date) {
  if (!isBoundedDate(date) || date.start.slice(8) !== '01') return null
  const startMonth = date.start.slice(0, 7)
  for (const grain of TREND_GRAINS) {
    const size = GRAIN_MONTHS[grain]
    const aligned = grain === 'month' || (Number(startMonth.slice(5)) - 1) % size === 0
    if (aligned && date.end === lastDayOfMonthISO(shiftMonth(startMonth, size - 1))) return grain
  }
  return null
}

function rangeDays(date) {
  return Math.round((new Date(date.end) - new Date(date.start)) / 86400000) + 1
}

/*
 * The grain the chart opens at for a selection: the calendar unit it *is*, when it is one, otherwise the
 * unit nearest its length, so the selection covers about one bar (Last 30 days → months, Last 90 days →
 * quarters, Year to date and Past 12 months → years). With no explicit selection the trend is not tied
 * to a period at all, and opens monthly.
 */
export function defaultTrendGrain(date) {
  if (!isBoundedDate(date)) return 'month'
  const exact = calendarGrainOf(date)
  if (exact) return exact
  const months = rangeDays(date) / 30.44
  if (months <= 1.5) return 'month'
  if (months <= 4.5) return 'quarter'
  return 'year'
}

/*
 * How far apart same-span bars sit, in months: the smallest of a month, a quarter and a year that the
 * selection fits inside. Null where the mode is not offered — no explicit selection, a selection that is
 * already a calendar unit, or one longer than a year. A selection exactly one step long (the Past 12
 * months preset runs from a date to the same date a year later) shares its boundary day with the next
 * bar; each bar is still exactly the span it names.
 */
export function sameSpanStepMonths(date) {
  if (!isBoundedDate(date) || calendarGrainOf(date)) return null
  for (const step of [1, 3, 12]) {
    if (date.end <= shiftDateByMonths(date.start, step)) return step
  }
  return null
}

// The chooser's entries for a selection: the calendar grains always, same-span when it applies.
export function trendGrainOptions(date) {
  const options = TREND_GRAINS.map(value => ({ value, label: GRAIN_LABELS[value] }))
  const step = sameSpanStepMonths(date)
  if (step) options.push({ value: TREND_GRAIN_SAME_SPAN, label: `Same span each ${GRAIN_NOUNS[step]}` })
  return options
}

// The grain in force: the user's pick while it still applies to the selection, else the default.
export function effectiveTrendGrain(choice, date) {
  if (choice === TREND_GRAIN_SAME_SPAN) return sameSpanStepMonths(date) ? choice : defaultTrendGrain(date)
  return TREND_GRAINS.includes(choice) ? choice : defaultTrendGrain(date)
}

export function trendGrainNoun(date) {
  return GRAIN_NOUNS[sameSpanStepMonths(date)] || null
}

/*
 * Calendar buckets over every month from `firstMonth` to `lastMonth`, widened to take in the selection
 * so it is always on the chart — which is also what keeps a period older than the trend span's floor
 * drawn — gaps included so the axis stays uniform. Quarters and years snap to
 * their calendar boundaries. A bucket is selected when it overlaps the selection at all.
 */
export function calendarTrendBuckets({ firstMonth, lastMonth, grain, date, fallbackMonth }) {
  const bounded = isBoundedDate(date)
  const months = [firstMonth, lastMonth, bounded && date.start.slice(0, 7), bounded && date.end.slice(0, 7)]
    .filter(Boolean)
  const min = months.length ? months.reduce((a, b) => (a < b ? a : b)) : fallbackMonth
  const max = months.length ? months.reduce((a, b) => (a > b ? a : b)) : fallbackMonth
  const size = GRAIN_MONTHS[grain] || 1
  const [minY, minM] = min.split('-').map(Number)
  const startM = minM - ((minM - 1) % size)
  let cursor = `${minY}-${String(startM).padStart(2, '0')}`
  const buckets = []
  while (cursor <= max) {
    const end = shiftMonth(cursor, size - 1)
    const rangeStart = `${cursor}-01`
    const rangeEnd = lastDayOfMonthISO(end)
    buckets.push({
      start: cursor, end, rangeStart, rangeEnd,
      isSelected: bounded && rangeStart <= date.end && rangeEnd >= date.start,
    })
    cursor = shiftMonth(cursor, size)
  }
  return buckets
}

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function dayLabel(iso, { year = true } = {}) {
  const [y, m, d] = iso.split('-').map(Number)
  return `${SHORT_MONTHS[m - 1]} ${d}${year ? `, ${y}` : ''}`
}

/*
 * A span's names: `full` is exact and goes on the tooltip and the date chip; `axis` fits a bar's width,
 * keeping only what tells the bars apart — the year when steps are yearly and the span sits inside one,
 * the month when the span sits inside one, else the two ends.
 */
export function sameSpanLabels(rangeStart, rangeEnd, stepMonths) {
  const sameYear = rangeStart.slice(0, 4) === rangeEnd.slice(0, 4)
  const full = sameYear
    ? `${dayLabel(rangeStart, { year: false })} – ${dayLabel(rangeEnd)}`
    : `${dayLabel(rangeStart)} – ${dayLabel(rangeEnd)}`
  let axis
  if (stepMonths === 12 && sameYear) axis = rangeStart.slice(0, 4)
  else if (rangeStart.slice(0, 7) === rangeEnd.slice(0, 7)) {
    axis = `${SHORT_MONTHS[Number(rangeStart.slice(5, 7)) - 1]} ${rangeStart.slice(0, 4)}`
  } else if (stepMonths === 12) {
    const short = iso => `${SHORT_MONTHS[Number(iso.slice(5, 7)) - 1]} ’${iso.slice(2, 4)}`
    axis = `${short(rangeStart)} – ${short(rangeEnd)}`
  } else {
    axis = `${dayLabel(rangeStart, { year: false })} – ${dayLabel(rangeEnd, { year: false })}`
  }
  return { full, axis }
}

/*
 * The selection repeated a step at a time across the data — from the first span reaching `firstMonth`
 * (the data's first month, floored by the trend span) to the last one starting by the end of its last month or by today, whichever is earlier
 * (and never short of the selection itself). Built
 * from the selection itself each time, so clicking one of these bars yields the same family around the
 * new selection and the chart does not move. Capped at SAME_SPAN_MAX_BUCKETS, keeping the newest unless
 * that would drop the selection.
 */
export function sameSpanTrendBuckets({ date, firstMonth, lastMonth, today = localIsoDate() }) {
  const step = sameSpanStepMonths(date)
  if (!step) return []
  const at = k => {
    const rangeStart = shiftDateByMonths(date.start, k * step)
    const rangeEnd = shiftDateByMonths(date.end, k * step, { stickToMonthEnd: true })
    return { rangeStart, rangeEnd }
  }
  const firstDay = `${firstMonth || date.start.slice(0, 7)}-01`
  const dataEnd = lastDayOfMonthISO(lastMonth || date.end.slice(0, 7))
  const lastDay = dataEnd < today ? dataEnd : today
  let lo = 0
  while (at(lo - 1).rangeEnd >= firstDay) lo--
  let hi = 0
  while (at(hi + 1).rangeStart <= lastDay) hi++
  if (hi - lo + 1 > SAME_SPAN_MAX_BUCKETS) {
    lo = Math.max(lo, hi - SAME_SPAN_MAX_BUCKETS + 1)
    if (lo > 0) lo = 0
    hi = Math.min(hi, lo + SAME_SPAN_MAX_BUCKETS - 1)
  }
  const buckets = []
  for (let k = lo; k <= hi; k++) {
    const { rangeStart, rangeEnd } = at(k)
    const { full, axis } = sameSpanLabels(rangeStart, rangeEnd, step)
    buckets.push({
      start: rangeStart.slice(0, 7), end: rangeEnd.slice(0, 7), rangeStart, rangeEnd,
      label: axis, fullLabel: full, isSelected: k === 0,
    })
  }
  return buckets
}
