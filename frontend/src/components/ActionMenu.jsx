// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import React, { useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useDismissibleLayer } from '../lib/uiInteractions.js'
import { useAnchoredPopup } from '../lib/anchoredPopup.js'
import { toCssPx, vw } from '../lib/displaySize.js'
import { IconButton, Tooltip } from './ui.jsx'

/*
 * The app's one pop-up menu: the `⋯` overflow menu, every right-click menu, and the menu under a split
 * button's caret. One shell, so a fix to placement, dismissal, focus or row styling reaches every menu.
 *
 * It exists so a surface can offer several rarely-used actions without spending permanent space on
 * them — the connection cards are the motivating case, where five always-visible buttons per card
 * meant thirty-five controls on a page whose actionable state (a review or mapping badge) was quieter
 * than its maintenance. What is actionable now stays on the surface; what is merely always possible
 * moves in here.
 *
 * Items render in order; `separatorBefore` draws a rule above one to group them. An item is one of:
 * - a plain action (`label`, `onClick`, optional `title`), with an optional muted `description` line;
 * - a choice in a one-of-many menu (`checked` true or false), shown with a tick on the current one;
 * - a setting among several that are each on or off (`toggled` true or false), shown with a checkbox.
 *   Choosing one runs its action and leaves the menu open, so several can be set in one visit;
 * - `disabled`, whose `disabledReason` shows on hover and on focus in place of its `title`. It stays
 *   focusable (`aria-disabled`) so the keyboard reaches the reason too;
 * - `danger`, reserved for actions with no way back — a delete that leaves nothing to restore. An
 *   action that is reversible with effort (re-linking a bank, re-syncing history) is NOT danger even
 *   when it deletes rows: its confirm dialog carries the red, which is where the click that actually
 *   does the thing lives. Spending the color on recoverable actions would leave nothing to distinguish
 *   the permanent ones.
 * `label` may be a node; such an item then needs a `key`.
 *
 * Keyboard follows the WAI-ARIA menu pattern. Opening moves focus into the menu, onto the first item
 * when the trigger was reached by keyboard (it is `:focus-visible`) and onto the menu itself otherwise,
 * so a pointer open shows no highlighted row. Arrow keys move through the items and wrap, Home and End
 * jump, Enter and Space choose (the items are buttons), and Tab or Escape closes. The highlighted row is
 * the focused one, whether the pointer or the keyboard put it there. Choosing an item, Escape and Tab
 * return focus to the trigger, or to whatever held it before a right-click; an outside click leaves
 * focus where it lands. Keys are kept from reaching the surface behind, which may have arrow or Enter
 * handling of its own; Escape is not, since dismissal listens for it on the window.
 *
 * It is anchored to the element that opened it (`anchorElement`), or to the pointer for a right-click
 * menu (`anchorPoint`, `{ x, y }`: the event's `clientX`/`clientY`, which are screen pixels), and the browser keeps it there (useAnchoredPopup): right-aligned to
 * the anchor by default, since the trigger sits at a card's trailing edge, and above the anchor when
 * there is not enough room below. A pointer is given a zero-size marker to anchor to, so both kinds
 * place and flip the same way. The anchor element counts as inside the menu for dismissal, so a trigger
 * that toggles closes it rather than having the outside click close it and its own click reopen it.
 * Portaled, so a scroll container or a stacking context around the trigger cannot clip or bury it.
 * A pointer menu stays where it opened while the page scrolls, as an element-anchored one stays with
 * its anchor; neither closes on scroll.
 */
export function ActionMenu({ anchorElement = null, anchorPoint = null, items = [], onClose, minWidth = 180, align = 'end', label }) {
  const ref = useRef(null)
  const pointRef = useRef(null)
  const itemRefs = useRef([])
  const returnFocusRef = useRef(null)
  const visibleItems = items.filter(Boolean)
  const open = Boolean(anchorElement || anchorPoint)
  const [active, setActive] = useState(() => (openedByKeyboard(anchorElement) ? 0 : -1))

  const elementRef = useMemo(() => ({ current: anchorElement }), [anchorElement])
  const dismissRefs = useMemo(() => [ref, elementRef], [elementRef])
  const { popupStyle, contentRef } = useAnchoredPopup({
    open, anchorRef: anchorPoint ? pointRef : elementRef, align, minWidth,
  })

  function returnFocus() {
    const current = document.activeElement
    if (!ref.current?.contains(current)) return
    const target = anchorElement || returnFocusRef.current
    if (target?.isConnected && target !== document.body) target.focus({ preventScroll: true })
    else current.blur()
  }

  function close() {
    onClose?.()
    returnFocus()
  }

  useDismissibleLayer({
    open,
    refs: dismissRefs,
    blurOnEscape: false,
    onClose: event => {
      onClose?.(event)
      if (event?.type === 'keydown') returnFocus()
    },
  })

  // Declared before the focus effect so the element to return to is read before focus moves.
  useLayoutEffect(() => {
    returnFocusRef.current = document.activeElement
  }, [])

  useLayoutEffect(() => {
    if (!open) return
    const target = active >= 0 ? itemRefs.current[active] : ref.current
    target?.focus({ preventScroll: true })
  }, [active, open])

  function handleKeyDown(event) {
    if (event.key === 'Escape') return
    event.stopPropagation()
    const count = visibleItems.length
    if (!count) return
    const moves = {
      ArrowDown: index => (index + 1) % count,
      ArrowUp: index => (index <= 0 ? count - 1 : index - 1),
      Home: () => 0,
      End: () => count - 1,
    }
    if (moves[event.key]) {
      event.preventDefault()
      setActive(moves[event.key])
    } else if (event.key === 'Tab') {
      event.preventDefault()
      close()
    }
  }

  if (!open) return null
  return createPortal(
    <>
    {anchorPoint ? (
      <div
        ref={pointRef}
        aria-hidden="true"
        style={{ position: 'fixed', left: toCssPx(anchorPoint.x), top: toCssPx(anchorPoint.y), width: 0, height: 0, pointerEvents: 'none' }}
      />
    ) : null}
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      onMouseDown={stopPress}
      onPointerDown={stopPress}
      onMouseLeave={() => setActive(-1)}
      style={{
        ...popupStyle,
        maxWidth: `min(480px, calc(${vw(100)} - 16px))`,
        zIndex: 1400,
        outline: 'none',
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: 4,
        boxShadow: '0 12px 36px rgba(15, 23, 42, 0.32)',
      }}
    >
      <div ref={contentRef}>
        {visibleItems.map((item, index) => (
          <React.Fragment key={item.key ?? item.label}>
            {item.separatorBefore && index > 0 ? (
              <div role="separator" style={{ height: 1, background: 'var(--border)', margin: '4px 6px' }} />
            ) : null}
            <ActionMenuItem
              item={item}
              highlighted={index === active}
              buttonRef={element => { itemRefs.current[index] = element }}
              onHover={() => setActive(index)}
              onChoose={() => {
                if (item.disabled) return
                item.onClick?.()
                if (typeof item.toggled !== 'boolean') close()
              }}
            />
          </React.Fragment>
        ))}
      </div>
    </div>
    </>,
    document.body,
  )
}

// A press inside the menu is not an outside click for any layer behind it, nor the start of a drag or a
// selection on the surface that rendered it (a portal still bubbles through that surface's React tree).
function stopPress(event) {
  event.stopPropagation()
}

// A trigger reached by keyboard is focus-visible; one clicked with a pointer is not, or is not focused.
// The anchor may wrap the trigger (a split button anchors to both halves), so focus inside it counts.
function openedByKeyboard(anchorElement) {
  const focused = document.activeElement
  if (!anchorElement || !focused || !anchorElement.contains(focused)) return false
  try {
    return focused.matches(':focus-visible')
  } catch {
    return false
  }
}

function ActionMenuItem({ item, highlighted, buttonRef, onHover, onChoose }) {
  const descriptionId = useId()
  const isChoice = typeof item.checked === 'boolean'
  const isToggle = typeof item.toggled === 'boolean'
  return (
    <Tooltip describeTrigger content={item.disabled ? item.disabledReason : ''} triggerStyle={{ display: 'flex' }}>
      <button
        ref={buttonRef}
        type="button"
        role={isToggle ? 'menuitemcheckbox' : isChoice ? 'menuitemradio' : 'menuitem'}
        aria-checked={isToggle ? item.toggled : isChoice ? item.checked : undefined}
        aria-disabled={item.disabled || undefined}
        aria-describedby={item.description ? descriptionId : undefined}
        tabIndex={-1}
        title={item.disabled && item.disabledReason ? undefined : item.title}
        onClick={onChoose}
        onMouseEnter={onHover}
        style={{
          display: 'block', width: '100%', textAlign: 'left',
          background: highlighted ? 'var(--surface2)' : 'none',
          border: 'none', outline: 'none', padding: '6px 10px',
          borderRadius: 6, fontSize: 13, overflowWrap: 'anywhere',
          cursor: item.disabled ? 'default' : 'pointer',
          opacity: item.disabled ? 0.5 : 1,
          color: item.danger ? 'var(--danger)' : 'var(--text)',
        }}
      >
        <span style={{ display: 'flex', alignItems: isToggle ? 'center' : 'baseline', justifyContent: isToggle ? 'flex-start' : 'space-between', gap: 8 }}>
          {isToggle ? <ToggleBox on={item.toggled} /> : null}
          <span>{item.label}</span>
          {item.checked ? <span aria-hidden="true" style={{ color: 'var(--accent2)', fontSize: 11 }}>✓</span> : null}
        </span>
        {item.description ? (
          <span id={descriptionId} style={{ display: 'block', fontSize: 12, color: 'var(--muted)' }}>
            {item.description}
          </span>
        ) : null}
      </button>
    </Tooltip>
  )
}

// Drawn rather than a native checkbox, which may not sit inside the item's button.
function ToggleBox({ on }) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: 14, height: 14, flexShrink: 0, borderRadius: 3, boxSizing: 'border-box',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        border: `1px solid ${on ? 'var(--accent)' : 'var(--muted)'}`,
        background: on ? 'var(--accent)' : 'transparent',
        color: '#fff', fontSize: 10, lineHeight: 1, fontWeight: 700,
      }}
    >
      {on ? '✓' : null}
    </span>
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
