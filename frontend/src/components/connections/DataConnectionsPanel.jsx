// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// Data connections as a way of *getting data in*, on the Import / Export page beside the file importer.
//
// **Why it is here and not only on Accounts.** Syncing used to live on the Accounts page's Connections
// tab, next to connecting a bank and mapping its accounts — so the routine operation was reached through
// a configuration surface, and the record of what a sync did was somewhere else again (Settings). Sync
// and a dropped CSV are the same user intent: bring me new data. They produce the same artifact — an
// `import_batch` card — and they are reviewed on the same history below. So they sit side by side, over
// one record of what arrived.
//
// **What deliberately stayed on Accounts:** connecting, disconnecting, the provider credential, and the
// account mapping. Those are decisions about how a connection is *set up*, they are made rarely, and
// Plaid Link in particular cannot move — its handler closure lives in that page's component, so
// navigating away mid-connect loses the in-flight connection. The Accounts card keeps a compact
// last-synced line and its own small per-connection sync so a mapping change can be verified where it
// was made; it does not become silent about whether the connection works.
//
// **Nothing here is a second implementation.** The actions come from `useConnectionOperations`, the
// status rendering from `ConnectionStatus`, the freshness rule from `connectionSummary`, and the run
// itself from `SyncStatusContext` — the same pieces the Accounts card and the navigation pane's sync
// control use. Two surfaces describing one connection must not be able to describe it differently.
//
// **One sync button, not one per row.** The first cut gave every provider and every connection its own,
// which at three connections under two providers put five sync buttons on a page that also has one in the
// navigation pane. They were not five different actions in any way a user cares about — "bring in
// everything new" is the whole intent here — so there is one, and it covers every connected provider.
// Syncing a single connection is a *check on something just configured*, which is a different question
// and lives where that configuring happens, on the Accounts card.
//
// **The card sits beside the file importer, so it has to stay short.** One line per connection: who it
// is, how stale it is, anything asking to be acted on, and a menu. The per-account breakdown of a pull
// deliberately is not here — it is on the import cards below, which is where those rows actually landed,
// and on the Accounts card for a connection being set up.

import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../../lib/api.js'
import { Button, Card, Tooltip } from '../ui.jsx'
import FeatureExplainer from '../../help/FeatureExplainer.jsx'
import { ActionMenu, ActionMenuButton } from '../ActionMenu.jsx'
import { LastSyncSummary, LastSyncedLine } from './ConnectionStatus.jsx'
import { useSyncStatus } from '../../contexts/SyncStatusContext.jsx'
import { useConnectionOperations } from '../../lib/useConnectionOperations.js'
import { providerSummaryLine } from '../../lib/connectionSummary.js'
import { formatTimestamp } from '../../lib/utils.js'

export function DataConnectionsPanel({ style, onOpenSyncLog }) {
  const navigate = useNavigate()
  // The listing the context already holds and keeps current through a run — not a fetch of our own.
  const { providers, syncState, runProviders, watching } = useSyncStatus()
  const [reviewByConnection, setReviewByConnection] = useState({})
  const [cardMenu, setCardMenu] = useState(null)
  // Which connection's last-sync detail is open, and the provider accounts that detail needs. Fetched on
  // expand rather than up front: it is one request per connection for something most visits never look
  // at, and the card's whole job is to stay short enough to sit beside the file importer.
  const [expandedConnId, setExpandedConnId] = useState(null)
  const [expandedAccounts, setExpandedAccounts] = useState([])
  // The connection list itself, collapsed by default. The card shares a row with the file importer, and
  // one row per connection is most of its height for information the header line already summarises.
  const [listOpen, setListOpen] = useState(false)

  // How much of each connection's synced data is waiting on a duplicate decision. Not in the providers
  // listing, because it is a property of the import cards a sync wrote rather than of the connection.
  const loadReview = useCallback(async () => {
    if (!(providers || []).length) return
    const batches = await api.listBatches().catch(() => [])
    const review = {}
    for (const b of batches || []) {
      if (b.source_kind !== 'connection_sync' || !b.connection_id) continue
      const entry = review[b.connection_id] || (review[b.connection_id] = { suspects: 0 })
      entry.suspects += Math.max(0, Number(b.suspect_duplicate_count || 0))
    }
    setReviewByConnection(review)
  }, [providers])

  useEffect(() => { loadReview() }, [loadReview])

  const toggleDetail = useCallback(async (connectionId) => {
    if (expandedConnId === connectionId) { setExpandedConnId(null); return }
    setExpandedConnId(connectionId)
    setExpandedAccounts([])
    const res = await api.getConnectionAccounts(connectionId).catch(() => null)
    if (!res) return
    // Every account the connection offers, not only those that received something: an account importing
    // nothing is exactly what this detail exists to surface, and it cannot appear in a tally built from
    // what landed.
    setExpandedAccounts((res.accounts || []).map(pa => ({
      external_account_id: pa.external_account_id,
      label: pa.source_label || pa.provider_name || pa.external_account_id,
      mapped: !!pa.mapped,
      mapping_mode: pa.mapping_mode,
    })))
  }, [expandedConnId])

  const {
    syncAll, fetchMoreHistory, refreshConnectionAccounts, openRemoveSynced,
    busy: { refreshingConnId, fetchingHistoryConnId, removingSync },
    dialogsNode,
  } = useConnectionOperations({ onChanged: loadReview })

  const connected = (providers || []).filter(p => (p.connections || []).length)
  // Nothing connected means no card. A CSV-only install should not be shown an empty frame for a feature
  // it does not use — setting one up is on the Accounts page, which is where the link below goes.
  if (!providers || !connected.length) return null

  // The same "is a sync happening?" expression the panel and the navigation control use, so the three
  // cannot disagree: between the driver's calls no connection reports as running.
  const syncing = runProviders.some(p => syncState[p]?.syncing)
    || watching
    || connected.some(p => (p.connections || []).some(c => c.syncing))
  const allConnections = connected.flatMap(p => (p.connections || []).map(c => ({ ...c, provider: p.provider })))
  // Oldest, not newest — the card speaks for every connection under it, so the honest headline is the one
  // furthest behind. Same rule `providerConnectionStates` and the navigation control apply.
  const oldest = allConnections.map(c => c.last_synced_at).filter(Boolean).sort()[0] || null
  const needsReconnect = allConnections.filter(c => c.reauth_required).length
  const totalReview = Object.values(reviewByConnection).reduce((n, r) => n + (r?.suspects || 0), 0)

  return (
    <>
      <Card style={{ display: 'grid', gap: 10, alignContent: 'start', ...style }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <FeatureExplainer topic="data-providers" placement="bottom-left" />
            <div style={{ fontSize: 14, fontWeight: 600 }}>Data connections</div>
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2, lineHeight: 1.5 }}>
            Pull new and changed transactions from a connected bank. What arrives lands on the cards below,
            the same as an imported file.
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Tooltip content={syncing
            ? 'A sync is already running'
            : `Pull new and changed transactions for all ${allConnections.length} connection${allConnections.length === 1 ? '' : 's'}`}>
            <Button small onClick={() => syncAll(connected)} disabled={syncing}>
              {syncing ? 'Syncing…' : '↻ Sync now'}
            </Button>
          </Tooltip>
          {/* Setting a connection up is a different job on a different page, and this is the only pointer
              to it from here — without it the card would be a dead end for anyone wanting a second bank. */}
          <Button variant="ghost" small onClick={() => navigate('/accounts?tab=connections')}
            title="Connect a bank, change what its accounts map to, or disconnect it">
            Manage connections
          </Button>
          {/* The log is on this page, below the history — so this is a scroll, not a journey. It is a
              button here rather than only a link from a connection's menu because "a sync brought in less
              than I expected" is a question about the whole card, not about one row of it. */}
          {onOpenSyncLog ? (
            <Button variant="ghost" small onClick={onOpenSyncLog}
              title="What every sync actually did — how much arrived, whether the full history was fetched, and anything the provider reported">
              Sync log
            </Button>
          ) : null}
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
        <button type="button" onClick={() => setListOpen(open => !open)}
          title={listOpen ? 'Hide the connections' : 'Show each connection'}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, alignSelf: 'flex-start',
            background: 'none', border: 'none', padding: 0, cursor: 'pointer',
            font: 'inherit', fontSize: 12, color: 'var(--muted)',
          }}>
          <span aria-hidden style={{ fontSize: 10 }}>{listOpen ? '▾' : '▸'}</span>
          <span>Connections ({allConnections.length})</span>
          {needsReconnect ? (
            <span style={{ color: 'var(--danger)', fontWeight: 600 }}>
              · {needsReconnect} need{needsReconnect === 1 ? 's' : ''} reconnecting
            </span>
          ) : null}
          {totalReview ? (
            <span style={{ color: 'var(--warning)', fontWeight: 600 }}>· {totalReview} to review</span>
          ) : null}
        </button>

        <div style={{ display: listOpen ? 'grid' : 'none', gap: 4 }}>
          {allConnections.map(c => {
            const review = reviewByConnection[c.id]
            const busyHere = fetchingHistoryConnId === c.id || refreshingConnId === c.id
            return (
              <div key={c.id} style={{ padding: '4px 0', borderTop: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                {/* The name is the disclosure, which is where it was and where it belongs: what opens is
                    that connection's own per-account detail, so the connection is the thing being opened.
                    Splitting the triangle onto a separate "Last sync" label read as the control having
                    disappeared, because a row with a name and no affordance on it looks inert. */}
                <button type="button" onClick={() => toggleDetail(c.id)}
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
                {/* A connection the provider will no longer accept cannot be repaired from here — the
                    remedy is a re-authorization, which lives with the rest of the setup. Saying so beats
                    a stale timestamp that suggests nothing is wrong. */}
                {c.reauth_required ? (
                  <button type="button" onClick={() => navigate('/accounts?tab=connections')}
                    title={c.last_sync_error || 'The provider no longer accepts this connection — reconnect it on the Accounts page.'}
                    style={{
                      padding: '1px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600, cursor: 'pointer',
                      background: 'color-mix(in srgb, var(--danger) 12%, var(--surface2))',
                      color: 'var(--danger)',
                      border: '1px solid color-mix(in srgb, var(--danger) 50%, var(--border))',
                    }}>
                    ⚠ reconnect needed
                  </button>
                ) : <LastSyncedLine lastSyncedAt={c.last_synced_at} />}
                {review?.suspects > 0 ? (
                  <span title={`${review.suspects} synced transaction${review.suspects === 1 ? '' : 's'} may duplicate an existing row — review them on this connection's sync cards below`}
                    style={{
                      padding: '1px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600,
                      background: 'color-mix(in srgb, var(--warning) 12%, var(--surface2))',
                      color: 'var(--warning)',
                      border: '1px solid color-mix(in srgb, var(--warning) 50%, var(--border))',
                    }}>
                    ⚠ {review.suspects} to review
                  </span>
                ) : null}
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginLeft: 'auto' }}>
                  {busyHere ? (
                    <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                      {fetchingHistoryConnId === c.id ? 'Fetching…' : 'Refreshing…'}
                    </span>
                  ) : null}
                  <ActionMenuButton
                    open={cardMenu?.connectionId === c.id}
                    title={`Actions for ${c.institution || 'this connection'}`}
                    disabled={!!refreshingConnId || !!fetchingHistoryConnId || syncing || removingSync}
                    onOpen={rect => setCardMenu({ connectionId: c.id, provider: c.provider, connection: c, anchorRect: rect })}
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
      </Card>

      {cardMenu ? (
        <ActionMenu
          anchorRect={cardMenu.anchorRect}
          onClose={() => setCardMenu(null)}
          minWidth={220}
          items={[
            {
              label: '↻ Fetch more history',
              title: 'Pull older transactions for this connection — requests all available history from the provider and imports anything earlier than what’s already here. A bank or plan may cap how far back it will return.',
              onClick: () => fetchMoreHistory(cardMenu.provider, cardMenu.connection),
            },
            {
              label: '↻ Refresh accounts',
              title: 'Rebuild this connection’s accounts from its saved credential (no re-linking), then sync. Use this if the accounts are missing — e.g. after restoring a backup. To pull older transactions, use Fetch more history.',
              onClick: () => refreshConnectionAccounts(cardMenu.provider, cardMenu.connection),
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
      {dialogsNode}
    </>
  )
}
