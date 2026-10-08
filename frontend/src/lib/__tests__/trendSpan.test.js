// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest'
import {
  TREND_SPAN_ALL,
  describeTrendSpan, parseTrendSpan, trendSpanFloorMonth, trendSpanFloorYear,
} from '../trendSpan.js'
import { calendarTrendBuckets } from '../trendBuckets.js'

describe('parseTrendSpan', () => {
  it('reads the three value forms', () => {
    expect(parseTrendSpan(TREND_SPAN_ALL)).toEqual({ kind: 'all' })
    expect(parseTrendSpan('5y')).toEqual({ kind: 'years', years: 5 })
    expect(parseTrendSpan('since:2019-07')).toEqual({ kind: 'since', month: '2019-07' })
  })

  // A value from a newer build, or a hand-edited preference, must show too much rather than nothing.
  it('falls back to all data on anything it does not recognise', () => {
    for (const value of [null, undefined, '', 'last5', '0y', 'since:2019', 'since:2019-13']) {
      expect(parseTrendSpan(value)).toEqual({ kind: 'all' })
    }
  })
})

describe('trendSpanFloorMonth', () => {
  it('counts a year span back from the anchor inclusively', () => {
    // Five years ending with 2026-10 is 2021-11 through 2026-10, not 2021-10.
    expect(trendSpanFloorMonth('5y', '2026-10')).toBe('2021-11')
    expect(trendSpanFloorMonth('1y', '2026-10')).toBe('2025-11')
  })

  // The same stretch of history, in whole buckets of whatever the chart draws: 3 years is 36 months,
  // 12 quarters or 3 years, and the oldest bar is never a fragment.
  it('counts whole buckets of the grain being drawn', () => {
    expect(trendSpanFloorMonth('3y', '2026-10', 'month')).toBe('2023-11')
    expect(trendSpanFloorMonth('3y', '2026-10', 'quarter')).toBe('2024-01')
    expect(trendSpanFloorMonth('3y', '2026-10', 'year')).toBe('2024-01')
    expect(trendSpanFloorMonth('3y', '2026-02', 'quarter')).toBe('2023-04')
  })

  it('anchors on the data, so a ledger that stopped years ago still shows its last years', () => {
    expect(trendSpanFloorMonth('3y', '2020-06')).toBe('2017-07')
  })

  it('takes a since value as the floor and ignores the anchor', () => {
    expect(trendSpanFloorMonth('since:2019-07', '2026-10')).toBe('2019-07')
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
    expect(trendSpanFloorYear('1y', '2026-10')).toBe('2026')
    expect(trendSpanFloorYear(TREND_SPAN_ALL, '2026-10')).toBeNull()
  })

  // A since value is exact, so its own year is the floor and that year's bar is drawn whole.
  it('keeps the year a since month falls in', () => {
    expect(trendSpanFloorYear('since:2019-07', '2026-10')).toBe('2019')
  })
})

// The span floors where the *data* starts, which is the whole of its effect on the single-period
// trend's two bucket builders. The pairing matters because a selection outside the span must still be
// drawn — a chart captioned with a period it does not contain is the defect being avoided.
describe('as the floor the trend buckets are built from', () => {
  const floored = (span, date) => calendarTrendBuckets({
    firstMonth: trendSpanFloorMonth(span, '2026-10', 'year') || '2014-03',
    lastMonth: '2026-10',
    grain: 'year',
    date,
  }).map(b => b.start.slice(0, 4))

  it('starts the bars at the span, not at the first transaction', () => {
    expect(floored('3y', null)).toEqual(['2024', '2025', '2026'])
    expect(floored(TREND_SPAN_ALL, null)[0]).toBe('2014')
  })

  it('still reaches a selected period older than the span', () => {
    expect(floored('3y', { start: '2019-01-01', end: '2019-12-31' })[0]).toBe('2019')
  })
})

describe('describeTrendSpan', () => {
  it('names a value for a chart subtitle, which already says what it totals', () => {
    expect(describeTrendSpan(TREND_SPAN_ALL)).toBe('across all data')
    expect(describeTrendSpan('3y')).toBe('across the last 3 years')
    expect(describeTrendSpan('since:2019-07')).toBe('since Jul 2019')
  })
})
