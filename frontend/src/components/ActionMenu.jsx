// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import React, { useRef } from 'react'
import { useDismissibleLayer } from '../lib/uiInteractions.js'

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
 * Items render in order; `separatorBefore` draws a rule above one to group them. Positioning is
 * viewport-clamped from the anchor's rect, and dismissal (outside click / Escape) is the shared
 * `useDismissibleLayer`.
 */
export function ActionMenu({ anchorRect, items = [], onClose, minWidth = 180, align = 'end' }) {
  const ref = useRef(null)
  useDismissibleLayer({ open: true, onClose, refs: [ref] })

  if (!anchorRect) return null
  // Right-aligned to the anchor by default: the trigger sits at a card's trailing edge, so growing
  // leftward keeps the menu on screen without measuring its width.
  const rawLeft = align === 'end' ? anchorRect.right - minWidth : anchorRect.left
  const left = Math.max(8, Math.min(rawLeft, window.innerWidth - minWidth - 8))
  const top = anchorRect.bottom + 4

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
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-haspopup="menu"
      aria-expanded={open}
      disabled={disabled}
      onClick={event => onOpen(event.currentTarget.getBoundingClientRect())}
      style={{
        background: open ? 'var(--surface2)' : 'none',
        border: '1px solid transparent',
        borderRadius: 6,
        color: 'var(--muted)',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        padding: '0 8px', fontSize: 18, lineHeight: '24px',
      }}
      onMouseEnter={e => { if (!disabled) e.currentTarget.style.background = 'var(--surface2)' }}
      onMouseLeave={e => { e.currentTarget.style.background = open ? 'var(--surface2)' : 'none' }}
    >
      ⋯
    </button>
  )
}
