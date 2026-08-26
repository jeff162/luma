// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

export const APP_NAME = String(import.meta.env.VITE_APP_NAME || 'Luma').trim() || 'Luma'
export const APP_VERSION = String(__APP_VERSION__).trim()
// Where the source lives. Held here rather than inline because it is a fact about the build, and the
// About page needs both the project root and the license file under it.
export const PROJECT_URL = 'https://github.com/jeff162/luma'
// The license as the FSF publishes it. The fallback for a copy that ships without its own LICENSE, and
// deliberately not this project's copy of the text: a fork edits a repository URL as easily as it edits
// a file, so pointing at the canonical source is the only outward link that means anything.
export const LICENSE_CANONICAL_URL = 'https://www.gnu.org/licenses/agpl-3.0.txt'

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
