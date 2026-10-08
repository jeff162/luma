// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { monthLabel } from './utils.js'
import { periodAverage, seriesDateRange } from './periodAverage.js'
import { monthsInRange, shiftMonth } from './trendBuckets.js'

/*
 * The month-by-month series behind the cash-flow frame's Trends form.
 *
 * The rows arrive from `/summary/monthly-cash-flow` already netted per category, which is what makes a
 * month's two bars the same figures as that month's Sankey sides. Everything here is presentation: which
 * window to show, filling the months the ledger skipped, and shaping each row for the chart.
 *
 * **`outflow` is emitted negative, and that is a contract rather than a convenience.** The chart draws
 * the two series as one diverging column via a shared `stackId` plus `stackOffset="sign"`, and it is the
 * *sign* of the value that decides which side of zero recharts puts the bar on. Emitting the magnitude
 * instead does not merely mislabel the bar — recharts stacks it upward on top of money in, which is a
 * different picture with no error in it anywhere. The true magnitude rides along as `outflowMagnitude`
 * so the tooltip never has to un-negate anything.
 *
 * **The axis runs continuously.** A month the ledger has no row for is drawn as an empty month rather
 * than closed up, because a gap between two months is information and eliding it would put two
 * non-adjacent months side by side as though nothing had happened between them.
 */

export const CASH_FLOW_TREND_LAST_12 = 'last12'
const LAST_12_MONTHS = 12

/*
 * The window options the year picker offers: a rolling last-12-months view plus every calendar year the
 * data reaches, newest first.
 */
export function cashFlowTrendYearOptions(rows) {
  const years = [...new Set(normalizeRows(rows).map(r => r.month.slice(0, 4)))].sort().reverse()
  return [
    { value: CASH_FLOW_TREND_LAST_12, label: 'Last 12 months' },
    ...years.map(y => ({ value: y, label: y })),
  ]
}

/*
 * Build the chart series for one window.
 *
 * `selectedYear` is whatever the picker last held, which may name a year the current filters no longer
 * reach — the shared year state survives switching frames and filters. An unreachable selection falls
 * back to the rolling window rather than rendering an empty chart, and the resolved value is returned so
 * the picker can show what is actually being displayed.
 */
export function buildCashFlowTrendSeries(rows, selectedYear) {
  const normalized = normalizeRows(rows)
  const yearOptions = cashFlowTrendYearOptions(normalized)
  const effectiveYear = yearOptions.some(o => o.value === selectedYear)
    ? selectedYear
    : CASH_FLOW_TREND_LAST_12

  const months = windowMonths(normalized, effectiveYear)
  const byMonth = new Map(normalized.map(r => [r.month, r]))
  const chartData = months.map(month => {
    const row = byMonth.get(month)
    const inflow = finite(row?.inflow)
    const outflow = finite(row?.outflow)
    return {
      month: monthLabel(month),
      monthKey: month,
      inflow,
      outflow: -outflow,
      outflowMagnitude: outflow,
      // The server's net where there is one; derived otherwise, which is the same figure by
      // construction and keeps an empty month at a flat zero rather than a gap in the line.
      net: row && Number.isFinite(Number(row.net)) ? Number(row.net) : inflow - outflow,
    }
  })

  // Per elapsed day rather than per drawn bucket, and `null` where the window is under a month — see
  // `periodAverage.js`. The dates come from the rows in this window only, so the figure describes what
  // is on screen; the months the loop filled in to keep the axis continuous carry none and are skipped.
  const windowed = normalized.filter(r => months.includes(r.month))
  const { firstDate, lastDate } = seriesDateRange(windowed)
  const total = chartData.reduce((sum, r) => sum + r.net, 0)
  const avgNet = periodAverage(total, firstDate, lastDate, 'month')

  return { yearOptions, effectiveYear, chartData, avgNet }
}

/*
 * The year-by-year series drawn above the monthly one, from `/summary/monthly-cash-flow` at
 * `granularity=year`. Those rows net each category over the whole year, which is what makes a year's two
 * bars the two sides of that year's diagram — summing the monthly rows instead would put a category
 * that went out one month and came back the next on both sides. Same sign contract as the monthly
 * series, and the same continuous axis: a year with no rows is drawn empty rather than closed up.
 */
export function buildCashFlowAnnualSeries(rows) {
  const byYear = new Map(
    (rows || []).filter(r => r && /^\d{4}$/.test(String(r.year))).map(r => [String(r.year), r]),
  )
  const years = [...byYear.keys()].sort()
  const chartData = []
  for (let y = Number(years[0]); years.length && y <= Number(years[years.length - 1]); y++) {
    const year = String(y)
    const row = byYear.get(year)
    const inflow = finite(row?.inflow)
    const outflow = finite(row?.outflow)
    chartData.push({
      year,
      inflow,
      outflow: -outflow,
      outflowMagnitude: outflow,
      net: row && Number.isFinite(Number(row.net)) ? Number(row.net) : inflow - outflow,
    })
  }
  // The yearly figure had the worst version of the bucket-count defect: the loop above fills every year
  // between the first and the last, so a year the ledger never reached and a part-finished current year
  // both divided as whole years. See `periodAverage.js`.
  const { firstDate, lastDate } = seriesDateRange(rows)
  const total = chartData.reduce((sum, r) => sum + r.net, 0)
  const avgNet = periodAverage(total, firstDate, lastDate, 'year')
  return { chartData, avgNet }
}

function normalizeRows(rows) {
  return (rows || []).filter(r => r && typeof r.month === 'string')
}

function finite(value) {
  const num = Number(value)
  return Number.isFinite(num) ? num : 0
}

/*
 * The month codes the window covers, gaps included.
 *
 * The rolling window is twelve *calendar* months back from the latest month holding data — not the
 * latest twelve rows. Those differ exactly when the ledger skips a month, and taking rows would then
 * span thirteen or more months under a label that says twelve.
 */
function windowMonths(rows, effectiveYear) {
  if (rows.length === 0) return []
  if (effectiveYear !== CASH_FLOW_TREND_LAST_12) {
    const inYear = rows.filter(r => r.month.slice(0, 4) === effectiveYear)
    return inYear.length > 0 ? monthsInRange(inYear[0].month, inYear[inYear.length - 1].month) : []
  }
  const end = rows[rows.length - 1].month
  const start = shiftMonth(end, -(LAST_12_MONTHS - 1))
  // A ledger shorter than the window starts where the data does, so a new install is not padded with
  // empty months it never had.
  const firstMonth = rows[0].month
  return monthsInRange(start > firstMonth ? start : firstMonth, end)
}
