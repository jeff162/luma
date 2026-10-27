// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAnchoredPopup } from '../lib/anchoredPopup.js'
import { useDismissibleLayer } from '../lib/uiInteractions.js'
import { HELP_TOPICS_BY_ID } from './content.jsx'
import { HelpPopoverPanel } from './helpPanel.jsx'
import { useHelpTopicViewer } from './useHelpTopicViewer.jsx'

// Card chrome for the floating `?` popover (the tip callout supplies its own inline style), and the
// text inside it.
const HELP_POPOVER_CARD_STYLE = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 10,
  boxShadow: '0 12px 32px rgba(15,23,42,0.32)',
  width: 'min(340px, calc(100vw - 32px))',
}
const HELP_POPOVER_TEXT_STYLE = {
  padding: '12px 14px',
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
 * is portaled and kept against the button by the browser (useAnchoredPopup), flipping above it or to
 * the other edge when it would overhang the window.
 */
export default function FeatureExplainer({ topic, label = 'About this feature', placement = 'bottom-right' }) {
  const [open, setOpen] = useState(false)
  const popoverRef = useRef(null)
  const buttonRef = useRef(null)
  const entry = HELP_TOPICS_BY_ID[topic]
  const { openTopic, viewerNode } = useHelpTopicViewer()

  useDismissibleLayer({
    open,
    onClose: () => setOpen(false),
    refs: [popoverRef, buttonRef],
  })

  const { popupStyle, contentRef } = useAnchoredPopup({
    open,
    anchorRef: buttonRef,
    align: placement === 'bottom-left' ? 'start' : 'end',
    // The card shows whole, flipping rather than shrinking while the other side has room for it.
    minRoom: Infinity,
  })

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
        <div ref={popoverRef} style={{ ...popupStyle, zIndex: HELP_POPOVER_Z_INDEX, ...HELP_POPOVER_CARD_STYLE }}>
          <HelpPopoverPanel
            topic={topic}
            containerRef={contentRef}
            onClose={() => setOpen(false)}
            onReadMore={() => { setOpen(false); openTopic(topic) }}
            style={HELP_POPOVER_TEXT_STYLE}
          />
        </div>,
        document.body,
      )}
      {viewerNode}
    </span>
  )
}
