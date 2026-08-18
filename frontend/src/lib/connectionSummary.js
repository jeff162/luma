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
