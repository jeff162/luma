// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { parseTimestamp } from './utils.js'

// The one line a provider's card shows about itself, in the header — the text that has to stand alone
// when the card is collapsed.
//
// It is a precedence rule rather than a concatenation, and that is the whole reason it lives here with a
// test. "Is anything happening right now?" and "how current is this data?" are different questions, and
// while a pull is in flight only the first one matters; stating both put two contradictory facts in one
// header row, because `last_synced_at` is stamped on *successful* pulls only — so a connection's very
// first sync read as `never synced` immediately beside a disabled `Syncing…` button.

export function providerSummaryLine({ connectionCount = 0, syncing = false, lastSyncedLabel = null } = {}) {
  if (!connectionCount) return 'Not connected'
  const connections = `${connectionCount} connection${connectionCount === 1 ? '' : 's'}`
  // Ordered, not combined. A running sync supersedes freshness; absent one, a connection that has never
  // completed a pull says so rather than falling silent, since "no date" is itself the finding.
  if (syncing) return `${connections} · syncing…`
  return lastSyncedLabel ? `${connections} · last synced ${lastSyncedLabel}` : `${connections} · never synced`
}


// --- Naming a provider -----------------------------------------------------------------------------
//
// Deliberately *not* the `providerLabel` in `importSourceFields.js`, and the difference is not drift.
// That one names the provider on a **transaction's** origin hover and import-history group header, where
// the label sits inside a dense row and the short form reads better ("SimpleFIN"). This one names the
// provider on the surfaces where it is being **set up and operated** — the connection cards, the sync
// panel, the navigation pane's tooltip — where the product's own full name is what the user went looking
// for and matched against the bridge they signed up to ("SimpleFIN Bridge").
//
// The fallback differs for the same reason: an unknown key on a connection surface is still a provider
// the user is configuring, so it gets a word rather than an empty string that would leave a label blank.
const CONNECTION_PROVIDER_LABELS = { plaid: 'Plaid', simplefin: 'SimpleFIN Bridge' }

export function connectionProviderLabel(provider) {
  const key = String(provider || '').toLowerCase()
  if (CONNECTION_PROVIDER_LABELS[key]) return CONNECTION_PROVIDER_LABELS[key]
  return key ? key[0].toUpperCase() + key.slice(1) : 'Provider'
}


// --- Re-linking an existing connection ------------------------------------------------------------
//
// Whether the connect dialog has to ask *which connection this replaces*, and how to describe the
// choices. Here rather than inline in the page for the usual reason: it is a rule with edges (a provider
// that never needs asking, a connection with no accounts yet, a list too long to read) and the page is
// where those edges would go untested.

// Connections a fresh authorization could be replacing.
//
// Empty for a provider whose handle is issued by the provider itself: its own `external_id` already
// answers "which connection is this?", the upsert lands the credential on the right row, and asking would
// be a question with one possible answer. Non-empty only where the handle is *derived from the
// credential*, so a new credential is indistinguishable from a new connection — and the user is the only
// one who knows which it is.
//
// Working connections are offered alongside ones that need reconnecting, deliberately. A provider whose
// credential spans several institutions is re-authorized as a matter of routine, with nothing wrong with
// the connection being replaced, so restricting the list to failing ones would hide the ordinary case.
export function relinkCandidates(provider) {
  if (!provider || provider.stable_external_id !== false) return []
  return provider.connections || []
}

// What distinguishes one candidate from another.
//
// The institution cannot: a provider that spans several banks reports the same string for every
// connection it holds, so a list keyed on it offers the user identical choices. The accounts are the part
// that differs, capped because the point is recognition, not an inventory.
export function connectionAccountsLabel(names, { max = 3 } = {}) {
  const shown = (names || []).map(n => (n || '').trim()).filter(Boolean)
  if (!shown.length) return null
  if (shown.length <= max) return shown.join(', ')
  return `${shown.slice(0, max).join(', ')} +${shown.length - max} more`
}


// --- Opening the last sync's rows ------------------------------------------------------------------
//
// Which import cards a connection's last sync actually wrote to, as batch descriptors the shared
// card-ledger panel can open. Here rather than inline because the rule has two edges worth testing.
//
// **One pull can write to more than one card.** Rows are filed under their *own* transaction month, so
// for a few days after a rollover the tail of the previous month arrives beside the current one. Opening
// only the largest would silently drop rows the summary just counted, and a card cannot show rows that
// are not on it — so every card the pull touched is returned.
//
// **`_syncScope` decides which of two reports this is.** Under the row cap the ids were recorded, so the
// ledger can be narrowed to exactly the rows this sync delivered — the case worth having, since a routine
// sync is a handful of rows someone may well want to categorize on the spot. Over it the ids were never
// stored and the card opens whole, which is the better report at that size anyway: the only pull that
// exceeds the cap is a first backfill, and a backfill has its own "Initial import" card already.
export function lastSyncReportCards(connection) {
  const cards = connection?.last_sync?.cards || []
  if (!cards.length) return []
  const scoped = Number(connection?.last_sync?.scoped_rows || 0) > 0
  return cards.map(card => ({
    id: card.id,
    filename: card.label,
    imported_at: card.imported_at,
    // Every card a sync writes is a sync card; the report words itself by it when opened whole.
    source_kind: 'connection_sync',
    ...(scoped ? { _syncScope: { connectionId: connection.id, label: 'the last sync' } } : {}),
  }))
}


// --- What a provider's connections are collectively saying ------------------------------------------
//
// The states the Connections tab's provider card has to report about one provider's connections.
//
// `unmappedByConnection` and `reviewByConnection` are passed in rather than read here: they come from
// other endpoints (the connection's account mapping, and the sync cards' unresolved duplicates), and a
// pure function over what the caller already has is what makes this testable.
export function providerConnectionStates(provider, { unmappedByConnection = {}, reviewByConnection = {} } = {}) {
  const connections = provider?.connections || []
  const reauth = connections.filter(c => c.reauth_required)
  // A connection needing reconnection is also failing, but it is reported only as the former: the two
  // pills would say the same thing twice, and only one of them names something the user can do.
  const failing = connections.filter(c => (c.consecutive_sync_failures || 0) > 0 && !c.reauth_required)
  const warned = connections.filter(c => (c.last_sync_warnings || []).length > 0)
  const synced = connections.map(c => c.last_synced_at).filter(Boolean).sort()
  const unmapped = connections.reduce((n, c) => n + (unmappedByConnection[c.id] || 0), 0)
  const review = connections.reduce((n, c) => n + (reviewByConnection[c.id]?.suspects || 0), 0)
  return {
    connections, reauth, failing, warned, unmapped, review,
    // The OLDEST of the successful pulls, not the newest: the card speaks for every connection under
    // it, so the honest headline is the one that is furthest behind. Taking the newest would let one
    // healthy connection make a card look current while another had not synced in a month.
    lastSynced: synced[0] || null,
    allSynced: synced.length === connections.length && synced.length > 0,
  }
}


// --- How current is everything? -------------------------------------------------------------------
//
// What one control speaking for *every* connection can honestly say about freshness, for the navigation
// pane's sync item.
//
// The rule is the same one `providerSummary` already applies a level down, and for the same reason: the
// headline is the connection that is **furthest behind**, not the most recently synced one. Taking the
// newest would let a connection synced two minutes ago report the whole app as current while another had
// not synced in a month — which is precisely the state a standing freshness indicator exists to reveal.
//
// A connection that has never synced is kept apart from the oldest date rather than folded into it. It
// has no timestamp to be the oldest, and treating it as infinitely stale would replace a readable date
// with "never" the first time a connection was added — so the count travels separately and the caller
// decides how loudly to say it.
export function syncFreshness(providers = []) {
  const byProvider = []
  let connectionCount = 0
  let oldest = null
  let neverSynced = 0
  for (const p of providers) {
    const connections = p.connections || []
    if (!connections.length) continue
    const synced = connections.map(c => c.last_synced_at).filter(Boolean).sort()
    const never = connections.length - synced.length
    connectionCount += connections.length
    neverSynced += never
    if (synced.length && (oldest === null || synced[0] < oldest)) oldest = synced[0]
    byProvider.push({
      provider: p.provider,
      connectionCount: connections.length,
      lastSynced: synced[0] || null,
      neverSynced: never,
    })
  }
  return { connectionCount, lastSynced: oldest, neverSynced, byProvider }
}


// A sync of everything is confirmed when everything is already this fresh, because a repeat pull brings
// in next to nothing and still spends a provider's request allowance. The test is the *oldest* sync, the
// same figure the sync controls display: one connection days behind means the sync has work to do.
export const RESYNC_CONFIRM_WINDOW_MS = 30 * 60 * 1000

// The oldest `last_synced_at` when every connection has synced inside that window, else null.
export function recentFullSync(providers = [], now = Date.now()) {
  const { connectionCount, lastSynced, neverSynced } = syncFreshness(providers)
  if (!connectionCount || neverSynced || !lastSynced) return null
  const age = now - parseTimestamp(lastSynced).getTime()
  return age < RESYNC_CONFIRM_WINDOW_MS ? lastSynced : null
}

// Whether any connection finished a sync between two reads of the providers listing: its
// `last_synced_at` moved forward, or it is new and has synced (a connect elsewhere pulls its history).
export function syncedSince(previous = [], next = []) {
  const before = new Map()
  for (const p of previous) for (const c of p.connections || []) before.set(c.id, c.last_synced_at || null)
  return next.some(p => (p.connections || []).some(c => {
    if (!c.last_synced_at) return false
    const was = before.get(c.id)
    return !was || parseTimestamp(c.last_synced_at) > parseTimestamp(was)
  }))
}

// The navigation pane's sync row, in the same precedence shape as `providerSummaryLine` above and for the
// same reason: it is a rule with edges, and the component is where those edges would go untested.
//
// The ordering is what matters. A run in progress supersedes freshness (nobody wants to be told how stale
// the data was while the pull fixing it is running), and a finished run supersedes it too until the user
// has seen the summary — the row is the way back to that panel, so it must not read as an invitation to
// start a second pull. Only an idle app reports freshness, and an idle app with nothing ever synced says
// so rather than falling silent, because "no date" is itself the finding.
export function syncNavLabel({ driving = false, finished = false, added = 0, relativeLabel = null } = {}) {
  if (driving) return added ? `Syncing — ${added} imported` : 'Syncing…'
  if (finished) return 'Sync finished'
  return relativeLabel ? `Sync · ${relativeLabel}` : 'Sync · never run'
}

// A provider account as `GET /connections/{id}/accounts` lists it, reduced to what `LastSyncSummary`'s chips
// read: the provider's label, and for a mapped account the local account its rows land in, which the chip
// shows after it as an import card's chip does.
export function providerAccountChip(pa) {
  return {
    external_account_id: pa.external_account_id,
    label: pa.source_label || pa.provider_name || pa.external_account_id,
    mapped_label: pa.mapped && pa.mapping_mode !== 'skip' ? pa.account_name || '' : '',
    mapped: !!pa.mapped,
    mapping_mode: pa.mapping_mode,
  }
}
