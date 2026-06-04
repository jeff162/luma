// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

// Pure helpers for the imported-category settings that ride along with a saved
// data source / import batch: whether a file's existing categories are applied
// by default, the normalized {scope_mode, owner_ids, unassigned_account_tokens}
// shape, the scope tokens that identify an owner or unassigned-account bucket,
// and the human-readable summary of the current scope. These must agree across
// the import preview, saved-profile summaries, and per-batch settings dialog.

import {
  IMPORT_CATEGORY_USAGE_MODE_ALL,
  normalizeImportCategoryUsageMode,
} from '../appConfig.js'
import {
  IMPORTED_CATEGORY_SCOPE_ALL,
  IMPORTED_CATEGORY_SCOPE_FILTERED,
  IMPORTED_CATEGORY_SETTINGS_KEY,
  FIXED_ACCOUNT_CATEGORY_SCOPE_TOKEN_PREFIX,
  NEW_ACCOUNT_CATEGORY_SCOPE_TOKEN_PREFIX,
  IMPORTED_CATEGORY_SCOPE_ALL_LABEL,
} from './constants.js'

export function getBlankImportedCategorySettings() {
  return {
    scope_mode: IMPORTED_CATEGORY_SCOPE_ALL,
    owner_ids: [],
    unassigned_account_tokens: [],
  }
}

export function getDefaultImportedCategoryUsageEnabled(categoryUsageMode) {
  return normalizeImportCategoryUsageMode(categoryUsageMode) === IMPORT_CATEGORY_USAGE_MODE_ALL
}

export function dedupeStringList(values) {
  const seen = new Set()
  const result = []
  for (const value of values || []) {
    const nextValue = String(value || '').trim()
    if (!nextValue || seen.has(nextValue)) continue
    seen.add(nextValue)
    result.push(nextValue)
  }
  return result
}

export function normalizeImportedCategorySettings(value) {
  const raw = value && typeof value === 'object' ? value : {}
  return {
    scope_mode: raw.scope_mode === IMPORTED_CATEGORY_SCOPE_FILTERED ? IMPORTED_CATEGORY_SCOPE_FILTERED : IMPORTED_CATEGORY_SCOPE_ALL,
    owner_ids: dedupeStringList(raw.owner_ids),
    unassigned_account_tokens: dedupeStringList(raw.unassigned_account_tokens),
  }
}

export function extractImportedCategorySettings(source) {
  if (!source || typeof source !== 'object') return getBlankImportedCategorySettings()
  if (source[IMPORTED_CATEGORY_SETTINGS_KEY]) {
    return normalizeImportedCategorySettings(source[IMPORTED_CATEGORY_SETTINGS_KEY])
  }
  if (source.column_map?.[IMPORTED_CATEGORY_SETTINGS_KEY]) {
    return normalizeImportedCategorySettings(source.column_map[IMPORTED_CATEGORY_SETTINGS_KEY])
  }
  return normalizeImportedCategorySettings({
    scope_mode: source.imported_category_scope_mode,
    owner_ids: source.imported_category_owner_ids,
    unassigned_account_tokens: source.imported_category_unassigned_account_tokens,
  })
}

export function getFixedAccountCategoryScopeToken(accountId) {
  const normalized = String(accountId || '').trim()
  return normalized ? `${FIXED_ACCOUNT_CATEGORY_SCOPE_TOKEN_PREFIX}${normalized}` : ''
}

export function getNewAccountCategoryScopeToken(name) {
  const normalized = String(name || '').trim().replace(/\s+/g, ' ').toLowerCase()
  return normalized ? `${NEW_ACCOUNT_CATEGORY_SCOPE_TOKEN_PREFIX}${normalized}` : ''
}

export function summarizeImportedCategorySettings(settings, choices, options = {}) {
  const { hideAllScopeLabel = false } = options
  const normalized = normalizeImportedCategorySettings(settings)
  if (normalized.scope_mode !== IMPORTED_CATEGORY_SCOPE_FILTERED) {
    return hideAllScopeLabel ? '' : IMPORTED_CATEGORY_SCOPE_ALL_LABEL
  }
  // In FILTERED mode the stored owner_ids / account tokens are the chosen
  // *inclusions*; the readable summary lists the complement instead — every
  // choice that is not included, rendered as "Excluding: …".
  const includedKeys = new Set()
  for (const ownerId of normalized.owner_ids) {
    includedKeys.add(`owner:${ownerId}`)
  }
  for (const token of normalized.unassigned_account_tokens) {
    includedKeys.add(`account:${token}`)
  }
  const labels = (choices || [])
    .filter(choice => !includedKeys.has(choice.key))
    .map(choice => choice.label)
  const choiceByKey = new Map((choices || []).map(choice => [choice.key, choice]))
  if (labels.length > 0) return `Excluding: ${labels.join(', ')}`
  return choiceByKey.size > 0 ? '' : 'No owners or unassigned accounts selected yet'
}
