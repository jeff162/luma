// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * The part of the window that is actually visible while an on-screen keyboard is open.
 *
 * iPad Safari does not shrink the page when the keyboard opens: it slides the visible area over the page
 * to reveal the focused field. A `position: fixed` layer is pinned to the page's full-size viewport, not
 * to the visible area, so it slides away too — and Safari misjudges the distance for a field inside such
 * a layer, often pushing the whole layer off the top. A fixed layer that pins itself to the visible area
 * reported here stays in place, and one that caps its height to it ends above the keyboard.
 *
 * Coordinates are the page viewport's, the same ones `getBoundingClientRect` and `position: fixed` use.
 * While no keyboard is open the area is the whole window, and `keyboard` is false so layers keep their
 * ordinary styles. A pinch-zoom also shrinks the visible area; it is not a keyboard, and is ignored.
 */

import { useEffect, useSyncExternalStore } from 'react'

const CLOSED = Object.freeze({ keyboard: false, top: 0, height: 0 })
let snapshot = CLOSED

function readSnapshot() {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null
  if (!vv || vv.scale > 1.01) return CLOSED
  const top = Math.max(0, vv.offsetTop)
  const height = vv.height
  // The page viewport's height without scrollbars, which the visible area also leaves out.
  if (top < 1 && height > document.documentElement.clientHeight - 1) return CLOSED
  if (snapshot.keyboard && snapshot.top === top && snapshot.height === height) return snapshot
  return { keyboard: true, top, height }
}

function getSnapshot() {
  snapshot = readSnapshot()
  return snapshot
}

// Calls `onChange` whenever the visible area moves or resizes. Returns the unsubscribe.
function subscribeVisibleArea(onChange) {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null
  if (!vv) return () => {}
  vv.addEventListener('resize', onChange)
  vv.addEventListener('scroll', onChange)
  return () => {
    vv.removeEventListener('resize', onChange)
    vv.removeEventListener('scroll', onChange)
  }
}

export function useVisibleViewport() {
  return useSyncExternalStore(subscribeVisibleArea, getSnapshot, () => CLOSED)
}

// The visible area's top and bottom in the coordinates `getBoundingClientRect` reports, which are not
// the ones `position: fixed` uses in every engine: WebKit measures an element from the visible area,
// others from the full-size page. A zero-size fixed marker at the page's top-left reports the difference,
// so no engine has to be named.
let originMarker = null
function readVisibleBounds() {
  const area = readSnapshot()
  if (!area.keyboard) return { top: 0, bottom: document.documentElement.clientHeight }
  if (!originMarker) {
    originMarker = document.createElement('div')
    originMarker.setAttribute('aria-hidden', 'true')
    originMarker.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none'
    document.body.appendChild(originMarker)
  }
  const top = area.top + originMarker.getBoundingClientRect().top
  return { top, bottom: top + area.height }
}

// Position for a layer that covers the window: the visible area while a keyboard is open.
export function visibleLayerBox(area) {
  return area.keyboard
    ? { top: area.top, left: 0, right: 0, height: area.height }
    : { inset: 0 }
}

// The window's height as a CSS length, for a layer's height cap.
export function visibleHeightCss(area) {
  return area.keyboard ? `${area.height}px` : '100vh'
}

// Where a floating panel placed at `top` sits while a keyboard is open: inside the visible area, moved
// only as far as it must to keep at least `minRoom` above the keyboard, with `maxHeight` what is left.
// Null while no keyboard is open, when the panel keeps its own placement.
export function placeAboveKeyboard(area, top, { edge = 24, minRoom = 240 } = {}) {
  if (!area.keyboard) return null
  const bottom = area.top + area.height
  const shownTop = Math.max(area.top + edge, Math.min(top, bottom - minRoom))
  return { top: shownTop, maxHeight: Math.max(0, bottom - shownTop - edge) }
}

// A field that raises an on-screen keyboard when focused. A select opens a list instead, and the
// non-text input types open a picker or nothing.
const NON_TEXT_INPUT_TYPES = new Set(['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'])
function raisesKeyboard(element) {
  if (!element) return false
  if (element.isContentEditable || element.tagName === 'TEXTAREA') return true
  return element.tagName === 'INPUT' && !NON_TEXT_INPUT_TYPES.has(element.type)
}

// Once layers have settled into the visible area, bring the focused field into view inside whichever
// layer or list holds it. Mounted once, at the app's root.
export function useRevealFocusedField() {
  useEffect(() => {
    let frame = 0
    function reveal() {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const field = document.activeElement
        if (!readSnapshot().keyboard || !raisesKeyboard(field)) return
        const { top, bottom } = readVisibleBounds()
        const rect = field.getBoundingClientRect()
        if (rect.top < top || rect.bottom > bottom) field.scrollIntoView({ block: 'nearest' })
      })
    }
    const unsubscribe = subscribeVisibleArea(reveal)
    return () => {
      cancelAnimationFrame(frame)
      unsubscribe()
    }
  }, [])
}
