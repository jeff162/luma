// The provider card header's one line, and the precedence that keeps it from contradicting the button
// sitting beside it.

import { describe, expect, it } from 'vitest'
import { connectionAccountsLabel, providerSummaryLine, connectionProviderLabel, providerConnectionStates, recentFullSync, relinkCandidates, syncedSince, syncFreshness, syncNavLabel } from '../connectionSummary.js'

describe('providerSummaryLine', () => {
  it('reports a running sync instead of the freshness it supersedes', () => {
    // The bug this exists for: `last_synced_at` is stamped on successful pulls only, so a connection's
    // first sync said "never synced" in the same header row as a disabled "Syncing…" button.
    expect(providerSummaryLine({ connectionCount: 1, syncing: true }))
      .toBe('1 connection · syncing…')
  })

  it('supersedes a real last-synced time too, not just a missing one', () => {
    // Otherwise the fix would only hold for a first sync, and a routine top-up would go on advertising a
    // staleness nobody is asking about while the pull that resolves it is running.
    expect(providerSummaryLine({
      connectionCount: 3, syncing: true, lastSyncedLabel: '8/17/2026, 02:52 PM',
    })).toBe('3 connections · syncing…')
  })

  it('says a connection has never completed a pull rather than falling silent', () => {
    // "No date" is the finding, not an absence of one — a connection that has never synced is exactly
    // what a user opening this card needs told.
    expect(providerSummaryLine({ connectionCount: 1 }))
      .toBe('1 connection · never synced')
  })

  it('names the freshness when there is one and nothing is running', () => {
    expect(providerSummaryLine({ connectionCount: 2, lastSyncedLabel: '8/17/2026, 02:52 PM' }))
      .toBe('2 connections · last synced 8/17/2026, 02:52 PM')
  })

  it('says nothing about syncing before there is anything to sync', () => {
    // No connections means the card is a setup step; a freshness or progress clause there would describe
    // work that cannot be happening.
    expect(providerSummaryLine({ connectionCount: 0, syncing: true })).toBe('Not connected')
    expect(providerSummaryLine()).toBe('Not connected')
  })
})


describe('relinkCandidates', () => {
  const connections = [
    { id: 'c1', institution: 'Harborline Bridge', reauth_required: 1 },
    { id: 'c2', institution: 'Harborline Bridge', reauth_required: 0 },
  ]

  it('asks nothing of a provider that issues its own handle', () => {
    // Its `external_id` already answers "which connection is this?", so the upsert lands the credential on
    // the right row. Asking would be a question with one possible answer.
    expect(relinkCandidates({ stable_external_id: true, connections })).toEqual([])
  })

  it('offers every connection where the handle rides the credential', () => {
    // Working ones included: a credential spanning several institutions is re-authorized routinely, with
    // nothing wrong with the connection being replaced, so a list of only failing ones hides the common
    // case that motivates this.
    expect(relinkCandidates({ stable_external_id: false, connections })).toEqual(connections)
  })

  it('has nothing to offer before the first connection exists', () => {
    expect(relinkCandidates({ stable_external_id: false, connections: [] })).toEqual([])
    expect(relinkCandidates({ stable_external_id: false })).toEqual([])
  })

  it('treats an unstated capability as stable, which is the safe direction', () => {
    // A provider that never declared it gets no question rather than a spurious one — and the check is
    // `!== false` precisely so an absent field cannot read as "ask".
    expect(relinkCandidates({ connections })).toEqual([])
    expect(relinkCandidates(null)).toEqual([])
  })
})

describe('connectionAccountsLabel', () => {
  it('names the accounts, since the institution cannot tell two connections apart', () => {
    // The whole reason this exists: a provider spanning several banks reports one institution string for
    // every connection, so a list keyed on it offers the user identical choices.
    expect(connectionAccountsLabel(['Everyday Checking', 'Savings'])).toBe('Everyday Checking, Savings')
  })

  it('caps the list, because the point is recognition rather than an inventory', () => {
    expect(connectionAccountsLabel(['A', 'B', 'C', 'D', 'E'])).toBe('A, B, C +2 more')
  })

  it('says nothing at all rather than something empty', () => {
    // A connection whose accounts have not been mapped yet has no distinguishing text to give, and a
    // stray separator would read as a name that failed to load.
    expect(connectionAccountsLabel([])).toBeNull()
    expect(connectionAccountsLabel(['', '  ', null])).toBeNull()
  })
})

describe('syncFreshness', () => {
  const at = t => ({ last_synced_at: t })

  it('reports the connection furthest behind, not the most recent one', () => {
    // The whole reason a standing indicator exists: one connection synced minutes ago must not let the
    // control claim everything is current while another has not synced in a month.
    const f = syncFreshness([
      { provider: 'plaid', connections: [at('2026-09-05T07:40:00Z')] },
      { provider: 'simplefin', connections: [at('2026-08-04T20:12:00Z')] },
    ])
    expect(f.lastSynced).toBe('2026-08-04T20:12:00Z')
    expect(f.connectionCount).toBe(2)
  })

  it('keeps a never-synced connection out of the oldest date and counts it separately', () => {
    // Folding it in would replace a readable date with "never" the first time a connection was added,
    // which says less than the date plus the count does.
    const f = syncFreshness([
      { provider: 'plaid', connections: [at('2026-09-05T07:40:00Z'), at(null)] },
    ])
    expect(f.lastSynced).toBe('2026-09-05T07:40:00Z')
    expect(f.neverSynced).toBe(1)
    expect(f.connectionCount).toBe(2)
  })

  it('applies the same oldest-wins rule within a provider', () => {
    const f = syncFreshness([
      { provider: 'simplefin', connections: [at('2026-09-05T07:40:00Z'), at('2026-09-01T09:00:00Z')] },
    ])
    expect(f.byProvider).toEqual([
      { provider: 'simplefin', connectionCount: 2, lastSynced: '2026-09-01T09:00:00Z', neverSynced: 0 },
    ])
  })

  it('ignores a configured provider with nothing connected', () => {
    // It has no freshness to report, and listing it would put a permanent "never synced" line in the
    // tooltip for a provider the user has not set up.
    const f = syncFreshness([
      { provider: 'plaid', connections: [] },
      { provider: 'simplefin', connections: [at('2026-09-05T07:40:00Z')] },
    ])
    expect(f.byProvider.map(p => p.provider)).toEqual(['simplefin'])
    expect(f.connectionCount).toBe(1)
  })

  it('says nothing rather than guessing when nothing has ever synced', () => {
    const f = syncFreshness([{ provider: 'plaid', connections: [at(null), at(null)] }])
    expect(f.lastSynced).toBeNull()
    expect(f.neverSynced).toBe(2)
  })

  it('reports an empty install as having nothing to sync', () => {
    expect(syncFreshness([])).toEqual({
      connectionCount: 0, lastSynced: null, neverSynced: 0, byProvider: [],
    })
    expect(syncFreshness().connectionCount).toBe(0)
  })
})

describe('syncNavLabel', () => {
  it('reports a running sync instead of the freshness it supersedes', () => {
    // Same precedence as the provider card's own line: nobody wants to be told how stale the data was
    // while the pull fixing it is running.
    expect(syncNavLabel({ driving: true, relativeLabel: '3d ago' })).toBe('Syncing…')
    expect(syncNavLabel({ driving: true, added: 142, relativeLabel: '3d ago' })).toBe('Syncing — 142 imported')
  })

  it('keeps naming the finished run until its summary has been seen', () => {
    // The row is the way back to the panel at this point, so it must not read as an invitation to start
    // a second pull.
    expect(syncNavLabel({ finished: true, relativeLabel: 'just now' })).toBe('Sync finished')
  })

  it('reports freshness only when nothing is happening', () => {
    expect(syncNavLabel({ relativeLabel: '2h ago' })).toBe('Sync · 2h ago')
  })

  it('says a connection has never synced rather than falling silent', () => {
    // "No date" is the finding, not an absence of one.
    expect(syncNavLabel({})).toBe('Sync · never run')
    expect(syncNavLabel()).toBe('Sync · never run')
  })
})

describe('connectionProviderLabel', () => {
  it('uses the product name the user signed up to, not the ledger\'s short form', () => {
    // The transaction-origin label in `importSourceFields.js` says "SimpleFIN" because it sits in a dense
    // row. On a surface where the provider is being set up, the full name is what was matched against.
    expect(connectionProviderLabel('simplefin')).toBe('SimpleFIN Bridge')
    expect(connectionProviderLabel('plaid')).toBe('Plaid')
  })

  it('names an unknown provider rather than leaving the label blank', () => {
    expect(connectionProviderLabel('northgate')).toBe('Northgate')
    expect(connectionProviderLabel('')).toBe('Provider')
    expect(connectionProviderLabel()).toBe('Provider')
  })

  it('is case-insensitive, since the key arrives from the server', () => {
    expect(connectionProviderLabel('SimpleFIN')).toBe('SimpleFIN Bridge')
  })
})

describe('providerConnectionStates', () => {
  const conn = (over = {}) => ({ id: 'c1', last_synced_at: '2026-09-05T07:40:00Z', ...over })

  it('reports a connection needing reconnection only as that, never also as failing', () => {
    // Both pills would name one connection, and only one of them says something the user can act on.
    const p = { connections: [conn({ reauth_required: true, consecutive_sync_failures: 4 })] }
    const s = providerConnectionStates(p)
    expect(s.reauth).toHaveLength(1)
    expect(s.failing).toHaveLength(0)
  })

  it('still counts a plain failure that is not a reconnection', () => {
    const p = { connections: [conn({ consecutive_sync_failures: 2 })] }
    expect(providerConnectionStates(p).failing).toHaveLength(1)
  })

  it('takes the oldest successful pull, so one healthy connection cannot mask a stale one', () => {
    const p = { connections: [
      conn({ id: 'a', last_synced_at: '2026-09-05T07:40:00Z' }),
      conn({ id: 'b', last_synced_at: '2026-08-04T20:12:00Z' }),
    ] }
    const s = providerConnectionStates(p)
    expect(s.lastSynced).toBe('2026-08-04T20:12:00Z')
    expect(s.allSynced).toBe(true)
  })

  it('says not every connection has synced when one never has', () => {
    const p = { connections: [conn({ id: 'a' }), conn({ id: 'b', last_synced_at: null })] }
    expect(providerConnectionStates(p).allSynced).toBe(false)
  })

  it('totals the caller\'s per-connection mapping and review counts', () => {
    // Passed in rather than read here: they come from other endpoints, and taking them as arguments is
    // what makes the rule above testable without a server.
    const p = { connections: [conn({ id: 'a' }), conn({ id: 'b' })] }
    const s = providerConnectionStates(p, {
      unmappedByConnection: { a: 2, b: 1 },
      reviewByConnection: { a: { suspects: 3 }, b: { suspects: 0 } },
    })
    expect(s.unmapped).toBe(3)
    expect(s.review).toBe(3)
  })

  it('is safe on a provider with nothing connected', () => {
    const s = providerConnectionStates({ connections: [] })
    expect(s).toMatchObject({ unmapped: 0, review: 0, lastSynced: null, allSynced: false })
    expect(providerConnectionStates().connections).toEqual([])
  })
})

describe('recentFullSync', () => {
  const at = t => ({ last_synced_at: t })
  const now = Date.parse('2026-09-05T08:00:00Z')

  it('asks only when the connection furthest behind is inside the window', () => {
    expect(recentFullSync([
      { provider: 'plaid', connections: [at('2026-09-05T07:50:00Z')] },
      { provider: 'simplefin', connections: [at('2026-09-05T07:40:00Z')] },
    ], now)).toBe('2026-09-05T07:40:00Z')
    expect(recentFullSync([
      { provider: 'plaid', connections: [at('2026-09-05T07:50:00Z')] },
      { provider: 'simplefin', connections: [at('2026-09-03T07:40:00Z')] },
    ], now)).toBeNull()
  })

  it('does not ask while any connection has never synced', () => {
    expect(recentFullSync([
      { provider: 'plaid', connections: [at('2026-09-05T07:50:00Z'), at(null)] },
    ], now)).toBeNull()
  })
})

describe('syncedSince', () => {
  const listing = (...connections) => [{ provider: 'plaid', connections }]

  it('sees a connection whose last sync moved forward, and nothing when none did', () => {
    const before = listing({ id: 'c1', last_synced_at: '2026-09-03T07:40:00Z' })
    expect(syncedSince(before, listing({ id: 'c1', last_synced_at: '2026-09-05T07:40:00Z' }))).toBe(true)
    expect(syncedSince(before, listing({ id: 'c1', last_synced_at: '2026-09-03T07:40:00Z' }))).toBe(false)
  })

  it('counts a connection added elsewhere once it has synced', () => {
    const before = listing({ id: 'c1', last_synced_at: '2026-09-03T07:40:00Z' })
    const after = listing({ id: 'c1', last_synced_at: '2026-09-03T07:40:00Z' }, { id: 'c2', last_synced_at: null })
    expect(syncedSince(before, after)).toBe(false)
    after[0].connections[1].last_synced_at = '2026-09-05T07:40:00Z'
    expect(syncedSince(before, after)).toBe(true)
  })
})
