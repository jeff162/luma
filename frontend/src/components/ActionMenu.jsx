// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import React, { useLayoutEffect, useRef, useState } from 'react'
import { useDismissibleLayer } from '../lib/uiInteractions.js'
import { IconButton } from './ui.jsx'

// Breathing room kept between the menu and the viewport edge, and between the menu and its anchor.
const VIEWPORT_MARGIN = 8
const ANCHOR_GAP = 4

/*
 * The shared "⋯" overflow menu: a small popover of actions anchored under the control that opened it.
 *
 * It exists so a surface can offer several rarely-used actions without spending permanent space on
 * them — the connection cards are the motivating case, where five always-visible buttons per card
 * meant thirty-five controls on a page whose actionable state (a review or mapping badge) was quieter
 * than its maintenance. What is actionable now stays on the surface; what is merely always possible
 * moves in here.
 *
 * `danger` is reserved for actions with no way back — a delete that leaves nothing to restore. An
 * action that is reversible with effort (re-linking a bank, re-syncing history) is NOT danger here
 * even when it deletes rows: its confirm dialog carries the red, which is where the click that
 * actually does the thing lives. Spending the color on recoverable actions would leave nothing to
 * distinguish the permanent ones.
 *
 * Items render in order; `separatorBefore` draws a rule above one to group them. Dismissal (outside
 * click / Escape) is the shared `useDismissibleLayer`.
 *
 * Positioning is viewport-clamped on both axes, which they do differently. Horizontally the menu is
 * right-aligned to the anchor and clamped against a known `minWidth`, so no measurement is needed.
 * Vertically it has to be measured after render — height follows the caller's item count — and the
 * menu flips above the anchor when it would otherwise run off the bottom. Clamping only the axis that
 * needed no measurement was the original bug: a trigger near the bottom of a long list of connection
 * cards opened its menu off-screen.
 */
export function ActionMenu({ anchorRect, items = [], onClose, minWidth = 180, align = 'end' }) {
  const ref = useRef(null)
  useDismissibleLayer({ open: true, onClose, refs: [ref] })
  // Below the anchor until measured. The horizontal axis needs no measurement — right-aligning to a
  // known `minWidth` is enough — but the vertical one does: how tall the menu is depends on how many
  // items the caller passed, so whether it fits below the trigger cannot be known before it renders.
  const [top, setTop] = useState(() => (anchorRect ? anchorRect.bottom + ANCHOR_GAP : 0))

  // Measured and corrected before paint, so the flip is never visible. `position: fixed` means the
  // adjustment is a single style write with no reflow of anything else.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !anchorRect) return
    const height = el.offsetHeight
    const below = anchorRect.bottom + ANCHOR_GAP
    if (below + height + VIEWPORT_MARGIN <= window.innerHeight) {
      setTop(below)
      return
    }
    // Flip above the anchor — the standard behavior for a trigger near the bottom of the screen. If it
    // does not fit there either (a long menu on a short window), sit against the bottom edge and let
    // the menu's own `overflowY` handle the rest, which still beats rendering it off-screen.
    const above = anchorRect.top - ANCHOR_GAP - height
    setTop(above >= VIEWPORT_MARGIN
      ? above
      : Math.max(VIEWPORT_MARGIN, window.innerHeight - height - VIEWPORT_MARGIN))
  }, [anchorRect, items.length])

  if (!anchorRect) return null
  // Right-aligned to the anchor by default: the trigger sits at a card's trailing edge, so growing
  // leftward keeps the menu on screen without measuring its width.
  const rawLeft = align === 'end' ? anchorRect.right - minWidth : anchorRect.left
  const left = Math.max(VIEWPORT_MARGIN, Math.min(rawLeft, window.innerWidth - minWidth - VIEWPORT_MARGIN))

  return (
    <div
      ref={ref}
      role="menu"
      style={{
        position: 'fixed', top, left, zIndex: 1400, minWidth,
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: 4,
        boxShadow: '0 12px 36px rgba(15, 23, 42, 0.32)',
        // Last resort for a menu taller than the window: scroll it rather than clip items away.
        maxHeight: `calc(100vh - ${VIEWPORT_MARGIN * 2}px)`,
        overflowY: 'auto',
      }}
    >
      {items.filter(Boolean).map((item, index) => (
        <React.Fragment key={item.label}>
          {item.separatorBefore && index > 0 ? (
            <div style={{ height: 1, background: 'var(--border)', margin: '4px 6px' }} />
          ) : null}
          <button
            type="button"
            role="menuitem"
            disabled={item.disabled}
            title={item.title}
            onClick={() => { item.onClick?.(); onClose?.() }}
            style={{
              display: 'block', width: '100%', textAlign: 'left',
              background: 'none', border: 'none', padding: '6px 10px',
              borderRadius: 6, fontSize: 13,
              cursor: item.disabled ? 'default' : 'pointer',
              opacity: item.disabled ? 0.5 : 1,
              color: item.danger ? 'var(--danger)' : 'var(--text)',
            }}
            onMouseEnter={e => { if (!item.disabled) e.currentTarget.style.background = 'var(--surface2)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
          >
            {item.label}
          </button>
        </React.Fragment>
      ))}
    </div>
  )
}

/*
 * The trigger that opens one. Kept beside the menu so every overflow affordance in the app is the
 * same glyph, hit area, and hover treatment, and so a caller only has to store the anchor rect.
 */
export function ActionMenuButton({ onOpen, title = 'More actions', disabled = false, open = false }) {
  return (
    <IconButton
      aria-label={title}
      aria-haspopup="menu"
      aria-expanded={open}
      disabled={disabled}
      onClick={event => onOpen(event.currentTarget.getBoundingClientRect())}
      style={{ padding: '0 8px', fontSize: 18, lineHeight: '24px', ...(open ? { background: 'var(--surface2)' } : null) }}
    >
      ⋯
    </IconButton>
  )
}
