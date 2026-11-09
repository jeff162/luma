// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/* eslint-disable react-refresh/only-export-components -- provider + useSyncStatus hook + nav-bar pill live together by design */

// App-level state for a running data-connection sync.
//
// A sync is the one long operation in the app that the user is expected to keep working through: a first
// backfill takes minutes, and since the backend stopped holding its write transaction across provider
// calls (see architecture.md → Database concurrency) there is no longer any reason to sit and wait for it.
// That is exactly what this exists to make possible — the panel reports progress, minimizes to a nav-bar
// pill, and the user goes and does something else.
//
// **What makes this different from the other three detached viewers** (duplicates, Amazon reconciliation,
// Amazon import detail), and the reason each piece below is shaped the way it is:
//
//   - Those hold a *snapshot*: `open()` fetches once and minimizing merely hides a dialog over data
//     already in hand. A sync is a live driver, so the **poll loop lives here too**, not just its state.
//     While it lived in the Accounts page, navigating away mid-sync left the loop running in a detached
//     closure writing to an unmounted component — the work continued invisibly and its results landed
//     nowhere. `useDetachedReportViewer` anticipates this: its docstring names `setViewer` as the seam a
//     provider layers its own updates onto, which is what the loop does here.
//
//   - A pull is **one HTTP call that returns only at the end**, so its own response cannot report
//     progress. The backend commits progress to the connection as it goes (`sync_progress`), and a
//     separate slow poll reads it — which is also what lets a second tab, or this one after a reload,
//     see a sync it never started.
//
//   - **There is no cancel, and the panel offers no way out but Minimize while a sync is live.** Closing
//     would discard the panel outright — no pill, no handle, nothing to restore short of a page reload —
//     which is the wrong thing to sit beside a live readout. Once the run ends the only action is Close.
//
// The navigation pane's side of this lives in `components/SyncNavItem.jsx`. It used to be a pill exported
// from here, appearing only while a run was stashed; it is now a permanent control that *starts* syncs as
// well as restoring them, which is why it sits with the components rather than with this state.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api.js'
import { useDetachedReportViewer } from '../lib/useDetachedReportViewer.js'
import { useOnForeground } from '../lib/useOnForeground.js'
import { syncedSince } from '../lib/connectionSummary.js'
import { SyncStatusPanel } from '../components/SyncStatusPanel.jsx'
import { addToRoster, foldLiveProgress, foldResponse, rosterMayHaveChangedLedger } from '../lib/syncRoster.js'

// ~3 min at the cadence below — comfortably covers a cursor provider's historical backfill.
const MAX_POLLS = 45
const POLL_INTERVAL_MS = 4000
// How often the *observer* asks the backend how far a running sync has got. Deliberately slower than the
// sync's own cadence: this is a progress read, not the thing driving the work, and every tick is a query
// against a database the sync is writing to.
const PROGRESS_INTERVAL_MS = 2500
// How long a tab that is only *watching* a run keeps watching after the last connection stopped reporting.
// The driver's calls are separated by `POLL_INTERVAL_MS` of quiet with the sync marker cleared, so
// "nothing is running" is not evidence that a run has ended — only that no call is in flight this instant.
// A watcher has no better signal (the driver is in another tab, or was in this one before a reload), so it
// waits out a few of those gaps first. Guessing high costs a panel that says "syncing" for a few seconds
// after the fact; guessing low declares a running sync finished, which is the worse of the two — and which
// is what a watcher used to do at the *first* gap, stopping its own poll along with it.
const WATCH_SETTLE_MS = 12000

const SyncStatusContext = createContext(null)

export function useSyncStatus() {
  const ctx = useContext(SyncStatusContext)
  if (!ctx) throw new Error('useSyncStatus must be used inside <SyncStatusProvider>')
  return ctx
}

// Runs `onSync` after each sync that may have changed transactions, wherever it was started — the navigation
// pane, a connection card, another tab. For a page holding its own copy of transaction-derived data, which
// no mutation signal reaches because a sync writes on the server. Keyed to the count seen at mount, so
// arriving on a page after earlier syncs does not repeat the load the mount just did; `onSync` is read
// through a ref, so a caller need not keep it stable.
export function useAfterLedgerSync(onSync) {
  const { ledgerRunsFinished } = useSyncStatus()
  const handledRef = useRef(ledgerRunsFinished)
  const onSyncRef = useRef(onSync)
  onSyncRef.current = onSync
  useEffect(() => {
    if (ledgerRunsFinished === handledRef.current) return
    handledRef.current = ledgerRunsFinished
    onSyncRef.current()
  }, [ledgerRunsFinished])
}

// The providers listing, which is this context's one source for "what connections exist and what are they
// doing". Read from here rather than from the sync call, because the sync call is still in flight — and
// because a client that did not start the sync (another tab, this one after a reload) has no call to read.
//
// The **raw payload is kept as well as the flattened rows**, and that is the whole reason these are two
// functions. The rows below are a projection for the panel and drop everything the panel does not draw,
// `last_synced_at` included — so the navigation pane's freshness figure, which needs exactly that field,
// used to fetch this same endpoint a second time on every app load, milliseconds after this one. Two
// identical requests for one answer. Consumers that need more than the projection read `providers` off
// the context instead.
async function fetchProviders() {
  const { providers = [] } = await api.getProviders().catch(() => ({ providers: [] }))
  return providers
}

function connectionRows(providers) {
  const rows = []
  for (const p of providers) {
    for (const c of p.connections || []) {
      rows.push({
        provider: p.provider,
        connectionId: c.id,
        institution: c.institution || p.provider,
        syncing: !!c.syncing,
        progress: c.sync_progress || null,
      })
    }
  }
  return rows
}

const runningOf = rows => rows.filter(r => r.syncing)

export function SyncStatusProvider({ children }) {
  // The listing every consumer shares, refreshed by whichever read happens to run — the load and foreground
  // check below, the observer's ticks during a sync, a run's own seed, once more when a run ends, and the
  // check before a Sync now. Null until the first read lands, which is what lets a consumer tell
  // "no connections" apart from "not asked yet".
  const [providers, setProviders] = useState(null)
  const readConnections = useCallback(async () => {
    const payload = await fetchProviders()
    setProviders(payload)
    return connectionRows(payload)
  }, [])
  // The panel envelope. `open` seeds it; the loop below layers live updates through `setViewer`, which is
  // the extension point the hook documents for exactly this.
  const { viewer, setViewer, open, close, minimize, restore } = useDetachedReportViewer(
    async () => ({ running: runningOf(await readConnections()) }),
  )
  // The run roster the panel renders — see the helpers above.
  const [runConnections, setRunConnections] = useState([])
  // provider -> { syncing, result, progress, status, paused, incomplete }. The same shape the Accounts
  // page used to keep locally, so its cards did not have to change to read it from here.
  const [syncState, setSyncState] = useState({})
  // Which providers belong to the run the panel is currently reporting on.
  //
  // `syncState` cannot answer this: it is keyed by provider and accumulates for the life of the page,
  // because the Connections tab's cards each read their own provider's slot and expect the last result to stay
  // there. Rendering all of it made the panel show every provider synced since the page loaded — sync
  // Plaid, then SimpleFIN, and the panel still listed Plaid's result from ten minutes earlier as though
  // it were part of the run in progress.
  const [runProviders, setRunProviders] = useState([])
  // Read through refs so the driver below keeps a stable identity: the observer rewrites `viewer` every
  // couple of seconds, and a driver that depended on it would be rebuilt on every tick.
  const viewerRef = useRef(viewer)
  viewerRef.current = viewer
  const syncStateRef = useRef(syncState)
  syncStateRef.current = syncState
  const runConnectionsRef = useRef(runConnections)
  runConnectionsRef.current = runConnections
  // Identifies the run a seed belongs to. The seed is a round trip, so a second run started while the
  // first one's listing is still in flight would otherwise have that listing's connections appended to it.
  const runTokenRef = useRef(0)

  const anyDriving = Object.values(syncState).some(s => s?.syncing)
  // Whether a run this tab is not driving is still believed to be going — see `WATCH_SETTLE_MS`. It keeps
  // the observer polling across the quiet between another tab's calls, and it is what those rows read their
  // live/finished state from, since they have no local driver to follow.
  const [watching, setWatching] = useState(false)
  // The tick closes over these, and is deliberately not rebuilt when they change: a poll loop torn down and
  // re-created on every state change it observes would restart its interval each time.
  const watchingRef = useRef(watching)
  watchingRef.current = watching
  const anyDrivingRef = useRef(anyDriving)
  anyDrivingRef.current = anyDriving
  const runProvidersRef = useRef(runProviders)
  runProvidersRef.current = runProviders
  const lastRunningAtRef = useRef(0)

  // The observer. Runs whenever anything is or might be syncing, including a sync this tab did not start,
  // and stops as soon as nothing is — a poll that keeps firing against an idle backend is a battery and
  // query cost for no information.
  useEffect(() => {
    if (!anyDriving && !watching) return undefined
    let alive = true
    const tick = async () => {
      const rows = await readConnections()
      if (!alive) return
      const running = runningOf(rows)
      if (running.length) {
        lastRunningAtRef.current = Date.now()
        if (!watchingRef.current) setWatching(true)
      } else if (!anyDrivingRef.current && watchingRef.current) {
        // A tab holding the driver knows the run is over the moment its last call returns, so it settles
        // immediately; only a watcher has to wait out the gaps.
        const grace = runProvidersRef.current.length ? 0 : WATCH_SETTLE_MS
        if (Date.now() - lastRunningAtRef.current > grace) setWatching(false)
      }
      setViewer(prev => (prev ? { ...prev, data: { ...(prev.data || {}), running } } : prev))
      // A sync this tab did not start has no roster to seed, so its connections join here.
      setRunConnections(prev => foldLiveProgress(addToRoster(prev, running), rows))
    }
    const id = setInterval(tick, PROGRESS_INTERVAL_MS)
    tick()
    return () => { alive = false; clearInterval(id) }
  }, [anyDriving, watching, readConnections, setViewer])

  // `runsFinished` and `ledgerRunsFinished` — see the run-end effect below, and the foreground read here,
  // which also counts a sync that finished elsewhere.
  const [runsFinished, setRunsFinished] = useState(0)
  const [ledgerRunsFinished, setLedgerRunsFinished] = useState(0)
  const providersRef = useRef(providers)
  providersRef.current = providers

  // Re-read the listing outside a run, adopting any sync it finds already going — started in another tab or
  // on another device, or here before a reload. Adopted rather than ignored: the panel state is in memory by
  // design, so without this a reload mid-backfill leaves the user with no indication that anything is
  // happening. Returns `{ providers, running }`, or null when the read failed, so a caller can tell a
  // failed read from an install with no connections.
  //
  // A sync that already *finished* elsewhere since the last read is counted as a run ending, so the pages
  // holding their own copy of what it wrote reload just as they would after one seen here. It always counts
  // as a ledger change: the connection records only its most recent call, and a run is several calls, so a
  // last call that brought nothing in says nothing about the ones before it.
  const refreshConnections = useCallback(async () => {
    let payload
    try {
      ({ providers: payload = [] } = await api.getProviders())
    } catch {
      return null
    }
    const previous = providersRef.current
    providersRef.current = payload
    setProviders(payload)
    const running = runningOf(connectionRows(payload)).length > 0
    const busy = anyDrivingRef.current || watchingRef.current
    if (running && !busy) {
      lastRunningAtRef.current = Date.now()
      // Set ahead of the render so an overlapping read does not adopt the same run a second time.
      watchingRef.current = true
      setWatching(true)
      open({ adopted: true })
    } else if (!running && !busy && previous && syncedSince(previous, payload)) {
      setRunsFinished(n => n + 1)
      setLedgerRunsFinished(n => n + 1)
    }
    return { providers: payload, running }
  }, [open])

  // At load, and whenever the app comes back to the foreground. A tablet keeps a backgrounded page alive
  // for days, and the listing is otherwise read only around this tab's own runs, so a sync done elsewhere
  // left the freshness shown here at whatever it was when the page was last in view. Skipped while a run
  // is live, because the observer above is already reading it.
  useEffect(() => { refreshConnections() }, [refreshConnections])
  useOnForeground(() => {
    if (anyDrivingRef.current || watchingRef.current) return
    refreshConnections()
  })

  // One more read when a run ends, because the observer above stops the moment nothing is syncing and its
  // last tick therefore saw the run mid-flight. `last_synced_at` moves exactly once per sync — at the end —
  // so without this the freshness a consumer shows would stay at the value it had *before* the sync that
  // just refreshed it, which is the one moment it is most obviously wrong.
  //
  // `runsFinished` counts those endings, for the consumers whose data a sync changes but who hold their own
  // copy of it — the Import page's history cards above all, whose row counts, account chips and review pills
  // otherwise stayed at whatever the page last loaded, mid-sync or before it, until something unrelated
  // reloaded them. A counter rather than a callback so a page can simply watch it while mounted, however
  // the run was started (its own panel, the navigation pane, another tab — or another device, counted by
  // `refreshConnections` above). 0 means no run has ended.
  //
  // `ledgerRunsFinished` counts only the endings that may have changed transactions, for the pages that
  // show them (see `useAfterLedgerSync`). Those reload a list the user may be scrolled into or editing, so
  // a sync that brought nothing in leaves them alone; `rosterMayHaveChangedLedger` says when that is known.
  const wasBusyRef = useRef(false)
  useEffect(() => {
    const busy = anyDriving || watching
    if (wasBusyRef.current && !busy) {
      readConnections().catch(() => {})
      setRunsFinished(n => n + 1)
      if (rosterMayHaveChangedLedger(runConnectionsRef.current)) setLedgerRunsFinished(n => n + 1)
    }
    wasBusyRef.current = busy
  }, [anyDriving, watching, readConnections])

  // Open a run the panel will report on, for one or more providers starting **together**.
  //
  // Separated from the driver below because a run and a provider are not the same unit of work. One
  // control can start every provider at once (the navigation pane's sync item does), and the setup has to
  // happen once for the whole set: done per provider it would race itself, since `syncStateRef` is only
  // as fresh as the last render and two providers started in the same tick would each conclude the other
  // was not running yet, each declare a fresh run, and each replace the other's roster.
  //
  // A sync starting while *another* is still going joins that run; one starting into an idle app begins
  // a new one, and the previous run's results stop being reported. Sequential syncs therefore each show
  // their own outcome, while genuinely concurrent ones are still listed together.
  //
  // Excluding the providers *being started* from the "is anything already running?" test is load-bearing.
  // Callers mark their own provider as syncing before handing over — `refreshConnectionAccounts` does a
  // provider round trip first and wants the button to read "Syncing…" across it — so a check that did not
  // exclude them would find *itself* already running, conclude it was joining an existing run, and carry
  // the previous one's results forward. That is exactly what left a finished Plaid result sitting in the
  // panel through the next SimpleFIN sync.
  // Named `startingProviders` rather than `providers`, which is the listing this context now holds — one
  // of the two would silently shadow the other in here, and they mean different things.
  const beginRun = useCallback((startingProviders, { connectionId } = {}) => {
    const starting = new Set(startingProviders)
    const joining = Object.entries(syncStateRef.current).some(([p, s]) => !starting.has(p) && s?.syncing)
    setRunProviders(prev => (joining ? [...new Set([...prev, ...startingProviders])] : [...startingProviders]))
    setSyncState(prev => {
      const next = { ...prev }
      for (const p of startingProviders) next[p] = { syncing: true, result: null }
      return next
    })
    // The roster follows the same rule: a joining sync adds its connections to the run on screen, a fresh
    // one replaces it. Cleared synchronously so the previous run's rows are gone before the seed lands.
    const token = joining ? runTokenRef.current : ++runTokenRef.current
    if (!joining) setRunConnections([])
    // Seeded from the listing rather than discovered as connections start reporting, so the panel shows
    // the whole run from the first frame and neither grows nor shrinks as it proceeds. The scope mirrors
    // the backend's `_connections_in_scope` exactly: one connection when the caller named one, otherwise
    // every connection of the providers starting. Deliberately not awaited — a sync must not wait on its
    // own readout — and guarded by the token so a listing that lands after a later run started is dropped.
    readConnections().then(rows => {
      if (token !== runTokenRef.current) return
      setRunConnections(prev => addToRoster(prev, rows.filter(
        r => starting.has(r.provider) && (!connectionId || r.connectionId === connectionId),
      )))
    }).catch(() => {})
    // Only seeds the panel; re-opening mid-sync would reset the envelope and blank the progress the
    // observer has been filling in.
    if (!viewerRef.current) open({ provider: startingProviders[0] })
  }, [open, readConnections])

  // The driver for one provider, lifted out of the Accounts page. Each call drains the pages available
  // right now; between calls we wait for the provider to make more available. Running totals are surfaced
  // on `syncState[provider]` so a connection card can show "Importing history… N so far". Assumes the run
  // it belongs to has already been opened by `beginRun`.
  const driveProvider = useCallback(async (provider, { days, connectionId, fullHistory = false } = {}) => {
    const totals = { added: 0, updated: 0, removed: 0, skipped: 0 }
    try {
      for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
        const res = await api.runSync(days, connectionId, { provider, fullHistory })
        // Exact per-connection totals for the call that just returned — see the roster helpers above.
        setRunConnections(prev => foldResponse(prev, res.connections, provider))
        totals.added += res.added || 0
        totals.updated += res.updated || 0
        totals.removed += res.removed || 0
        totals.skipped += res.skipped || 0
        if (res.historical_complete) {
          // A paused connection also reports nothing-more-right-now, so the loop ends either way;
          // `paused` is what tells "finished" apart from "stopped, with more to come on a later sync".
          setSyncState(prev => ({
            ...prev, [provider]: { syncing: false, result: { ...totals }, paused: res.paused || [] },
          }))
          return totals
        }
        setSyncState(prev => ({
          ...prev,
          [provider]: { syncing: true, result: null, progress: { ...totals }, status: res.update_status },
        }))
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
      }
      // Not signalled complete within the poll budget — keep what arrived and let the user re-sync.
      setSyncState(prev => ({
        ...prev, [provider]: { syncing: false, result: { ...totals }, incomplete: true },
      }))
      return totals
    } catch (err) {
      setSyncState(prev => ({ ...prev, [provider]: { syncing: false, result: null } }))
      throw err
    }
  }, [])

  const runSync = useCallback(async (provider, opts = {}) => {
    beginRun([provider], opts)
    return driveProvider(provider, opts)
  }, [beginRun, driveProvider])

  // Every provider with something to sync, as one run — what a single app-wide control needs, since
  // "sync" from the navigation pane means "bring in everything new", not "bring in Plaid".
  //
  // Failures are collected rather than raised. `Promise.all` would reject on the first provider to fail
  // and leave the others running with nobody awaiting them, so a bank being down would both abandon the
  // run's reporting and hide the fact that the other provider imported fine. The caller gets every
  // failure and decides what to say; each provider's own `syncState` slot has already recorded its
  // outcome either way, so the cards and the panel are correct regardless of what the caller does.
  const runSyncAll = useCallback(async (providers, opts = {}) => {
    const list = [...new Set(providers)].filter(Boolean)
    if (!list.length) return { failures: [] }
    beginRun(list, opts)
    const settled = await Promise.allSettled(list.map(p => driveProvider(p, opts)))
    return {
      failures: settled
        .map((r, i) => (r.status === 'rejected' ? { provider: list[i], error: r.reason } : null))
        .filter(Boolean),
    }
  }, [beginRun, driveProvider])

  const value = useMemo(
    () => ({ providers, syncState, setSyncState, runProviders, runConnections, watching, runsFinished,
              ledgerRunsFinished, runSync, runSyncAll, refreshConnections, viewer, open, close, minimize, restore }),
    [providers, syncState, runProviders, runConnections, watching, runsFinished, ledgerRunsFinished, runSync,
      runSyncAll, refreshConnections, viewer, open, close, minimize, restore],
  )
  return <SyncStatusContext.Provider value={value}>{children}</SyncStatusContext.Provider>
}

// Mounted once near the top of the App tree so the panel survives route changes.
export function SyncStatusRenderer() {
  const { viewer, syncState, runProviders, runConnections, watching, close, minimize } = useSyncStatus()
  if (!viewer || viewer.minimized) return null
  return (
    <SyncStatusPanel
      connections={runConnections}
      syncState={syncState}
      runProviders={runProviders}
      watching={watching}
      onClose={close}
      onMinimize={minimize}
    />
  )
}
