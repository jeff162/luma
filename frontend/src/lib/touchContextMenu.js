// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * Press-and-hold on a touch screen opens the same menu a right-click does.
 *
 * iPad Safari fires no `contextmenu` for a long press on an ordinary element, so every right-click menu
 * in the app was out of reach there. Rather than teach each surface a second gesture, a finger held still
 * for HOLD_MS dispatches a `contextmenu` event at the press, and the surfaces' existing handlers open
 * their menus where the finger is.
 *
 * - A finger that moves past HOLD_SLOP, lifts, or is taken over by a scroll (`pointercancel`) cancels.
 * - Where the browser fires its own `contextmenu` on a long press (Android), that one is used and the
 *   hold stands down, so no menu opens twice.
 * - A press in a text field is left alone: a long press there is the platform's text-editing gesture.
 * - When a handler took the event, the mouse events that lifting the finger may produce are withheld,
 *   so the element under the menu is not also activated and the menu does not close at once.
 * - An item drag (`pointerDrag.js`) picks up sooner, and blocks `contextmenu` while it is held, so a drag
 *   in progress never opens a menu.
 *
 * On a touch screen text is unselectable app-wide (`index.html`), so the same hold does not also start a
 * Safari text selection; fields and text marked `ui-selectable` keep it.
 */

const HOLD_MS = 500
const HOLD_SLOP = 10
// How long after the finger lifts a mouse event still counts as one the hold's release produced.
const RELEASE_SUPPRESS_MS = 400

function isEditable(target) {
  return target instanceof Element
    && Boolean(target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])'))
}

export function installTouchContextMenu(root = document) {
  let hold = null

  function cancel() {
    if (!hold) return
    clearTimeout(hold.timer)
    hold.stopSuppressing?.()
    hold = null
  }

  // Lifting the finger would otherwise send the element under it the compatibility `mousedown` and
  // `click` of a tap: the click activates the element, and the mousedown reads as a press outside the
  // menu that just opened and closes it. Cancelling `touchend` withholds both where the browser follows
  // the standard; the capture listeners catch them where it does not.
  function suppressRelease() {
    function onTouchEnd(touchEvent) {
      touchEvent.preventDefault()
    }
    function onMouse(mouseEvent) {
      mouseEvent.preventDefault()
      mouseEvent.stopPropagation()
    }
    root.addEventListener('touchend', onTouchEnd, { capture: true, passive: false, once: true })
    root.addEventListener('mousedown', onMouse, true)
    root.addEventListener('click', onMouse, true)
    return () => {
      root.removeEventListener('touchend', onTouchEnd, { capture: true })
      root.removeEventListener('mousedown', onMouse, true)
      root.removeEventListener('click', onMouse, true)
    }
  }

  function fire() {
    const { target, clientX, clientY } = hold
    hold.fired = true
    if (!target.isConnected) return
    const menuEvent = new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, composed: true, button: 2, buttons: 0, clientX, clientY,
    })
    target.dispatchEvent(menuEvent)
    if (menuEvent.defaultPrevented) hold.stopSuppressing = suppressRelease()
  }

  function onPointerDown(event) {
    cancel()
    if (event.pointerType !== 'touch' || !event.isPrimary || isEditable(event.target)) return
    hold = {
      target: event.target,
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      fired: false,
      stopSuppressing: null,
    }
    hold.timer = setTimeout(fire, HOLD_MS)
  }

  function onPointerMove(event) {
    if (!hold || hold.fired || event.pointerId !== hold.pointerId) return
    if (Math.hypot(event.clientX - hold.clientX, event.clientY - hold.clientY) > HOLD_SLOP) cancel()
  }

  function onPointerEnd(event) {
    if (!hold || event.pointerId !== hold.pointerId) return
    if (hold.stopSuppressing) {
      setTimeout(hold.stopSuppressing, RELEASE_SUPPRESS_MS)
      hold.stopSuppressing = null
    }
    cancel()
  }

  // The browser's own long-press menu (`isTrusted`) supersedes the hold; ours is untrusted and passes.
  function onNativeContextMenu(event) {
    if (event.isTrusted && hold && !hold.fired) cancel()
  }

  root.addEventListener('pointerdown', onPointerDown, true)
  root.addEventListener('pointermove', onPointerMove, true)
  root.addEventListener('pointerup', onPointerEnd, true)
  root.addEventListener('pointercancel', onPointerEnd, true)
  root.addEventListener('contextmenu', onNativeContextMenu, true)

  return () => {
    cancel()
    root.removeEventListener('pointerdown', onPointerDown, true)
    root.removeEventListener('pointermove', onPointerMove, true)
    root.removeEventListener('pointerup', onPointerEnd, true)
    root.removeEventListener('pointercancel', onPointerEnd, true)
    root.removeEventListener('contextmenu', onNativeContextMenu, true)
  }
}
