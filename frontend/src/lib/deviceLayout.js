// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// Identifies the kind of screen a layout was tuned on, so column geometry saved on a desktop does not
// reach a tablet. Browsers expose no device id, so the key is built from what does tell devices apart:
// the primary pointer (touch or mouse) and the screen size, plus the orientation on a touch device.
//
// The screen size, not the window size, so resizing a desktop window never switches layouts. The
// shorter side comes first because iPad Safari reports the same screen size in both orientations while
// other browsers swap the two; the orientation is read separately, and only for touch, where rotating
// is how the device is used.

import { useSyncExternalStore } from 'react'

const COARSE_POINTER_QUERY = '(pointer: coarse)'
const PORTRAIT_QUERY = '(orientation: portrait)'

function matches(query) {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia(query).matches
}

export function readDeviceLayoutKey() {
  if (typeof window === 'undefined') return 'mouse-unknown'
  const width = Number(window.screen?.width) || 0
  const height = Number(window.screen?.height) || 0
  const size = width && height ? `${Math.min(width, height)}x${Math.max(width, height)}` : 'unknown'
  if (!matches(COARSE_POINTER_QUERY)) return `mouse-${size}`
  return `touch-${size}-${matches(PORTRAIT_QUERY) ? 'portrait' : 'landscape'}`
}

// Rotating, moving a window to another monitor and attaching a pointer all fire one of these.
function subscribe(onChange) {
  if (typeof window === 'undefined') return () => {}
  window.addEventListener('resize', onChange)
  const queries = typeof window.matchMedia === 'function'
    ? [COARSE_POINTER_QUERY, PORTRAIT_QUERY].map(query => window.matchMedia(query))
    : []
  queries.forEach(query => query.addEventListener?.('change', onChange))
  return () => {
    window.removeEventListener('resize', onChange)
    queries.forEach(query => query.removeEventListener?.('change', onChange))
  }
}

export function useDeviceLayoutKey() {
  return useSyncExternalStore(subscribe, readDeviceLayoutKey, () => 'mouse-unknown')
}

export function useCoarsePointer() {
  return useSyncExternalStore(subscribe, () => matches(COARSE_POINTER_QUERY), () => false)
}

// The preference key a layout is saved under on this kind of screen.
export function deviceLayoutPreferenceKey(baseKey, deviceKey) {
  return `${baseKey}@${deviceKey}`
}
