// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

/*
 * Theme application. The whole app is themed by CSS custom properties defined in index.html
 * (`:root` = dark; `[data-theme="light"]` = light). This module is the single place that turns
 * the user's stored choice into the `data-theme` attribute on <html>.
 *
 * Three theme choices: 'system' resolves against the OS `prefers-color-scheme`; 'light'/'dark'
 * are explicit. The stored preference (ui.appearance.theme) round-trips from the backend, which
 * is too slow to gate first paint — so every change is mirrored into a localStorage cache that
 * the tiny inline script in index.html reads before React mounts, preventing a theme flash. The
 * backend preference stays the source of truth; on load the app reconciles the cache to it.
 */

export const THEME_PREF_KEY = 'ui.appearance.theme'
export const THEME_CACHE_KEY = 'fintrack.theme'

export const THEME_SYSTEM = 'system'
export const THEME_LIGHT = 'light'
export const THEME_DARK = 'dark'

export const THEME_CHOICES = [THEME_SYSTEM, THEME_LIGHT, THEME_DARK]

export const THEME_LABELS = {
  [THEME_LIGHT]: 'Light',
  [THEME_DARK]: 'Dark',
  [THEME_SYSTEM]: 'System',
}

// A stored value we don't recognize falls back to System rather than guessing light/dark.
export function normalizeThemeChoice(choice) {
  return THEME_CHOICES.includes(choice) ? choice : THEME_SYSTEM
}

// The one rule that needs unit coverage: which concrete theme a choice yields given the OS hint.
export function resolveEffectiveTheme(choice, prefersDark) {
  const normalized = normalizeThemeChoice(choice)
  if (normalized === THEME_LIGHT) return THEME_LIGHT
  if (normalized === THEME_DARK) return THEME_DARK
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
