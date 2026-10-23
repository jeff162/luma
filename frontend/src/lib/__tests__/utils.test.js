import { describe, it, expect } from 'vitest'
import { localIsoDate } from '../utils.js'

describe('localIsoDate', () => {
  it('uses local parts, so the default is not yesterday west of Greenwich', () => {
    // toISOString converts to UTC; an afternoon in a negative-offset zone lands on the previous day.
    const evening = new Date(2026, 7, 14, 21, 30)
    expect(localIsoDate(evening)).toBe('2026-08-14')
  })

  it('pads single-digit months and days', () => {
    expect(localIsoDate(new Date(2026, 0, 5, 12))).toBe('2026-01-05')
  })
})
