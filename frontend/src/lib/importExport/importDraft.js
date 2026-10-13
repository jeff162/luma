// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// Pure helpers for import-draft persistence and the snapshot/profile-body shapes
// it round-trips through. Two layers coexist:
//   - a saved import profile is the source of truth for reusable mapping state;
//   - a browser-local draft is the fallback that lets a no-profile manual import
//     resume later, and it is header-compatible rather than file-specific so the
//     work only carries forward when the next file still looks like the same
//     provider shape. The local draft must never override a matched profile.
// This module owns the blank snapshot/mapping shapes, the localStorage draft
// load/save/clear primitives keyed by instance+subject, the conversion between a
// draft snapshot and a saved-profile body, and the file-compatibility checks.

import {
  IMPORTED_CATEGORY_SETTINGS_KEY,
  IMPORTED_CATEGORY_SCOPE_ALL,
} from './constants.js'
import {
  getBlankImportedCategorySettings,
  normalizeImportedCategorySettings,
  extractImportedCategorySettings,
} from './importedCategorySettings.js'
import { inferFilenamePattern } from '../importColumnInference.js'

export function getBlankImportSnapshot() {
  return {
    column_map: {},
    category_assignments: {},
    account_map: {},
    skip_accounts: [],
    account_new: {},
    account_id: null,
    single_account_new: null,
    date_format: '%m/%d/%Y',
    amount_convention: 'single_signed',
    skip_rows: 0,
    apply_categorization: true,
    use_imported_categories: false,
    [IMPORTED_CATEGORY_SETTINGS_KEY]: getBlankImportedCategorySettings(),
  }
}

export function getBlankMappingSuggestions() {
  return {
    date: '',
    amount: '',
    debit: '',
    credit: '',
    direction: '',
    description: '',
    category: '',
    notes: '',
    pending: '',
    currency: '',
    transaction_id: '',
    account: '',
  }
}

// A file without a column the source maps says nothing about that mapping — typically an export from
// before the vendor added the column — so saving the source after importing it keeps the stored mapping
// rather than taking the file's empty field. Otherwise one older file would quietly un-map a
// transaction-ID column and every later file would arrive without ids until someone noticed. A column
// the file does carry is the user's to clear, and with no headers there is nothing to judge absence by.
export function keepMappingsForAbsentColumns(columnMap, storedColumnMap, fileHeaders) {
  const headers = new Set(fileHeaders || [])
  if (headers.size === 0) return columnMap
  const kept = { ...columnMap }
  for (const key of Object.keys(getBlankMappingSuggestions())) {
    const stored = storedColumnMap?.[key]
    if (!kept[key] && stored && !headers.has(stored)) kept[key] = stored
  }
  return kept
}

export function stableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function deriveImportSourceHints(previewLike) {
  const filename = previewLike?.filename || ''
  const filenamePattern = inferFilenamePattern(filename).trim().toLowerCase()
  return {
    headerFingerprint: previewLike?.header_fingerprint || '',
    filenamePattern,
  }
}

export function buildEmptyDataSourceBody(name) {
  return {
    name: name.trim(),
    filename_pattern: null,
    header_fingerprint: null,
    template_filename: null,
    template_file_hash: null,
    column_map: {},
    account_id: null,
    date_format: '%m/%d/%Y',
    amount_convention: 'single_signed',
    skip_rows: 0,
    apply_categorization: true,
    // Spelled out like its siblings even though it matches the API default, so the shape stays complete
    // and a later change to that default can't silently alter what a new empty source starts with.
    enrich_from_source: false,
    use_imported_categories: false,
    imported_category_scope_mode: IMPORTED_CATEGORY_SCOPE_ALL,
    imported_category_owner_ids: [],
    imported_category_unassigned_account_tokens: [],
  }
}

export function getImportDraftStorageKey(instanceId, subjectId) {
  return instanceId && subjectId ? `luma.importDraft.v2.${instanceId}.${subjectId}` : null
}

export function loadSavedImportDraftRecord(instanceId, subjectId) {
  const storageKey = getImportDraftStorageKey(instanceId, subjectId)
  if (!storageKey) return null
  try {
    const raw = window.localStorage.getItem(storageKey)
    if (!raw) return null
    const saved = JSON.parse(raw)
    if (!saved?.snapshot) return null
    return saved
  } catch {
    return null
  }
}

export function loadSavedImportDraft(previewLike, instanceId, subjectId) {
  const saved = loadSavedImportDraftRecord(instanceId, subjectId)
  if (!saved) return null
  const { headerFingerprint } = deriveImportSourceHints(previewLike)
  if (saved.headerFingerprint && headerFingerprint && saved.headerFingerprint !== headerFingerprint) return null
  return saved.snapshot
}

export function saveImportDraft(previewLike, snapshot, instanceId, subjectId) {
  const storageKey = getImportDraftStorageKey(instanceId, subjectId)
  if (!storageKey) return
  try {
    const { headerFingerprint, filenamePattern } = deriveImportSourceHints(previewLike)
    const record = {
      headerFingerprint,
      filenamePattern,
      templateFilename: previewLike?.filename || '',
      templateFileHash: previewLike?.file_content_hash || '',
      snapshot,
    }
    window.localStorage.setItem(storageKey, JSON.stringify(record))
    return record
  } catch { }
}

export function saveImportDraftRecord(record, instanceId, subjectId) {
  const storageKey = getImportDraftStorageKey(instanceId, subjectId)
  if (!storageKey) return null
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(record))
    return record
  } catch { }
}

export function clearSavedImportDraft(instanceId, subjectId) {
  const storageKey = getImportDraftStorageKey(instanceId, subjectId)
  if (!storageKey) return
  try {
    window.localStorage.removeItem(storageKey)
  } catch { }
}

export function buildProfileBodyFromSnapshot(name, draftRecord) {
  const snapshot = draftRecord?.snapshot
  if (!snapshot) return null
  const columnMap = { ...(snapshot.column_map || {}) }
  if (snapshot.single_account_new?.name?.trim()) {
    columnMap.single_account_new = {
      name: snapshot.single_account_new.name.trim(),
      type: snapshot.single_account_new.type || 'depository',
    }
  }
  if (snapshot.account_map && Object.keys(snapshot.account_map).length > 0) {
    columnMap.account_assignments = { ...snapshot.account_map }
  }
  if (snapshot.skip_accounts?.length > 0) {
    columnMap.account_skips = [...snapshot.skip_accounts]
  }
  if (snapshot.account_new && Object.keys(snapshot.account_new).length > 0) {
    columnMap.account_new = { ...snapshot.account_new }
  }
  columnMap[IMPORTED_CATEGORY_SETTINGS_KEY] = normalizeImportedCategorySettings(
    extractImportedCategorySettings(snapshot)
  )
  const importedCategorySettings = normalizeImportedCategorySettings(extractImportedCategorySettings(snapshot))
  return {
    name: name.trim(),
    filename_pattern: draftRecord?.filenamePattern || null,
    header_fingerprint: draftRecord?.headerFingerprint || null,
    template_filename: draftRecord?.templateFilename || null,
    template_file_hash: draftRecord?.templateFileHash || null,
    column_map: columnMap,
    account_id: snapshot.account_id || null,
    date_format: snapshot.date_format || '%m/%d/%Y',
    amount_convention: snapshot.amount_convention || 'single_signed',
    skip_rows: snapshot.skip_rows || 0,
    apply_categorization: snapshot.apply_categorization !== false,
    // Every per-source toggle the import screen offers has to be carried here, or saving the source
    // silently drops it to the API's default and the next recognized file comes back unchecked.
    enrich_from_source: !!snapshot.enrich_from_source,
    use_imported_categories: !!snapshot.use_imported_categories,
    imported_category_scope_mode: importedCategorySettings.scope_mode,
    imported_category_owner_ids: importedCategorySettings.owner_ids,
    imported_category_unassigned_account_tokens: importedCategorySettings.unassigned_account_tokens,
  }
}

export function buildDraftRecordFromPreview(previewLike, snapshot) {
  if (!previewLike || !snapshot) return null
  const { headerFingerprint, filenamePattern } = deriveImportSourceHints(previewLike)
  return {
    headerFingerprint,
    filenamePattern,
    templateFilename: previewLike?.filename || '',
    templateFileHash: previewLike?.file_content_hash || '',
    snapshot,
  }
}

export function doesDraftMatchPreview(draftRecord, previewLike) {
  if (!draftRecord || !previewLike) return false
  const draftFileHash = String(draftRecord.templateFileHash || '').trim()
  const previewFileHash = String(previewLike.file_content_hash || '').trim()
  if (draftFileHash && previewFileHash) return draftFileHash === previewFileHash
  const draftHeader = String(draftRecord.headerFingerprint || '').trim()
  const previewHeader = String(previewLike.header_fingerprint || '').trim()
  return !!draftHeader && !!previewHeader && draftHeader === previewHeader
}

export function getSuggestedDataSourceName({ draftRecord = null, previewLike = null } = {}) {
  const savedPattern = String(draftRecord?.filenamePattern || '').trim()
  if (savedPattern) return savedPattern
  return inferFilenamePattern(draftRecord?.templateFilename || previewLike?.filename || '').trim()
}

export function formatImportBatchTimestamp(value) {
  const normalized = String(value || '').trim()
  return normalized ? normalized.slice(0, 16).replace('T', ' ') : ''
}

// A header fingerprint as the list of column names it stands for.
export function splitHeaderFingerprint(value) {
  return String(value || '')
    .split('|')
    .map(header => header.trim())
    .filter(Boolean)
}

// Which columns this file has gained or lost since the data source last recorded its layout. The
// source's fingerprint is rewritten by every import it is used for (backend `run_import_parsed`), so
// this is the change since the *previous* file rather than since the source was created — which is
// the comparison worth showing, because each change is then surfaced exactly once, on the file that
// introduced it. Empty on either side means there is nothing to compare, not that nothing changed.
export function importColumnDelta(profile, previewLike) {
  const before = splitHeaderFingerprint(profile?.header_fingerprint)
  const after = splitHeaderFingerprint(previewLike?.header_fingerprint)
  if (!before.length || !after.length) return { added: [], removed: [] }
  const beforeSet = new Set(before)
  const afterSet = new Set(after)
  return {
    added: after.filter(header => !beforeSet.has(header)),
    removed: before.filter(header => !afterSet.has(header)),
  }
}

export function profileHeaderClearlyMismatches(profile, previewLike) {
  const profileHeader = String(profile?.header_fingerprint || '').trim()
  const previewHeader = String(previewLike?.header_fingerprint || '').trim()
  return !!profileHeader && !!previewHeader && profileHeader !== previewHeader
}

// Saved data sources whose header signature matches the dropped file. This is the basis for the
// auto-detect upload flow: one match applies straight away, several let the user choose, none falls
// back to a temporary draft. A profile with no stored fingerprint never auto-matches (we can't claim
// it fits), and a file with no fingerprint matches nothing.
export function findProfilesMatchingPreview(previewLike, profiles) {
  const previewHeader = String(previewLike?.header_fingerprint || '').trim()
  if (!previewHeader) return []
  return (profiles || []).filter(
    profile => String(profile?.header_fingerprint || '').trim() === previewHeader,
  )
}

// Union a column's whole-file distinct values (and summed value counts) across several previews — the
// files of one multi-file import group. This is what lets the account-mapping UI surface every account
// value in the selection, including one that appears only in a non-first file. Values keep first-seen
// order; counts are summed. A single preview degrades to just that preview's values, unchanged.
export function unionPreviewColumnValues(previews, column) {
  const values = []
  const seen = new Set()
  const counts = {}
  if (!column) return { values, counts }
  for (const preview of previews || []) {
    for (const value of preview?.column_distinct_values?.[column] || []) {
      if (!seen.has(value)) { seen.add(value); values.push(value) }
    }
    const previewCounts = preview?.column_value_counts?.[column] || {}
    for (const [value, count] of Object.entries(previewCounts)) {
      counts[value] = (counts[value] || 0) + (Number(count) || 0)
    }
  }
  return { values, counts }
}

// Group previewed files by data source for the multi-file selector. Two files are the *same source*
// when they share a header fingerprint (the same objective signal profile-matching uses); that grouping
// is independent of whether a saved profile exists. Each group is labeled by its matched data source:
// exactly one matching profile -> that source; none -> an "unknown" group (mapped by hand, using the
// filename-suggested name); several -> ambiguous (the user still resolves *which* saved source after
// picking the group, via the existing single-file source chooser). A file we couldn't fingerprint
// (empty signature, usually a parse failure) is never merged with another — it gets its own group — so
// unrelated shapes can't be silently lumped together. First-seen order is preserved.
//
// `entries` is an array of `{ file, preview }` (preview = the previewCsv result). Returns
// `[{ key, fingerprint, files: [{file, preview}], matchedProfiles, profileId, ambiguous, label }]`.
export function groupFilesBySource(entries, profiles) {
  const groups = []
  const byFingerprint = new Map()
  ;(entries || []).forEach((entry, index) => {
    if (!entry || !entry.file) return
    const fingerprint = String(entry.preview?.header_fingerprint || '').trim()
    // Empty fingerprint -> a unique key so un-fingerprintable files never coalesce.
    const key = fingerprint || `__unfingerprinted_${index}__`
    let group = fingerprint ? byFingerprint.get(fingerprint) : null
    if (!group) {
      group = { key, fingerprint, files: [], matchedProfiles: [], profileId: null, ambiguous: false, label: '' }
      groups.push(group)
      if (fingerprint) byFingerprint.set(fingerprint, group)
    }
    group.files.push({ file: entry.file, preview: entry.preview })
  })
  for (const group of groups) {
    const representative = group.files[0]?.preview || null
    const matched = findProfilesMatchingPreview(representative, profiles)
    group.matchedProfiles = matched
    group.ambiguous = matched.length > 1
    group.profileId = matched.length === 1 ? matched[0].id : null
    if (matched.length === 1) {
      group.label = matched[0].name || 'Saved source'
    } else if (matched.length > 1) {
      group.label = matched.map(profile => profile.name).filter(Boolean).join(', ') || 'Multiple sources'
    } else {
      group.label = getSuggestedDataSourceName({ previewLike: representative }) || 'Unknown source'
    }
  }
  return groups
}
