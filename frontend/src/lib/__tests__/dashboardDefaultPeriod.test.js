// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { resolveDashboardDefaultDate } from '../dashboardDefaultPeriod.js'

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

  it('auto with current-year data → Last 12 months', () => {
    expect(resolveDashboardDefaultDate('auto', true)).toEqual({ start: '2025-07-30', end: '2026-07-30', preset: 'Last 12 months' })
  })

  it('auto without current-year data → all-time (null)', () => {
    expect(resolveDashboardDefaultDate('auto', false)).toBeNull()
  })

  it('auto with unknown probe result falls back to all-time (null)', () => {
    expect(resolveDashboardDefaultDate('auto', undefined)).toBeNull()
  })

  it('every option ends at today', () => {
    for (const pref of ['ytd', 'last12m']) {
      expect(resolveDashboardDefaultDate(pref).end).toBe('2026-07-30')
    }
  })
})
