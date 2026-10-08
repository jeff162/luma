import { describe, it, expect } from 'vitest'
import {
  CASH_FLOW_TREND_LAST_12,
  buildCashFlowAnnualSeries,
  buildCashFlowTrendSeries,
  cashFlowTrendYearOptions,
} from '../cashFlowTrend.js'

// Rows as /summary/monthly-cash-flow emits them: both sides as positive magnitudes, net = in - out,
// and the real first/last transaction date in the bucket, which is what the average divides by.
function month(m, inflow, outflow, { first = `${m}-01`, last = `${m}-28` } = {}) {
  return { month: m, inflow, outflow, net: inflow - outflow, first_date: first, last_date: last }
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
  it('counts the days of a month nothing happened in, because they elapsed', () => {
    // February holds no rows and still belongs in the denominator: the average is over the span the
    // chart covers, not over the months that happened to have activity.
    const series = buildCashFlowTrendSeries(
      [month('2026-01', 400, 100), month('2026-03', 400, 100)], CASH_FLOW_TREND_LAST_12,
    )

    expect(keys(series)).toHaveLength(3)
    // 2026-01-01 through 2026-03-28 inclusive is 87 days; the net is 600 over that span.
    expect(series.avgNet).toBeCloseTo(600 / (87 / 30.436875), 6)
  })

  it('divides by elapsed days rather than by the buckets drawn', () => {
    // One bucket, but only nine days of it. Dividing by the bucket count would report the whole 900 as
    // a month's worth; the real rate is more than three times that.
    const series = buildCashFlowTrendSeries(
      [month('2026-04', 1000, 100, { first: '2026-04-01', last: '2026-04-09' })], CASH_FLOW_TREND_LAST_12,
    )
    expect(series.avgNet).toBeNull()
  })

  it('has no average at all with nothing to average', () => {
    // Not zero: an average of nothing is not a figure, and zero reads as one.
    const series = buildCashFlowTrendSeries([], CASH_FLOW_TREND_LAST_12)
    expect(series.chartData).toEqual([])
    expect(series.avgNet).toBeNull()
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

describe('the yearly series', () => {
  it('keeps the sign contract and draws a year with no rows as an empty year', () => {
    const { chartData, avgNet } = buildCashFlowAnnualSeries([
      { year: '2023', inflow: 50000, outflow: 42000, net: 8000,
        first_date: '2023-01-05', last_date: '2023-12-20' },
      { year: '2025', inflow: 60000, outflow: 64000, net: -4000,
        first_date: '2025-01-09', last_date: '2025-11-30' },
    ])
    expect(chartData.map(r => r.year)).toEqual(['2023', '2024', '2025'])
    expect(chartData[0]).toMatchObject({ inflow: 50000, outflow: -42000, outflowMagnitude: 42000, net: 8000 })
    expect(chartData[1]).toMatchObject({ inflow: 0, outflow: -0, net: 0 })
    // Three year buckets, but 2023-01-05 to 2025-11-30 is 1061 days — a little under three years. The
    // old mean-of-buckets said 4000/3; the span is what divides now, and the gap year is inside it.
    expect(avgNet).toBeCloseTo(4000 / (1061 / 365.2425), 6)
  })

  it('is empty with no rows', () => {
    expect(buildCashFlowAnnualSeries([]).chartData).toEqual([])
  })
})
