// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { alignOnAxis, besideOnAxis } from '../lib/floatingPlacement.js'
import { useDismissibleLayer } from '../lib/uiInteractions.js'
import { HELP_TOPICS_BY_ID } from './content.jsx'
import { HelpPopoverPanel } from './helpPanel.jsx'
import { useHelpTopicViewer } from './useHelpTopicViewer.jsx'

// Card chrome for the floating `?` popover (the tip callout supplies its own inline style).
const HELP_POPOVER_CARD_STYLE = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 10,
  boxShadow: '0 12px 32px rgba(15,23,42,0.32)',
  padding: '12px 14px',
  width: 'min(340px, calc(100vw - 32px))',
  fontSize: 13,
  lineHeight: 1.5,
  color: 'var(--text)',
}

// The `ActionMenu`'s layer: a `?` sits in dialogs and floating panels as well as on pages, and its card has
// to open above whichever one hosts it.
const HELP_POPOVER_Z_INDEX = 1400

/*
 * Inline explainer affordance for a feature surface. Renders a small `?` button that
 * opens a popover showing the topic's one-line summary and a "Read more" link to the
 * standalone Help page. Popover, Help page, and the context-triggered tip callout
 * (ContextualExplainer) all consume the same content registry via `HelpPopoverPanel`,
 * so their text cannot drift.
 *
 * `placement` names the edge the card lines up with — `bottom-left` opens rightward from the button's
 * left edge, `bottom-right` leftward from its right edge — and is a preference, not a promise. The card
 * is portaled and placed in viewport coordinates, slid back inside the window and flipped above the
 * button when it would overhang, the same way `Tooltip` places itself. Positioned inside the button's
 * own box it could not see the window edge, so a `?` near the right of a toolbar opened off screen.
 */
export default function FeatureExplainer({ topic, label = 'About this feature', placement = 'bottom-right' }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState(null)
  const popoverRef = useRef(null)
  const buttonRef = useRef(null)
  const entry = HELP_TOPICS_BY_ID[topic]
  const { openTopic, viewerNode } = useHelpTopicViewer()

  useDismissibleLayer({
    open,
    onClose: () => setOpen(false),
    refs: [popoverRef, buttonRef],
  })

  // Measured before paint, and again whenever anything scrolls or the window resizes, so the card follows
  // its button rather than hanging where the button used to be.
  useLayoutEffect(() => {
    if (!open) { setPos(null); return undefined }
    function place() {
      const trigger = buttonRef.current?.getBoundingClientRect()
      const card = popoverRef.current?.getBoundingClientRect()
      if (!trigger || !card) return
      const { clientWidth: vw, clientHeight: vh } = document.documentElement
      setPos({
        left: alignOnAxis({
          start: placement === 'bottom-left' ? trigger.left : trigger.right - card.width,
          size: card.width, lo: 0, hi: vw,
        }),
        top: besideOnAxis({ before: trigger.top, after: trigger.bottom, size: card.height, lo: 0, hi: vh }),
      })
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open, placement])

  if (!entry) return null

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center' }}>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen(value => !value)}
        title={label}
        aria-label={label}
        style={{
          width: 18, height: 18,
          borderRadius: '50%',
          background: open ? 'var(--accent2)' : 'var(--surface2)',
          color: open ? '#fff' : 'var(--muted)',
          border: '1px solid color-mix(in srgb, var(--accent2) 20%, var(--border))',
          cursor: 'pointer',
          fontSize: 11, fontWeight: 700,
          lineHeight: 1, padding: 0,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        }}
      >?</button>
      {open && createPortal(
        <HelpPopoverPanel
          topic={topic}
          containerRef={popoverRef}
          onClose={() => setOpen(false)}
          onReadMore={() => { setOpen(false); openTopic(topic) }}
          style={{
            position: 'fixed', zIndex: HELP_POPOVER_Z_INDEX,
            top: pos?.top ?? 0, left: pos?.left ?? 0,
            // Hidden until measured, so the first frame never shows the card at an unclamped spot.
            visibility: pos ? 'visible' : 'hidden',
            ...HELP_POPOVER_CARD_STYLE,
          }}
        />,
        document.body,
      )}
      {viewerNode}
    </span>
  )
}
