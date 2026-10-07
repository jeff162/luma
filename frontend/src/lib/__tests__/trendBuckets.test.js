import { describe, it, expect } from 'vitest'
import {
  shiftMonth, lastDayOfMonthISO, trendsWindowRange, trendsWindowMonths, resolveTrendsWindowKey,
  shiftDateByMonths, defaultTrendGrain, sameSpanStepMonths, trendGrainOptions, effectiveTrendGrain,
  calendarTrendBuckets, sameSpanTrendBuckets, SAME_SPAN_MAX_BUCKETS, TREND_GRAIN_SAME_SPAN,
} from '../trendBuckets.js'

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

// The FilterBar presets as they resolve on 2026-10-07, the shapes the single-period trend has to handle.
const PRESETS = {
  monthToDate: { start: '2026-10-01', end: '2026-10-07' },
  lastMonth: { start: '2026-09-01', end: '2026-09-30' },
  yearToDate: { start: '2026-01-01', end: '2026-10-07' },
  lastYear: { start: '2025-01-01', end: '2025-12-31' },
  past12Months: { start: '2025-10-07', end: '2026-10-07' },
  last30Days: { start: '2026-09-08', end: '2026-10-07' },
  last90Days: { start: '2026-07-10', end: '2026-10-07' },
}

describe('shiftDateByMonths', () => {
  it('clamps to the target month, and keeps a span end on the month end only when asked', () => {
    expect(shiftDateByMonths('2026-03-31', -1)).toBe('2026-02-28')
    expect(shiftDateByMonths('2026-09-30', 1)).toBe('2026-10-30')
    expect(shiftDateByMonths('2026-09-30', 1, { stickToMonthEnd: true })).toBe('2026-10-31')
    expect(shiftDateByMonths('2026-10-07', -12)).toBe('2025-10-07')
  })
})

describe('the single-period trend grain', () => {
  it('opens at the unit a selection is, or the one nearest its length', () => {
    expect(defaultTrendGrain(null)).toBe('month')
    expect(defaultTrendGrain(PRESETS.lastMonth)).toBe('month')
    expect(defaultTrendGrain(PRESETS.lastYear)).toBe('year')
    expect(defaultTrendGrain({ start: '2026-07-01', end: '2026-09-30' })).toBe('quarter')
    expect(defaultTrendGrain(PRESETS.monthToDate)).toBe('month')
    expect(defaultTrendGrain(PRESETS.last30Days)).toBe('month')
    expect(defaultTrendGrain(PRESETS.last90Days)).toBe('quarter')
    expect(defaultTrendGrain(PRESETS.yearToDate)).toBe('year')
    expect(defaultTrendGrain(PRESETS.past12Months)).toBe('year')
  })

  it('offers same-span only for a selection that is not a calendar unit, stepping by the smallest unit it fits', () => {
    expect(sameSpanStepMonths(PRESETS.monthToDate)).toBe(1)
    expect(sameSpanStepMonths(PRESETS.last30Days)).toBe(1)
    expect(sameSpanStepMonths(PRESETS.last90Days)).toBe(3)
    expect(sameSpanStepMonths(PRESETS.yearToDate)).toBe(12)
    expect(sameSpanStepMonths(PRESETS.past12Months)).toBe(12)
    expect(sameSpanStepMonths(PRESETS.lastMonth)).toBe(null)
    expect(sameSpanStepMonths(PRESETS.lastYear)).toBe(null)
    expect(sameSpanStepMonths({ start: '2024-03-01', end: '2026-10-07' })).toBe(null)
    expect(sameSpanStepMonths({ start: null, end: null })).toBe(null)
    expect(trendGrainOptions(PRESETS.yearToDate).map(o => o.value)).toEqual(['month', 'quarter', 'year', TREND_GRAIN_SAME_SPAN])
    expect(trendGrainOptions(PRESETS.lastMonth).map(o => o.value)).toEqual(['month', 'quarter', 'year'])
  })

  it('drops a same-span pick the selection no longer supports, and keeps a calendar pick', () => {
    expect(effectiveTrendGrain(TREND_GRAIN_SAME_SPAN, PRESETS.yearToDate)).toBe(TREND_GRAIN_SAME_SPAN)
    expect(effectiveTrendGrain(TREND_GRAIN_SAME_SPAN, PRESETS.lastMonth)).toBe('month')
    expect(effectiveTrendGrain('year', PRESETS.lastMonth)).toBe('year')
    expect(effectiveTrendGrain(null, PRESETS.past12Months)).toBe('year')
  })
})

describe('calendarTrendBuckets', () => {
  it('highlights every bucket a non-calendar selection overlaps', () => {
    const buckets = calendarTrendBuckets({ firstMonth: '2024-01', lastMonth: '2026-10', grain: 'month', date: PRESETS.past12Months })
    const selected = buckets.filter(b => b.isSelected).map(b => b.start)
    // Oct 7 '25 – Oct 7 '26 touches both Octobers.
    expect(selected).toEqual(monthsBetween('2025-10', '2026-10'))
    const years = calendarTrendBuckets({ firstMonth: '2024-01', lastMonth: '2026-10', grain: 'year', date: PRESETS.past12Months })
    expect(years.map(b => [b.start, b.isSelected])).toEqual([['2024-01', false], ['2025-01', true], ['2026-01', true]])
  })

  it('snaps quarters to the calendar and widens to take in a selection outside the data', () => {
    const buckets = calendarTrendBuckets({ firstMonth: '2025-05', lastMonth: '2025-08', grain: 'quarter', date: { start: '2026-01-01', end: '2026-01-31' } })
    expect(buckets.map(b => [b.rangeStart, b.rangeEnd])).toEqual([
      ['2025-04-01', '2025-06-30'], ['2025-07-01', '2025-09-30'],
      ['2025-10-01', '2025-12-31'], ['2026-01-01', '2026-03-31'],
    ])
    expect(buckets.map(b => b.isSelected)).toEqual([false, false, false, true])
  })
})

describe('sameSpanTrendBuckets', () => {
  it('repeats year to date day-for-day in every year of the data', () => {
    const buckets = sameSpanTrendBuckets({ date: PRESETS.yearToDate, firstMonth: '2024-03', lastMonth: '2026-10', today: '2026-10-07' })
    expect(buckets.map(b => [b.rangeStart, b.rangeEnd, b.label, b.isSelected])).toEqual([
      ['2024-01-01', '2024-10-07', '2024', false],
      ['2025-01-01', '2025-10-07', '2025', false],
      ['2026-01-01', '2026-10-07', '2026', true],
    ])
    expect(buckets[0].fullLabel).toBe('Jan 1 – Oct 7, 2024')
  })

  it('compares month to date against the same days of earlier months, not whole months', () => {
    const buckets = sameSpanTrendBuckets({ date: PRESETS.monthToDate, firstMonth: '2026-08', lastMonth: '2026-10', today: '2026-10-07' })
    expect(buckets.map(b => [b.rangeStart, b.rangeEnd])).toEqual([
      ['2026-08-01', '2026-08-07'], ['2026-09-01', '2026-09-07'], ['2026-10-01', '2026-10-07'],
    ])
  })

  it('tiles a rolling 30 days back without gaps, and stops at today', () => {
    const buckets = sameSpanTrendBuckets({ date: PRESETS.last30Days, firstMonth: '2026-07', lastMonth: '2026-10', today: '2026-10-07' })
    expect(buckets.map(b => [b.rangeStart, b.rangeEnd])).toEqual([
      ['2026-06-08', '2026-07-07'], ['2026-07-08', '2026-08-07'],
      ['2026-08-08', '2026-09-07'], ['2026-09-08', '2026-10-07'],
    ])
  })

  it('yields the same bars around a clicked bar, so the chart stays put', () => {
    const before = sameSpanTrendBuckets({ date: PRESETS.yearToDate, firstMonth: '2020-01', lastMonth: '2026-10', today: '2026-10-07' })
    const clicked = before[2]
    const after = sameSpanTrendBuckets({ date: { start: clicked.rangeStart, end: clicked.rangeEnd }, firstMonth: '2020-01', lastMonth: '2026-10', today: '2026-10-07' })
    expect(after.map(b => b.rangeStart)).toEqual(before.map(b => b.rangeStart))
    expect(after.findIndex(b => b.isSelected)).toBe(2)
  })

  it('caps a long history at the newest buckets, never dropping the selection', () => {
    const newest = sameSpanTrendBuckets({ date: PRESETS.monthToDate, firstMonth: '2000-01', lastMonth: '2026-10', today: '2026-10-07' })
    expect(newest).toHaveLength(SAME_SPAN_MAX_BUCKETS)
    expect(newest[newest.length - 1].isSelected).toBe(true)
    const old = sameSpanTrendBuckets({ date: { start: '2001-03-01', end: '2001-03-07' }, firstMonth: '2000-01', lastMonth: '2026-10', today: '2026-10-07' })
    expect(old).toHaveLength(SAME_SPAN_MAX_BUCKETS)
    expect(old.some(b => b.isSelected)).toBe(true)
  })
})

function monthsBetween(a, b) {
  const out = []
  for (let m = a; m <= b; m = shiftMonth(m, 1)) out.push(m)
  return out
}
