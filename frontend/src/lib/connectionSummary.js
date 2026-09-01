// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

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
