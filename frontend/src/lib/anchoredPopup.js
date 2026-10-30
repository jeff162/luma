// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * A popup kept against the element it belongs to by CSS anchor positioning.
 *
 * The browser does the placing, so the popup stays with its anchor through any scroll, a resize, and
 * Safari sliding the page for an on-screen keyboard; measuring the anchor ourselves goes wrong there,
 * because Safari reports an element's position from the visible area while `position: fixed` places from
 * the full-size page.
 *
 * The popup opens on its preferred side, capped to the room there (the `position-area` cell is the
 * percentage basis for its height). When that room is less than its minimum it overflows the cell, and
 * the browser tries the flips in order. The flip is driven by that overflow, not by
 * `position-try-order: most-height`, which WebKit accepts but does not act on. The minimum is
 * `minRoom`, or the popup's whole content when shorter, so a short popup is not padded out; that is why
 * the popup's content goes in an element given `contentRef`.
 */

import { useId, useLayoutEffect, useRef, useState } from 'react'
import { vw } from './displaySize.js'

const VIEWPORT_MARGIN = 8

// `position-area` and its fallbacks for each side and alignment. `start` aligns the popup's leading edge
// with the anchor's and grows away from it; `end` aligns the trailing edges.
const PLACEMENTS = {
  below: {
    start: 'block-end span-inline-end',
    end: 'block-end span-inline-start',
    fallbacks: 'flip-block, flip-inline, flip-block flip-inline',
  },
  beside: {
    start: 'inline-end span-block-end',
    end: 'inline-end span-block-start',
    fallbacks: 'flip-inline, flip-block, flip-block flip-inline',
  },
}

export function useAnchoredPopup({
  open,
  anchorRef,
  // `below` the anchor, `beside` it (after it on the inline axis, top edges aligned), or `over` it
  // (covering it from its left edge, centred on it vertically, as an inline editor that replaces it).
  placement = 'below',
  align = 'start',
  gap = 4,
  minWidth = 0,
  // `exact`: as wide as the anchor (or `minWidth`, whichever is wider), as a dropdown under a field is.
  // `atLeast`: no narrower than that, growing with its content.
  anchorWidth = null,
  minRoom = 240,
}) {
  const name = `--anchor-${useId().replace(/[^\w-]/g, '')}`
  const contentRef = useRef(null)
  const [contentHeight, setContentHeight] = useState(0)

  // Set on the anchor directly, so a caller does not have to thread the name into its markup.
  useLayoutEffect(() => {
    const anchor = anchorRef.current
    if (!open || !anchor) return undefined
    anchor.style.anchorName = name
    return () => {
      if (anchor.style.anchorName === name) anchor.style.anchorName = ''
    }
  }, [anchorRef, name, open])

  useLayoutEffect(() => {
    const content = contentRef.current
    if (!open || !content) return undefined
    const measure = () => setContentHeight(content.offsetHeight)
    measure()
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(measure)
    observer.observe(content)
    return () => observer.disconnect()
  }, [open])

  if (placement === 'over') {
    return {
      popupStyle: {
        position: 'fixed', positionAnchor: name,
        top: 'anchor(center)', left: 'anchor(left)', translate: '0 -50%',
      },
      contentRef,
    }
  }
  const sides = PLACEMENTS[placement]
  const popupStyle = {
    position: 'fixed',
    positionAnchor: name,
    positionArea: sides[align],
    positionTryFallbacks: sides.fallbacks,
    ...(placement === 'below' ? { marginBlock: gap } : { marginInline: gap }),
    ...(anchorWidth === 'exact' ? { width: `max(anchor-size(width), ${minWidth}px)` } : null),
    ...(anchorWidth === 'atLeast' ? { minWidth: `max(anchor-size(width), ${minWidth}px)` } : null),
    ...(anchorWidth ? null : { minWidth }),
    maxWidth: `calc(${vw(100)} - ${VIEWPORT_MARGIN * 2}px)`,
    maxHeight: `calc(100% - ${gap + VIEWPORT_MARGIN}px)`,
    minHeight: Math.min(minRoom, contentHeight),
    overflowY: 'auto',
  }
  return { popupStyle, contentRef }
}
