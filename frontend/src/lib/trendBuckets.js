// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * Trend-bucket geometry for the Dashboard single-period chart. Pure month math, kept in its own module
 * so it is unit-testable and so the page file exports only components. Bucket ranges are inclusive month
 * codes ('YYYY-MM'); the page folds monthly-trend rows into them (aggregateMonthlyIntoBuckets).
 */

export function shiftMonth(ym, deltaMonths) {
  const [y, m] = ym.split('-').map(Number)
  const totalMonthIndex = (y * 12) + (m - 1) + deltaMonths
  const newY = Math.floor(totalMonthIndex / 12)
  const newM = (totalMonthIndex % 12) + 1
  return `${newY}-${String(newM).padStart(2, '0')}`
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
