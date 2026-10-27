// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * Keeps a swipe or wheel over a layer from scrolling the page behind it.
 *
 * A browser hands a scroll gesture to the next scrollable ancestor when the element under the pointer
 * cannot take it: a short list with nothing to scroll, or a long one already at its end. Over a floating
 * panel that ancestor is the page. `overscroll-behavior: contain` is meant to stop this, but browsers do
 * not reliably apply it to a box that has nothing to scroll, which is the common case for a short report.
 *
 * So the gesture is cancelled at the layer's root when nothing between the pointer and the root can
 * scroll in its direction. Anything that can still scroll inside the layer scrolls as usual.
 */

import { useEffect } from 'react'

const SCROLLABLE_OVERFLOW = new Set(['auto', 'scroll', 'overlay'])

// Whether `el` can scroll further by `delta` along the axis (positive is down or right).
function canScrollBy(el, axis, delta) {
  const style = getComputedStyle(el)
  if (!SCROLLABLE_OVERFLOW.has(axis === 'y' ? style.overflowY : style.overflowX)) return false
  if (axis === 'y') {
    return delta > 0 ? el.scrollTop + el.clientHeight < el.scrollHeight - 1 : el.scrollTop > 0
  }
  // scrollLeft runs negative in a right-to-left box, so compare magnitudes.
  const left = Math.abs(el.scrollLeft)
  return delta > 0 ? left + el.clientWidth < el.scrollWidth - 1 : left > 0
}

function hasScrollRoom(target, root, axis, delta) {
  for (let el = target; el && el !== root.parentElement; el = el.parentElement) {
    if (canScrollBy(el, axis, delta)) return true
  }
  return false
}

function dominantAxis(dx, dy) {
  return Math.abs(dy) >= Math.abs(dx) ? ['y', dy] : ['x', dx]
}

// A form control's own gestures (a range slider's drag, a select's list) are not page scrolls.
function isFormControl(target) {
  return target.closest?.('input, select') != null
}

export function useScrollContainment(rootRef) {
  useEffect(() => {
    const root = rootRef.current
    if (!root) return undefined
    let last = null

    function onTouchStart(event) {
      last = event.touches.length === 1
        ? { x: event.touches[0].clientX, y: event.touches[0].clientY }
        : null
    }
    function onTouchMove(event) {
      // A second finger is a pinch, which the browser zooms rather than scrolls.
      if (!last || event.touches.length !== 1 || !event.cancelable) return
      const touch = event.touches[0]
      // A finger moving up scrolls the content down, so the scroll delta is the reverse of its motion.
      const [axis, delta] = dominantAxis(last.x - touch.clientX, last.y - touch.clientY)
      last = { x: touch.clientX, y: touch.clientY }
      if (delta === 0 || isFormControl(event.target)) return
      if (!hasScrollRoom(event.target, root, axis, delta)) event.preventDefault()
    }
    function onWheel(event) {
      // A trackpad pinch arrives as a wheel with ctrlKey; leave the browser's zoom alone.
      if (event.ctrlKey || !event.cancelable) return
      const [axis, delta] = dominantAxis(event.deltaX, event.deltaY)
      if (delta === 0) return
      if (!hasScrollRoom(event.target, root, axis, delta)) event.preventDefault()
    }

    // Non-passive, or the browser has already begun scrolling by the time the handler runs.
    root.addEventListener('touchstart', onTouchStart, { passive: true })
    root.addEventListener('touchmove', onTouchMove, { passive: false })
    root.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      root.removeEventListener('touchstart', onTouchStart)
      root.removeEventListener('touchmove', onTouchMove)
      root.removeEventListener('wheel', onWheel)
    }
  }, [rootRef])
}
