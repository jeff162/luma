// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// The import history's rows: one per data source, each holding the cards it produced. Saved data sources,
// marketplace vendors and connections each get their own row; a file imported without a source is the
// temporary draft (the newest) or the unknown-data-source bucket (the rest). Shared by the Import
// history and the import-storage screen in Settings, which groups the same cards under the same names.

import { byCoverage } from './importHistoryWindow.js'

// One marketplace vendor's cards, split into a subtree per account they imported into: with two Amazon
// accounts in one ledger, a flat list interleaves two people's order history and there is nothing on a
// card that says whose it is. The account is read from `amazon_account_id`, recorded on the card at
// import (and backfilled onto older ones from their rows).
//
// A card with no account recorded is one with no rows to backfill from — in practice an items-only card
// holding detail until its orders file arrives. That is what its group is named for, and the group falls
// back to naming the absence when its cards are not all in that state.
export function buildMarketplaceAccountGroups(batches) {
  const groups = new Map()
  for (const batch of batches) {
    const key = batch.amazon_account_id || ''
    if (!groups.has(key)) {
      groups.set(key, { key: key || 'unattributed', accountId: batch.amazon_account_id || null,
                        label: batch.amazon_account_name || '', batches: [] })
    }
    const group = groups.get(key)
    // An account renamed between imports leaves older cards carrying the older name; the newest card's
    // name wins, which is the one the account list also shows.
    if (!group.label && batch.amazon_account_name) group.label = batch.amazon_account_name
    group.batches.push(batch)
  }
  const unattributed = groups.get('')
  if (unattributed) {
    const allWaiting = unattributed.batches.every(b => Number(b.unmatched_item_count || 0) > 0)
    unattributed.label = allWaiting ? 'Waiting for orders file' : 'No account recorded'
  }
  // Named accounts first, alphabetically; the unattributed group last, since it is a leftover rather
  // than a peer of the accounts.
  return [...groups.values()].sort((a, b) => {
    if (!a.accountId !== !b.accountId) return a.accountId ? -1 : 1
    return a.label.localeCompare(b.label)
  })
}

export function buildDataSourceRows({ profiles = [], batches = [], manualDraftRecord = null }) {
  // A marketplace card belongs to its vendor's row even when it names a saved source, because a
  // marketplace source is stored as a `csv_import_profile` row too. Tested on the card rather than on
  // the profile list, so this holds however the two are fetched.
  const isMarketplaceBatch = batch => typeof batch.source_kind === 'string' && batch.source_kind.startsWith('marketplace:')
  const savedSourceRows = profiles.map(profile => {
    // Cards run by the period they cover (`byCoverage`); `latestBatch` stays the most recently
    // imported, since "Last used" is a fact about the source rather than about its newest data.
    const profileBatches = batches
      .filter(batch => batch.profile_id === profile.id && !isMarketplaceBatch(batch))
      .sort(byCoverage)
    const latestBatch = [...profileBatches].sort((a, b) => String(b.imported_at || '').localeCompare(String(a.imported_at || '')))[0] || null
    return {
      key: `profile:${profile.id}`,
      kind: 'profile',
      profile,
      hasImportedCategories: profileBatches.some(batch => batch.has_imported_categories),
      batches: profileBatches,
      latestBatch,
    }
  })
  // Marketplace imports (Amazon, …) carry `source_kind` of `marketplace:<vendor>` and never have a CSV
  // profile; they group under their own vendor entry rather than the "unknown data source" bucket.
  // A marketplace card *may* now carry a `profile_id` (a saved Amazon source), and it still belongs to
  // the vendor rather than to a data-source row of its own — so the `profile_id` test that used to send
  // such a card to the CSV mapping row is gone from here and from the profile rows above.
  const marketplaceByVendor = new Map()
  for (const batch of batches) {
    if (!isMarketplaceBatch(batch)) continue
    const vendor = batch.source_kind.split(':')[1] || 'marketplace'
    if (!marketplaceByVendor.has(vendor)) marketplaceByVendor.set(vendor, [])
    marketplaceByVendor.get(vendor).push(batch)
  }
  for (const [vendor, vendorBatches] of marketplaceByVendor) {
    const byImport = vendorBatches.sort((a, b) => String(b.imported_at || '').localeCompare(String(a.imported_at || '')))
    // Cards ordered by the data they cover; latestBatch stays the most recently imported so
    // "Last used" is unaffected.
    savedSourceRows.push({
      key: `marketplace:${vendor}`,
      kind: 'marketplace',
      vendor,
      label: vendor.charAt(0).toUpperCase() + vendor.slice(1),
      profile: null,
      hasImportedCategories: byImport.some(b => b.has_imported_categories),
      batches: [...byImport].sort(byCoverage),
      accountGroups: buildMarketplaceAccountGroups([...byImport].sort(byCoverage)),
      latestBatch: byImport[0],
      manualDraftRecord: null,
    })
  }

  // Data-source sync cards (source_kind 'connection_sync', no CSV profile): one history row per
  // connection, its per-(connection, month) period cards as the expandable batches — grouped like a
  // marketplace vendor so synced rows get the same per-card duplicate/review affordances as an imported
  // file. The card filename is "<institution> · <Month Year>"; the institution prefix labels the row.
  const isConnectionSyncBatch = batch => batch.source_kind === 'connection_sync'
  const connectionLabelFromFilename = filename => {
    const [prefix] = String(filename || '').split(' · ')
    return (prefix || '').trim() || 'Connection'
  }
  // A card whose connection is gone keeps its history on purpose — `connection_id` is ON DELETE SET
  // NULL, because these cards are the provenance of transactions still in the ledger and outlive the
  // credential that fetched them. What they must not do is pile into one bucket: keyed together, a
  // group takes its name from whichever orphan is newest and files every other source under it, so a
  // SimpleFIN import ends up sitting beneath a bank's name. Each card still carries its own identity in
  // the filename prefix, so that is what they are grouped by instead.
  const connectionGroups = new Map()
  for (const batch of batches) {
    if (!isConnectionSyncBatch(batch)) continue
    const key = batch.connection_id
      || `disconnected:${connectionLabelFromFilename(batch.filename)}`
    if (!connectionGroups.has(key)) connectionGroups.set(key, [])
    connectionGroups.get(key).push(batch)
  }
  for (const [groupKey, connBatches] of connectionGroups) {
    const byImport = connBatches.sort((a, b) => String(b.imported_at || '').localeCompare(String(a.imported_at || '')))
    const byPeriod = [...byImport].sort(byCoverage)
    // Absent for a disconnected group, which is what tells the row it is history rather than a live
    // connection — there is no connection left for its actions to act on.
    const connectionId = byImport[0]?.connection_id || null
    savedSourceRows.push({
      key: `connection:${groupKey}`,
      kind: 'connection',
      connectionId,
      disconnected: !connectionId,
      // Prefer the connection's own institution/provider (real fields) over parsing them out of the
      // card filename; the filename parse stays as a fallback for older cards created before the
      // provenance was plumbed through — and it is the only source for a disconnected group, whose
      // connection row is gone along with the fields it carried.
      label: byImport[0]?.connection_institution || connectionLabelFromFilename(byImport[0]?.filename),
      provider: byImport[0]?.connection_provider || null,
      profile: null,
      hasImportedCategories: false,
      batches: byPeriod,
      latestBatch: byImport[0],
      // The connection's own last sync, which is what "recent" means for it. The newest card's imported_at
      // is only when that card was created — a monthly card keeps receiving rows for weeks afterwards.
      // Null once disconnected, when the connection's record is gone.
      lastSyncedAt: byImport[0]?.connection_last_synced_at || null,
      manualDraftRecord: null,
    })
  }

  const manualBatches = batches
    .filter(batch => !batch.profile_id && !batch.unknown_source_fallback && !isMarketplaceBatch(batch) && !isConnectionSyncBatch(batch))
    .sort((a, b) => String(b.imported_at || '').localeCompare(String(a.imported_at || '')))
  const fallbackUnknownBatches = batches
    .filter(batch => !batch.profile_id && batch.unknown_source_fallback && !isMarketplaceBatch(batch) && !isConnectionSyncBatch(batch))
    .sort((a, b) => String(b.imported_at || '').localeCompare(String(a.imported_at || '')))
  const latestManualBatch = manualBatches[0] || null
  const olderManualBatches = manualBatches.slice(1)

  if (latestManualBatch) {
    savedSourceRows.push({
      key: 'manual-draft',
      kind: 'manual',
      profile: null,
      hasImportedCategories: !!latestManualBatch?.has_imported_categories,
      batches: [latestManualBatch],
      latestBatch: latestManualBatch,
      manualDraftRecord,
    })
  }

  const unknownSourceBatches = [
    ...olderManualBatches,
    ...fallbackUnknownBatches,
  ].sort(byCoverage)

  if (unknownSourceBatches.length > 0) {
    savedSourceRows.push({
      key: 'unknown-source',
      kind: 'unknown',
      profile: null,
      hasImportedCategories: unknownSourceBatches.some(batch => batch.has_imported_categories),
      batches: unknownSourceBatches,
      latestBatch: [...unknownSourceBatches].sort((a, b) => String(b.imported_at || '').localeCompare(String(a.imported_at || '')))[0],
      manualDraftRecord: null,
    })
  }
  // A connection is as recent as its last sync; everything else as its newest import. The two timestamps are
  // written in different shapes (`2026-09-12T13:23:40Z` against `2026-09-12 13:23:40`, both UTC), so the
  // separator is normalized before comparing, or every same-day sync would sort after every same-day import.
  const recency = row => String((row.kind === 'connection' && row.lastSyncedAt) || row.latestBatch?.imported_at || '').replace('T', ' ')
  return savedSourceRows.sort((a, b) => {
    const priority = row => row.kind === 'manual' ? 0 : 1
    const priorityDiff = priority(a) - priority(b)
    if (priorityDiff !== 0) return priorityDiff
    return recency(b).localeCompare(recency(a))
  })
}
