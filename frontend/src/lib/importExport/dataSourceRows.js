// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// The import history's rows: one per data source, each holding the cards it produced. Saved data sources,
// marketplace vendors and connections each get their own row; a file imported without a source is the
// temporary draft (the newest) or the unknown-data-source bucket (the rest). Shared by the Import
// history and the import-storage screen in Settings, which groups the same cards under the same names.

import { byCoverage } from './importHistoryWindow.js'

export function buildDataSourceRows({ profiles = [], batches = [], manualDraftRecord = null }) {
  const savedSourceRows = profiles.map(profile => {
    // Cards run by the period they cover (`byCoverage`); `latestBatch` stays the most recently
    // imported, since "Last used" is a fact about the source rather than about its newest data.
    const profileBatches = batches.filter(batch => batch.profile_id === profile.id).sort(byCoverage)
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
  const isMarketplaceBatch = batch => typeof batch.source_kind === 'string' && batch.source_kind.startsWith('marketplace:')
  const marketplaceByVendor = new Map()
  for (const batch of batches) {
    if (batch.profile_id || !isMarketplaceBatch(batch)) continue
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
