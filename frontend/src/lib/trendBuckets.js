// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * Trend-bucket geometry for the Dashboard single-period chart. Pure month math, kept in its own module
 * so it is unit-testable and so the page file exports only components. Bucket ranges are inclusive month
 * codes ('YYYY-MM'); the page folds monthly-trend rows into them (aggregateMonthlyIntoBuckets).
 */

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

// The window the Trends tab's monthly charts and averages cover: `'last12'` is the trailing twelve months
// ending with `currentMonth`, anything else a calendar year ('YYYY'). Returned both as month codes, which
// the charts slice their rows by, and as inclusive ISO dates, which a report opened from one of those
// figures lists by — one definition, so a report can never cover different months than the figure did.
export function trendsWindowRange(windowKey, currentMonth) {
  if (windowKey === 'last12') {
    const startMonth = shiftMonth(currentMonth, -11)
    return {
      key: 'last12',
      startMonth,
      endMonth: currentMonth,
      start: `${startMonth}-01`,
      end: lastDayOfMonthISO(currentMonth),
      label: 'Last 12 months',
    }
  }
  const year = String(windowKey)
  return {
    key: year,
    startMonth: `${year}-01`,
    endMonth: `${year}-12`,
    start: `${year}-01-01`,
    end: `${year}-12-31`,
    label: year,
  }
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

// Which window the Trends tab shows. An explicit pick from its year picker always wins; with none
// (`selectedYear` null) it is the trailing twelve months when they hold any data, otherwise the most
// recent year that does, so a stale or imported ledger does not open on empty charts. `rows` are the
// tab's monthly series rows (`{ month: 'YYYY-MM', … }`).
export function resolveTrendsWindowKey(rows, selectedYear, currentMonth) {
  if (selectedYear != null) return String(selectedYear)
  const months = rows
    .map(r => r?.month)
    .filter(month => typeof month === 'string' && /^\d{4}-\d{2}$/.test(month))
  const last12 = trendsWindowRange('last12', currentMonth)
  if (months.length === 0 || months.some(month => month >= last12.startMonth && month <= last12.endMonth)) {
    return 'last12'
  }
  return months.reduce((latest, month) => (month > latest ? month : latest)).slice(0, 4)
}

// A "year to date" selection: anchored to January 1 and ending before December of the same calendar
// year (the "Year to date" preset, or a custom "Jan 1 → date this year" range). Such a slice compares
// most meaningfully against the *same* Jan→month window in prior years, not against contiguous tiles of
// its own length — so the trend treats it specially (see computeTrendBuckets).
export function isYearToDateRange(date) {
  return !!date?.start && !!date?.end
    && date.start.slice(5, 10) === '01-01'
    && date.start.slice(0, 4) === date.end.slice(0, 4)
    && Number(date.end.slice(5, 7)) < 12
}

// Single-page bottom-chart trend: instead of fetching a fixed rolling window, bucket the historical
// timeline by the SELECTED period's length so the trend reads as "this kind of slice, over time." The
// selected period sits as one bar; a generous run of earlier buckets and a small lookahead show the user
// where they are.
//
// Year-to-date is the exception (see isYearToDateRange): the bars step a full year at a time and each
// spans the same Jan→end-month window, so the chart answers "this year so far vs. prior years to the
// same point." The window is whole calendar months (Jan→end month), each bar is labeled by its year, and
// there's no future lookahead (prior years only). The comparison is at month granularity — a prior
// year's current month counts whole, not truncated to today's day-of-month.
export function computeTrendBuckets(periodDate, options = {}) {
  const earlierCount = options.earlierCount ?? 11
  let laterCount = options.laterCount ?? 3
  let anchorStart, bucketMonths
  if (periodDate?.start && periodDate?.end) {
    anchorStart = periodDate.start.slice(0, 7)
    // Bucket width tracks the selected period's *duration*, not how many calendar-month labels it
    // touches. Otherwise a ~30-day range straddling a month boundary (e.g. "Last 30 days") counts as
    // two months and inflates every bucket — and the displayed average — vs. an equivalent "Last month".
    const daySpan = Math.round((new Date(periodDate.end) - new Date(periodDate.start)) / 86400000) + 1
    bucketMonths = Math.max(1, Math.round(daySpan / 30.44))
  } else {
    const now = new Date()
    anchorStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    bucketMonths = 1
  }
  const yearToDate = isYearToDateRange(periodDate)
  const stepMonths = yearToDate ? 12 : bucketMonths
  if (yearToDate) {
    // Size the window to whole calendar months so the selected bar spans exactly Jan→end month, and
    // show prior years only.
    bucketMonths = Number(periodDate.end.slice(5, 7))
    laterCount = 0
  }
  const anchorEnd = shiftMonth(anchorStart, bucketMonths - 1)
  // Year-to-date bars all share one Jan→month range, so label each by its year to tell them apart;
  // ordinary buckets get their range/month label downstream (bucketLabel).
  const bucketOf = (start, end, isSelected) => ({
    start, end, isSelected,
    ...(yearToDate ? { label: start.slice(0, 4) } : {}),
  })
  const buckets = []
  for (let i = earlierCount; i >= 1; i--) {
    const start = shiftMonth(anchorStart, -i * stepMonths)
    buckets.push(bucketOf(start, shiftMonth(start, bucketMonths - 1), false))
  }
  buckets.push(bucketOf(anchorStart, anchorEnd, true))
  for (let i = 1; i <= laterCount; i++) {
    const start = shiftMonth(anchorStart, i * stepMonths)
    buckets.push(bucketOf(start, shiftMonth(start, bucketMonths - 1), false))
  }
  return { bucketMonths, buckets, yearToDate }
}
