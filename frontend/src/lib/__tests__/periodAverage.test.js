// The denominator rule every average on the Dashboard now shares: elapsed days between the first and
// last transaction in the window, never a count of buckets — and no figure at all for a unit the
// window does not cover.

import { describe, expect, it } from 'vitest'
import { periodAverage, seriesDateRange, spanDays, spansWholeUnit } from '../periodAverage.js'

describe('spanDays', () => {
  it('counts both ends', () => {
    expect(spanDays('2026-01-01', '2026-01-01')).toBe(1)
    expect(spanDays('2026-01-01', '2026-01-31')).toBe(31)
  })

  it('is null where an end is missing or reversed', () => {
    expect(spanDays(null, '2026-01-31')).toBeNull()
    expect(spanDays('2026-02-01', '2026-01-31')).toBeNull()
  })
})

describe('periodAverage', () => {
  it('divides by elapsed days, not by how many buckets were drawn', () => {
    // Twelve monthly buckets would divide 1200 by 12 and say 100/mo. The window is 2015-01-11 to
    // 2015-12-31 — 355 days, a little under a year — so the true monthly rate is higher.
    const avg = periodAverage(1200, '2015-01-11', '2015-12-31', 'month')
    expect(avg).toBeCloseTo(1200 / (355 / 30.436875), 6)
    expect(avg).toBeGreaterThan(100)
  })

  it('does not let a partial end year count as a whole one', () => {
    // Two calendar years of buckets, but only 14 months of data. Bucket-counting would divide by 2.
    const avg = periodAverage(1400, '2025-01-01', '2026-02-28', 'year')
    expect(avg).toBeCloseTo(1400 / (424 / 365.2425), 6)
    expect(avg).toBeGreaterThan(1400 / 2)
  })

  it('counts a gap in the middle, because those days did elapse', () => {
    // Nothing happened for ten months between the two transactions; the rate is over the whole span.
    expect(periodAverage(600, '2025-01-01', '2026-01-01', 'year'))
      .toBeCloseTo(600 / (366 / 365.2425), 6)
  })

  it('refuses a yearly rate the window cannot support', () => {
    // Four months of data extrapolated to a year is a forecast, not a summary.
    expect(periodAverage(4000, '2026-01-01', '2026-04-30', 'year')).toBeNull()
    // The same money does support a monthly rate.
    expect(periodAverage(4000, '2026-01-01', '2026-04-30', 'month')).not.toBeNull()
  })

  it('refuses a monthly rate below a month, including the fresh-install case', () => {
    expect(periodAverage(400, '2026-10-01', '2026-10-03', 'month')).toBeNull()
    expect(periodAverage(400, '2026-10-01', '2026-10-03', 'year')).toBeNull()
  })

  it('accepts exactly one unit, by the calendar rather than by an average length', () => {
    // 28 days is a whole month when the month is February; 28 days of March is not.
    expect(spansWholeUnit('2026-02-01', '2026-02-28', 'month')).toBe(true)
    expect(spansWholeUnit('2026-03-01', '2026-03-28', 'month')).toBe(false)
    expect(spansWholeUnit('2025-01-01', '2025-12-31', 'year')).toBe(true)
    expect(spansWholeUnit('2025-01-02', '2025-12-31', 'year')).toBe(false)
  })

  it('averages per quarter where that is the grain on screen', () => {
    // The single-period trend charts quarters as well as months and years, and the same partial-bucket
    // problem applies: a part-finished quarter at the end must not divide as a whole one.
    expect(periodAverage(900, '2026-01-01', '2026-03-31', 'quarter'))
      .toBeCloseTo(900 / (90 / 91.310625), 6)
    expect(periodAverage(900, '2026-01-01', '2026-02-15', 'quarter')).toBeNull()
  })

  it('is null rather than zero for an unusable total', () => {
    expect(periodAverage(undefined, '2024-01-01', '2026-01-01', 'year')).toBeNull()
  })
})

describe('seriesDateRange', () => {
  it('takes the real dates and skips buckets the axis filled in', () => {
    const rows = [
      { month: '2025-11', first_date: null, last_date: null },
      { month: '2025-12', first_date: '2025-12-14', last_date: '2025-12-30' },
      { month: '2026-01', first_date: null, last_date: null },
      { month: '2026-02', first_date: '2026-02-02', last_date: '2026-02-09' },
    ]
    expect(seriesDateRange(rows)).toEqual({ firstDate: '2025-12-14', lastDate: '2026-02-09' })
  })

  it('is null-ended when nothing carries a date', () => {
    expect(seriesDateRange([{ month: '2026-01' }])).toEqual({ firstDate: null, lastDate: null })
    expect(seriesDateRange([])).toEqual({ firstDate: null, lastDate: null })
  })
})
