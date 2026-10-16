// The narrow exception to absolute timestamps — see `formatRelativeTimestamp`'s own comment for why it
// is an exception rather than a default.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { formatRelativeTimestamp, formatTimestamp, parseTimestamp } from '../utils.js'

const NOW = new Date('2026-09-05T12:00:00Z').getTime()
const ago = (ms) => new Date(NOW - ms).toISOString()

// Pinned away from UTC for the whole file. The bug these guard is that a zone-less timestamp is read
// in the runner's own zone, so in a UTC runner the wrong behaviour and the right one are identical and
// every assertion below would pass against the unfixed code.
const ORIGINAL_TZ = process.env.TZ
beforeAll(() => { process.env.TZ = 'America/New_York' })
afterAll(() => { process.env.TZ = ORIGINAL_TZ })

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

describe('formatRelativeTimestamp', () => {
  it('steps through the units as the value ages', () => {
    expect(formatRelativeTimestamp(ago(5 * SECOND), NOW)).toBe('just now')
    expect(formatRelativeTimestamp(ago(3 * MINUTE), NOW)).toBe('3m ago')
    expect(formatRelativeTimestamp(ago(5 * HOUR), NOW)).toBe('5h ago')
    expect(formatRelativeTimestamp(ago(3 * DAY), NOW)).toBe('3d ago')
  })

  it('never rounds a real age down to zero', () => {
    // "0m ago" is both wrong and unreadable; anything past the "just now" band has to name a unit.
    expect(formatRelativeTimestamp(ago(50 * SECOND), NOW)).toBe('1m ago')
  })

  it('falls back to a date once the age stops being easier to read than one', () => {
    // "23d ago" is harder to place than a date, and a short date fits the narrow chrome just as well.
    expect(formatRelativeTimestamp(ago(23 * DAY), NOW)).not.toMatch(/ago/)
  })

  it('reports a future timestamp as "just now" rather than counting upward from it', () => {
    // The only way to get one is clock skew against the server; a negative age reads as an app bug.
    expect(formatRelativeTimestamp(new Date(NOW + HOUR).toISOString(), NOW)).toBe('just now')
  })

  it('returns null for a missing or unparseable value, so callers own the empty state', () => {
    expect(formatRelativeTimestamp(null, NOW)).toBeNull()
    expect(formatRelativeTimestamp('', NOW)).toBeNull()
    expect(formatRelativeTimestamp('not a date', NOW)).toBeNull()
  })
})

// The backend's timestamps are UTC and carry no zone, which `new Date` reads as local time. Both
// formatters therefore have to be told. These use the two shapes the backend actually produces —
// `utcnow_iso()`'s `T` with microseconds, and a SQLite `datetime('now')` default's space, no fraction.
describe('parseTimestamp', () => {
  it('reads a zone-less timestamp as UTC, in both shapes the backend writes', () => {
    expect(parseTimestamp('2026-09-05T12:00:00.123456').toISOString()).toBe('2026-09-05T12:00:00.123Z')
    expect(parseTimestamp('2026-09-05 12:00:00').toISOString()).toBe('2026-09-05T12:00:00.000Z')
    expect(parseTimestamp('2026-09-05T12:00').toISOString()).toBe('2026-09-05T12:00:00.000Z')
  })

  it('leaves a value that already states its zone alone', () => {
    expect(parseTimestamp('2026-09-05T12:00:00Z').toISOString()).toBe('2026-09-05T12:00:00.000Z')
    expect(parseTimestamp('2026-09-05T08:00:00-04:00').toISOString()).toBe('2026-09-05T12:00:00.000Z')
  })

  it('leaves a date-only value alone, which is already UTC and would change day if touched', () => {
    expect(parseTimestamp('2026-09-05').toISOString()).toBe('2026-09-05T00:00:00.000Z')
  })

  it('gives an unparseable value back as an invalid date for the caller to reject', () => {
    expect(Number.isNaN(parseTimestamp('not a time').getTime())).toBe(true)
    expect(Number.isNaN(parseTimestamp(null).getTime())).toBe(true)
  })
})

describe('timestamps written without a zone', () => {
  it('does not report a sync from hours ago as having just happened', () => {
    // The bug this exists for: read as local, a UTC timestamp looks like the future, and the age
    // clamps at zero — so the sync freshness indicator claimed "just now" for a whole UTC offset.
    const threeHoursAgoUtc = '2026-09-05T09:00:00'
    expect(formatRelativeTimestamp(threeHoursAgoUtc, NOW)).toBe('3h ago')
  })

  it('shows the same moment whichever way the backend spelled it', () => {
    expect(formatTimestamp('2026-09-05 09:00:00')).toBe(formatTimestamp('2026-09-05T09:00:00Z'))
  })
})
