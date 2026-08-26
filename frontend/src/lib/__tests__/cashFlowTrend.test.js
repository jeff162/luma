import { describe, it, expect } from 'vitest'
import {
  CASH_FLOW_TREND_LAST_12,
  buildCashFlowTrendSeries,
  cashFlowTrendYearOptions,
} from '../cashFlowTrend.js'

// Rows as /summary/monthly-cash-flow emits them: both sides as positive magnitudes, net = in - out.
function month(m, inflow, outflow) {
  return { month: m, inflow, outflow, net: inflow - outflow }
}

const monthsFrom = (startYear, startMonth, count, fn = i => [1000 + i, 500 + i]) =>
  Array.from({ length: count }, (_, i) => {
    const index = (startYear * 12) + (startMonth - 1) + i
    const code = `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`
    const [inflow, outflow] = fn(i)
    return month(code, inflow, outflow)
  })

const keys = series => series.chartData.map(r => r.monthKey)

describe('the diverging-bar sign contract', () => {
  // The chart draws money in and money out as one column via a shared stackId plus stackOffset="sign",
  // so recharts decides which side of zero a bar goes on from the *sign* of the value it is handed.
  // Emitting a magnitude does not mislabel the bar, it stacks it upward on top of money in — a
  // different picture with no visible error in it, which is exactly how it shipped once already.
  const series = buildCashFlowTrendSeries([month('2026-05', 15759.92, 8811.87)], CASH_FLOW_TREND_LAST_12)
  const row = series.chartData[0]

  it('emits money in positive so it draws above the centerline', () => {
    expect(row.inflow).toBeCloseTo(15759.92)
    expect(row.inflow).toBeGreaterThan(0)
  })

  it('emits money out negative so it draws below the centerline', () => {
    expect(row.outflow).toBeCloseTo(-8811.87)
    expect(row.outflow).toBeLessThan(0)
  })

  it('carries the true magnitude alongside, so the tooltip never un-negates anything', () => {
    expect(row.outflowMagnitude).toBeCloseTo(8811.87)
  })

  it('keeps the two bars summing to the net line drawn across them', () => {
    expect(row.inflow + row.outflow).toBeCloseTo(row.net)
    expect(row.net).toBeCloseTo(6948.05)
  })

  it('holds the contract for a month that spent more than it took in', () => {
    const [deficit] = buildCashFlowTrendSeries(
      [month('2026-04', 3000, 31000)], CASH_FLOW_TREND_LAST_12,
    ).chartData
    expect(deficit.inflow).toBeGreaterThan(0)
    expect(deficit.outflow).toBeLessThan(0)
    expect(deficit.inflow + deficit.outflow).toBeCloseTo(deficit.net)
    expect(deficit.net).toBeCloseTo(-28000)
  })
})

describe('the window', () => {
  it('offers a rolling window plus every year in the data, newest first', () => {
    const options = cashFlowTrendYearOptions([month('2024-03', 1, 1), month('2025-07', 1, 1), month('2026-01', 1, 1)])
    expect(options.map(o => o.value)).toEqual([CASH_FLOW_TREND_LAST_12, '2026', '2025', '2024'])
  })

  it('shows the last twelve calendar months, not the last twelve rows', () => {
    // The two differ exactly when the ledger skips a month. Taking rows and then running the axis
    // continuously across them would span thirteen months under a label that says twelve.
    const rows = monthsFrom(2025, 8, 13).filter(r => r.month !== '2026-02')
    expect(rows).toHaveLength(12)

    const series = buildCashFlowTrendSeries(rows, CASH_FLOW_TREND_LAST_12)

    expect(keys(series)).toHaveLength(12)
    expect(keys(series)[0]).toBe('2025-09')
    expect(keys(series)[11]).toBe('2026-08')
  })

  it('runs the axis continuously across a month the ledger skipped', () => {
    const series = buildCashFlowTrendSeries(
      [month('2026-01', 100, 40), month('2026-04', 200, 90)], CASH_FLOW_TREND_LAST_12,
    )

    expect(keys(series)).toEqual(['2026-01', '2026-02', '2026-03', '2026-04'])
    const skipped = series.chartData[1]
    expect(skipped.inflow).toBe(0)
    expect(skipped.outflow).toBe(-0)
    expect(skipped.net).toBe(0)
  })

  it('starts where a short ledger starts rather than padding empty months before it', () => {
    const series = buildCashFlowTrendSeries([month('2026-06', 10, 5), month('2026-07', 10, 5)], CASH_FLOW_TREND_LAST_12)
    expect(keys(series)).toEqual(['2026-06', '2026-07'])
  })

  it('narrows to a selected calendar year', () => {
    const rows = [...monthsFrom(2025, 10, 3), ...monthsFrom(2026, 1, 3)]
    const series = buildCashFlowTrendSeries(rows, '2026')

    expect(series.effectiveYear).toBe('2026')
    expect(keys(series)).toEqual(['2026-01', '2026-02', '2026-03'])
  })

  it('falls back to the rolling window when the selected year is no longer in the data', () => {
    // The year selection is shared state that survives switching frames and filters, so it can name a
    // year the current filters no longer reach. Rendering an empty chart would read as no data at all.
    const rows = monthsFrom(2026, 1, 4)
    const series = buildCashFlowTrendSeries(rows, '2019')

    expect(series.effectiveYear).toBe(CASH_FLOW_TREND_LAST_12)
    expect(keys(series)).toEqual(['2026-01', '2026-02', '2026-03', '2026-04'])
  })

  it('falls back when nothing is selected yet', () => {
    expect(buildCashFlowTrendSeries(monthsFrom(2026, 1, 2), null).effectiveYear).toBe(CASH_FLOW_TREND_LAST_12)
    expect(buildCashFlowTrendSeries(monthsFrom(2026, 1, 2), undefined).effectiveYear).toBe(CASH_FLOW_TREND_LAST_12)
  })
})

describe('the average net', () => {
  it('averages over the months on screen, empty ones included', () => {
    // An empty month is a real month at zero net, so it pulls the average toward zero. Skipping it would
    // report the average of the months that happened to have activity, which is a different figure.
    const series = buildCashFlowTrendSeries(
      [month('2026-01', 300, 100), month('2026-03', 100, 300)], CASH_FLOW_TREND_LAST_12,
    )

    expect(keys(series)).toHaveLength(3)
    expect(series.avgNet).toBeCloseTo(0)
  })

  it('is zero rather than NaN with nothing to average', () => {
    const series = buildCashFlowTrendSeries([], CASH_FLOW_TREND_LAST_12)
    expect(series.chartData).toEqual([])
    expect(series.avgNet).toBe(0)
  })
})

describe('malformed rows', () => {
  it('ignores rows with no month rather than rendering a chart around them', () => {
    const series = buildCashFlowTrendSeries(
      [null, undefined, { inflow: 5 }, month('2026-02', 10, 4)], CASH_FLOW_TREND_LAST_12,
    )
    expect(keys(series)).toEqual(['2026-02'])
  })

  it('treats a missing or non-numeric side as zero', () => {
    const [row] = buildCashFlowTrendSeries(
      [{ month: '2026-02', inflow: null, outflow: 'nope', net: undefined }], CASH_FLOW_TREND_LAST_12,
    ).chartData
    expect(row.inflow).toBe(0)
    expect(row.outflowMagnitude).toBe(0)
    expect(row.net).toBe(0)
  })

  it('derives the net when the server did not send one, and trusts it when it did', () => {
    const derived = buildCashFlowTrendSeries([{ month: '2026-02', inflow: 900, outflow: 400 }], CASH_FLOW_TREND_LAST_12)
    expect(derived.chartData[0].net).toBeCloseTo(500)

    // A server net of exactly zero is a real figure, not a missing one.
    const flat = buildCashFlowTrendSeries([{ month: '2026-02', inflow: 700, outflow: 700, net: 0 }], CASH_FLOW_TREND_LAST_12)
    expect(flat.chartData[0].net).toBe(0)
  })
})
