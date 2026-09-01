// The provider card header's one line, and the precedence that keeps it from contradicting the button
// sitting beside it.

import { describe, expect, it } from 'vitest'
import { connectionAccountsLabel, providerSummaryLine, relinkCandidates } from '../connectionSummary.js'

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
