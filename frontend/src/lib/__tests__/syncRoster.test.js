import { describe, expect, it } from 'vitest'
import {
  addToRoster, foldLiveProgress, foldResponse, rosterAdded, rosterMayHaveChangedLedger, rosterRequests,
} from '../syncRoster.js'

const seed = (...ids) => addToRoster([], ids.map(id => ({
  connectionId: id, provider: 'acme', institution: `${id} Bank`,
})))

// One call's response, in the shape POST /sync returns.
const response = (id, added, extra = {}) => ([{
  connection_id: id, institution: `${id} Bank`, added, updated: 0, removed: 0, skipped: 0,
  error: null, ...extra,
}])

// One providers-listing tick: a connection mid-call, with whatever it has committed.
const tick = (id, progress) => ([{
  connectionId: id, provider: 'acme', institution: `${id} Bank`,
  syncing: !!progress, progress: progress || null,
}])

describe('the run roster', () => {
  it('seeds a row per connection and keeps the order they arrived in', () => {
    const roster = seed('a', 'b')
    expect(roster.map(e => e.connectionId)).toEqual(['a', 'b'])
    expect(roster.map(rosterAdded)).toEqual([0, 0])
  })

  it('does not duplicate a connection the roster already holds', () => {
    const roster = addToRoster(seed('a'), [{ connectionId: 'a', provider: 'acme', institution: 'A Bank' }])
    expect(roster).toHaveLength(1)
  })

  // The whole reason totals come from responses: the driver makes many calls and each response describes
  // only its own, so a run total is their sum.
  it('sums a connection’s totals across the run’s calls', () => {
    let roster = seed('a')
    roster = foldResponse(roster, response('a', 12), 'acme')
    roster = foldResponse(roster, response('a', 7), 'acme')
    expect(rosterAdded(roster[0])).toBe(19)
  })

  it('adds the call in flight to what earlier calls settled', () => {
    let roster = foldResponse(seed('a'), response('a', 12), 'acme')
    roster = foldLiveProgress(roster, tick('a', { added: 3, requests: 2 }))
    expect(rosterAdded(roster[0])).toBe(15)
    expect(rosterRequests(roster[0])).toBe(2)
  })

  // The response ends the call the live figure was describing. Counting both would inflate the row for a
  // whole poll interval — the window between the response landing and the next tick clearing it.
  it('does not double-count the in-flight call once its response lands', () => {
    let roster = foldLiveProgress(seed('a'), tick('a', { added: 5, requests: 2 }))
    roster = foldResponse(roster, response('a', 5), 'acme')
    expect(rosterAdded(roster[0])).toBe(5)
    expect(rosterRequests(roster[0])).toBe(2)
  })

  // Between the driver's calls nothing is running and `sync_progress` is cleared, so the roster has to
  // hold its figures across that gap rather than reading them off the tick.
  it('holds its totals through the gap between calls', () => {
    let roster = foldResponse(seed('a'), response('a', 12), 'acme')
    roster = foldLiveProgress(roster, tick('a', null))
    expect(rosterAdded(roster[0])).toBe(12)
  })

  it('accumulates requests across calls', () => {
    let roster = foldLiveProgress(seed('a'), tick('a', { added: 1, requests: 3 }))
    roster = foldLiveProgress(roster, tick('a', null))
    roster = foldLiveProgress(roster, tick('a', { added: 4, requests: 2 }))
    expect(rosterRequests(roster[0])).toBe(5)
  })

  // A sync this tab did not start has no responses to read. Its rows fall back to the last progress the
  // poll saw, which is second-hand but beats reporting a busy connection as zero.
  it('falls back to observed progress for a run it is not driving', () => {
    let roster = foldLiveProgress(seed('a'), tick('a', { added: 8, requests: 1 }))
    expect(rosterAdded(roster[0])).toBe(8)
    roster = foldLiveProgress(roster, tick('a', null))
    expect(rosterAdded(roster[0])).toBe(8)
  })

  it('prefers response totals over what the poll happened to observe', () => {
    let roster = foldLiveProgress(seed('a'), tick('a', { added: 8 }))
    roster = foldLiveProgress(roster, tick('a', null))   // observed = 8
    roster = foldResponse(roster, response('a', 11), 'acme')
    expect(rosterAdded(roster[0])).toBe(11)
  })

  it('reports a connection’s error, and drops it when a later call succeeds', () => {
    let roster = foldResponse(seed('a'), response('a', 0, { error: 'provider timed out' }), 'acme')
    expect(roster[0].error).toBe('provider timed out')
    roster = foldResponse(roster, response('a', 4), 'acme')
    expect(roster[0].error).toBeNull()
  })

  it('adopts a connection a response names that the roster never seeded', () => {
    const roster = foldResponse(seed('a'), response('b', 3), 'acme')
    expect(roster.map(e => e.connectionId)).toEqual(['a', 'b'])
    expect(rosterAdded(roster[1])).toBe(3)
  })

  it('leaves connections outside the run untouched', () => {
    const roster = foldResponse(seed('a', 'b'), response('a', 5), 'acme')
    expect(rosterAdded(roster[1])).toBe(0)
    expect(roster[1].fromResponse).toBe(false)
  })
})

// The pages showing transactions reload on a run this says may have changed them, so a wrong "no" leaves
// them stale — the case it has to get right — while a wrong "yes" only costs a reload.
describe('whether a run may have changed the ledger', () => {
  it('says no only when every connection answered with nothing added, updated or removed', () => {
    const quiet = foldResponse(seed('a', 'b'), [...response('a', 0), ...response('b', 0)], 'acme')
    expect(rosterMayHaveChangedLedger(quiet)).toBe(false)
    expect(rosterMayHaveChangedLedger(foldResponse(quiet, response('b', 0, { removed: 1 }), 'acme'))).toBe(true)
    expect(rosterMayHaveChangedLedger(foldResponse(quiet, response('a', 0, { updated: 2 }), 'acme'))).toBe(true)
  })

  it('says yes when it cannot know: a connection only watched, or no roster at all', () => {
    const watched = foldResponse(seed('a', 'b'), response('a', 0), 'acme')
    expect(rosterMayHaveChangedLedger(watched)).toBe(true)
    expect(rosterMayHaveChangedLedger([])).toBe(true)
  })
})
