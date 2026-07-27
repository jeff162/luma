// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest'
import { isYearToDateRange, computeTrendBuckets, shiftMonth } from '../trendBuckets.js'

describe('shiftMonth', () => {
  it('crosses year boundaries in both directions', () => {
    expect(shiftMonth('2026-01', -1)).toBe('2025-12')
    expect(shiftMonth('2026-07', -12)).toBe('2025-07')
    expect(shiftMonth('2026-11', 3)).toBe('2027-02')
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
