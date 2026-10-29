// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import React, { useMemo, useRef } from 'react'
import { useDismissibleLayer } from '../lib/uiInteractions.js'
import { useAnchoredPopup } from '../lib/anchoredPopup.js'
import { IconButton, Tooltip } from './ui.jsx'

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
 * Items render in order; `separatorBefore` draws a rule above one to group them. A `disabled` item's
 * `disabledReason` shows on hover in place of its `title`, which a disabled button never opens.
 * Dismissal (outside click / Escape) is the shared `useDismissibleLayer`.
 *
 * It is anchored to the element that opened it (`anchorElement`), or to the pointer for a right-click
 * menu (`anchorPoint`, `{ x, y }`), and the browser keeps it there (useAnchoredPopup): right-aligned to
 * the anchor by default, since the trigger sits at a card's trailing edge, and above the anchor when
 * there is not enough room below. A pointer is given a zero-size marker to anchor to, so both kinds
 * place and flip the same way.
 */
export function ActionMenu({ anchorElement = null, anchorPoint = null, items = [], onClose, minWidth = 180, align = 'end' }) {
  const ref = useRef(null)
  const pointRef = useRef(null)
  useDismissibleLayer({ open: true, onClose, refs: [ref] })
  const elementRef = useMemo(() => ({ current: anchorElement }), [anchorElement])
  const open = Boolean(anchorElement || anchorPoint)
  const { popupStyle, contentRef } = useAnchoredPopup({
    open, anchorRef: anchorPoint ? pointRef : elementRef, align, minWidth,
  })

  if (!open) return null
  return (
    <>
    {anchorPoint ? (
      <div
        ref={pointRef}
        aria-hidden="true"
        style={{ position: 'fixed', left: anchorPoint.x, top: anchorPoint.y, width: 0, height: 0, pointerEvents: 'none' }}
      />
    ) : null}
    <div
      ref={ref}
      role="menu"
      style={{
        ...popupStyle,
        zIndex: 1400,
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: 4,
        boxShadow: '0 12px 36px rgba(15, 23, 42, 0.32)',
      }}
    >
      <div ref={contentRef}>
        {items.filter(Boolean).map((item, index) => (
          <React.Fragment key={item.label}>
            {item.separatorBefore && index > 0 ? (
              <div style={{ height: 1, background: 'var(--border)', margin: '4px 6px' }} />
            ) : null}
            <Tooltip describeTrigger content={item.disabled ? item.disabledReason : ''} triggerStyle={{ display: 'flex' }}>
              <button
                type="button"
                role="menuitem"
                disabled={item.disabled}
                title={item.disabled && item.disabledReason ? undefined : item.title}
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
            </Tooltip>
          </React.Fragment>
        ))}
      </div>
    </div>
    </>
  )
}

/*
 * The trigger that opens one. Kept beside the menu so every overflow affordance in the app is the
 * same glyph, hit area, and hover treatment, and so a caller only has to store the anchor element.
 */
export function ActionMenuButton({ onOpen, title = 'More actions', disabled = false, open = false }) {
  return (
    <IconButton
      aria-label={title}
      aria-haspopup="menu"
      aria-expanded={open}
      disabled={disabled}
      onClick={event => onOpen(event.currentTarget)}
      style={{ padding: '0 8px', fontSize: 18, lineHeight: '24px', ...(open ? { background: 'var(--surface2)' } : null) }}
    >
      ⋯
    </IconButton>
  )
}
