import { describe, it, expect } from 'vitest'
import { isYearToDateRange, computeTrendBuckets, shiftMonth, lastDayOfMonthISO, trendsWindowRange, trendsWindowMonths, resolveTrendsWindowKey } from '../trendBuckets.js'

describe('shiftMonth', () => {
  it('crosses year boundaries in both directions', () => {
    expect(shiftMonth('2026-01', -1)).toBe('2025-12')
    expect(shiftMonth('2026-07', -12)).toBe('2025-07')
    expect(shiftMonth('2026-11', 3)).toBe('2027-02')
  })
})

describe('lastDayOfMonthISO', () => {
  it('knows month lengths, including a leap February', () => {
    expect(lastDayOfMonthISO('2026-04')).toBe('2026-04-30')
    expect(lastDayOfMonthISO('2028-02')).toBe('2028-02-29')
    expect(lastDayOfMonthISO('2026-02')).toBe('2026-02-28')
  })
})

describe('trendsWindowRange', () => {
  it('covers the twelve months ending with the current one, to its last day', () => {
    expect(trendsWindowRange('last12', '2026-09')).toEqual({
      key: 'last12', startMonth: '2025-10', endMonth: '2026-09', start: '2025-10-01', end: '2026-09-30', label: 'Last 12 months',
    })
  })
  it('covers a whole calendar year for a year pick', () => {
    expect(trendsWindowRange('2024', '2026-09')).toEqual({
      key: '2024', startMonth: '2024-01', endMonth: '2024-12', start: '2024-01-01', end: '2024-12-31', label: '2024',
    })
  })
})

describe('trendsWindowMonths', () => {
  it('runs across every month of a past year, including the ones with no rows', () => {
    const months = trendsWindowMonths(trendsWindowRange('2023', '2026-09'), '2026-09', '2019-04')
    expect(months).toHaveLength(12)
    expect(months[0]).toBe('2023-01')
    expect(months).toContain('2023-02')
    expect(months[11]).toBe('2023-12')
  })
  it('stops at the current month rather than drawing months that have not happened', () => {
    const months = trendsWindowMonths(trendsWindowRange('2026', '2026-09'), '2026-09', '2019-04')
    expect(months[months.length - 1]).toBe('2026-09')
    expect(months).toHaveLength(9)
  })
  it('starts at the first month of data when the ledger begins inside the window', () => {
    expect(trendsWindowMonths(trendsWindowRange('last12', '2026-09'), '2026-09', '2026-06'))
      .toEqual(['2026-06', '2026-07', '2026-08', '2026-09'])
  })
  it('has no months without data, or when the data starts after the window', () => {
    expect(trendsWindowMonths(trendsWindowRange('2023', '2026-09'), '2026-09', null)).toEqual([])
    expect(trendsWindowMonths(trendsWindowRange('2023', '2026-09'), '2026-09', '2024-02')).toEqual([])
  })
})

describe('resolveTrendsWindowKey', () => {
  const rows = months => months.map(month => ({ month, series_id: 'g', total: 1 }))

  it('honours an explicit pick even where it holds no data', () => {
    expect(resolveTrendsWindowKey(rows(['2026-08']), '2019', '2026-09')).toBe('2019')
  })
  it('opens on the last twelve months when they hold data', () => {
    expect(resolveTrendsWindowKey(rows(['2021-03', '2025-10']), null, '2026-09')).toBe('last12')
  })
  it('falls back to the most recent year with data when the last twelve months are empty', () => {
    // 2025-09 is one month before the window starts, so it must not count as recent data.
    expect(resolveTrendsWindowKey(rows(['2023-02', '2025-09', '2024-11']), null, '2026-09')).toBe('2025')
  })
  it('stays on the last twelve months when there is no data at all, and ignores malformed months', () => {
    expect(resolveTrendsWindowKey([], null, '2026-09')).toBe('last12')
    expect(resolveTrendsWindowKey([{ month: null }, { month: '2024' }], null, '2026-09')).toBe('last12')
  })
})

describe('isYearToDateRange', () => {
  it('is true for a Jan-1-anchored partial year', () => {
    expect(isYearToDateRange({ start: '2026-01-01', end: '2026-07-27' })).toBe(true)
  })
  it('is false for a full calendar year (nothing to align differently)', () => {
    expect(isYearToDateRange({ start: '2026-01-01', end: '2026-12-31' })).toBe(false)
  })
  it('is false when it does not start on Jan 1 (e.g. Last 30 days beginning Jan 5)', () => {
    expect(isYearToDateRange({ start: '2026-01-05', end: '2026-02-03' })).toBe(false)
  })
  it('is false for month-to-date', () => {
    expect(isYearToDateRange({ start: '2026-07-01', end: '2026-07-27' })).toBe(false)
  })
  it('is false with no date', () => {
    expect(isYearToDateRange(null)).toBe(false)
  })
})

describe('computeTrendBuckets — year to date', () => {
  const ytd = { start: '2026-01-01', end: '2026-07-27' }

  it('steps a full year and spans Jan→end month, prior years only', () => {
    const { buckets, bucketMonths, yearToDate } = computeTrendBuckets(ytd, { earlierCount: 3 })
    expect(yearToDate).toBe(true)
    expect(bucketMonths).toBe(7) // Jan..Jul
    // No lookahead: the selected bucket is the last one.
    expect(buckets[buckets.length - 1].isSelected).toBe(true)
    // Each bar is the same Jan→Jul window of consecutive years.
    expect(buckets.map(b => [b.start, b.end])).toEqual([
      ['2023-01', '2023-07'],
      ['2024-01', '2024-07'],
      ['2025-01', '2025-07'],
      ['2026-01', '2026-07'],
    ])
    // Labeled by year so same-range bars are distinguishable.
    expect(buckets.map(b => b.label)).toEqual(['2023', '2024', '2025', '2026'])
  })
})

describe('computeTrendBuckets — non-YTD is unchanged', () => {
  it('tiles contiguous month-wide buckets for a single month with a lookahead', () => {
    const { buckets, bucketMonths, yearToDate } = computeTrendBuckets(
      { start: '2026-07-01', end: '2026-07-31' },
      { earlierCount: 2, laterCount: 1 },
    )
    expect(yearToDate).toBe(false)
    expect(bucketMonths).toBe(1)
    expect(buckets.map(b => b.start)).toEqual(['2026-05', '2026-06', '2026-07', '2026-08'])
    expect(buckets.find(b => b.isSelected).start).toBe('2026-07')
    expect(buckets.every(b => b.label === undefined)).toBe(true) // labels derived downstream
  })

  it('tiles contiguous multi-month windows immediately prior (e.g. a ~90-day range)', () => {
    const { buckets, bucketMonths } = computeTrendBuckets(
      { start: '2026-05-01', end: '2026-07-30' }, // ~3 months
      { earlierCount: 2, laterCount: 0 },
    )
    expect(bucketMonths).toBe(3)
    expect(buckets.map(b => [b.start, b.end])).toEqual([
      ['2025-11', '2026-01'],
      ['2026-02', '2026-04'],
      ['2026-05', '2026-07'],
    ])
  })
})
