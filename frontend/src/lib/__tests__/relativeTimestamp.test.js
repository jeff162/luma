// The narrow exception to absolute timestamps — see `formatRelativeTimestamp`'s own comment for why it
// is an exception rather than a default.

import { describe, expect, it } from 'vitest'
import { formatRelativeTimestamp } from '../utils.js'

const NOW = new Date('2026-09-05T12:00:00Z').getTime()
const ago = (ms) => new Date(NOW - ms).toISOString()

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
