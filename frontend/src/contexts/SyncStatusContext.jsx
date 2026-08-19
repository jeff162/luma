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

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api.js'
import { useDetachedReportViewer } from '../lib/useDetachedReportViewer.js'
import { MinimizedReportPill } from '../components/MinimizedReportPill.jsx'
import { SyncStatusPanel } from '../components/SyncStatusPanel.jsx'
import { addToRoster, foldLiveProgress, foldResponse, rosterAdded } from '../lib/syncRoster.js'

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

// Every connection the app knows about, flattened, with whatever a running sync has committed. Read from
// the providers listing rather than from the sync call, because the sync call is still in flight — and
// because a client that did not start the sync (another tab, this one after a reload) has no call to read.
async function loadConnections() {
  const { providers = [] } = await api.getProviders().catch(() => ({ providers: [] }))
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
  // The panel envelope. `open` seeds it; the loop below layers live updates through `setViewer`, which is
  // the extension point the hook documents for exactly this.
  const { viewer, setViewer, open, close, minimize, restore } = useDetachedReportViewer(
    async () => ({ running: runningOf(await loadConnections()) }),
  )
  // The run roster the panel renders — see the helpers above.
  const [runConnections, setRunConnections] = useState([])
  // provider -> { syncing, result, progress, status, paused, incomplete }. The same shape the Accounts
  // page used to keep locally, so its cards did not have to change to read it from here.
  const [syncState, setSyncState] = useState({})
  // Which providers belong to the run the panel is currently reporting on.
  //
  // `syncState` cannot answer this: it is keyed by provider and accumulates for the life of the page,
  // because the Accounts cards each read their own provider's slot and expect the last result to stay
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
      const rows = await loadConnections()
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
  }, [anyDriving, watching, setViewer])

  // A sync already running when this tab loaded — started in another tab, or here before a reload. Adopted
  // rather than ignored: the panel state is in memory by design, so without this a reload mid-backfill
  // leaves the user with no indication that anything is happening.
  useEffect(() => {
    let alive = true
    loadConnections().then(rows => {
      if (!alive || !runningOf(rows).length) return
      lastRunningAtRef.current = Date.now()
      setWatching(true)
      open({ adopted: true })
    }).catch(() => {})
    return () => { alive = false }
  }, [open])

  // The driver, lifted out of the Accounts page. Each call drains the pages available right now; between
  // calls we wait for the provider to make more available. Running totals are surfaced on
  // `syncState[provider]` so a connection card can show "Importing history… N so far".
  const runSync = useCallback(async (provider, { days, connectionId, fullHistory = false } = {}) => {
    // A sync starting while *another* is still going joins that run; one starting into an idle app begins
    // a new one, and the previous run's results stop being reported. Sequential syncs therefore each show
    // their own outcome, while genuinely concurrent ones are still listed together.
    //
    // `p !== provider` is load-bearing. Callers mark their own provider as syncing before handing over —
    // `refreshConnectionAccounts` does a provider round trip first and wants the button to read "Syncing…"
    // across it — so a check that did not exclude the provider being started would find *itself* already
    // running, conclude it was joining an existing run, and carry the previous one's results forward. That
    // is exactly what left a finished Plaid result sitting in the panel through the next SimpleFIN sync.
    const joining = Object.entries(syncStateRef.current).some(([p, s]) => p !== provider && s?.syncing)
    setRunProviders(prev => (joining ? [...new Set([...prev, provider])] : [provider]))
    setSyncState(prev => ({ ...prev, [provider]: { syncing: true, result: null } }))
    // The roster follows the same rule: a joining sync adds its connections to the run on screen, a fresh
    // one replaces it. Cleared synchronously so the previous run's rows are gone before the seed lands.
    const token = joining ? runTokenRef.current : ++runTokenRef.current
    if (!joining) setRunConnections([])
    // Seeded from the listing rather than discovered as connections start reporting, so the panel shows
    // the whole run from the first frame and neither grows nor shrinks as it proceeds. The scope mirrors
    // the backend's `_connections_in_scope` exactly: one connection when the caller named one, otherwise
    // every connection of the provider. Deliberately not awaited — a sync must not wait on its own
    // readout — and guarded by the token so a listing that lands after a later run started is dropped.
    loadConnections().then(rows => {
      if (token !== runTokenRef.current) return
      setRunConnections(prev => addToRoster(prev, rows.filter(
        r => r.provider === provider && (!connectionId || r.connectionId === connectionId),
      )))
    }).catch(() => {})
    // Only seeds the panel; re-opening mid-sync would reset the envelope and blank the progress the
    // observer has been filling in.
    if (!viewerRef.current) open({ provider })
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
  }, [open])

  const value = useMemo(
    () => ({ syncState, setSyncState, runProviders, runConnections, watching, runSync,
              viewer, open, close, minimize, restore }),
    [syncState, runProviders, runConnections, watching, runSync,
      viewer, open, close, minimize, restore],
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

export function MinimizedSyncNavItem() {
  const { viewer, syncState, runProviders, runConnections, watching, restore } = useSyncStatus()
  if (!viewer || !viewer.minimized) return null
  // Counted off the roster, which holds its figures through the gaps between the driver's calls — the pill
  // used to read whatever was running at that instant, so a stashed sync's count dropped to zero and back
  // every few seconds.
  const added = runConnections.reduce((n, e) => n + rosterAdded(e), 0)
  // Between pressing Sync and the backend reporting a connection as running — and again between every pair
  // of the driver's calls — nothing is running while this tab knows perfectly well that a sync is being
  // driven. Reading that off `syncState` keeps a stashed pill from claiming the sync had already finished.
  const driving = runProviders.some(p => syncState[p]?.syncing) || watching
  // The label carries the status, not just a name — the whole point of stashing it is to glance at the
  // chip rather than restore the panel to find out whether anything is still happening.
  const label = driving ? (added ? `Syncing — ${added} imported` : 'Syncing…') : 'Sync finished'
  return (
    <MinimizedReportPill
      label={label}
      tone={driving ? 'var(--accent)' : 'var(--success)'}
      icon={driving ? '↻' : '✓'}
      title={driving
        ? `${runConnections.length} connection(s) syncing — ${added} transaction(s) imported so far`
        : 'The sync has finished — restore for the summary'}
      onRestore={restore}
    />
  )
}
