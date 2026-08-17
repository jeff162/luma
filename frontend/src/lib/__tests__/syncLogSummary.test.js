import { describe, expect, it } from 'vitest'

import {
  allowanceSummary, cardSummary, checkpointSummary, finalStatusSummary, historyDepthSummary,
  parseCheckpoint, requestPoolSummary, skippedBreakdown, windowSummary,
} from '../syncLogSummary.js'

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

  it('collapses a walk to its outer span, without restating the request count', () => {
    // The count is `requested_windows.length`, which the row's own counts line already shows. Printing it
    // here too read as two figures that happen to agree.
    const windows = [
      { start: '2026-06-28', end: '2026-08-12' },
      { start: '2026-05-14', end: '2026-06-28' },
      { start: '2026-03-30', end: '2026-05-14' },
    ]
    expect(windowSummary(windows)).toBe('fetched Mar 30, 2026 – Aug 12, 2026')
  })

  it('is null when the adapter named no window', () => {
    expect(windowSummary([])).toBeNull()
    expect(windowSummary(undefined)).toBeNull()
  })
})

describe('historyDepthSummary', () => {
  it('reconciles the depth asked for against the depth a paused walk reached', () => {
    // The motivating row: ten years asked for, ~2.6 of them fetched before the request allowance ran out.
    // Side by side and unreconciled, the two figures read as a contradiction.
    const windows = [{ start: '2024-01-14', end: '2024-02-28' }, { start: '2026-07-02', end: '2026-08-16' }]
    expect(historyDepthSummary(3650, windows)).toBe('asked for 10 years, reached 2 yr 7 mo')
  })

  it('drops the shortfall when the walk got what it asked for', () => {
    // A walk's last window overshoots by up to its own width, so this is a near-match, not an equality.
    const windows = [{ start: '2026-06-20', end: '2026-08-16' }]
    expect(historyDepthSummary(60, windows)).toBe('asked for 2 months')
  })

  it('states the depth alone for a provider that names no window', () => {
    // A cursor provider asks for "everything since this token"; nothing here can say how far back it got.
    expect(historyDepthSummary(730, [])).toBe('asked for 2 years')
  })

  it('is null when no depth was requested', () => {
    expect(historyDepthSummary(null, [])).toBeNull()
    expect(historyDepthSummary(0, [])).toBeNull()
  })
})

describe('allowanceSummary', () => {
  const METER = { capacity: 22, refill_per_hour: 1 }

  it('says what is left on the shared bucket', () => {
    expect(allowanceSummary({ ...METER, pools: { shared: 6.4 } }))
      .toBe('6 of 22 shared requests left')
  })

  it('floors rather than rounds, since this is a spendable count', () => {
    // Claiming a request the server has not granted is the error that costs a disabled token.
    expect(allowanceSummary({ ...METER, pools: { shared: 5.9 } })).toBe('5 of 22 shared requests left')
  })

  it('names how long until the next request when everything is spent', () => {
    const text = allowanceSummary({ ...METER, pools: { shared: 0.25 } })
    expect(text).toBe('0 of 22 shared requests left · next request in ~45 min')
  })

  it('counts the accounts that ran dry, which a shared figure cannot show', () => {
    // The state that fills a log with pause markers on a pull that was making progress throughout: one
    // account is out while its siblings keep walking.
    const text = allowanceSummary({ ...METER, pools: { shared: 9, 'p:a': 0, 'p:b': 0, 'p:c': 4 } })
    expect(text).toBe('9 of 22 shared requests left · 2 accounts out of allowance · next request in ~1 hr')
  })

  it('reports the thinnest account while all of them still have room', () => {
    const text = allowanceSummary({ ...METER, pools: { shared: 20, 'p:a': 3.2 } })
    expect(text).toBe('20 of 22 shared requests left · 3 left on the thinnest account')
  })

  it('is null for a provider that meters nothing, and for a row that recorded no allowance', () => {
    // Distinct from a measured zero, which is why the column carries no default.
    expect(allowanceSummary(null)).toBeNull()
    expect(allowanceSummary({ ...METER, pools: {} })).toBeNull()
  })
})

describe('requestPoolSummary', () => {
  it('says which bucket paid, since a bare total reconciles against neither', () => {
    const windows = [
      { start: '2026-08-01', end: '2026-08-16', pool: 'shared' },
      { start: '2026-06-17', end: '2026-08-01', pool: 'shared' },
      { start: '2026-05-03', end: '2026-06-17', pool: 'p:a' },
    ]
    expect(requestPoolSummary(windows)).toBe('2 shared, 1 charged to 1 account')
  })

  it('is null when the adapter recorded no attribution', () => {
    // Rows predating the field, and cursor providers, which name no window at all.
    expect(requestPoolSummary([{ start: '2026-08-01', end: '2026-08-16' }])).toBeNull()
    expect(requestPoolSummary([])).toBeNull()
  })
})

describe('skippedBreakdown', () => {
  const recorded = '{"provider:acct": {"added": 1}}'   // presence is the "breakdown was recorded" signal

  it('splits the total into the buckets that mean opposite things', () => {
    const parts = skippedBreakdown({
      skipped: 31, skipped_no_account: 3, skipped_already_held: 26, mode: 'routine',
      account_counts: recorded,
    })
    expect(parts.map(p => [p.key, p.count, p.tone])).toEqual([
      ['no_account', 3, 'warning'],
      ['already_held', 26, 'muted'],
      ['zero_amount', 2, 'muted'],
    ])
  })

  it('names an all-zero-amount sync rather than falling back to the bare total', () => {
    // The shape a provider reporting balance-only rows produces: both counters legitimately 0 against a
    // real total. Reading "no breakdown" off the counters alone hid exactly this case.
    const parts = skippedBreakdown({
      skipped: 31, skipped_no_account: 0, skipped_already_held: 0, account_counts: recorded,
    })
    expect(parts.map(p => [p.key, p.count])).toEqual([['zero_amount', 31]])
  })

  it('uses the connection card’s wording, since the card deep-links here', () => {
    const parts = skippedBreakdown({ skipped: 3, skipped_no_account: 3, account_counts: recorded })
    expect(parts[0].label).toBe('No destination')
  })

  it('tones already-imported as a problem only on a first pull', () => {
    // The incremental overlap re-asks for held days on purpose, so this is routine on a top-up. On an
    // initial pull nothing should be held yet, which is the contradiction the card also flags.
    const initial = skippedBreakdown({
      skipped: 4, skipped_already_held: 4, mode: 'initial', account_counts: recorded,
    })
    expect(initial[0].tone).toBe('warning')
    const routine = skippedBreakdown({
      skipped: 4, skipped_already_held: 4, mode: 'routine', account_counts: recorded,
    })
    expect(routine[0].tone).toBe('muted')
  })

  it('omits buckets that caught nothing', () => {
    const parts = skippedBreakdown({ skipped: 4, skipped_already_held: 4, account_counts: recorded })
    expect(parts.map(p => p.key)).toEqual(['already_held'])
  })

  it('is null for a row written before the breakdown existed', () => {
    // Such a row has no `account_counts`, which is what separates it from a genuine all-zero-amount sync
    // — the counters read 0/0 in both cases, and deriving from that alone confuses the two.
    expect(skippedBreakdown({ skipped: 31, skipped_no_account: 0, skipped_already_held: 0 })).toBeNull()
  })

  it('is null when nothing was skipped', () => {
    expect(skippedBreakdown({ skipped: 0, account_counts: recorded })).toBeNull()
    expect(skippedBreakdown(undefined)).toBeNull()
  })
})

describe('finalStatusSummary', () => {
  it('puts a metered walk stopping on its allowance into words', () => {
    // Luma's own marker rather than a provider value, which is what made it worst as a raw chip. The
    // wording avoids promising the next sync will resume it: the bucket refills on its own clock.
    expect(finalStatusSummary('BUDGET_PAUSED'))
      .toBe('paused on the provider’s request allowance — resumes once it refills')
  })

  it('keeps a provider refusal apart from this app declining to ask', () => {
    // Opposite failures wearing the same outcome: one means the limit worked, the other means our model
    // of it is wrong, and only the second is a bug.
    expect(finalStatusSummary('RATE_LIMITED'))
      .toBe('the provider refused a request — its limit was reached before this app’s own count said so')
  })

  it('reads the provider vocabulary it knows', () => {
    expect(finalStatusSummary('HISTORICAL_UPDATE_COMPLETE')).toBe('all available history delivered')
    expect(finalStatusSummary('INITIAL_UPDATE_COMPLETE'))
      .toBe('recent transactions delivered, history still filling in')
  })

  it('is null for a provider that reports no status, so the row shows no status line', () => {
    expect(finalStatusSummary(null)).toBeNull()
    expect(finalStatusSummary(undefined)).toBeNull()
  })

  it('is null for a value it does not recognize, so the caller shows the raw token', () => {
    // A provider vocabulary this mapping predates must still leave evidence on the row.
    expect(finalStatusSummary('SOME_FUTURE_STATUS')).toBeNull()
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
