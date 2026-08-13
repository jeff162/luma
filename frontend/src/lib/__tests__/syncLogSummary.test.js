import { describe, expect, it } from 'vitest'

import { cardSummary, checkpointSummary, parseCheckpoint, windowSummary } from '../syncLogSummary.js'

// The fingerprint format these read is produced by `_cursor_fingerprint` in backend/routers/sync.py and
// travels as a plain string, so nothing but these cases keeps the two ends in step. The fallback
// behaviour matters as much as the happy path: every function returns null when it cannot interpret its
// input, which is what makes the caller show the raw value instead of a confidently wrong sentence.

describe('parseCheckpoint', () => {
  it('reads the key=value pairs a JSON checkpoint is rendered as', () => {
    expect(parseCheckpoint('through=2026-08-12, budget_date=2026-08-12, requests_used=1')).toEqual({
      through: '2026-08-12', budget_date: '2026-08-12', requests_used: '1',
    })
  })

  it('keeps a value containing its own separator', () => {
    // An opaque token's leading slice is arbitrary characters; splitting on every `=` would truncate it.
    expect(parseCheckpoint('len=32·ab=cd')).toEqual({ len: '32·ab=cd' })
  })

  it('is null for an absent or unparseable fingerprint', () => {
    expect(parseCheckpoint(null)).toBeNull()
    expect(parseCheckpoint('none')).toBeNull()
  })
})

describe('checkpointSummary', () => {
  it('says how far the connection is caught up and what it moved from', () => {
    const text = checkpointSummary(
      'through=2026-08-10, budget_date=2026-08-10, requests_used=1',
      'through=2026-08-12, budget_date=2026-08-12, requests_used=1',
    )
    expect(text).toBe('caught up through Aug 12, 2026 (was Aug 10, 2026) · 1 request used today')
  })

  it('omits the previous position when the pull did not advance it', () => {
    const text = checkpointSummary('through=2026-08-12, requests_used=3', 'through=2026-08-12, requests_used=4')
    expect(text).toBe('caught up through Aug 12, 2026 · 4 requests used today')
  })

  it('is null for an opaque paging token, so the caller shows the raw fingerprint', () => {
    // A cursor provider's token has no interpretable keys. Saying nothing is required, not merely tidy:
    // whether that token advanced is the first question a stalled sync raises.
    expect(checkpointSummary('len=32·eyJhbGci', 'len=32·eyJhbGci')).toBeNull()
    expect(checkpointSummary(null, null)).toBeNull()
  })
})

describe('windowSummary', () => {
  it('names a single fetched range', () => {
    expect(windowSummary([{ start: '2026-08-05', end: '2026-08-12' }]))
      .toBe('fetched Aug 5, 2026 – Aug 12, 2026')
  })

  it('collapses a walk to its outer span and the requests it cost', () => {
    const windows = [
      { start: '2026-06-28', end: '2026-08-12' },
      { start: '2026-05-14', end: '2026-06-28' },
      { start: '2026-03-30', end: '2026-05-14' },
    ]
    expect(windowSummary(windows)).toBe('fetched Mar 30, 2026 – Aug 12, 2026 across 3 requests')
  })

  it('is null when the adapter named no window', () => {
    expect(windowSummary([])).toBeNull()
    expect(windowSummary(undefined)).toBeNull()
  })
})

describe('cardSummary', () => {
  it('drops the institution prefix the log row already shows', () => {
    const cards = [
      { card: 'SimpleFIN Bridge · August 2026', added: 5 },
      { card: 'SimpleFIN Bridge · July 2026', added: 6 },
    ]
    expect(cardSummary(cards, 'SimpleFIN Bridge')).toBe('August 2026 (5), July 2026 (6)')
  })

  it('leaves a card name that does not carry the prefix intact', () => {
    expect(cardSummary([{ card: 'Other Bank · August 2026', added: 1 }], 'SimpleFIN Bridge'))
      .toBe('Other Bank · August 2026 (1)')
  })

  it('is null when the pull added nothing', () => {
    expect(cardSummary([], 'SimpleFIN Bridge')).toBeNull()
  })
})
