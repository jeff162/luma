// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

export const APP_NAME = String(import.meta.env.VITE_APP_NAME || 'Luma').trim() || 'Luma'
export const APP_VERSION = String(__APP_VERSION__ || '0.2.0').trim() || '0.2.0'

export const IMPORT_CATEGORY_USAGE_MODE_ALL = 'all'
export const IMPORT_CATEGORY_USAGE_MODE_NONE = 'none'
export const IMPORT_CATEGORY_USAGE_MODE_PER_SOURCE = 'per_source'
export const IMPORT_CATEGORY_USAGE_MODE_VALUES = new Set([
  IMPORT_CATEGORY_USAGE_MODE_ALL,
  IMPORT_CATEGORY_USAGE_MODE_NONE,
  IMPORT_CATEGORY_USAGE_MODE_PER_SOURCE,
])
export const IMPORT_DEFAULT_CATEGORY_USAGE_MODE_PREF_KEY = 'import.defaultImportedCategoryMode'
export const SUPPORTED_DATA_PROVIDERS = [
  { id: 'plaid', name: 'Plaid', availability: 'Available now' },
]

export function normalizeImportCategoryUsageMode(value) {
  return IMPORT_CATEGORY_USAGE_MODE_VALUES.has(value) ? value : IMPORT_CATEGORY_USAGE_MODE_PER_SOURCE
}
