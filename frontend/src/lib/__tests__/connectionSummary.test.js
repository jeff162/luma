// The provider card header's one line, and the precedence that keeps it from contradicting the button
// sitting beside it.

import { describe, expect, it } from 'vitest'
import { providerSummaryLine } from '../connectionSummary.js'

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
