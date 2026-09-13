// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// The things you *do* to a data connection that are not configuration: sync it, pull more of its history,
// rebuild its accounts, and take its synced transactions back out.
//
// Extracted when the connections UI split in two. Configuration (connect, disconnect, account mapping,
// the provider credential) stayed on the Accounts page because that is where those decisions are made and
// where Plaid Link has to stay — its handler closure lives in that component, so navigating away
// mid-connect loses the connection. The operations here moved to Import / Export, beside the import cards
// a sync writes to, because a sync is how new data arrives and belongs with the other way new data
// arrives. Both surfaces still need *some* of these — the Accounts card keeps a per-connection sync so a
// mapping change can be verified where it was made — so they live in one hook rather than being written
// twice. Two implementations of "remove this connection's synced transactions" is not a thing this
// codebase should have.
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
import { connectionProviderLabel } from './connectionSummary.js'
import { connectionOperationDialogs } from '../components/connections/ConnectionOperationDialogs.jsx'

export function useConnectionOperations({ onChanged } = {}) {
  const { syncState, setSyncState, runSync: syncUntilComplete, runSyncAll } = useSyncStatus()
  const { ensureVault } = useVaultGateContext()
  const [notice, setNotice] = useState(null)
  const [refreshingConnId, setRefreshingConnId] = useState(null)
  const [fetchingHistoryConnId, setFetchingHistoryConnId] = useState(null)
  // "Remove synced transactions": a preflight (how much would go, and which of it was hand-edited since
  // it synced) feeds the confirm dialog before anything is deleted.
  const [removeSyncTarget, setRemoveSyncTarget] = useState(null)
  const [removingSync, setRemovingSync] = useState(false)

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

  // A routine top-up. `connectionId` narrows it to one connection, which is what the Accounts card offers
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
      await settle()
    } catch (e) {
      setSyncState(prev => ({ ...prev, [provider]: { syncing: false, result: null } }))
      // Settle on failure too: the failure was recorded server-side, and the badge reporting it is
      // least useful if it only appears after an unrelated reload.
      await settle()
      if (await retriedAfterUnlock(e, () => sync(provider, { connectionId }))) return
      setNotice({ title: 'Sync failed', description: e.message })
    }
  }, [ensureVault, retriedAfterUnlock, settle, setSyncState, syncState, syncUntilComplete])

  // Every provider that has something to sync, as one run. This is what a page-level or app-level
  // control means by "sync" — bring in everything new — as against the per-connection check the Accounts
  // card offers. Failures are collected per provider rather than raised, so one bank being down neither
  // abandons the run nor hides that the others imported fine.
  const syncAll = useCallback(async (providers) => {
    const list = (providers || [])
      .filter(p => (p.connections || []).length)
      .map(p => p.provider)
    if (!list.length) return
    if (!(await ensureVault())) return
    const { failures } = await runSyncAll(list, { days: 0 })
    await settle()
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
  }, [ensureVault, runSyncAll, settle])

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
      await settle()
    } finally {
      setFetchingHistoryConnId(null)
    }
  }, [ensureVault, fetchingHistoryConnId, pullConnectionHistory, refreshingConnId, settle])

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
      await settle()
    } catch (e) {
      setSyncState(prev => ({ ...prev, [provider]: { syncing: false, result: null } }))
      if (await retriedAfterUnlock(e, () => refreshAccounts(provider, connection))) return
      setNotice({ title: 'Could not refresh accounts', description: e.message })
    } finally {
      setRefreshingConnId(null)
    }
  }, [ensureVault, refreshingConnId, retriedAfterUnlock, settle, setSyncState, syncUntilComplete])

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

  return {
    sync,
    syncAll,
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
    }),
  }
}
