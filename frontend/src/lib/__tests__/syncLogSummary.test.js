import { describe, expect, it } from 'vitest'

import {
  cardSummary, checkpointSummary, connectionEventSummary, finalStatusSummary,
  historyDepthSummary, parseCheckpoint, requestPoolSummary, skippedBreakdown, syncModeLabel, windowSummary,
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
  // The server sums these from `account_counts` and sends them named. Nothing here subtracts, which is the
  // property under test: the previous shape recovered the zero-amount bucket from the total's remainder,
  // so every bucket added after it was silently absorbed into whichever one was computed last.
  const breakdown = (over = {}) => ({
    skipped_by_choice: 0, skipped_unknown_account: 0,
    skipped_already_held: 0, skipped_zero_amount: 0, ...over,
  })

  it('splits the total into the buckets that mean opposite things', () => {
    const parts = skippedBreakdown({
      mode: 'routine',
      skipped_breakdown: breakdown({
        skipped_by_choice: 6, skipped_unknown_account: 3, skipped_already_held: 26,
        skipped_zero_amount: 2,
      }),
    })
    expect(parts.map(p => [p.key, p.count, p.tone])).toEqual([
      ['skipped_by_choice', 6, 'muted'],
      ['skipped_unknown_account', 3, 'warning'],
      ['skipped_already_held', 26, 'muted'],
      ['skipped_zero_amount', 2, 'muted'],
    ])
  })

  it('keeps a deliberately skipped account clear of the actionable wording', () => {
    // The two halves of the split read as opposite advice, which is the whole reason it exists. "Map the
    // account to import them" is wrong for an account the user excluded on purpose — there is nothing to
    // fix, and saying otherwise is what made a correctly-configured connection look broken.
    const [byChoice, unknown] = skippedBreakdown({
      skipped_breakdown: breakdown({ skipped_by_choice: 6, skipped_unknown_account: 3 }),
    })
    expect(byChoice.label).toBe('Not imported')
    expect(byChoice.tone).toBe('muted')
    expect(byChoice.title).not.toMatch(/Map the account/)
    expect(unknown.label).toBe('No destination')
    expect(unknown.tone).toBe('warning')
    expect(unknown.title).toMatch(/Map the account/)
  })

  it('names an all-zero-amount sync rather than falling back to the bare total', () => {
    // The shape a provider reporting balance-only rows produces. It used to be the remainder, and so was
    // indistinguishable from any bucket the client did not know about.
    const parts = skippedBreakdown({ skipped_breakdown: breakdown({ skipped_zero_amount: 31 }) })
    expect(parts.map(p => [p.key, p.count])).toEqual([['skipped_zero_amount', 31]])
  })

  it('reports a row written before the split under its legacy bucket', () => {
    // The server still emits `skipped_no_account` for rows that predate the split, since which kind they
    // were is not recoverable. A log spanning the change stays truthful rather than reporting old skips
    // as zero.
    const parts = skippedBreakdown({ skipped_breakdown: { skipped_no_account: 4 } })
    expect(parts.map(p => [p.key, p.count, p.label])).toEqual([
      ['skipped_no_account', 4, 'No destination'],
    ])
  })

  it('tones already-imported as a problem only on a first pull', () => {
    // The incremental overlap re-asks for held days on purpose, so this is routine on a top-up. On a
    // first pull nothing should be held yet, which is the contradiction the card also flags — and now
    // the only one that does.
    const counts = { skipped_breakdown: breakdown({ skipped_already_held: 4 }) }
    expect(skippedBreakdown({ ...counts, mode: 'initial' })[0].tone).toBe('warning')
    expect(skippedBreakdown({ ...counts, mode: 'routine' })[0].tone).toBe('muted')
  })

  it('reads the server’s verdict rather than re-deriving one', () => {
    // The judgement lives in one place (`unexplained_already_held`, backend), because three surfaces
    // render it — this row, the connection card's chip, and the outcome pill — and while each derived it
    // from `mode` they disagreed about the same sync in front of the user.
    const counts = { skipped_breakdown: breakdown({ skipped_already_held: 26 }), mode: 'initial' }
    expect(skippedBreakdown({ ...counts, already_held_unexplained: 0 })[0].tone).toBe('muted')
    expect(skippedBreakdown({ ...counts, already_held_unexplained: 3 })[0].tone).toBe('warning')
    // Including when the server says the *raw* count is entirely routine overlap on a first pull — the
    // walk re-seeing its own pages, which no client-side reading of `mode` or `cursor_before` can spot.
    expect(skippedBreakdown({ ...counts, cursor_before: null, already_held_unexplained: 0 })[0].tone)
      .toBe('muted')
  })

  it('does not call a resumed backfill a contradiction', () => {
    // `mode` alone cannot answer "is this the first pull". A metered provider delivers its initial
    // backfill over as many syncs as its allowance allows, and every one of them is still `initial`,
    // because what flips the mode is the backfill completing. Each resumption re-asks for a window it has
    // already partly fetched, so already-held rows are what it is *supposed* to produce — painted orange
    // on every sync, for as long as the backfill took. `cursor_before` is the resume point it started
    // from, and only a call with none had nothing to have already fetched.
    const counts = { skipped_breakdown: breakdown({ skipped_already_held: 26 }), mode: 'initial' }
    const resumed = skippedBreakdown({ ...counts, cursor_before: 'through=2026-08-18' })[0]
    expect(resumed.tone).toBe('muted')
    expect(resumed.title).toMatch(/on purpose/)
    const firstPull = skippedBreakdown({ ...counts, cursor_before: null })[0]
    expect(firstPull.tone).toBe('warning')
    expect(firstPull.title).toMatch(/should not happen/)
  })

  it('falls back to the older reading for rows written before the server sent a verdict', () => {
    // Log rows are kept across upgrades, so a row with no `already_held_unexplained` still has to render
    // something defensible — the cursor-based reading it had before.
    const counts = { skipped_breakdown: breakdown({ skipped_already_held: 26 }), mode: 'initial' }
    expect(skippedBreakdown({ ...counts, cursor_before: 'through=2026-08-18' })[0].tone).toBe('muted')
    expect(skippedBreakdown({ ...counts, cursor_before: null })[0].tone).toBe('warning')
  })

  it('omits buckets that caught nothing', () => {
    const parts = skippedBreakdown({ skipped_breakdown: breakdown({ skipped_already_held: 4 }) })
    expect(parts.map(p => p.key)).toEqual(['skipped_already_held'])
  })

  it('is null for a row that recorded no breakdown at all', () => {
    // Distinct from every-bucket-zero: "nothing was recorded" and "measured, and the answer is none" are
    // different facts, and a row predating the tally must not render as a clean sync.
    expect(skippedBreakdown({ skipped: 31 })).toBeNull()
    expect(skippedBreakdown({ skipped: 31, skipped_breakdown: null })).toBeNull()
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

describe('syncModeLabel', () => {
  // `mode` stores whether the backfill was unfinished, not whether THIS pull started it. A metered
  // provider pausing on its allowance leaves several pulls all labelled `initial`, reading as several
  // first syncs; `cursor_before` is what separates the one that began from the ones that resumed.

  it('names the pull that started the backfill', () => {
    expect(syncModeLabel({ mode: 'initial', cursor_before: null })).toBe('initial')
    expect(syncModeLabel({ mode: 'initial', cursor_before: '' })).toBe('initial')
  })

  it('names a resumed backfill as continuing', () => {
    expect(syncModeLabel({ mode: 'initial', cursor_before: 'through=2026-08-18' }))
      .toBe('initial · continuing')
  })

  it('says continuing for the pull that finally finishes, which is what it did', () => {
    // It continued, and it finished — the row's own `backfill complete` badge carries the second half,
    // so the mode chip has no need to contradict itself trying to say both.
    expect(syncModeLabel({ mode: 'initial', cursor_before: 'through=2026-08-18', became_complete: true }))
      .toBe('initial · continuing')
  })

  it('leaves a routine top-up unlabelled', () => {
    // Nearly every row is one, so only the history pulls are marked.
    expect(syncModeLabel({ mode: 'routine', cursor_before: 'through=2026-08-18' })).toBeNull()
  })

  it('passes through anything it does not recognize, and nulls an absent mode', () => {
    // A mode this build predates must still render as itself rather than vanish.
    expect(syncModeLabel({ mode: 'backfill' })).toBe('backfill')
    expect(syncModeLabel({})).toBeNull()
    expect(syncModeLabel(undefined)).toBeNull()
  })
})

describe('connectionEventSummary', () => {
  it('leaves a sync row to the fields that describe it', () => {
    expect(connectionEventSummary({ event: 'sync' })).toBeNull()
    // Every row written before the column existed was a sync.
    expect(connectionEventSummary({})).toBeNull()
  })

  it('lets a failure speak through its error rather than a success sentence', () => {
    const summary = connectionEventSummary({ event: 'connect', error: 'Plaid: bad secret (INVALID_API_KEYS)' })
    expect(summary.label).toBeTruthy()
    expect(summary.text).toBeNull()
  })

  it('tells a revoking disconnect from one that ended access only here', () => {
    const revoked = connectionEventSummary({ event: 'disconnect', detail: { revoked: true } })
    const localOnly = connectionEventSummary({
      event: 'disconnect', detail: { revoked: false, reason: 'provider_cannot_revoke' },
    })
    expect(revoked.text).toBeTruthy()
    expect(localOnly.text).toBeTruthy()
    expect(localOnly.text).not.toEqual(revoked.text)
  })
})
