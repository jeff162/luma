// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

/*
 * Theme application. The whole app is themed by CSS custom properties defined in index.html
 * (`:root` = dark; `[data-theme="light"]` = light). This module is the single place that turns
 * the user's stored choice into the `data-theme` attribute on <html>.
 *
 * Theme choices: 'system' resolves against the OS `prefers-color-scheme`; the rest are explicit
 * palettes. There are two pairs plus system — 'light'/'soft' are the light family (soft = a
 * muted, lower-glare light) and 'dark'/'dim' are the dark family (dim = a soft charcoal). Each
 * maps 1:1 to a `[data-theme="…"]` block in index.html. The stored preference (ui.appearance.theme)
 * round-trips from the backend, which is too slow to gate first paint — so every change is mirrored
 * into a localStorage cache that the tiny inline script in index.html reads before React mounts,
 * preventing a theme flash. The backend preference stays the source of truth; on load the app
 * reconciles the cache to it.
 */

export const THEME_PREF_KEY = 'ui.appearance.theme'
export const THEME_CACHE_KEY = 'luma.theme'
// Records which backend database the cached choice belongs to (see reconcileThemeCacheForDb).
export const THEME_CACHE_DB_KEY = 'luma.theme.db'

export const THEME_SYSTEM = 'system'
export const THEME_LIGHT = 'light'
export const THEME_SOFT = 'soft'
export const THEME_DIM = 'dim'
export const THEME_DARK = 'dark'

// The explicit palettes (everything except 'system'); these map directly to data-theme blocks.
export const EXPLICIT_THEMES = [THEME_LIGHT, THEME_SOFT, THEME_DIM, THEME_DARK]

// Ordered light→dark with System last — this is also the chooser's display order.
export const THEME_CHOICES = [THEME_LIGHT, THEME_SOFT, THEME_DIM, THEME_DARK, THEME_SYSTEM]

export const THEME_LABELS = {
  [THEME_LIGHT]: 'Light',
  [THEME_SOFT]: 'Soft light',
  [THEME_DIM]: 'Dim',
  [THEME_DARK]: 'Dark',
  [THEME_SYSTEM]: 'System',
}

// A stored value we don't recognize falls back to System rather than guessing a palette.
export function normalizeThemeChoice(choice) {
  return THEME_CHOICES.includes(choice) ? choice : THEME_SYSTEM
}

// The one rule that needs unit coverage: which concrete data-theme a choice yields given the OS hint.
// Explicit palettes apply as-is; System resolves to the OS-preferred end of each family.
export function resolveEffectiveTheme(choice, prefersDark) {
  const normalized = normalizeThemeChoice(choice)
  if (EXPLICIT_THEMES.includes(normalized)) return normalized
  return prefersDark ? THEME_DARK : THEME_LIGHT
}

function systemPrefersDark() {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-color-scheme: dark)').matches
}

// Apply the choice to the document and refresh the pre-paint cache. Caches the raw choice (not the
// resolved theme) so a 'system' user keeps following the OS on the next load instead of being pinned.
export function applyTheme(choice) {
  const normalized = normalizeThemeChoice(choice)
  const effective = resolveEffectiveTheme(normalized, systemPrefersDark())
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-theme', effective)
  }
  try {
    window.localStorage.setItem(THEME_CACHE_KEY, normalized)
  } catch { /* private mode: skip the cache, first paint just uses the OS default next time */ }
  return effective
}

// The pre-paint cache (THEME_CACHE_KEY) survives a backend database reset, so a recreated/empty
// database would otherwise inherit the palette configured for the *previous* one — most visibly the
// welcome screen, which renders before any per-profile theme loads and so shows only the cached value.
// Tag the cache with the db_instance_id it was written under: when that id changes (a different or
// freshly recreated database, which defines no theme yet), the cached choice is stale, so fall back to
// System (the OS scheme). Clearing local profiles on the *same* database leaves the id unchanged, so a
// theme configured there is still honored. A first run with no tag adopts the current id without
// resetting, so existing setups keep their theme.
export function reconcileThemeCacheForDb(dbInstanceId) {
  const dbId = dbInstanceId || ''
  let cachedDbId = null
  try {
    cachedDbId = window.localStorage.getItem(THEME_CACHE_DB_KEY)
  } catch {
    return
  }
  if (cachedDbId === dbId) return
  if (cachedDbId) applyTheme(THEME_SYSTEM)
  try {
    window.localStorage.setItem(THEME_CACHE_DB_KEY, dbId)
  } catch { /* private mode: best-effort; the cache just stays untagged */ }
}
