// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// The things you *do* to a data connection that are not configuration: sync it, pull more of its history,
// rebuild its accounts, take its synced transactions back out, and rename it.
//
// Kept apart from the Import page's Connections tab that calls them (`ConnectionsTab.jsx`), which holds
// the configuration — connect, disconnect, account mapping, the provider credential — and the Plaid
// Link handler that cannot be unmounted mid-connect. The tab offers these at two levels: one Sync now
// for every connection, and per connection a small sync (so a mapping change can be verified where it
// was made) and the rarer actions in its menu.
//
// **Every action is vault-gated the same way**, via `ensureVault()` from the App-level gate: the action
// awaits it and then carries on in its own call frame, so a locked vault costs one passphrase rather than
// a passphrase plus a repeat of the gesture. A `423` is that same gate arriving late — the client's
// "unlocked" is a cached answer the server invalidates on its idle timeout — so it re-prompts and re-runs
// rather than surfacing as a failure whose remedy the user has to infer. `retriedAfterUnlock` is exported
// because the *configuration* actions need the identical treatment.
//
// The hook owns the dialogs these raise (the remove-synced confirmation and its preflight, and the notices)
// and hands them back as `dialogsNode`, the same seam `useBatchDetailPanels` uses. A host that renders the
// node gets working actions; one that forgets gets silent no-ops, which is why the node is not optional.

import { useCallback, useState } from 'react'
import { api } from './api.js'
import { useSyncStatus } from '../contexts/SyncStatusContext.jsx'
import { useVaultGateContext } from '../contexts/VaultGateContext.jsx'
import { connectionProviderLabel, recentFullSync } from './connectionSummary.js'
import { connectionOperationDialogs } from '../components/connections/ConnectionOperationDialogs.jsx'

export function useConnectionOperations({ onChanged } = {}) {
  const {
    providers: knownProviders, syncState, setSyncState, runSync: syncUntilComplete, runSyncAll, refreshConnections,
  } = useSyncStatus()
  const { ensureVault } = useVaultGateContext()
  const [notice, setNotice] = useState(null)
  const [refreshingConnId, setRefreshingConnId] = useState(null)
  const [fetchingHistoryConnId, setFetchingHistoryConnId] = useState(null)
  // "Remove synced transactions": a preflight (how much would go, and which of it was hand-edited since
  // it synced) feeds the confirm dialog before anything is deleted.
  const [removeSyncTarget, setRemoveSyncTarget] = useState(null)
  const [removingSync, setRemovingSync] = useState(false)
  // A Sync now held for confirmation because everything synced moments ago: `{ lastSynced, list }`.
  const [resyncConfirm, setResyncConfirm] = useState(null)

  // Tells the host something changed that no sync run reports. The actions that end in a run (a sync, more
  // history, rebuilt accounts) deliberately do not call it: every run's end already reaches the host
  // through `runsFinished`, and settling here as well reloaded the Connections tab twice per sync.
  const settle = useCallback(async () => { await onChanged?.() }, [onChanged])

  // A 423 is the gate arriving late rather than a failure to report: the server drops the key on restart
  // and on its idle timeout, so a call this gate already let through can still be refused. Answered the
  // way a locked vault is — prompt, then run the action again. Returns whether it was this case and has
  // been dealt with.
  const retriedAfterUnlock = useCallback(async (error, action) => {
    if (error?.status !== 423) return false
    if (await ensureVault({ force: true })) await action()
    return true
  }, [ensureVault])

  // The historical pull behind a connect, a mapping decision, and "fetch more history" alike: mark the
  // provider syncing, poll to completion, and report a failure without implying the step it followed
  // (the connect, the mapping save) failed with it.
  const pullConnectionHistory = useCallback(async (provider, { connectionId, days, failureTitle }) => {
    setSyncState(prev => ({ ...prev, [provider]: { syncing: true, result: null } }))
    try {
      await syncUntilComplete(provider, { days, connectionId, fullHistory: true })
    } catch (e) {
      setSyncState(prev => ({ ...prev, [provider]: { syncing: false, result: null } }))
      if (await retriedAfterUnlock(e, () => pullConnectionHistory(provider, { connectionId, days, failureTitle }))) return
      setNotice({ title: failureTitle, description: e.message })
    }
  }, [retriedAfterUnlock, setSyncState, syncUntilComplete])

  // A routine top-up. `connectionId` narrows it to one connection, which is what a connection's card offers
  // so a mapping change can be checked where it was made; without one it covers the whole provider.
  const sync = useCallback(async function sync(provider, { connectionId = null } = {}) {
    if (syncState[provider]?.syncing) return
    if (!(await ensureVault())) return
    setSyncState(prev => ({ ...prev, [provider]: { syncing: true, result: null } }))
    try {
      // days=0 keeps a cursor provider's maintained window at max, so a routine sync never narrows
      // history the initial pull already fetched; a provider with no cursor reads it as "top up", and
      // its own look-back bounds the fetch.
      await syncUntilComplete(provider, { days: 0, connectionId })
    } catch (e) {
      // A failed run ends too, so the hosts still reload and the badge reporting the failure (recorded
      // server-side) appears without waiting for an unrelated reload.
      setSyncState(prev => ({ ...prev, [provider]: { syncing: false, result: null } }))
      if (await retriedAfterUnlock(e, () => sync(provider, { connectionId }))) return
      setNotice({ title: 'Sync failed', description: e.message })
    }
  }, [ensureVault, retriedAfterUnlock, setSyncState, syncState, syncUntilComplete])

  // Every provider that has something to sync, as one run. This is what a page-level or app-level
  // control means by "sync" — bring in everything new — as against the per-connection check a
  // connection's card offers. Failures are collected per provider rather than raised, so one bank being
  // down neither abandons the run nor hides that the others imported fine.
  //
  // The Connections tab, the Data Import card and the navigation pane all start it here. The listing is
  // read fresh first, because what this page last loaded can be days old on a tablet: a sync since run
  // elsewhere is then confirmed rather than repeated, and one still running elsewhere is adopted into the
  // panel rather than started again. The vault is asked for only once a pull is going ahead.
  const runAll = useCallback(async (list) => {
    if (!(await ensureVault())) return
    const { failures } = await runSyncAll(list, { days: 0 })
    if (failures.length) {
      setNotice({
        title: failures.length === 1 ? 'A data provider could not be synced' : 'Some data providers could not be synced',
        // Named per provider: with several connected, "sync failed" leaves the user to work out which
        // one — and the others may well have imported fine, which the panel behind this still shows.
        description: failures
          .map(f => `${connectionProviderLabel(f.provider)}: ${f.error?.message || 'the sync did not complete'}`)
          .join('\n'),
      })
    }
  }, [ensureVault, runSyncAll])

  const syncAll = useCallback(async () => {
    const fresh = await refreshConnections()
    if (fresh?.running) return
    const listing = fresh?.providers || knownProviders || []
    const list = listing.filter(p => (p.connections || []).length).map(p => p.provider)
    if (!list.length) return
    const lastSynced = recentFullSync(listing)
    if (lastSynced) { setResyncConfirm({ lastSynced, list }); return }
    await runAll(list)
  }, [knownProviders, refreshConnections, runAll])

  const confirmResync = useCallback(() => {
    const list = resyncConfirm?.list
    setResyncConfirm(null)
    if (list) runAll(list)
  }, [resyncConfirm, runAll])

  // Deepen one connection's history. `fullHistory` is what separates this from a routine top-up, which
  // sends the same `days`: for a cursor provider it raises `days_requested` and the provider backfills
  // older transactions through the same cursor, while a provider with no cursor reads it as "walk further
  // back" rather than "fetch the recent window again". It is also the only pull permitted to widen the
  // connection's coverage claim backward. A bank or plan may cap how far back it goes.
  const fetchMoreHistory = useCallback(async (provider, connection) => {
    if (fetchingHistoryConnId || refreshingConnId) return
    if (!(await ensureVault())) return
    setFetchingHistoryConnId(connection.id)
    try {
      await pullConnectionHistory(provider, {
        connectionId: connection.id, days: 0,
        failureTitle: 'Could not fetch more history',
      })
    } finally {
      setFetchingHistoryConnId(null)
    }
  }, [ensureVault, fetchingHistoryConnId, pullConnectionHistory, refreshingConnId])

  // Rebuild a connection's account rows from its still-valid credential (no re-link), then sync its
  // history. The one-click recovery after a restore rolled the ledger back but kept the connection.
  const refreshConnectionAccounts = useCallback(async function refreshAccounts(provider, connection) {
    if (refreshingConnId) return
    if (!(await ensureVault())) return
    setRefreshingConnId(connection.id)
    setSyncState(prev => ({ ...prev, [provider]: { syncing: true, result: null } }))
    try {
      const res = await api.refreshConnectionAccounts(provider, connection.external_id)
      // Recovery syncs at full depth (days=0), independent of the new-connection window: a
      // restore-recovery should pull back as much as the provider will give, not the shallower default
      // a fresh connect might use.
      await syncUntilComplete(provider, { days: 0, connectionId: res.connection_id, fullHistory: true })
    } catch (e) {
      setSyncState(prev => ({ ...prev, [provider]: { syncing: false, result: null } }))
      if (await retriedAfterUnlock(e, () => refreshAccounts(provider, connection))) return
      setNotice({ title: 'Could not refresh accounts', description: e.message })
    } finally {
      setRefreshingConnId(null)
    }
  }, [ensureVault, refreshingConnId, retriedAfterUnlock, setSyncState, syncUntilComplete])

  // Opens on the preflight rather than on cached card counts, since the numbers the dialog states are
  // what actually gets deleted.
  const openRemoveSynced = useCallback(async (connection) => {
    setRemoveSyncTarget({ connection, summary: null })
    try {
      const summary = await api.getConnectionSyncedTransactions(connection.id)
      setRemoveSyncTarget({ connection, summary })
    } catch (e) {
      setRemoveSyncTarget(null)
      setNotice({ title: 'Could not read this connection’s synced transactions', description: e.message })
    }
  }, [])

  const confirmRemoveSynced = useCallback(async (force) => {
    const target = removeSyncTarget
    if (!target) return
    setRemovingSync(true)
    try {
      const res = await api.removeConnectionSyncedTransactions(target.connection.id, force)
      setRemoveSyncTarget(null)
      await settle()
      // The restored count is reported because it is the one effect with no visible home: rows on other
      // imports that had been removed as duplicates of this connection's copies come back to the ledger.
      setNotice({
        title: 'Synced transactions removed',
        description: `${res.removed} transaction${res.removed === 1 ? '' : 's'} removed.`
          + (res.restored ? ` ${res.restored} transaction${res.restored === 1 ? '' : 's'} from other imports, previously removed as duplicates of them, ${res.restored === 1 ? 'is' : 'are'} back in the ledger.` : '')
          + ' The next sync re-imports this history from the provider.',
      })
    } catch (e) {
      setRemoveSyncTarget(null)
      setNotice({ title: 'Could not remove synced transactions', description: e.message })
    } finally {
      setRemovingSync(false)
    }
  }, [removeSyncTarget, settle])

  // The name the connection is shown by. Not vault-gated: it is display only and reaches no provider. Every
  // listing that names connections re-reads, so the new name shows wherever the old one did; a failure is
  // thrown back to the editor, which stays open with the reason.
  const renameConnection = useCallback(async (connectionId, name) => {
    await api.setConnectionNickname(connectionId, name)
    await refreshConnections()
    await settle()
  }, [refreshConnections, settle])

  return {
    sync,
    syncAll,
    renameConnection,
    fetchMoreHistory,
    refreshConnectionAccounts,
    openRemoveSynced,
    pullConnectionHistory,
    retriedAfterUnlock,
    setNotice,
    // Which connection is mid-operation, so a host can label its own trigger — the ⋯ menu these live in
    // is closed while the work runs, so the busy state has nowhere else to show.
    busy: { refreshingConnId, fetchingHistoryConnId, removingSync },
    dialogsNode: connectionOperationDialogs({
      notice,
      onDismissNotice: () => setNotice(null),
      removeSyncTarget,
      removingSync,
      onConfirmRemoveSynced: confirmRemoveSynced,
      onCancelRemoveSynced: () => setRemoveSyncTarget(null),
      resyncConfirm,
      onConfirmResync: confirmResync,
      onCancelResync: () => setResyncConfirm(null),
    }),
  }
}
