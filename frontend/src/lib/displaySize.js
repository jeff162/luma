// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * Display size: the whole app drawn smaller or larger, as the browser's own zoom would, but kept with the
 * user's preferences for each kind of screen (`useDisplaySize.js`) instead of per browser and per address.
 *
 * Applied as CSS `zoom` on <html>, driven by the `--ui-scale` property (index.html). Like the theme, the
 * stored preference round-trips from the backend, so every change is mirrored into a localStorage cache
 * that the pre-paint script in index.html reads; the app reconciles the cache to the preference on load.
 *
 * Under the zoom there are two coordinate spaces, measured the same in Chromium and WebKit:
 * - screen pixels: `getBoundingClientRect`, a pointer's `clientX`/`clientY`, `innerWidth`/`innerHeight`,
 *   `visualViewport`, and the root element's `clientWidth`/`clientHeight`;
 * - CSS pixels: every length written into a style, and an element's `offset*`, `client*` and `scroll*`.
 * One CSS pixel covers `uiScale()` screen pixels. A measurement that ends up in a style, or is mixed with
 * a CSS-pixel value, is converted first (`cssPoint`, `cssRect`, `cssViewport`, `toCssPx`); measurements
 * compared only with each other need nothing. Viewport units shrink with the zoom as well, so a length
 * relative to the window is written with `vh()`, `dvh()` or `vw()`. CSS anchor positioning needs nothing.
 */

import { localStore } from './browserStorage.js'

export const DISPLAY_SIZE_PREF_KEY = 'ui.appearance.displaySize'
export const DISPLAY_SIZE_CACHE_KEY = 'luma.displaySize'

// Percentages, in display order. Steps rather than a free value, so a layout only has to hold at these.
// Keep in sync with the list in index.html's pre-paint script.
export const DISPLAY_SIZE_CHOICES = [70, 80, 90, 100, 110, 125]
export const DEFAULT_DISPLAY_SIZE = 100

export function normalizeDisplaySize(value) {
  const size = Number(value)
  return DISPLAY_SIZE_CHOICES.includes(size) ? size : DEFAULT_DISPLAY_SIZE
}

function readAppliedScale() {
  if (typeof document === 'undefined') return 1
  return Number.parseFloat(document.documentElement.style.getPropertyValue('--ui-scale')) || 1
}

let scale = readAppliedScale()

export function applyDisplaySize(value) {
  const size = normalizeDisplaySize(value)
  const changed = size / 100 !== scale
  scale = size / 100
  if (typeof document !== 'undefined') {
    const root = document.documentElement.style
    if (size === DEFAULT_DISPLAY_SIZE) root.removeProperty('--ui-scale')
    else root.setProperty('--ui-scale', String(scale))
  }
  localStore.set(DISPLAY_SIZE_CACHE_KEY, String(size))
  // The window holds a different number of CSS pixels now, which is what a resize means to the layers
  // that keep themselves inside it (floating panels re-clamp on it).
  if (changed && typeof window !== 'undefined') window.dispatchEvent(new Event('resize'))
  return size
}

// How many screen pixels one CSS pixel covers.
export function uiScale() {
  return scale
}

// A length in screen pixels (a measured distance or a pointer delta) as CSS pixels.
export function toCssPx(screenPx) {
  return screenPx / scale
}

export function cssPoint(event) {
  return { x: event.clientX / scale, y: event.clientY / scale }
}

export function cssRect(element) {
  const rect = element.getBoundingClientRect()
  return {
    left: rect.left / scale, top: rect.top / scale, right: rect.right / scale, bottom: rect.bottom / scale,
    width: rect.width / scale, height: rect.height / scale,
  }
}

export function cssViewport() {
  return { width: window.innerWidth / scale, height: window.innerHeight / scale }
}

// The screen's usable width, the most a window on it can be widened to. A tablet's window is its screen.
export function cssScreenWidth() {
  return (window.screen?.availWidth || window.innerWidth) / scale
}

export const vh = amount => `calc(${amount}vh / var(--ui-scale, 1))`
export const dvh = amount => `calc(${amount}dvh / var(--ui-scale, 1))`
export const vw = amount => `calc(${amount}vw / var(--ui-scale, 1))`
