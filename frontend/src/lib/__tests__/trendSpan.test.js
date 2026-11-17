// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest'
import {
  TREND_SPAN_ALL,
  describeTrendSpan, parseTrendSpan, trendSpanFloorMonth, trendSpanFloorYear,
} from '../trendSpan.js'
import { calendarTrendBuckets } from '../trendBuckets.js'

describe('parseTrendSpan', () => {
  it('reads the preset values', () => {
    expect(parseTrendSpan(TREND_SPAN_ALL)).toEqual({ kind: 'all' })
    expect(parseTrendSpan('5y')).toEqual({ kind: 'years', years: 5 })
  })

  // A value from another build — including the start month an older one stored — or a hand-edited
  // preference must show too much rather than nothing, and always be an entry the chooser has.
  it('falls back to all data on anything that is not a preset', () => {
    for (const value of [null, undefined, '', 'last5', '0y', '7y', 'since:2019-07', 'since:2019-13']) {
      expect(parseTrendSpan(value)).toEqual({ kind: 'all' })
    }
  })
})

describe('trendSpanFloorMonth', () => {
  it('counts a year span back from the anchor inclusively', () => {
    // Five years ending with 2026-10 is 2021-11 through 2026-10, not 2021-10.
    expect(trendSpanFloorMonth('5y', '2026-10')).toBe('2021-11')
    expect(trendSpanFloorMonth('3y', '2026-10')).toBe('2023-11')
  })

  // The same stretch of history, in whole buckets of whatever the chart draws: 3 years is 36 months,
  // 12 quarters or 3 years, and the oldest bar is never a fragment.
  it('counts whole buckets of the grain being drawn', () => {
    expect(trendSpanFloorMonth('3y', '2026-10', 'month')).toBe('2023-11')
    expect(trendSpanFloorMonth('3y', '2026-10', 'quarter')).toBe('2024-01')
    expect(trendSpanFloorMonth('3y', '2026-10', 'year')).toBe('2024-01')
    expect(trendSpanFloorMonth('3y', '2026-02', 'quarter')).toBe('2023-04')
  })

  it('counts back from the chart end it is given, so an older selection shows its own history', () => {
    expect(trendSpanFloorMonth('3y', '2020-06')).toBe('2017-07')
  })

  it('is null for all data, and for a year span with nothing to count back from', () => {
    expect(trendSpanFloorMonth(TREND_SPAN_ALL, '2026-10')).toBeNull()
    expect(trendSpanFloorMonth('5y', null)).toBeNull()
  })
})

describe('trendSpanFloorYear', () => {
  // Whole years: five years is five year bars, not four and a ten-month fragment of 2021.
  it('counts whole calendar years back from the anchor', () => {
    expect(trendSpanFloorYear('5y', '2026-10')).toBe('2022')
    expect(trendSpanFloorYear('3y', '2020-12')).toBe('2018')
    expect(trendSpanFloorYear(TREND_SPAN_ALL, '2026-10')).toBeNull()
  })
})

// The span counts back from where the chart ends, which on the single-period trend is the selected
// period: the chart is the history leading up to it, and nothing after.
describe('as the range the trend buckets are built from', () => {
  const years = (span, date, end) => calendarTrendBuckets({
    firstMonth: trendSpanFloorMonth(span, end, 'year') || '2014-03',
    lastMonth: end,
    grain: 'year',
    date,
  }).map(b => b.start.slice(0, 4))

  it('ends at the selection and reaches back the span from there', () => {
    expect(years('3y', null, '2026-10')).toEqual(['2024', '2025', '2026'])
    expect(years('3y', { start: '2025-01-01', end: '2025-12-31' }, '2025-12')).toEqual(['2023', '2024', '2025'])
    expect(years(TREND_SPAN_ALL, null, '2026-10')[0]).toBe('2014')
  })

  it('still draws the whole of a selection longer than the span', () => {
    expect(years('3y', { start: '2019-01-01', end: '2025-12-31' }, '2025-12')[0]).toBe('2019')
  })
})

describe('describeTrendSpan', () => {
  it('names a value for a chart subtitle, which already says what it totals', () => {
    expect(describeTrendSpan(TREND_SPAN_ALL)).toBe('across all data')
    expect(describeTrendSpan('3y', { anchorMonth: '2026-11' })).toBe('over 3 years')
  })

  it('names where the chart starts when a selection widened it past the span', () => {
    expect(describeTrendSpan('3y', { firstBucket: '2019-01', grain: 'year', anchorMonth: '2025-12' }))
      .toBe('since 2019')
    expect(describeTrendSpan('3y', { firstBucket: '2019-07', grain: 'month', anchorMonth: '2025-12' }))
      .toBe('since Jul 2019')
    expect(describeTrendSpan('3y', { firstBucket: '2023-01', grain: 'year', anchorMonth: '2025-12' }))
      .toBe('over 3 years')
  })
})
