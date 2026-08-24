import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { resolveDashboardDefaultDate, initialDefaultPref } from '../dashboardDefaultPeriod.js'

describe('resolveDashboardDefaultDate', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-30T12:00:00'))
  })
  afterEach(() => vi.useRealTimers())

  it('ytd runs from Jan 1 to today', () => {
    expect(resolveDashboardDefaultDate('ytd')).toEqual({ start: '2026-01-01', end: '2026-07-30', preset: 'Year to date' })
  })

  it('last12m runs a year back to today', () => {
    expect(resolveDashboardDefaultDate('last12m')).toEqual({ start: '2025-07-30', end: '2026-07-30', preset: 'Last 12 months' })
  })

  it('all resolves to null (all-time)', () => {
    expect(resolveDashboardDefaultDate('all')).toBeNull()
  })

  it('an unknown/missing pref falls back to all-time (null)', () => {
    expect(resolveDashboardDefaultDate(undefined)).toBeNull()
  })

  it('concrete presets end at today', () => {
    for (const pref of ['ytd', 'last12m']) {
      expect(resolveDashboardDefaultDate(pref).end).toBe('2026-07-30')
    }
  })
})

describe('initialDefaultPref (first-visit seed)', () => {
  it('seeds Last 12 months when the last 12 months has data', () => {
    expect(initialDefaultPref(true)).toBe('last12m')
  })
  it('seeds All time when there is no recent data', () => {
    expect(initialDefaultPref(false)).toBe('all')
  })
})
