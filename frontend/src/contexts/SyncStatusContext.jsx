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

// ~3 min at the cadence below — comfortably covers a cursor provider's historical backfill.
const MAX_POLLS = 45
const POLL_INTERVAL_MS = 4000
// How often the *observer* asks the backend how far a running sync has got. Deliberately slower than the
// sync's own cadence: this is a progress read, not the thing driving the work, and every tick is a query
// against a database the sync is writing to.
const PROGRESS_INTERVAL_MS = 2500

const SyncStatusContext = createContext(null)

export function useSyncStatus() {
  const ctx = useContext(SyncStatusContext)
  if (!ctx) throw new Error('useSyncStatus must be used inside <SyncStatusProvider>')
  return ctx
}

// Connections currently running a sync, with whatever progress each has committed. Read from the
// providers listing rather than from the sync call, because the sync call is still in flight — and
// because a client that did not start the sync (another tab, this one after a reload) has no call to read.
async function loadRunningSyncs() {
  const { providers = [] } = await api.getProviders().catch(() => ({ providers: [] }))
  const running = []
  for (const p of providers) {
    for (const c of p.connections || []) {
      if (c.syncing) {
        running.push({
          provider: p.provider,
          connectionId: c.id,
          institution: c.institution || p.provider,
          progress: c.sync_progress || null,
        })
      }
    }
  }
  return running
}

export function SyncStatusProvider({ children }) {
  // The panel envelope. `open` seeds it; the loop below layers live updates through `setViewer`, which is
  // the extension point the hook documents for exactly this.
  const { viewer, setViewer, open, close, minimize, restore } = useDetachedReportViewer(
    async () => ({ running: await loadRunningSyncs() }),
  )
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

  const anyDriving = Object.values(syncState).some(s => s?.syncing)
  const anyRunning = !!viewer?.data?.running?.length

  // The observer. Runs whenever anything is or might be syncing, including a sync this tab did not start,
  // and stops as soon as nothing is — a poll that keeps firing against an idle backend is a battery and
  // query cost for no information.
  useEffect(() => {
    if (!anyDriving && !anyRunning) return undefined
    let alive = true
    const tick = async () => {
      const running = await loadRunningSyncs()
      if (!alive) return
      setViewer(prev => (prev ? { ...prev, data: { ...(prev.data || {}), running } } : prev))
    }
    const id = setInterval(tick, PROGRESS_INTERVAL_MS)
    tick()
    return () => { alive = false; clearInterval(id) }
  }, [anyDriving, anyRunning, setViewer])

  // A sync already running when this tab loaded — started in another tab, or here before a reload. Adopted
  // rather than ignored: the panel state is in memory by design, so without this a reload mid-backfill
  // leaves the user with no indication that anything is happening.
  useEffect(() => {
    let alive = true
    loadRunningSyncs().then(running => {
      if (alive && running.length) open({ adopted: true })
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
    setRunProviders(prev => (
      Object.entries(syncStateRef.current).some(([p, s]) => p !== provider && s?.syncing)
        ? [...new Set([...prev, provider])]
        : [provider]
    ))
    setSyncState(prev => ({ ...prev, [provider]: { syncing: true, result: null } }))
    // Only seeds the panel; re-opening mid-sync would reset the envelope and blank the progress the
    // observer has been filling in.
    if (!viewerRef.current) open({ provider })
    const totals = { added: 0, updated: 0, removed: 0, skipped: 0 }
    try {
      for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
        const res = await api.runSync(days, connectionId, { provider, fullHistory })
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
    () => ({ syncState, setSyncState, runProviders, runSync,
              viewer, open, close, minimize, restore }),
    [syncState, runProviders, runSync, viewer, open, close, minimize, restore],
  )
  return <SyncStatusContext.Provider value={value}>{children}</SyncStatusContext.Provider>
}

// Mounted once near the top of the App tree so the panel survives route changes.
export function SyncStatusRenderer() {
  const { viewer, syncState, runProviders, close, minimize } = useSyncStatus()
  if (!viewer || viewer.minimized) return null
  return (
    <SyncStatusPanel
      running={viewer.data?.running || []}
      syncState={syncState}
      runProviders={runProviders}
      onClose={close}
      onMinimize={minimize}
    />
  )
}

export function MinimizedSyncNavItem() {
  const { viewer, syncState, runProviders, restore } = useSyncStatus()
  if (!viewer || !viewer.minimized) return null
  const running = viewer.data?.running || []
  const added = running.reduce((n, r) => n + (r.progress?.added || 0), 0)
    || runProviders.reduce((n, p) => n + (syncState[p]?.progress?.added || 0), 0)
  // The label carries the status, not just a name — the whole point of stashing it is to glance at the
  // chip rather than restore the panel to find out whether anything is still happening.
  const label = running.length ? `Syncing — ${added} imported` : 'Sync finished'
  return (
    <MinimizedReportPill
      label={label}
      tone={running.length ? 'var(--accent)' : 'var(--success)'}
      icon={running.length ? '↻' : '✓'}
      title={running.length
        ? `${running.length} connection(s) syncing — ${added} transaction(s) imported so far`
        : 'The sync has finished — restore for the summary'}
      onRestore={restore}
    />
  )
}
