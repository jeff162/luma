// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * Every press-and-move gesture in the app: resizing, moving a panel, and dragging an item onto a target.
 *
 * Built on pointer events, not mouse events or the browser's drag-and-drop, because both of those are
 * mouse-only in practice: a finger produces no mouse movement, and touch browsers start native drags
 * unreliably or not at all. One pointer stream answers mouse, touch and pen.
 *
 * - **`trackPointer`** follows a press from the moment it lands. It is for handles whose only job is the
 *   gesture (a splitter, a resize grip, a panel header), and such a handle sets `touch-action: none` so a
 *   finger moves it rather than scrolling the page.
 *
 * - **`startPointerDrag`** picks up an item that also means something when clicked and may sit in a
 *   scrolling list. A mouse picks it up after a few pixels of movement, so a click stays a click. A finger
 *   picks it up after a short press-and-hold, so a swipe that starts on an item still scrolls the list —
 *   the platform's own convention. Touch is followed with touch events rather than pointer events, because
 *   only a non-passive `touchmove` can stop the browser turning the finger's movement into a scroll.
 *
 * - **`useDropZone`** marks an element as a target. The target under the pointer is found by hit-testing:
 *   the innermost zone that accepts the item wins, so a zone nested in another takes the drop only when
 *   it wants it and otherwise passes it outward, as a refused `dragover` did. A zone may also ask to be
 *   scrolled when the pointer nears its edges; nothing else scrolls, which keeps a drag in a floating
 *   panel from scrolling the page behind it.
 *
 * While an item is up, a copy of it follows the pointer, Escape puts it back, and the click a release
 * would otherwise produce is swallowed. Only one item drag runs at a time.
 */

import { useCallback, useLayoutEffect, useRef } from 'react'
import { cssPoint, cssRect } from './displaySize.js'

const MOUSE_DRAG_THRESHOLD = 4
const TOUCH_HOLD_MS = 300
const TOUCH_SLOP = 8
const AUTO_SCROLL_EDGE = 40
const AUTO_SCROLL_MAX_STEP = 12

// Spread onto a drag source's style. A press-and-hold would otherwise select the item's text or open the
// platform's callout before the drag picks it up.
export const DRAG_SOURCE_STYLE = {
  userSelect: 'none',
  WebkitUserSelect: 'none',
  WebkitTouchCallout: 'none',
}

/**
 * Keeps a mouse press on a gesture handle from selecting text or moving focus. Cancelling the
 * `pointerdown` would do that too, but it also suppresses the `mousedown` outright, and outside-click
 * dismissal and panel focus listen for it — so it is the `mousedown`'s default that is cancelled, while
 * the event itself still runs. It follows the `pointerdown` within the same task, which bounds the wait.
 *
 * @param {PointerEvent} event
 */
export function preventPressDefaults(event) {
  if (event.pointerType !== 'mouse') return
  const cancel = mouseEvent => mouseEvent.preventDefault()
  window.addEventListener('mousedown', cancel, { capture: true, once: true })
  window.setTimeout(() => window.removeEventListener('mousedown', cancel, { capture: true }), 0)
}

/**
 * Follows one press until it is released, reporting each move. The handle's own `touch-action: none` is
 * what lets a finger drive it.
 *
 * @param {PointerEvent} event the `pointerdown` that starts the gesture
 * @param {{ onMove?: (event: PointerEvent) => void, onEnd?: (event: PointerEvent) => void }} handlers
 * @returns {() => void} stops following without calling `onEnd`, for a component that unmounts mid-gesture
 */
export function trackPointer(event, { onMove, onEnd } = {}) {
  const { pointerId } = event
  function move(moveEvent) {
    if (moveEvent.pointerId === pointerId) onMove?.(moveEvent)
  }
  function end(endEvent) {
    if (endEvent.pointerId !== pointerId) return
    stop()
    onEnd?.(endEvent)
  }
  function stop() {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', end)
    window.removeEventListener('pointercancel', end)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', end)
  window.addEventListener('pointercancel', end)
  return stop
}

const zoneRegistry = new WeakMap()
let activeDrag = null

/**
 * Makes the element the returned ref is attached to a drop zone. Every handler is optional; a zone
 * without `onDrop` is never a target and exists only to `autoScroll`.
 *
 * @param {{
 *   accepts?: (item: any) => boolean,
 *   onEnter?: (item: any) => void,
 *   onLeave?: () => void,
 *   onOver?: (item: any, point: { clientX: number, clientY: number }) => void,
 *   onDrop?: (item: any, point: { clientX: number, clientY: number }, element: HTMLElement) => void,
 *   autoScroll?: boolean,
 * }} options
 * @returns {(element: HTMLElement | null) => void} a stable ref callback
 */
export function useDropZone(options) {
  const optionsRef = useRef(options)
  useLayoutEffect(() => {
    optionsRef.current = options
  })
  return useCallback(element => {
    if (element) zoneRegistry.set(element, optionsRef)
  }, [])
}

/**
 * Called from a source's `onPointerDown`. Nothing happens until the press becomes a drag, so the source's
 * click keeps working.
 *
 * @param {PointerEvent} event
 * @param {{
 *   onStart: (context: { source: HTMLElement, target: EventTarget }) => any,
 *   onMove?: (point: { clientX: number, clientY: number }) => void,
 *   onEnd?: (result: { dropped: boolean, cancelled: boolean }) => void,
 *   preview?: false | ((source: HTMLElement) => { element?: HTMLElement, offsetX?: number, offsetY?: number }),
 * }} options `onStart` returns the dragged item, or null to refuse the drag. `preview` replaces the copy
 *   that follows the pointer, or turns it off; its offsets are CSS pixels (see displaySize.js).
 */
export function startPointerDrag(event, options) {
  if (activeDrag || event.button !== 0) return
  if (event.target?.closest?.('input, textarea, select, [contenteditable="true"]')) return

  const drag = {
    options,
    source: event.currentTarget,
    target: event.target,
    pointerId: event.pointerId,
    start: { clientX: event.clientX, clientY: event.clientY },
    point: { clientX: event.clientX, clientY: event.clientY },
    active: false,
    item: null,
    preview: null,
    previewOffset: { x: 0, y: 0 },
    zone: null,
    scroller: null,
    frame: null,
    holdTimer: null,
    cleanups: [],
  }
  activeDrag = drag

  function listen(type, handler, listenerOptions) {
    window.addEventListener(type, handler, listenerOptions)
    drag.cleanups.push(() => window.removeEventListener(type, handler, listenerOptions))
  }

  if (event.pointerType === 'touch') {
    listen('touchmove', touchEvent => {
      const touch = touchEvent.touches[0]
      if (!touch || touchEvent.touches.length > 1) { end(drag, { cancelled: true }); return }
      const point = { clientX: touch.clientX, clientY: touch.clientY }
      if (!drag.active) {
        // Moving before the hold completes is a scroll; let the browser have it.
        if (distance(point, drag.start) > TOUCH_SLOP) end(drag, { cancelled: true })
        return
      }
      touchEvent.preventDefault()
      drag.point = point
      update(drag)
    }, { passive: false })
    listen('touchend', touchEvent => {
      // Cancelling the touchend is what stops the release from also arriving as a click.
      if (drag.active && touchEvent.cancelable) touchEvent.preventDefault()
      end(drag, { cancelled: false })
    }, { passive: false })
    listen('touchcancel', () => end(drag, { cancelled: true }))
    drag.holdTimer = window.setTimeout(() => activate(drag), TOUCH_HOLD_MS)
  } else {
    listen('pointermove', moveEvent => {
      if (moveEvent.pointerId !== drag.pointerId) return
      drag.point = { clientX: moveEvent.clientX, clientY: moveEvent.clientY }
      if (!drag.active) {
        if (distance(drag.point, drag.start) < MOUSE_DRAG_THRESHOLD) return
        activate(drag)
        return
      }
      update(drag)
    })
    listen('pointerup', upEvent => {
      if (upEvent.pointerId !== drag.pointerId) return
      if (drag.active) swallowNextClick()
      end(drag, { cancelled: false })
    })
    listen('pointercancel', () => end(drag, { cancelled: true }))
  }
  listen('blur', () => end(drag, { cancelled: true }))
}

function distance(a, b) {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
}

function activate(drag) {
  drag.holdTimer = null
  if (activeDrag !== drag) return
  const item = drag.options.onStart?.({ source: drag.source, target: drag.target })
  if (item === null || item === undefined) {
    end(drag, { cancelled: true })
    return
  }
  drag.active = true
  drag.item = item

  const priorCursor = document.body.style.cursor
  const priorUserSelect = document.body.style.userSelect
  document.body.style.cursor = 'grabbing'
  document.body.style.userSelect = 'none'
  window.getSelection?.()?.removeAllRanges()
  drag.cleanups.push(() => {
    document.body.style.cursor = priorCursor
    document.body.style.userSelect = priorUserSelect
  })

  function onKeyDown(keyEvent) {
    if (keyEvent.key !== 'Escape') return
    keyEvent.preventDefault()
    keyEvent.stopImmediatePropagation()
    end(drag, { cancelled: true })
  }
  // A long press on a touch screen opens the context menu on some platforms, and a menu opening over a
  // drag in progress would strand it.
  function onContextMenu(menuEvent) {
    menuEvent.preventDefault()
    menuEvent.stopImmediatePropagation()
  }
  window.addEventListener('keydown', onKeyDown, true)
  window.addEventListener('contextmenu', onContextMenu, true)
  drag.cleanups.push(() => {
    window.removeEventListener('keydown', onKeyDown, true)
    window.removeEventListener('contextmenu', onContextMenu, true)
  })

  if (drag.options.preview !== false) createPreview(drag)
  update(drag)
  autoScrollFrame(drag)
}

function createPreview(drag) {
  const custom = typeof drag.options.preview === 'function' ? drag.options.preview(drag.source) || {} : {}
  const rect = cssRect(drag.source)
  let element = custom.element
  if (!element) {
    // A copy hung off <body> loses what it inherited in place, so the text styles come with it.
    const computed = window.getComputedStyle(drag.source)
    element = drag.source.cloneNode(true)
    element.removeAttribute('title')
    Object.assign(element.style, {
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      boxSizing: 'border-box',
      margin: '0',
      font: computed.font,
      color: computed.color,
      letterSpacing: computed.letterSpacing,
      opacity: '0.8',
      boxShadow: '0 6px 16px rgba(0, 0, 0, 0.22)',
    })
  }
  Object.assign(element.style, {
    position: 'fixed',
    left: '0',
    top: '0',
    pointerEvents: 'none',
    zIndex: '10000',
  })
  element.setAttribute('aria-hidden', 'true')
  drag.previewOffset = {
    x: custom.offsetX ?? cssPoint(drag.start).x - rect.left,
    y: custom.offsetY ?? cssPoint(drag.start).y - rect.top,
  }
  document.body.appendChild(element)
  drag.preview = element
}

function update(drag) {
  const { clientX, clientY } = drag.point
  if (drag.preview) {
    const at = cssPoint(drag.point)
    drag.preview.style.transform = `translate(${at.x - drag.previewOffset.x}px, ${at.y - drag.previewOffset.y}px)`
  }
  drag.options.onMove?.(drag.point)

  let zone = null
  let scroller = null
  for (let element = document.elementFromPoint(clientX, clientY); element; element = element.parentElement) {
    const record = zoneRegistry.get(element)
    if (!record) continue
    const zoneOptions = record.current
    if (!zone && zoneOptions.onDrop && (zoneOptions.accepts ? zoneOptions.accepts(drag.item) : true)) {
      zone = { element, record }
    }
    if (!scroller && zoneOptions.autoScroll) scroller = element
    if (zone && scroller) break
  }

  if (zone?.element !== drag.zone?.element) {
    drag.zone?.record.current.onLeave?.()
    drag.zone = zone
    zone?.record.current.onEnter?.(drag.item)
  }
  drag.zone?.record.current.onOver?.(drag.item, drag.point)
  drag.scroller = scroller
}

function edgeStep(position, start, end) {
  if (position < start || position > end) return 0
  if (position < start + AUTO_SCROLL_EDGE) {
    return -Math.ceil(AUTO_SCROLL_MAX_STEP * (1 - (position - start) / AUTO_SCROLL_EDGE))
  }
  if (position > end - AUTO_SCROLL_EDGE) {
    return Math.ceil(AUTO_SCROLL_MAX_STEP * (1 - (end - position) / AUTO_SCROLL_EDGE))
  }
  return 0
}

// Runs every frame while the item is up, because a pointer held still at an edge is the whole gesture:
// no event arrives to drive it. Content that slides under the pointer can change the zone beneath it, so
// a scroll re-runs the hit test.
function autoScrollFrame(drag) {
  drag.frame = window.requestAnimationFrame(() => autoScrollFrame(drag))
  const element = drag.scroller
  if (!element) return
  const rect = element.getBoundingClientRect()
  const { scrollTop, scrollLeft } = element
  element.scrollTop += edgeStep(drag.point.clientY, rect.top, rect.bottom)
  element.scrollLeft += edgeStep(drag.point.clientX, rect.left, rect.right)
  if (element.scrollTop !== scrollTop || element.scrollLeft !== scrollLeft) update(drag)
}

function swallowNextClick() {
  const swallow = clickEvent => {
    clickEvent.preventDefault()
    clickEvent.stopPropagation()
  }
  window.addEventListener('click', swallow, { capture: true, once: true })
  window.setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0)
}

function end(drag, { cancelled }) {
  if (activeDrag !== drag) return
  activeDrag = null
  if (drag.holdTimer) window.clearTimeout(drag.holdTimer)
  if (drag.frame) window.cancelAnimationFrame(drag.frame)
  drag.preview?.remove()
  for (const cleanup of drag.cleanups) cleanup()
  if (!drag.active) return

  const zone = drag.zone
  zone?.record.current.onLeave?.()
  const dropped = !cancelled && !!zone
  if (dropped) zone.record.current.onDrop(drag.item, drag.point, zone.element)
  drag.options.onEnd?.({ dropped, cancelled })
}
