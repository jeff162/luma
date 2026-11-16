// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// Data connections as a way of *getting data in*, on the Import page's Data Import tab beside the file
// drop zone.
//
// **Why it is here as well as on the Connections tab.** A sync and a dropped file are the same intent —
// bring in new data — and they produce the same artifact, an import card in the history below. So the
// two sit side by side over one record of what arrived, and the tab is where everything recently
// imported is started and read. Setting a connection up (connecting, mapping, the credential,
// disconnecting) stays on the Connections tab.
//
// **Nothing here is a second implementation.** The actions come from `useConnectionOperations`, the
// status rendering from `ConnectionStatus`, the summary line from `connectionSummary`, and the run
// itself from `SyncStatusContext` — the pieces the Connections tab and the navigation pane's sync
// control use. Two surfaces describing one connection must not be able to describe it differently.
//
// **One sync button, not one per row.** "Bring in everything new" is the whole intent here. Syncing a
// single connection is a check on something just configured, and lives where the configuring happens.
//
// **The card sits beside the drop zone, so it has to stay short.** One line per connection, collapsed
// by default: who it is, how stale it is, anything asking to be acted on, and a menu. The per-account
// breakdown of a pull is on the import cards below, which is where those rows landed.

import { useCallback, useMemo, useState } from 'react'
import { api } from '../../lib/api.js'
import { Button, Card, Tooltip } from '../ui.jsx'
import FeatureExplainer from '../../help/FeatureExplainer.jsx'
import { ActionMenu, ActionMenuButton } from '../ActionMenu.jsx'
import { LastSyncSummary, LastSyncedLine, StatusPill } from './ConnectionStatus.jsx'
import { ConnectionSyncLogDialog } from './ConnectionSyncLogDialog.jsx'
import { useSyncStatus } from '../../contexts/SyncStatusContext.jsx'
import { useConnectionOperations } from '../../lib/useConnectionOperations.js'
import { providerSummaryLine } from '../../lib/connectionSummary.js'
import { formatTimestamp } from '../../lib/utils.js'

// `batches` is the host's own list of import cards, which is where the count of synced rows waiting on
// a duplicate decision comes from. `onShowHistory({ connectionIds })` brings those cards into view,
// `onShowConnections` opens the Connections tab, and `onChanged` tells the host that an action here
// changed the cards without a sync run to report it.
export function DataConnectionsPanel({ style, batches, onShowHistory, onShowConnections, onChanged }) {
  // The listing the context already holds and keeps current through a run — not a fetch of our own.
  const { providers, syncState, runProviders, watching } = useSyncStatus()
  const [cardMenu, setCardMenu] = useState(null)
  // Which connection's last-sync detail is open, and the provider accounts that detail needs. Fetched on
  // expand rather than up front: it is one request per connection for something most visits never look at.
  const [expandedConnId, setExpandedConnId] = useState(null)
  const [expandedAccounts, setExpandedAccounts] = useState([])
  const [listOpen, setListOpen] = useState(false)
  const [syncLogOpen, setSyncLogOpen] = useState(false)

  const suspectsByConnection = useMemo(() => {
    const suspects = {}
    for (const b of batches || []) {
      if (b.source_kind !== 'connection_sync' || !b.connection_id) continue
      suspects[b.connection_id] = (suspects[b.connection_id] || 0) + Math.max(0, Number(b.suspect_duplicate_count || 0))
    }
    return suspects
  }, [batches])

  const toggleDetail = useCallback(async (connectionId) => {
    if (expandedConnId === connectionId) { setExpandedConnId(null); return }
    setExpandedConnId(connectionId)
    setExpandedAccounts([])
    const res = await api.getConnectionAccounts(connectionId).catch(() => null)
    if (!res) return
    // Every account the connection offers, not only those that received something: an account importing
    // nothing is exactly what this detail exists to surface.
    setExpandedAccounts((res.accounts || []).map(pa => ({
      external_account_id: pa.external_account_id,
      label: pa.display_label || pa.provider_name || pa.external_account_id,
      mapped: !!pa.mapped,
      mapping_mode: pa.mapping_mode,
    })))
  }, [expandedConnId])

  const {
    syncAll, fetchMoreHistory, refreshConnectionAccounts, openRemoveSynced,
    busy: { refreshingConnId, fetchingHistoryConnId, removingSync },
    dialogsNode,
  } = useConnectionOperations({ onChanged })

  const connected = (providers || []).filter(p => (p.connections || []).length)
  // Nothing connected means no card: a file-only install is not shown an empty frame for a feature it
  // does not use. Setting one up is the Connections tab.
  if (!connected.length) return null

  // The same "is a sync happening?" expression the Connections tab, the sync panel and the navigation
  // control use, so they cannot disagree.
  const syncing = runProviders.some(p => syncState[p]?.syncing)
    || watching
    || connected.some(p => p.connections.some(c => c.syncing))
  const allConnections = connected.flatMap(p => p.connections.map(c => ({ ...c, provider: p.provider })))
  // Oldest, not newest — the card speaks for every connection under it, so the honest headline is the one
  // furthest behind.
  const oldest = allConnections.map(c => c.last_synced_at).filter(Boolean).sort()[0] || null
  const needsReconnect = allConnections.filter(c => c.reauth_required).length
  const reviewConnectionIds = allConnections.filter(c => suspectsByConnection[c.id] > 0).map(c => c.id)
  const totalReview = reviewConnectionIds.reduce((n, id) => n + suspectsByConnection[id], 0)

  return (
    <>
      <Card style={{ display: 'grid', gap: 10, alignContent: 'start', ...style }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <FeatureExplainer topic="data-providers" placement="bottom-left" />
            <div style={{ fontSize: 14, fontWeight: 600 }}>Data connections</div>
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2, lineHeight: 1.5 }}>
            Fetch new and changed transactions from the connected accounts.
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Tooltip describeTrigger content={syncing
            ? 'A sync is already running'
            : `Pull new and changed transactions for all ${allConnections.length} connection${allConnections.length === 1 ? '' : 's'}`}>
            <Button onClick={syncAll} disabled={syncing}>
              {syncing ? 'Syncing…' : '↻ Sync now'}
            </Button>
          </Tooltip>
          <Button variant="secondary" onClick={() => setSyncLogOpen(true)}
            title="What every sync, connect and disconnect actually did — how much arrived, whether the full history was fetched, and anything the provider reported">
            Sync log
          </Button>
          <span style={{ fontSize: 12, color: 'var(--muted)', marginLeft: 'auto' }}>
            {providerSummaryLine({
              connectionCount: allConnections.length,
              syncing,
              lastSyncedLabel: formatTimestamp(oldest),
            })}
          </span>
        </div>

        {/* Everything that is *asking* for something rides on this line, so it survives the collapse —
            a connection that has stopped importing, or synced rows waiting on a duplicate decision,
            must not be hidden behind a disclosure nobody opened. Only the routine roll-call collapses. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" onClick={() => setListOpen(open => !open)}
            aria-expanded={listOpen}
            title={listOpen ? 'Hide the connections' : 'Show each connection'}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              background: 'none', border: 'none', padding: 0, cursor: 'pointer',
              font: 'inherit', fontSize: 12, color: 'var(--muted)',
            }}>
            <span aria-hidden style={{ fontSize: 10 }}>{listOpen ? '▾' : '▸'}</span>
            <span>Connections ({allConnections.length})</span>
          </button>
          {needsReconnect ? (
            <StatusPill tone="danger" onClick={onShowConnections}
              title="The provider no longer accepts the connection — reconnect it on the Connections tab">
              ⚠ {needsReconnect} need{needsReconnect === 1 ? 's' : ''} reconnecting
            </StatusPill>
          ) : null}
          {totalReview ? (
            <StatusPill tone="warning" onClick={() => onShowHistory?.({ connectionIds: reviewConnectionIds })}
              title={`${totalReview} synced transaction${totalReview === 1 ? '' : 's'} may duplicate an existing row — show the sync cards to review`}>
              ⚠ {totalReview} to review
            </StatusPill>
          ) : null}
        </div>

        {listOpen ? (
          <div style={{ display: 'grid', gap: 4 }}>
            {allConnections.map(c => {
              const suspects = suspectsByConnection[c.id] || 0
              const busyHere = fetchingHistoryConnId === c.id || refreshingConnId === c.id
              return (
                <div key={c.id} style={{ padding: '4px 0', borderTop: '1px solid var(--border)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    {/* The name is the disclosure: what opens is that connection's own per-account
                        detail, so the connection is the thing being opened. */}
                    <button type="button" onClick={() => toggleDetail(c.id)}
                      aria-expanded={expandedConnId === c.id}
                      title={expandedConnId === c.id
                        ? 'Hide what the last sync did for each account'
                        : 'Show what the last sync did for each account'}
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0,
                        background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                        font: 'inherit', fontSize: 13, color: 'var(--text)',
                      }}>
                      <span aria-hidden style={{ color: 'var(--muted)', fontSize: 10 }}>
                        {expandedConnId === c.id ? '▾' : '▸'}
                      </span>
                      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {c.institution || 'Linked bank'}
                      </span>
                    </button>
                    {/* A connection the provider will no longer accept cannot be repaired from here, and
                        saying so beats a stale timestamp that suggests nothing is wrong. */}
                    {c.reauth_required ? (
                      <StatusPill tone="danger" onClick={onShowConnections}
                        title={c.last_sync_error || 'The provider no longer accepts this connection — reconnect it on the Connections tab.'}>
                        ⚠ reconnect needed
                      </StatusPill>
                    ) : <LastSyncedLine lastSyncedAt={c.last_synced_at} requestAllowance={c.request_allowance} />}
                    {suspects > 0 ? (
                      <StatusPill tone="warning" onClick={() => onShowHistory?.({ connectionIds: [c.id] })}
                        title={`${suspects} synced transaction${suspects === 1 ? '' : 's'} may duplicate an existing row — show this connection's sync cards to review`}>
                        ⚠ {suspects} to review
                      </StatusPill>
                    ) : null}
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginLeft: 'auto' }}>
                      {busyHere ? (
                        <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                          {fetchingHistoryConnId === c.id ? 'Fetching…' : 'Refreshing…'}
                        </span>
                      ) : null}
                      <ActionMenuButton
                        open={cardMenu?.connection.id === c.id}
                        title={`Actions for ${c.institution || 'this connection'}`}
                        disabled={!!refreshingConnId || !!fetchingHistoryConnId || syncing || removingSync}
                        onOpen={element => setCardMenu({ connection: c, anchorElement: element })}
                      />
                    </div>
                  </div>
                  {expandedConnId === c.id ? (
                    <div style={{ padding: '4px 0 6px 18px' }}>
                      <LastSyncSummary
                        lastSync={c.last_sync}
                        syncing={!!c.syncing}
                        providerAccounts={expandedAccounts}
                      />
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>
        ) : null}
      </Card>

      {cardMenu ? (
        <ActionMenu
          anchorElement={cardMenu.anchorElement}
          onClose={() => setCardMenu(null)}
          minWidth={220}
          items={[
            {
              label: '↻ Fetch more history',
              title: 'Pull older transactions for this connection — requests all available history from the provider and imports anything earlier than what’s already here. A bank or plan may cap how far back it will return.',
              onClick: () => fetchMoreHistory(cardMenu.connection.provider, cardMenu.connection),
            },
            {
              label: '↻ Refresh accounts',
              title: 'Rebuild this connection’s accounts from its saved credential (no re-linking), then sync. Use this if the accounts are missing — e.g. after restoring a backup. To pull older transactions, use Fetch more history.',
              onClick: () => refreshConnectionAccounts(cardMenu.connection.provider, cardMenu.connection),
            },
            {
              label: 'Remove synced transactions',
              separatorBefore: true,
              title: 'Delete every transaction this connection has synced and reset how far it has pulled, so the next sync re-imports that history from the provider. The connection, its accounts, and their mapping are kept.',
              onClick: () => openRemoveSynced(cardMenu.connection),
            },
          ]}
        />
      ) : null}
      {syncLogOpen ? <ConnectionSyncLogDialog onClose={() => setSyncLogOpen(false)} /> : null}
      {dialogsNode}
    </>
  )
}
