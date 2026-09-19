// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// The roster of a data-connection sync run: one row per connection the run covers, held for the life of
// the run and only ever gaining detail. `SyncStatusContext` owns the state and feeds these; the panel
// renders what they return.
//
// Holding a roster — rather than rendering whichever connections are running *at this instant* — is the
// point: the driver is a sequence of HTTP calls with a wait between them, and each call clears the
// sync marker on its way out (`set_sync_running`, which also drops `sync_progress`). So the honest answer
// to "what is running right now" is *nothing* for several seconds of every cycle, and a panel rendering
// it directly grew and collapsed on that rhythm, then collapsed again at the end when N connection rows
// gave way to one provider total.
//
// Totals come from the **responses**, not from the polled progress: `res.connections` breaks each call
// down per connection, so summing responses cannot miss a call, while a poll every couple of seconds
// routinely misses a short one entirely. Polled progress is used only for the call in flight — the part no
// response can report yet, because the response is what ends it.
const emptyEntry = row => ({
  connectionId: row.connectionId,
  provider: row.provider,
  institution: row.institution,
  added: 0, updated: 0, removed: 0, skipped: 0,
  // Whether any response has described this connection. A run this tab is not driving has no responses to
  // read, so those rows fall back to `observed` — the last progress the poll saw before the marker
  // cleared. Second-hand and possibly a page short, but far better than reporting a busy sync as zero.
  fromResponse: false,
  observed: 0,
  // Provider requests spent, accumulated the same way `observed` is, because the figure is per-call and
  // resets with each one. A call the poll never saw goes uncounted — tolerable for a "how much work is
  // this taking" reading in a way it would not be for the row counts, which come from the responses.
  requests: 0,
  live: null,
  error: null,
})

// Append connections the roster does not have yet, preserving the order rows first appeared in.
export function addToRoster(prev, rows) {
  const have = new Set(prev.map(e => e.connectionId))
  const additions = rows.filter(r => !have.has(r.connectionId)).map(emptyEntry)
  return additions.length ? [...prev, ...additions] : prev
}

// Fold one call's per-connection totals in. Additive because the run is many calls: each response
// describes only its own call.
export function foldResponse(prev, connections, provider) {
  if (!connections?.length) return prev
  const byId = new Map(connections.map(c => [c.connection_id, c]))
  const next = prev.map(e => {
    const c = byId.get(e.connectionId)
    if (!c) return e
    byId.delete(e.connectionId)
    return {
      ...e,
      added: e.added + (c.added || 0),
      updated: e.updated + (c.updated || 0),
      removed: e.removed + (c.removed || 0),
      skipped: e.skipped + (c.skipped || 0),
      fromResponse: true,
      // The response *is* the end of the call the live figure described, so whatever the last poll saw of
      // it is now counted twice — once here and once in `live`. Cleared rather than left for the next
      // tick to overwrite, which is up to a poll interval away and would inflate the row until it came.
      live: null,
      requests: e.requests + (e.live?.requests || 0),
      // Only the most recent call's, on purpose: an error the next call did not repeat has been resolved
      // by that call succeeding, and reporting it afterwards would describe a connection that now works.
      error: c.error || null,
    }
  })
  // A connection the seed missed — it cannot normally happen (both scopes resolve the same way) but a
  // response naming a connection the panel does not list would be a silent hole, so adopt it.
  for (const c of byId.values()) {
    next.push({
      ...emptyEntry({ connectionId: c.connection_id, provider, institution: c.institution }),
      added: c.added || 0, updated: c.updated || 0, removed: c.removed || 0, skipped: c.skipped || 0,
      fromResponse: true, error: c.error || null,
    })
  }
  return next
}

// Overlay the in-flight call's progress. When a connection's progress disappears its call has ended, so
// the last figure seen is folded into `observed` — the only total available for a run this tab is not
// driving, and harmless for one it is, where `fromResponse` wins.
export function foldLiveProgress(prev, rows) {
  const byId = new Map(rows.map(r => [r.connectionId, r]))
  return prev.map(e => {
    const row = byId.get(e.connectionId)
    const live = row?.syncing ? (row.progress || {}) : null
    if (live) return { ...e, live }
    if (!e.live) return e
    return {
      ...e,
      live: null,
      observed: e.observed + (e.live.added || 0),
      requests: e.requests + (e.live.requests || 0),
    }
  })
}

// What the panel shows for one connection: exact response totals where a response covered it, the
// second-hand observation where none did, plus whatever the call in flight has added since.
export function rosterAdded(entry) {
  const settled = entry.fromResponse ? entry.added : entry.observed
  return settled + (entry.live?.added || 0)
}

export function rosterRequests(entry) {
  return entry.requests + (entry.live?.requests || 0)
}


// Whether a finished run may have changed the ledger, which is what decides if the pages showing
// transactions reload. Only response totals can say that nothing changed: a connection this tab watched
// rather than drove has no more than `observed`, which misses a short call entirely, so it counts as a
// change, and so does a run with no roster at all. Removals count as well, since they trash rows a page
// may be showing.
export function rosterMayHaveChangedLedger(roster) {
  if (!roster.length) return true
  return roster.some(e => !e.fromResponse || e.added > 0 || e.updated > 0 || e.removed > 0)
}
