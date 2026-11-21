// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/* eslint-disable react-refresh/only-export-components -- shared UI kit: primitive components live alongside style helpers used to compose them */

import { cloneElement, forwardRef, isValidElement, useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { getCategoryBadgeTheme } from '../lib/categoryAppearance.js'
import { useBusyIndicator } from '../lib/useBusyIndicator.js'
import { alignOnAxis, besideOnAxis } from '../lib/floatingPlacement.js'
import { SUGGESTED_PASSPHRASE_WORDS, SUGGESTED_PASSWORD_WORDS, suggestPassphrase } from '../lib/passphraseGenerator.js'
import { useCoarsePointer } from '../lib/deviceLayout.js'
import { useVisibleViewport, visibleHeightCss, visibleLayerBox } from '../lib/visibleViewport.js'
import { cssRect, toCssPx } from '../lib/displaySize.js'

/*
 * These primitives define the app-wide visual language for everyday UI chrome: category markers and badges,
 * floating panels and overlays, shared form controls, and compact action rows. Feature components build on this
 * file so stacked windows, dialogs, and routine editing surfaces stay visually aligned instead of drifting apart.
 */

/*
 * Shared hover/focus tooltip — the one hint surface for the app. Themed (so it matches in dark and
 * light, unlike a native `title`), rendered through a portal with fixed positioning so it escapes
 * ancestor `overflow` clipping (e.g. scrolling tables). `content` may be a string or rich JSX; `tone`
 * shifts the border for warning/validation hints. Trigger wrapper is inline-flex so it doesn't disturb
 * layout. This is the primitive native `title=` and page-local tooltips should migrate onto.
 *
 * Two opt-in modes for richer hints:
 *   - `interactive` keeps the popover alive while the pointer is over it (a brief close delay bridges
 *     the gap from trigger to popover) and makes it clickable, so the content can hold a link or button.
 *   - `bare` drops the themed box chrome and only positions `content`, for content that brings its own
 *     card (e.g. a help summary panel). Combine both for a hover help card.
 *
 * `openDelay` (ms) makes the hover have to *dwell* before the hint appears. It defaults to 0 — instant,
 * the historical behavior — and is opt-in per caller. Set it on hints attached to **rows of a scrollable
 * list**: with the cursor held still and the list moving under it, every row that slides past counts as
 * a fresh hover, so zero-delay hints strobe as the user scrolls. A dwell requirement costs nothing to a
 * user who actually stops on a row and removes the flicker entirely for one who is just passing through.
 */
// The dwell to use for a hint attached to a row of a long scrolling list. Long enough that scrolling
// past under a resting cursor never fires it, short enough that deliberately stopping on a row still
// feels immediate. Shared so these hovers stay consistent across reports rather than each picking a
// number.
export const ROW_HOVER_OPEN_DELAY_MS = 300

// The dwell for a status hint a pointer often crosses on the way somewhere else, so it does not flash.
export const HOVER_OPEN_DELAY_MS = 300

// Off screen but still read by assistive technology: a label that has to stay a control's accessible
// name when the visible text is not there.
export const VISUALLY_HIDDEN_STYLE = {
  position: 'absolute', width: 1, height: 1, padding: 0, margin: -1,
  overflow: 'hidden', clip: 'rect(0, 0, 0, 0)', whiteSpace: 'nowrap', border: 0,
}

// The border-box width that fits a wrapped hint to its widest line, or null where nothing would shrink.
// CSS cannot do this on its own: a `max-content` box whose text overflows `maxWidth` grows to exactly
// `maxWidth`, and wrapping then leaves the unused remainder of the longest line as a blank strip down
// the right-hand side. The rendered lines are read back through a Range, which reports one rect per line
// for any inline content (strings and rich JSX alike); a block child reports its full width, so it simply
// yields no shrink. Null where the environment has no layout to measure (jsdom).
function fittedTooltipWidth(el) {
  if (typeof document.createRange !== 'function') return null
  const range = document.createRange()
  range.selectNodeContents(el)
  if (typeof range.getClientRects !== 'function') return null
  const lines = Array.from(range.getClientRects()).filter(rect => rect.width > 0)
  if (lines.length < 2) return null
  const style = getComputedStyle(el)
  const inset = ['paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth']
    .reduce((sum, key) => sum + (parseFloat(style[key]) || 0), 0)
  const used = toCssPx(Math.max(...lines.map(rect => rect.right)) - Math.min(...lines.map(rect => rect.left)))
  // Rounded up with a pixel spare, so sub-pixel text never finds itself a hair too wide and re-wraps.
  const fitted = Math.ceil(used + inset) + 1
  return fitted < cssRect(el).width - 1 ? fitted : null
}

// The tooltip's own box, apart from where it is placed and how wide it is: for a hint that cannot use
// `Tooltip` itself, such as one that follows the pointer through a drag.
export function getTooltipSurfaceStyle({ tone = 'neutral' } = {}) {
  return {
    background: 'var(--surface)',
    border: `1px solid ${tone === 'warning'
      ? 'color-mix(in srgb, var(--danger) 55%, var(--border))'
      : 'color-mix(in srgb, var(--text) 24%, var(--border))'}`,
    borderRadius: 8,
    padding: '6px 10px',
    fontSize: 12,
    color: 'var(--text)',
    boxShadow: '0 8px 24px rgba(0,0,0,0.28)',
  }
}

// `describeTrigger` also gives the hint to assistive technology, as the trigger's description, for a
// plain-text hint on a single control. A disabled control needs it: the hover is its only way to say why,
// and a screen reader never sees a hover.
//
// `side="right"` places the hint beside the trigger, centred on it, instead of below it. Use it for a
// column of triggers, where a hint below one would cover the next.
export function Tooltip({ children, content, maxWidth = 280, align = 'left', side = 'below', tone = 'neutral', interactive = false, bare = false, triggerStyle = null, openDelay = 0, describeTrigger = false }) {
  const triggerRef = useRef(null)
  const descriptionId = useId()
  const tipRef = useRef(null)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState(null)
  // `{ content, width }` — the fitted width, keyed to the content it was measured for so a hint whose
  // text changes while open is measured again rather than squeezed into the old one's width.
  const [fit, setFit] = useState(null)
  const closeTimer = useRef(null)
  const openTimer = useRef(null)
  // The live scroll/right-click/press dismissal while this tooltip is armed or showing, held as a ref so it
  // can be attached the instant a hover lands — see `armDismissal`.
  const dismissalRef = useRef(null)
  // Set by a press, so the focus that the same press gives the trigger does not open the hint again.
  // Cleared when the pointer leaves or focus moves on.
  const pressedRef = useRef(false)
  useEffect(() => () => {
    clearTimeout(closeTimer.current)
    clearTimeout(openTimer.current)
    disarmDismissal()
  }, [])

  /*
   * An open tooltip is positioned once, in fixed coordinates, against where its trigger was at the time.
   * Scrolling moves the trigger but not the tooltip, so it would hang detached in mid-air until the
   * pointer left. Close on any scroll instead, and cancel a pending open so a scroll that starts during
   * the dwell never resolves into a hint. Capture phase because the scroll almost always happens in an
   * ancestor container and scroll events don't bubble. Attached only while this tooltip is armed or
   * showing, so the many idle tooltips in a list cost nothing.
   *
   * The same dismissal serves a right-click. A context menu opens at the pointer without the pointer
   * moving, so no `mouseleave` ever fires and the hint stays up — and since this tooltip sits at the top
   * of the app's stacking order (see `zIndex` below), it paints over the menu; an `interactive` hint also
   * keeps pointer events, so the menu items it covers stop being clickable. Capture phase and window-wide
   * because the menu may be opened from an ancestor of the trigger (transaction rows put the handler on
   * the row, not the cell) or from somewhere else on the page entirely.
   *
   * A press dismisses too, as a native `title` does. A trigger that opens something (a document, a
   * note) puts its dialog under a pointer that has not moved, so no `mouseleave` comes, and a press
   * inside the dwell would otherwise open the hint a moment later on top of that dialog. A press inside
   * an `interactive` card is left alone, since that card is there to be used.
   *
   * **This is armed imperatively from `show`, not by an effect keyed on `open`, and that is the whole
   * difference between dismissing a right-click and missing it.** An effect cannot run until React has
   * re-rendered, and the events race it: `mouseover` → `contextmenu` on a transaction row measures
   * **2ms** end to end, so the listener that was going to cancel the dwell is still unattached when the
   * right-click passes, and the card opens 300ms later over the menu it should have yielded to —
   * `interactive`, so it then swallows the clicks aimed at the menu items beneath it. It presented as an
   * intermittent Playwright failure because whether React flushes
   * inside those 2ms is a matter of load; a person right-clicking a merchant hits the same race, and
   * loses it as reliably. Nothing here may be made to depend on a render having happened.
   */
  function armDismissal() {
    if (dismissalRef.current) return
    const dismiss = () => {
      clearTimeout(openTimer.current)
      clearTimeout(closeTimer.current)
      setOpen(false)
      disarmDismissal()
    }
    const dismissOnPress = event => {
      if (tipRef.current?.contains(event.target)) return
      pressedRef.current = true
      dismiss()
    }
    dismissalRef.current = { dismiss, dismissOnPress }
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('contextmenu', dismiss, true)
    window.addEventListener('pointerdown', dismissOnPress, true)
  }

  function disarmDismissal() {
    const listeners = dismissalRef.current
    if (!listeners) return
    dismissalRef.current = null
    window.removeEventListener('scroll', listeners.dismiss, true)
    window.removeEventListener('contextmenu', listeners.dismiss, true)
    window.removeEventListener('pointerdown', listeners.dismissOnPress, true)
  }
  // Position only once the tooltip is mounted, so its real measured size is known. A portaled DOM
  // tooltip can't paint past the window the way a native `title` can, so the best it can do is stay
  // fully inside the viewport: clamp horizontally to keep it on-screen, and flip above the trigger
  // when placing it below would run off the bottom edge.
  //
  // Before positioning, a wrapped hint is narrowed to its widest line (see `fittedTooltipWidth`). That
  // takes a render of its own, so the first pass only measures and the tooltip stays hidden until the
  // second has placed it at its final width.
  useLayoutEffect(() => {
    if (!open) { setPos(null); setFit(null); return }
    if (!bare && fit?.content !== content) {
      setFit({ content, width: tipRef.current ? fittedTooltipWidth(tipRef.current) : null })
      return
    }
    const trigger = triggerRef.current?.getBoundingClientRect()
    const tip = tipRef.current?.getBoundingClientRect()
    if (!trigger || !tip) return
    const vw = document.documentElement.clientWidth
    const vh = document.documentElement.clientHeight
    const left = side === 'right'
      ? besideOnAxis({ before: trigger.left, after: trigger.right, size: tip.width, lo: 0, hi: vw })
      : alignOnAxis({
        start: align === 'right' ? trigger.right - tip.width : trigger.left, size: tip.width, lo: 0, hi: vw,
      })
    const top = side === 'right'
      ? alignOnAxis({ start: trigger.top + (trigger.height - tip.height) / 2, size: tip.height, lo: 0, hi: vh })
      : besideOnAxis({ before: trigger.top, after: trigger.bottom, size: tip.height, lo: 0, hi: vh })
    // Measured in screen pixels, placed in CSS pixels (displaySize.js).
    setPos({ top: toCssPx(top), left: toCssPx(left) })
  }, [open, content, align, side, bare, fit])
  if (!content) return children
  const triggerChild = describeTrigger && isValidElement(children)
    ? cloneElement(children, {
      'aria-describedby': [children.props['aria-describedby'], descriptionId].filter(Boolean).join(' '),
    })
    : children
  function show() {
    if (pressedRef.current) return
    clearTimeout(closeTimer.current)
    // Before anything that can open, so a right-click arriving in the same frame as the hover is still
    // caught (see armDismissal).
    armDismissal()
    if (!openDelay) { setOpen(true); return }
    // Re-entering the same trigger while already open (e.g. crossing a child element) must not drop the
    // hint and re-serve the delay, so only an unopened tooltip arms the dwell timer.
    if (open) return
    openTimer.current = setTimeout(() => setOpen(true), openDelay)
  }
  function hide() {
    pressedRef.current = false
    clearTimeout(openTimer.current)
    // The dismissal outlives an `interactive` hint's closing grace on purpose: the pointer crossing into
    // the card keeps it open (the card's own `onMouseEnter` clears this timer), and it still has to get
    // out of the way of a scroll or a menu while it is up.
    if (interactive) {
      closeTimer.current = setTimeout(() => { setOpen(false); disarmDismissal() }, 140)
    } else {
      setOpen(false)
      disarmDismissal()
    }
  }
  // Render hidden until measured so the first frame never flashes at an unclamped spot.
  const positionStyle = {
    position: 'fixed',
    top: pos?.top ?? 0,
    left: pos?.left ?? 0,
    visibility: pos ? 'visible' : 'hidden',
    zIndex: 4000,
    pointerEvents: interactive ? 'auto' : 'none',
  }
  // `bare` lets the content supply its own card; otherwise wrap it in the themed hint box.
  const boxStyle = bare ? positionStyle : {
    ...positionStyle,
    ...getTooltipSurfaceStyle({ tone }),
    // max-content keeps the tooltip from inheriting a tiny trigger's width as its wrap budget; once
    // measured, a wrapped hint takes its widest line instead (`fittedTooltipWidth`).
    ...(fit?.content === content && fit.width
      ? { width: fit.width, boxSizing: 'border-box' }
      : { width: 'max-content' }),
    maxWidth,
    // Balanced lines, so a hint that wraps does not leave one word alone on its last line; the fitted
    // width then follows the balanced lines, which is also the narrower box.
    textWrap: 'balance',
    whiteSpace: 'normal',
    wordBreak: 'break-word',
    textAlign: 'left',
  }
  return (
    <span
      ref={triggerRef}
      // triggerStyle lets a caller make the wrapper shrink/ellipsize (e.g. wrapping a truncating
      // table cell) since the default inline-flex wrapper carries a min-content floor otherwise.
      style={{ position: 'relative', display: 'inline-flex', ...triggerStyle }}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {triggerChild}
      {describeTrigger ? <span id={descriptionId} style={VISUALLY_HIDDEN_STYLE}>{content}</span> : null}
      {open ? createPortal(
        <div
          ref={tipRef}
          role="tooltip"
          // A portal still bubbles React events to the trigger's ancestors, so without this a right-click
          // in the card would open the menu of the row the trigger sits in.
          onContextMenu={event => event.stopPropagation()}
          onMouseEnter={interactive ? () => clearTimeout(closeTimer.current) : undefined}
          onMouseLeave={interactive ? hide : undefined}
          style={boxStyle}
        >
          {content}
        </div>,
        document.body,
      ) : null}
    </span>
  )
}

export function CategoryMarker({ kind = 'category', size, style }) {
  const markerSize = size ?? (kind === 'group' ? 9 : 7)
  const isGroup = kind === 'group'
  if (isGroup) {
    return (
      <span
        aria-hidden="true"
        style={{
          width: markerSize,
          height: markerSize + 1,
          flexShrink: 0,
          marginRight: -1,
          display: 'inline-block',
          position: 'relative',
          boxSizing: 'border-box',
          borderRadius: '50%',
          border: '1px solid currentColor',
          opacity: 0.72,
          transform: 'translateY(1px)',
          ...style,
        }}
      >
        <span
          style={{
            position: 'absolute',
            left: markerSize * 0.15,
            bottom: -1,
            width: Math.max(3, Math.round(markerSize * 0.26)),
            height: Math.max(3, Math.round(markerSize * 0.2)),
            borderLeft: '1px solid currentColor',
            borderBottom: '1px solid currentColor',
            borderBottomLeftRadius: Math.max(2, Math.round(markerSize * 0.18)),
            transform: 'skewX(-20deg)',
            boxSizing: 'border-box',
          }}
        />
      </span>
    )
  }
  return (
    <span
      aria-hidden="true"
      style={{
        width: markerSize,
        height: markerSize,
        flexShrink: 0,
        display: 'inline-block',
        background: 'currentColor',
        borderRadius: '50%',
        opacity: 0.78,
        ...style,
      }}
    />
  )
}

// A resize grip on a touch screen. A finger needs a far wider target than a cursor, and with no hover it
// needs something visible to aim at, so a grip widens to TOUCH_GRIP_WIDTH there and shows this diamond,
// centred on its divider at the point `left`/`top` give. Renders nothing for a mouse.
export const TOUCH_GRIP_WIDTH = 24

export function TouchResizeMark({ left = '50%', top = '50%' }) {
  const coarsePointer = useCoarsePointer()
  if (!coarsePointer) return null
  return (
    <span
      aria-hidden="true"
      style={{
        position: 'absolute',
        left,
        top,
        width: 5,
        height: 5,
        transform: 'translate(-50%, -50%) rotate(45deg)',
        background: 'color-mix(in srgb, var(--muted) 55%, var(--border))',
        pointerEvents: 'none',
      }}
    />
  )
}

export function Card({ children, style }) {
  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 12, padding: 20, ...style,
    }}>
      {children}
    </div>
  )
}

export function getFormControlStyle({
  size = 'md',
  accent = false,
  clickable = false,
  surface = 'inset',
} = {}) {
  const sizes = {
    sm: { padding: '5px 8px', fontSize: 12, borderRadius: 6 },
    md: { padding: '7px 10px', fontSize: 13, borderRadius: 6 },
    lg: { padding: '8px 12px', fontSize: 14, borderRadius: 8 },
    // A `Button` size's height, for a field in a row of buttons. A fixed height rather than padding, because
    // a select draws a taller text line than an input at the same font size and ignores `line-height`.
    regular: { padding: '0 10px', height: 29, boxSizing: 'border-box', fontSize: 13, borderRadius: 8 },
    compact: { padding: '0 8px', height: 22, boxSizing: 'border-box', fontSize: 12, borderRadius: 6 },
  }
  const chosenSize = sizes[size] || sizes.md
  const background = surface === 'base' ? 'var(--surface)' : 'var(--surface2)'
  return {
    background,
    color: 'var(--text)',
    border: `1px solid ${accent ? 'var(--accent)' : 'var(--border)'}`,
    outline: 'none',
    cursor: clickable ? 'pointer' : 'auto',
    ...chosenSize,
  }
}

export function InsetPanel({ children, style, as: Tag = 'div', ...rest }) {
  return (
    <Tag
      style={{
        display: 'grid',
        gap: 12,
        padding: 14,
        border: '1px solid var(--border)',
        borderRadius: 10,
        background: 'var(--surface2)',
        ...style,
      }}
      {...rest}
    >
      {children}
    </Tag>
  )
}

export function FormLabel({ children, style, ...rest }) {
  return (
    <label
      {...rest}
      style={{
        fontSize: 11,
        color: 'var(--muted)',
        display: 'block',
        marginBottom: 3,
        ...style,
      }}
    >
      {children}
    </label>
  )
}

export function SectionEyebrow({ children, style }) {
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 600,
        color: 'var(--muted)',
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
        ...style,
      }}
    >
      {children}
    </div>
  )
}

export function getFloatingPanelSurfaceStyle({ active = true, radius = 16 } = {}) {
  return {
    background: active
      ? 'linear-gradient(180deg, color-mix(in srgb, var(--surface) 98%, white), var(--surface))'
      : 'linear-gradient(180deg, color-mix(in srgb, var(--surface) 97%, black), var(--surface))',
    border: active
      ? '1px solid color-mix(in srgb, var(--accent) 30%, color-mix(in srgb, var(--border) 88%, white 10%))'
      : '1px solid color-mix(in srgb, var(--border) 88%, white 8%)',
    borderRadius: radius,
    boxShadow: active
      ? '0 30px 80px rgba(15, 23, 42, 0.38), 0 0 0 1px color-mix(in srgb, var(--border) 32%, transparent), inset 0 1px 0 rgba(255,255,255,0.08)'
      : '0 18px 44px rgba(15, 23, 42, 0.24), 0 0 0 1px color-mix(in srgb, var(--border) 18%, transparent), inset 0 1px 0 rgba(255,255,255,0.04)',
  }
}

export function getFloatingPanelHeaderBackground(active = true) {
  return active
    ? 'linear-gradient(180deg, color-mix(in srgb, var(--surface2) 72%, var(--surface)), color-mix(in srgb, var(--surface) 91%, var(--accent)))'
    : 'linear-gradient(180deg, color-mix(in srgb, var(--surface2) 62%, var(--surface)), color-mix(in srgb, var(--surface) 96%, black))'
}

export function OverlayBackdrop({
  children,
  onClick,
  zIndex = 900,
  tint = 'rgba(15, 23, 42, 0.42)',
  blur = 2,
  padding = 24,
  alignItems = 'center',
  justifyContent = 'center',
  // 'none' lets clicks fall through to the page behind so a non-blocking floating dialog can sit over
  // live content (the panel itself re-enables pointer events). Children inherit 'none' unless they opt
  // back in, so the centered panel must set pointerEvents: 'auto'.
  pointerEvents = 'auto',
}) {
  // Kept on the visible area while an on-screen keyboard is open (see visibleViewport.js).
  const area = useVisibleViewport()
  return (
    <div
      onClick={onClick}
      // Marks an active modal layer so lower surfaces (e.g. detail panels' Escape-to-close)
      // can tell a dialog is open above them and let the dialog own the Escape instead.
      data-modal-overlay=""
      style={{
        position: 'fixed',
        ...visibleLayerBox(area),
        zIndex,
        display: 'flex',
        alignItems,
        justifyContent,
        padding,
        background: tint,
        backdropFilter: blur ? `blur(${blur}px)` : undefined,
        pointerEvents,
      }}
    >
      {children}
    </div>
  )
}

export const FloatingPanel = forwardRef(function FloatingPanel(
  { children, active = true, radius = 16, style, onClick, ...rest },
  ref
) {
  return (
    <div
      ref={ref}
      onClick={onClick}
      style={{
        ...getFloatingPanelSurfaceStyle({ active, radius }),
        overflow: 'hidden',
        ...style,
      }}
      {...rest}
    >
      {children}
    </div>
  )
})

export function FloatingPanelHeader({ children, active = true, onPointerDown, style }) {
  return (
    <div
      onPointerDown={onPointerDown}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        borderBottom: '1px solid var(--border)',
        background: getFloatingPanelHeaderBackground(active),
        ...style,
      }}
    >
      {children}
    </div>
  )
}

// The standard dialog shell. Three things a caller has to know:
//
//   - **It renders where it is mounted; it does not portal.** Its fixed overlay is positioned and stacked
//     against whatever ancestor established a containing block, so a dialog opened from inside a row, a
//     list or another overlay is wrapped in `createPortal(…, document.body)` by its caller.
//   - **The body scrolls, with the header and actions pinned.** A direct child of the body uses
//     `overflow: clip` rather than `overflow: hidden` for rounded corners: the body is a grid, where a
//     scroll container's minimum height is zero, so such a child is squeezed and cut off with no scrollbar.
//   - **`actions` is wrapped in `DialogActions` here.** Pass the buttons bare, or in a fragment.
export function AppDialog({
  title,
  description,
  children,
  actions,
  onClose,
  zIndex = 1200,
  tint = 'rgba(15, 23, 42, 0.38)',
  width = 'min(560px, 100%)',
  borderColor = 'var(--border)',
  headerPadding = '16px 20px',
  bodyPadding = 20,
  panelStyle,
  bodyStyle,
  footerAlign = 'end',
  dismissOnBackdrop = false,
  // A `RefreshButton`, attached to the title like a page's (see `PageHeader`).
  refresh = null,
  // A `FeatureExplainer`, placed before the title like a page's (see `PageHeader`).
  help = null,
}) {
  const area = useVisibleViewport()

  return (
    <OverlayBackdrop
      zIndex={zIndex}
      tint={tint}
      onClick={dismissOnBackdrop ? onClose : undefined}
    >
      {/* The panel is bounded by the viewport and scrolls its BODY, never the page. Three things made a
          tall dialog unusable before this: the backdrop is `position: fixed`, so the page behind cannot
          scroll to reveal anything; `FloatingPanel` clips its overflow (it has to, for the rounded
          corners); and the body had no height cap. Content taller than the screen was therefore cut off
          with no scrollbar anywhere — silently, and only past a row count no dialog had reached yet.
          Scrolling the body rather than the panel is what keeps the title and the action buttons pinned;
          a dialog whose Continue button scrolls out of reach is the same bug wearing a scrollbar.
          The 48 is `OverlayBackdrop`'s default 24px padding, top and bottom. */}
      <FloatingPanel
        onClick={event => event.stopPropagation()}
        style={{
          width,
          border: `1px solid ${borderColor}`,
          maxHeight: `calc(${visibleHeightCss(area)} - 48px)`,
          display: 'flex',
          flexDirection: 'column',
          ...panelStyle,
        }}
      >
        {(title || description) ? (
          <FloatingPanelHeader style={{ padding: headerPadding, flexShrink: 0 }}>
            <div>
              {title ? (
                <div style={{ fontSize: 16, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
                  {help ? <span style={{ display: 'inline-flex', fontWeight: 400 }}>{help}</span> : null}
                  {title}
                  {refresh ? <span style={{ display: 'inline-flex' }}>{refresh}</span> : null}
                </div>
              ) : null}
              {description ? (
                <div className="ui-selectable" style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4, lineHeight: 1.5 }}>
                  {description}
                </div>
              ) : null}
            </div>
          </FloatingPanelHeader>
        ) : null}
        {children ? (
          // `minHeight: 0` is load-bearing, not defensive: a flex child's default `min-height: auto`
          // refuses to shrink below its content, so without it the panel's maxHeight is overridden by
          // the body and nothing scrolls at all.
          <div style={{
            padding: bodyPadding, display: 'grid', gap: 12,
            overflowY: 'auto', minHeight: 0, ...bodyStyle,
          }}>
            {children}
          </div>
        ) : null}
        {actions ? (
          <DialogActions align={footerAlign} style={{ flexShrink: 0 }}>
            {actions}
          </DialogActions>
        ) : null}
      </FloatingPanel>
    </OverlayBackdrop>
  )
}

export function AppConfirmDialog({
  title,
  description,
  children,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  confirmVariant = 'primary',
  confirmDisabled = false,
  cancelDisabled = false,
  onConfirm,
  onCancel,
  width,
  borderColor,
  dismissOnBackdrop = false,
}) {
  return (
    <AppDialog
      title={title}
      description={description}
      onClose={onCancel}
      width={width}
      borderColor={borderColor}
      dismissOnBackdrop={dismissOnBackdrop}
      actions={(
        <>
          <Button variant="secondary" onClick={onCancel} disabled={cancelDisabled}>
            {cancelLabel}
          </Button>
          <Button variant={confirmVariant} onClick={onConfirm} disabled={confirmDisabled}>
            {confirmLabel}
          </Button>
        </>
      )}
    >
      {children}
    </AppDialog>
  )
}

export function AppNoticeDialog({
  title = 'Notice',
  description,
  children,
  closeLabel = 'OK',
  onClose,
  width,
  borderColor,
}) {
  return (
    <AppDialog
      title={title}
      description={description}
      onClose={onClose}
      width={width}
      borderColor={borderColor}
      actions={<Button onClick={onClose}>{closeLabel}</Button>}
    >
      {children}
    </AppDialog>
  )
}

export function AppTextEntryDialog({
  title,
  description,
  label,
  value,
  onChange,
  placeholder,
  confirmLabel = 'Save',
  cancelLabel = 'Cancel',
  confirmVariant = 'primary',
  confirmDisabled = false,
  onConfirm,
  onCancel,
  helpText,
  width,
  borderColor,
}) {
  const inputRef = useRef(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select?.()
  }, [])

  return (
    <AppDialog
      title={title}
      description={description}
      onClose={onCancel}
      width={width}
      borderColor={borderColor}
      actions={(
        <>
          <Button variant="secondary" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button variant={confirmVariant} onClick={onConfirm} disabled={confirmDisabled}>
            {confirmLabel}
          </Button>
        </>
      )}
    >
      {label ? <FormLabel style={{ marginBottom: -4 }}>{label}</FormLabel> : null}
      <input
        ref={inputRef}
        value={value}
        onChange={event => onChange(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter' && !confirmDisabled) {
            event.preventDefault()
            onConfirm()
          }
          if (event.key === 'Escape') {
            event.preventDefault()
            onCancel()
          }
        }}
        placeholder={placeholder}
        style={{
          ...getFormControlStyle({ size: 'lg' }),
          width: '100%',
        }}
      />
      {helpText ? (
        <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
          {helpText}
        </div>
      ) : null}
    </AppDialog>
  )
}

export function DialogActions({ children, align = 'end', style, background = 'var(--surface2)' }) {
  const justifyContent = align === 'between'
    ? 'space-between'
    : align === 'center'
      ? 'center'
      : 'flex-end'
  return (
    <div
      style={{
        padding: '14px 20px',
        borderTop: '1px solid var(--border)',
        background,
        display: 'flex',
        justifyContent,
        gap: 8,
        flexWrap: 'wrap',
        ...style,
      }}
    >
      {children}
    </div>
  )
}

// `help` is the page-level overview explainer slot: a `?` that sits immediately left of the title, the
// app's consistent launcher spot for "what is this page" help (pass a node, e.g. <FeatureExplainer …/>,
// so this primitive stays free of help-module imports). `leftAdornment` renders to the right of the
// title for page-scoped controls; `children` are the right-aligned actions.
// The action cluster wraps rather than squeezing: a page that accumulates a fourth or fifth control ran
// its buttons into each other on a narrow window, since a non-wrapping flex row shrinks its children
// instead. Both the cluster and the outer row wrap, and the cluster keeps `marginLeft: auto` so a wrapped
// line still sits hard right — dropped flush left it would read as content belonging to the heading, and
// the title would stop looking like a title. Every one of these properties is inert until the row
// actually overflows, so no page's current layout moves.
// `refresh` takes a `RefreshButton`, placed after the title and anything else attached to it — the standard
// home for a page's refresh (see `RefreshButton`).
export function PageHeader({ title, children, leftAdornment, help, titleAdornment, refresh }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      flexWrap: 'wrap', rowGap: 12,
      marginBottom: 16,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {help}
          <h1 style={{ fontSize: 22, fontWeight: 600 }}>{title}</h1>
          {titleAdornment}
          {refresh}
        </div>
        {leftAdornment}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8, marginLeft: 'auto' }}>
        {children}
      </div>
    </div>
  )
}

// `type` defaults to "button", not the browser's "submit". This used to be dropped entirely, so every Button
// inside a form submitted it whatever the caller wrote: a `type="button"` Cancel in the two-factor setup
// form only avoided submitting because its click also removed the form, before the browser's default
// action ran. A button that acts through its own onClick should not *also* submit by accident of where it
// sits; one that means to submit says `type="submit"`.
//
// `progress` (a 0–1 fraction) turns the button into its own progress bar for a long action it started: the
// face fills from the left behind the label, which carries the figures. A running bar is the button busy
// rather than unavailable, so it keeps its full colour even though it is disabled for the duration.
//
// The app's one labelled button. Its look comes only from these props, so a caller's `style` is for
// placement (margin, flex, width, visibility) and is applied last; a colour passed there would be a
// variant that nothing else can reuse.
//   - `variant`: `primary` is the surface's one committing action (Save, Confirm); `secondary` is every
//     other action; `quiet` is an outlined, unfilled action that should not compete with the data around
//     it; `danger` is the confirm of something that cannot be undone (`ui-patterns.md` → Confirmation).
//   - `tone="danger"` reds the label of a `secondary` or `quiet` button: a destructive action that is not
//     itself the final confirm.
//   - `pressed` makes it a toggle (`aria-pressed`), drawn in the accent while on.
//   - `size`: `regular` everywhere by default; `compact` for an action repeated on every row or card, so a
//     run of them reads as a quiet toolbar rather than as the surface's main verbs.
// Any other prop (a ref, `aria-expanded`, a hover or context-menu handler) goes to the `<button>`, here and
// on `IconButton`, `FilterChip` and `LinkButton`, so a control that opens a popover keeps its wiring.
// Every variant draws a 1px border, transparent where it has none to show, so the two sizes are each one
// height whichever variant sits beside which.
//
// The padding lives in `index.html` with the label's optical centring: a font's text box carries room for
// accents above the capitals, so a label centred by its box draws low, by a pixel or more in some fonts.
// Where the browser can trim that box to the capitals and the baseline, the padding grows to keep the
// button's height. A caller that sizes the button itself (its own padding, height or line height) keeps
// the untrimmed box, because its numbers were chosen against it. So does one laid out as a flex or grid
// container: the trim reaches only a block's own lines, so its label keeps the full box, and the larger
// padding would make it taller than its size.
const BUTTON_SIZES = {
  regular: { fontSize: 13, borderRadius: 8 },
  compact: { fontSize: 12, borderRadius: 6 },
}

const UNTRIMMABLE_DISPLAYS = new Set(['flex', 'inline-flex', 'grid', 'inline-grid'])

function keepsUntrimmedBox(style) {
  if (!style) return false
  if (UNTRIMMABLE_DISPLAYS.has(style.display)) return true
  return ['padding', 'paddingTop', 'paddingBottom', 'paddingBlock', 'height', 'lineHeight'].some(key => key in style)
}

function buttonLook(variant, tone, pressed) {
  if (variant === 'primary') return { background: 'var(--accent)', color: '#fff', border: '1px solid var(--accent)' }
  if (variant === 'danger') return { background: 'var(--danger)', color: '#fff', border: '1px solid var(--danger)' }
  if (pressed) {
    return {
      background: 'color-mix(in srgb, var(--accent) 16%, var(--surface2))',
      color: 'var(--accent2)',
      border: '1px solid color-mix(in srgb, var(--accent) 55%, var(--border))',
    }
  }
  const danger = tone === 'danger'
  if (variant === 'quiet') {
    return { background: 'transparent', color: danger ? 'var(--danger)' : 'var(--muted)', border: '1px solid var(--border)' }
  }
  return danger
    ? {
      background: 'color-mix(in srgb, var(--danger) 12%, var(--surface2))',
      color: 'var(--danger)',
      border: '1px solid color-mix(in srgb, var(--danger) 45%, var(--border))',
    }
    : {
      background: 'color-mix(in srgb, var(--surface2) 76%, var(--accent) 8%)',
      color: 'var(--text)',
      border: '1px solid color-mix(in srgb, var(--accent2) 24%, var(--border))',
    }
}

export function Button({ children, onClick, onMouseDown, onPointerDown, variant = 'primary', tone, pressed, size = 'regular',
  disabled, style, title, type = 'button', 'aria-label': ariaLabel, 'aria-busy': ariaBusy, progress, ...rest }) {
  const className = `ui-button ui-button-${size}${keepsUntrimmedBox(style) ? '' : ' ui-button-trim'}`
  const showsProgress = typeof progress === 'number' && Number.isFinite(progress)
  const look = {
    ...BUTTON_SIZES[size],
    ...buttonLook(variant, tone, pressed),
    fontWeight: 500,
    cursor: showsProgress ? 'progress' : (disabled ? 'not-allowed' : 'pointer'),
    // The press itself is quick, so it reads as the button going down under the pointer rather than easing.
    transition: 'opacity 0.15s, background 0.15s, border-color 0.15s, box-shadow 0.15s, transform 0.06s, filter 0.06s',
    opacity: disabled && !showsProgress ? 0.5 : 1,
    ...(showsProgress ? { position: 'relative', overflow: 'hidden' } : null),
  }
  return (
    <button
      {...rest}
      // Carries the pressed look (`index.html`), the one state an inline style cannot express, and the
      // size's padding with the label's optical centring. Without the pressed look a click gave no sign of
      // having landed unless the action happened to change the screen.
      className={className}
      type={type}
      aria-label={ariaLabel}
      aria-busy={ariaBusy ?? (showsProgress || undefined)}
      aria-pressed={pressed === undefined ? undefined : !!pressed}
      // The DOM attribute, not just the dimmed look and the dropped handlers. Without it the control
      // stays focusable, still announces as enabled to a screen reader, and still submits a form it
      // sits in — so a button that looks unavailable is only unavailable to a mouse. The handlers stay
      // guarded as well: `disabled` blocks activation, but a caller can pass one through a wrapper.
      disabled={!!disabled}
      onClick={disabled ? undefined : onClick}
      onMouseDown={disabled ? undefined : onMouseDown}
      onPointerDown={disabled ? undefined : onPointerDown}
      style={{ ...look, ...style }}
      title={title}
    >
      {showsProgress ? (
        <>
          <span
            aria-hidden="true"
            className="ui-button-progress"
            style={{ width: `${Math.min(Math.max(progress, 0), 1) * 100}%` }}
          />
          <span style={{ position: 'relative' }}>{children}</span>
        </>
      ) : children}
    </button>
  )
}

// How long a finished refresh may wait for its turn to end before the icon is stopped anyway. A turn is
// 0.6s; this only matters where no animation events arrive at all (animations switched off outright).
export const REFRESH_TURN_FALLBACK_MS = 1200

// The one refresh control: an icon-only ↻ attached to the title of whatever it reloads. `PageHeader` and
// `AppDialog` take it as `refresh`; a custom header places it straight after its title text. The title
// rather than the action row, because a refresh is not an action on the data — it is about the view the
// title names — and the action row's first place belongs to the page's most common action.
//
// **A press always turns the icon at least once.** Most reloads here finish in a few milliseconds and bring
// back what was already on screen, so a refresh that changed nothing visible and showed no sign of having
// run read as a click that had not registered. That is a deliberate exception to `useBusyIndicator`, and a
// narrow one: its rule exists so a control the user did *not* touch does not twitch, while one they just
// pressed owes them an answer. Work the button did not start (`loading`) still goes through the indicator,
// so a background reload turns it only once it has run long enough to notice.
//
// The turn stops at the end of a rotation rather than wherever it happens to be, which is also what makes
// "at least once" hold without a timer: `lingering` is set as the animation starts and cleared only at an
// iteration boundary reached with nothing left to wait for.
export function RefreshButton({ onRefresh, loading = false, disabled = false, title = 'Refresh', onPointerDown }) {
  const [inFlight, setInFlight] = useState(false)
  const [lingering, setLingering] = useState(false)
  const slowLoad = useBusyIndicator(loading)
  const wanted = inFlight || slowLoad
  // Read from the animation's iteration event, which fires between renders.
  const wantedRef = useRef(wanted)
  useLayoutEffect(() => { wantedRef.current = wanted }, [wanted])
  const spinning = wanted || lingering

  // The iteration event never arrives where animations are switched off entirely, and waiting on it there
  // would leave the button refusing presses for good.
  useEffect(() => {
    if (wanted || !lingering) return undefined
    const id = setTimeout(() => setLingering(false), REFRESH_TURN_FALLBACK_MS)
    return () => clearTimeout(id)
  }, [wanted, lingering])

  async function refresh() {
    // A second press while the first is still turning would start the same reload over for nothing.
    if (inFlight || lingering) return
    setInFlight(true)
    setLingering(true)
    try {
      await onRefresh?.()
    } finally {
      setInFlight(false)
    }
  }

  return (
    <Button
      variant="secondary"
      onClick={refresh}
      onPointerDown={onPointerDown}
      disabled={disabled}
      title={title}
      aria-label="Refresh"
      aria-busy={spinning || undefined}
      // Shorter than the line of the titles it sits on (17px in a section, 22px on a page), so it reads as
      // attached to the title rather than as a control standing beside it.
      style={{ padding: '3px 4px', lineHeight: 0 }}
    >
      <svg
        className={spinning ? 'ui-refresh-icon is-spinning' : 'ui-refresh-icon'}
        aria-hidden="true"
        width="12"
        height="12"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        onAnimationStart={() => setLingering(true)}
        onAnimationIteration={() => { if (!wantedRef.current) setLingering(false) }}
      >
        <path d="M13.5 8a5.5 5.5 0 1 1-1.61-3.89" />
        <path d="M8.89 4.11h3v-3" />
      </svg>
    </Button>
  )
}

// The edit pencil, tip down-left as a pencil is usually drawn (the ✎ character points the other way).
// Sized in `em` by default so it follows the font size of the control it sits in.
export function PencilGlyph({ size = '1em', color = 'currentColor' }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="none" aria-hidden="true">
      <path
        d="M2.5 13.5l.9-2.8L10 4.1l1.9 1.9-6.6 6.6-2.8.9z"
        stroke={color}
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path d="M9 5l2 2" stroke={color} strokeWidth="1.2" strokeLinecap="round" />
      <path
        d="M10 4.1l1.4-1.4a1 1 0 0 1 1.4 0l.5.5a1 1 0 0 1 0 1.4L11.9 6"
        stroke={color}
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// A glyph with no label: trash, edit, close, copy, open-report. Bare until hovered, so a row of them
// stays quieter than the data beside it; the hover fill and the press live in `index.html`, since an
// inline style cannot express either. The name is required because the glyph is all a screen reader
// would otherwise get, and it doubles as the hover hint unless `title` says more.
// `tone="danger"` is for what cannot be undone, as on `Button`; `tone="accent"` is the `↗` that opens a
// report (`ui-patterns.md` → Status, badges and timestamps); `pressed` makes it a toggle.
// The padding is in `index.html` (`ui-icon-button-<size>`), because a touch screen widens it there.
const ICON_BUTTON_SIZES = {
  regular: { fontSize: 14, borderRadius: 6 },
  compact: { fontSize: 12, borderRadius: 5 },
  // The × that closes a panel or dialog from its header.
  large: { fontSize: 21, borderRadius: 6 },
}

export function IconButton({ children, onClick, onMouseDown, onPointerDown, 'aria-label': ariaLabel, title, size = 'regular',
  tone, pressed, disabled, style, type = 'button', ...rest }) {
  return (
    <button
      {...rest}
      className={`ui-button ui-icon-button ui-icon-button-${size}`}
      type={type}
      aria-label={ariaLabel}
      aria-pressed={pressed === undefined ? undefined : !!pressed}
      title={title ?? ariaLabel}
      disabled={!!disabled}
      onClick={disabled ? undefined : onClick}
      onMouseDown={disabled ? undefined : onMouseDown}
      onPointerDown={disabled ? undefined : onPointerDown}
      style={{
        ...ICON_BUTTON_SIZES[size],
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1,
        border: `1px solid ${pressed ? 'color-mix(in srgb, var(--accent) 55%, var(--border))' : 'transparent'}`,
        ...(pressed ? { background: 'color-mix(in srgb, var(--accent) 16%, var(--surface2))' } : null),
        color: tone === 'danger' ? 'var(--danger)' : tone === 'accent' || pressed ? 'var(--accent2)' : 'var(--muted)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.4 : 1,
        transition: 'background 0.15s, color 0.15s, transform 0.06s, filter 0.06s',
        ...style,
      }}
    >
      {children}
    </button>
  )
}

// The glyph that ends a clickable stand-alone pill (a status, a count, a notice) and says what the click
// does: `report` opens a report, `go` moves to another page or opens a dialog (`ui-patterns.md` →
// *Pickers and filters*). A clickable pill also carries the `ui-pill` class, whose hover is in `index.html`.
const PILL_MARKS = {
  report: { glyph: '↗', style: { color: 'var(--accent2)', fontSize: 10 } },
  go: { glyph: '›', style: { opacity: 0.7, fontSize: 13 } },
}

export function PillMark({ kind }) {
  const mark = PILL_MARKS[kind]
  if (!mark) return null
  return <span aria-hidden="true" style={{ lineHeight: 1, flexShrink: 0, ...mark.style }}>{mark.glyph}</span>
}

// A rounded chip that narrows a list: a facet value, a status filter, a quick scope. `selected` makes it a
// toggle (`aria-pressed`); `count` is the number of rows it would show, drawn inside the chip so it is
// visible before the chip is pressed. `variant="add"` is the dashed chip that opens a picker to add
// another. `tone="danger"` marks a selection that removes something (tags picked for removal), and
// `countTone` colours the count where its colour already means something (a finding's kind).
// A chip that only displays a value is `OwnerChip` or `StatusPill`, not this.
export function FilterChip({ children, onClick, selected, count, countTone, variant, tone, disabled, title, 'aria-label': ariaLabel, style, ...rest }) {
  const add = variant === 'add'
  const hue = tone === 'danger' ? 'var(--danger)' : 'var(--accent)'
  return (
    <button
      {...rest}
      className="ui-button ui-pill"
      type="button"
      aria-label={ariaLabel}
      aria-pressed={add || selected === undefined ? undefined : !!selected}
      title={title}
      disabled={!!disabled}
      onClick={disabled ? undefined : onClick}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '3px 10px', borderRadius: 999, fontSize: 12, fontWeight: 500, lineHeight: 1.4, whiteSpace: 'nowrap',
        border: add
          ? '1px dashed var(--border)'
          : `1px solid ${selected ? `color-mix(in srgb, ${hue} 50%, var(--border))` : 'var(--border)'}`,
        background: add ? 'transparent' : selected ? `color-mix(in srgb, ${hue} 14%, var(--surface2))` : 'var(--surface2)',
        color: add ? 'var(--muted)' : selected ? (tone === 'danger' ? 'var(--danger)' : 'var(--accent2)') : 'var(--text)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        transition: 'background 0.15s, border-color 0.15s, color 0.15s, transform 0.06s, filter 0.06s',
        ...style,
      }}
    >
      {children}
      {/* Read as "Label (3)": the drawn count is a separate badge, which a screen reader would run
          straight into the label. A block-level box is what puts the space between the two. */}
      {count != null ? <span style={{ ...VISUALLY_HIDDEN_STYLE, display: 'inline-block' }}>{`(${count})`}</span> : null}
      {count != null ? (
        <span aria-hidden="true" style={{
          fontSize: 10.5, fontWeight: 700, minWidth: 16, textAlign: 'center', padding: '0 5px', borderRadius: 99,
          background: countTone
            ? `color-mix(in srgb, ${countTone} 22%, var(--surface))`
            : selected ? 'color-mix(in srgb, var(--accent) 22%, var(--surface))' : 'var(--surface)',
          color: countTone || (selected ? 'var(--accent2)' : 'var(--muted)'),
        }}>
          {count}
        </span>
      ) : null}
    </button>
  )
}

// An action that reads as text: "Read more →", "+ New tag", a count that opens its rows. It takes the
// size of the text around it, so it sits in a sentence or a label row without changing its line.
// `tone="muted"` is for a secondary action beside a label rather than an invitation; `tone="danger"` is
// for one that clears or removes.
export function LinkButton({ children, onClick, tone, disabled, title, 'aria-label': ariaLabel, style, ...rest }) {
  const color = tone === 'muted' ? 'var(--muted)' : tone === 'danger' ? 'var(--danger)' : 'var(--accent2)'
  return (
    <button
      {...rest}
      className="ui-link-button"
      type="button"
      aria-label={ariaLabel}
      title={title}
      disabled={!!disabled}
      onClick={disabled ? undefined : onClick}
      style={{
        background: 'none', border: 'none', padding: 0, font: 'inherit',
        color,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        ...style,
      }}
    >
      {children}
    </button>
  )
}

export function Select({ value, onChange, options, style, id, ...rest }) {
  const autoId = useId()  // self-assigned id (caller's wins) clears the "field needs an id/name" check
  return (
    <select
      {...rest}
      id={id || autoId}
      value={value}
      onChange={e => onChange(e.target.value)}
      style={{
        ...getFormControlStyle({ size: 'lg', clickable: true }),
        ...style,
      }}
    >
      {options.map(o => (
        <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>
      ))}
    </select>
  )
}

// `forwardRef` because these fields cannot be reached any other way: a sensitive field renders with
// `suppressAutofillId`, deliberately carrying no id or name, so a caller wanting to move focus to the
// next one (Enter-to-advance in the vault dialogs) has no selector to query and needs the node itself.
//
// `size` is a `getFormControlStyle` size, not the HTML attribute.
export const Input = forwardRef(function Input(
  { value, onChange, placeholder, style, id, size = 'lg', suppressAutofillId = false, ...rest }, ref,
) {
  // `...rest` forwards a11y/form props (aria-label, name, type, …) the wrapper used to swallow —
  // a placeholder alone isn't an accessible name, so callers can give the field a real label.
  // A stable auto-`id` (caller-supplied wins) satisfies the browser's "field needs an id/name"
  // check for every Input without each call site having to invent one.
  //
  // `suppressAutofillId` renders the field with NO id/name at all — deliberately leaving it one of
  // the "form field element has neither an id nor a name attribute" fields the console warns about.
  // Sensitive fields (vault passphrase, provider secret) want this: `useId` values are reused across
  // views, and the browser keys its form-field history on that id, so a text search box that rendered
  // as the same `:rN:` leaks its saved suggestions onto the password field. No handle → no key → no
  // suggestions. The console warning is the intended trade and must not be "fixed" by giving it an id.
  const autoId = useId()
  return (
    <input
      {...rest}
      ref={ref}
      id={suppressAutofillId ? undefined : (id || autoId)}
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      style={{
        ...getFormControlStyle({ size }),
        ...style,
      }}
    />
  )
})

// Password field with an inline show/hide reveal — the field for every secret someone types or pastes,
// since a masked field with no reveal leaves no way to check what actually landed in it. It renders the
// shared `Input` by default, so it takes the same props (a `lib/sensitiveFields.js` set, a forwarded ref
// for Enter-to-advance) and matches the fields beside it. `as` swaps in another field component with the
// same string-valued `onChange` — the sign-in screen's `TransientTextInput`, which knows nothing of
// `suppressAutofillId`, so a set carrying that prop needs the default. `style` styles the field and
// `wrapperStyle` sizes it (e.g. a maxWidth so it doesn't stretch to the full card); the reveal button is
// non-tabbable so it never sits between the field and the submit button in tab order.
//
// There is deliberately no `autoComplete` default. Whether the field holds a new secret or an existing one
// is the caller's to say, and a default that guessed is how a field asking for an existing passphrase came
// to be offered a generated one.
//
// `onReveal` (optional, may be async) runs before the field is revealed, for a value the browser does
// not hold yet — the provider secret is stored write-only, so showing it means fetching it first. If it
// throws, the field stays hidden: a failed fetch (locked vault, no secret on file) must not flip the
// control to "revealed" over an empty box, which would read as "the stored secret is blank".
//
// `suggestion` or `onSuggest` offers a generated secret above the field, for a field that *chooses* one:
// it fills the field, shows it, and then calls `onSuggest(value)` where given, so a host with a confirm
// field can empty and focus it — typing the words back there is what shows they were taken down, so it is
// never filled for them. `suggestion` says what is suggested: a vault `passphrase` (the default), or a
// sign-in `password`, which is shorter (`lib/passphraseGenerator.js` says why). `suggestionFits` is the
// field's own rule (the vault floor); a draw that misses it is redrawn. The link sits above the field
// rather than below so it never lands between the field and its confirmation in tab order. `label`, where
// given, is drawn on the same line as the link, so a row of labelled fields keeps its labels level.
const SUGGESTIONS = {
  passphrase: { words: SUGGESTED_PASSPHRASE_WORDS, label: 'Suggest a passphrase' },
  password: { words: SUGGESTED_PASSWORD_WORDS, label: 'Suggest a password' },
}

export const PasswordInput = forwardRef(function PasswordInput(
  { as: Field = Input, style, wrapperStyle, disabled = false, onReveal, onSuggest, suggestionFits,
    suggestion, label, onChange, ...rest }, ref,
) {
  const [revealed, setRevealed] = useState(false)
  const [revealing, setRevealing] = useState(false)
  const [suggesting, setSuggesting] = useState(false)
  const offered = (suggestion || onSuggest) ? SUGGESTIONS[suggestion || 'passphrase'] : null

  async function suggest() {
    setSuggesting(true)
    try {
      const value = await suggestPassphrase({ count: offered.words, fits: suggestionFits })
      // Flushed so the host's `onSuggest` runs against what this value renders — a confirm field that only
      // appears once there is a passphrase exists by then, and can take focus.
      flushSync(() => {
        onChange(value)
        setRevealed(true)
      })
      onSuggest?.(value)
    } catch {
      // Nothing to show for it: the field is untouched, and choosing a passphrase by hand still works.
    } finally {
      setSuggesting(false)
    }
  }

  async function toggleReveal() {
    if (revealed) { setRevealed(false); return }
    if (onReveal) {
      setRevealing(true)
      try {
        await onReveal()
      } catch {
        return  // the host reports why; staying hidden keeps an empty field from reading as the value
      } finally {
        setRevealing(false)
      }
    }
    setRevealed(true)
  }

  // With a line above the field, the sizing goes on the column holding both, so the suggestion link sits
  // at the field's edge rather than the far side of a wide card.
  const field = (
    <div style={{ position: 'relative', ...(offered || label ? null : wrapperStyle) }}>
      <Field
        {...rest}
        ref={ref}
        onChange={onChange}
        type={revealed ? 'text' : 'password'}
        disabled={disabled}
        style={{ width: '100%', ...style, paddingRight: 58 }}
      />
      <button
        type="button"
        tabIndex={-1}
        disabled={disabled || revealing}
        onClick={toggleReveal}
        aria-label={revealed ? 'Hide characters' : 'Show characters'}
        style={{
          position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)',
          background: 'transparent', border: 'none', color: 'var(--muted)',
          fontSize: 12, fontWeight: 600, cursor: (disabled || revealing) ? 'default' : 'pointer', padding: '4px 6px',
        }}
      >
        {revealing ? '…' : revealed ? 'Hide' : 'Show'}
      </button>
    </div>
  )
  if (!offered && !label) return field
  return (
    <div style={{ display: 'grid', gap: 4, ...wrapperStyle }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
        {label || <span />}
        {offered ? (
          <LinkButton onClick={suggest} disabled={disabled || suggesting} style={{ fontSize: 10, whiteSpace: 'nowrap' }}>
            {offered.label}
          </LinkButton>
        ) : null}
      </div>
      {field}
    </div>
  )
})

// The search box for a page or panel: the shared `Input` with a × inside its right edge while it holds text,
// and Escape in the field clearing it. The × is drawn here rather than left to `type="search"` because the
// browser's own is absent in Firefox and cannot be themed; `.ui-search-input` (index.html) hides that one so
// there are never two. `type="search"` stays for what it tells assistive tech. Like PasswordInput's reveal,
// the × is non-tabbable — Escape is the keyboard path — and `style` styles the field while `wrapperStyle`
// sizes it.
//
// Escape is handled only while there is text to clear, and then goes no further: the pages and panels that
// hold these boxes close or deselect on a window-level Escape, and one key press must not do both. On an
// empty field it passes through untouched, so Escape still backs out of the surface as before.
export const SearchInput = forwardRef(function SearchInput(
  { value, onChange, onKeyDown, style, wrapperStyle, disabled = false, ...rest }, ref,
) {
  const fieldRef = useRef(null)
  useImperativeHandle(ref, () => fieldRef.current, [])
  const hasText = !!value

  function clear() {
    onChange('')
    fieldRef.current?.focus()
  }

  function handleKeyDown(event) {
    onKeyDown?.(event)
    if (event.defaultPrevented || event.key !== 'Escape' || !hasText) return
    event.preventDefault()
    event.stopPropagation()
    onChange('')
  }

  return (
    <div style={{ position: 'relative', ...wrapperStyle }}>
      <Input
        {...rest}
        ref={fieldRef}
        type="search"
        className="ui-search-input"
        value={value}
        onChange={onChange}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        style={{ width: '100%', ...style, paddingRight: 30 }}
      />
      {hasText && !disabled ? (
        <button
          type="button"
          tabIndex={-1}
          aria-label="Clear search"
          title="Clear search"
          // Keeps focus in the field, so a click reads as editing the search rather than leaving it.
          onMouseDown={event => event.preventDefault()}
          onClick={clear}
          style={{
            position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: 20, height: 20, padding: 0, borderRadius: 999,
            background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer',
          }}
        >
          <svg aria-hidden="true" width="10" height="10" viewBox="0 0 10 10" fill="none"
            stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" />
          </svg>
        </button>
      ) : null}
    </div>
  )
})

// The username a password manager files the secret fields after it under, for a surface with no username
// field of its own (`VAULT_PASSWORD_MANAGER_USERNAME` in `lib/sensitiveFields.js` says why the vault needs
// one). A hidden field annotated `username` is the documented way to supply it; whether a particular
// manager honours it can only be seen in that browser. Place it directly before the secret fields, so a
// visible text field further up — a recovery code — is not the one taken as the username instead.
export function PasswordManagerUsername({ value }) {
  return (
    <input type="text" autoComplete="username" value={value} readOnly tabIndex={-1} aria-hidden="true"
      style={{ display: 'none' }} />
  )
}

// What is still wrong with a field, shown under it while the user types — the note a greyed submit button
// points back to. Renders nothing when there is nothing to say, so a caller passes its issue string
// unconditionally rather than wrapping every use in a condition. `role="status"` so a screen reader hears
// the reason change as it is typed, which is the only way someone who cannot see the greyed button
// learns why it will not submit.
export function FieldIssue({ children, style }) {
  if (!children) return null
  return (
    <div role="status" style={{ fontSize: 12, color: 'var(--danger)', lineHeight: 1.4, ...style }}>
      {children}
    </div>
  )
}

// `className` lets a button that wraps the badge mark it `ui-pill-face`, so the badge takes the button's hover.
export function Badge({ label, toneKey, markerKind = 'category', className }) {
  const theme = getCategoryBadgeTheme(toneKey || label || 'badge')
  return (
    <span className={className} style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      background: theme.bg,
      color: theme.text,
      border: `1px solid ${theme.border}`,
      borderRadius: 99, padding: '2px 8px', fontSize: 12, fontWeight: 500,
      whiteSpace: 'nowrap',
    }}>
      <CategoryMarker kind={markerKind} />
      {label}
    </span>
  )
}

// Content that is on screen but no longer current, because a reload is in flight.
//
// The alternative for a panel that reloads — swap it for a spinner — moves everything below it twice and
// is the app's most disruptive jitter, which is why the standing rule is to keep the previous content and
// show the spinner only when there is nothing to keep (`ui-patterns.md`). That rule has one exception:
// figures that answer a question the user has just *changed*. Holding last month's totals silently under a
// newly-picked date filter is worse than a flicker, because the numbers are wrong rather than merely old.
//
// So: keep them, and make it visible that they are not the answer yet. Dimmed, non-interactive (a click on
// a stale bar would drill into figures that are about to change), and `aria-busy` for anyone not seeing
// the dimming. The dimming gates on `useBusyIndicator`, so a reload quick enough to be imperceptible does
// not dim at all — otherwise this would reintroduce the flicker it exists to replace, in a subtler form.
// Clicks follow `refreshing` instead: the indicator's minimum display outlasts the reload, and a chart
// whose new figures are already drawn must not ignore a click (`transient-failures.md` entry 3).
export function StaleWhileRefreshing({ refreshing, children, style }) {
  const stale = useBusyIndicator(refreshing)
  return (
    <div
      aria-busy={stale || undefined}
      style={{
        opacity: stale ? 0.45 : 1,
        // Fading in both directions: an instant jump between opacities is its own flicker, and the fade
        // out doubles as the "it's current now" signal.
        transition: 'opacity 160ms ease',
        pointerEvents: refreshing ? 'none' : undefined,
        ...style,
      }}
    >
      {children}
    </div>
  )
}

// The ring's style lives in index.html beside the refresh icon's, whose keyframes it shares.
export function Spinner({ label = 'Loading…' }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
      padding: 40, color: 'var(--muted)', fontSize: 14,
    }}>
      <span className="ui-spinner-ring" aria-hidden="true" />
      {label}
    </div>
  )
}

// A view's load that failed, retry included (`useViewLoad`). In place of the content when there is none to
// show; `inline` above content kept from an earlier load, which is then no longer current.
export function LoadFailed({ what, onRetry, inline = false }) {
  return (
    <div role="alert" style={{
      display: 'flex', alignItems: 'center', justifyContent: inline ? 'flex-start' : 'center', gap: 10,
      padding: inline ? '0 0 12px' : 40, color: 'var(--muted)', fontSize: 14,
    }}>
      <span>Couldn&apos;t load {what}.</span>
      <Button variant="secondary" size="compact" onClick={onRetry}>Retry</Button>
    </div>
  )
}

export function EmptyState({ message }) {
  return (
    <div style={{
      textAlign: 'center', padding: '48px 24px',
      color: 'var(--muted)', fontSize: 14,
    }}>
      {message}
    </div>
  )
}

// A quiet, inline note for warning that the active filter conflicts with what a surface is showing —
// e.g. an exclude chip removing a slice the Dashboard report breaks down, or an empty ledger with
// matches outside the date range. Informational only (the filter still applies); muted and accent-tinted so
// it reads as an aside, not an error. `children` is the message; an optional action renders as a link.
export function FilterConflictNote({ children, actionLabel, onAction, style }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap',
      fontSize: 12.5, lineHeight: 1.45,
      color: 'var(--text)',
      background: 'color-mix(in srgb, var(--accent2) 8%, var(--surface))',
      border: '1px solid color-mix(in srgb, var(--accent2) 28%, var(--border))',
      borderRadius: 8,
      padding: '8px 12px',
      ...style,
    }}>
      <span aria-hidden="true" style={{ color: 'var(--accent2)' }}>ⓘ</span>
      <span style={{ flex: 1, minWidth: 0 }}>{children}</span>
      {actionLabel && onAction && (
        <LinkButton onClick={onAction} style={{ fontSize: 12.5, whiteSpace: 'nowrap', fontWeight: 500 }}>
          {actionLabel}
        </LinkButton>
      )}
    </div>
  )
}

export function GroupedSelect({ value, onChange, groups, extra = [], style, id, ...rest }) {
  const autoId = useId()  // self-assigned id (caller's wins) clears the "field needs an id/name" check
  return (
    <select
      {...rest}
      id={id || autoId}
      value={value}
      onChange={e => onChange(e.target.value)}
      style={{
        ...getFormControlStyle({ size: 'lg', clickable: true }),
        ...style,
      }}
    >
      {groups.map(g => (
        <optgroup key={g.value || g.label} label={g.label}>
          {(g.options || []).map(o => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </optgroup>
      ))}
      {extra.map(o => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  )
}

// Header select-all checkbox for bulk-select tables: checked when the whole set is selected,
// indeterminate during a partial selection. Shared so every bulk-capable table renders the same control.
export function SelectAllCheckbox({ checked, indeterminate, onChange, title }) {
  const ref = useRef(null)
  useEffect(() => { if (ref.current) ref.current.indeterminate = indeterminate }, [indeterminate])
  return (
    <Tooltip content={title}>
      <input
        ref={ref}
        type="checkbox"
        checked={checked}
        onChange={onChange}
        // A controlled checkbox needs a handler *or* `readOnly`, else React warns. When a caller renders
        // this without an `onChange` (a read-only/display table), mark it read-only rather than warning.
        readOnly={!onChange}
        // The checkbox has no visible label, so the hint is also its name.
        aria-label={title}
        style={{ cursor: 'pointer', margin: 0 }}
      />
    </Tooltip>
  )
}

/*
 * Shared segmented control: a row of mutually exclusive options in one enclosed track, for choosing
 * which *view* of a surface is on screen. The Dashboard uses it twice in its header (the reporting
 * frame and the analysis mode) and the Recurring page once (series / findings / forward view).
 *
 * Prefer this over an in-page tab row when the options are peer views of one subject rather than
 * several separate management surfaces — see `ui-patterns.md` → Page layout for that distinction.
 *
 * An option may carry a `badge` (a count, usually), with `badgeTone: 'warning'` where the number is
 * the reason to look. The badge belongs on the control rather than the view it names: a count that is
 * only visible once you have switched cannot tell you to switch. An option's `title` is its hover hint.
 *
 * `size="compact"` is for a choice that adjusts a list rather than switching the view (a sort order, a
 * scope inside a form): smaller, with the chosen option tinted rather than filled, so it stays quieter
 * than the content it orders.
 */
export function SegmentedToggle({ value, options, onChange, ariaLabel, size = 'regular', disabled = false }) {
  const compact = size === 'compact'
  return (
    <div role="group" aria-label={ariaLabel} style={{
      display: compact ? 'inline-flex' : 'flex', background: 'var(--surface2)',
      borderRadius: compact ? 6 : 8, border: '1px solid var(--border)', overflow: 'hidden',
      opacity: disabled ? 0.5 : 1,
    }}>
      {options.map((opt, index) => {
        const on = value === opt.value
        const warn = opt.badgeTone === 'warning'
        return (
          <button key={opt.value} type="button" onClick={() => onChange(opt.value)} aria-pressed={on} title={opt.title}
            disabled={disabled} style={{
              display: 'inline-flex', alignItems: 'center', gap: compact ? 5 : 7,
              padding: compact ? '3px 10px' : '7px 14px', border: 'none', fontSize: compact ? 12 : 13,
              borderLeft: compact && index > 0 ? '1px solid var(--border)' : 'none',
              cursor: disabled ? 'not-allowed' : 'pointer',
              background: on ? (compact ? 'color-mix(in srgb, var(--accent) 16%, var(--surface2))' : 'var(--accent)') : 'transparent',
              color: on ? (compact ? 'var(--accent2)' : '#fff') : 'var(--muted)',
              fontWeight: on && compact ? 600 : 400,
            }}>
            {opt.label}
            {opt.badge != null && opt.badge !== '' ? (
              <span style={{
                fontSize: 11, fontWeight: 700, minWidth: 16, textAlign: 'center',
                padding: '0 5px', borderRadius: 99, lineHeight: '16px',
                background: on
                  ? 'rgba(255, 255, 255, 0.24)'
                  : warn ? 'color-mix(in srgb, var(--warning) 20%, var(--surface))' : 'var(--surface)',
                color: on ? '#fff' : warn ? 'var(--warning)' : 'var(--muted)',
              }}>
                {opt.badge}
              </span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}

// Shared on/off switch for boolean settings. A pill track with a sliding knob (flex alignment
// positions the knob, so there is no manual offset math), rendered as an accessible role="switch"
// button with an optional trailing label. Prefer this over a bare checkbox for settings toggles so
// the look stays consistent across the app. `ariaLabel` names a switch whose label is rendered
// elsewhere in its row rather than beside it.
// `size="compact"` draws a smaller track, for a switch set inside a compact control.
export function Toggle({ checked, onChange, label, ariaLabel, disabled = false, style, size = 'regular' }) {
  const compact = size === 'compact'
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => { if (!disabled) onChange(!checked) }}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 8,
        background: 'none', border: 'none', padding: 0,
        cursor: disabled ? 'not-allowed' : 'pointer',
        color: 'var(--text)', fontSize: 13, lineHeight: 1.4,
        opacity: disabled ? 0.6 : 1,
        textAlign: 'left',
        ...style,
      }}
    >
      <span style={{
        flex: '0 0 auto',
        display: 'inline-flex', alignItems: 'center',
        justifyContent: checked ? 'flex-end' : 'flex-start',
        width: compact ? 26 : 34, height: compact ? 15 : 20, padding: 2, boxSizing: 'border-box',
        borderRadius: 999,
        background: checked ? 'var(--accent)' : 'var(--surface2)',
        border: '1px solid color-mix(in srgb, var(--accent) 20%, var(--border))',
        transition: 'background 120ms ease',
      }}>
        <span style={{
          width: compact ? 9 : 14, height: compact ? 9 : 14, borderRadius: '50%',
          background: '#fff',
          boxShadow: '0 1px 2px rgba(15, 23, 42, 0.35)',
        }} />
      </span>
      {label ? <span>{label}</span> : null}
    </button>
  )
}

// Shared inline match highlighter for search surfaces (the category tree, pickers, the ledger's
// match hovers): wraps
// case-insensitive occurrences of `query` inside `text` so matches stand out. With no query it yields
// the plain string, leaving non-search rendering untouched.
export function HighlightedText({ text, query }) {
  const value = String(text ?? '')
  const needle = String(query ?? '').trim()
  if (!needle) return value
  const lowerValue = value.toLowerCase()
  const lowerNeedle = needle.toLowerCase()
  const parts = []
  let from = 0
  let key = 0
  for (;;) {
    const idx = lowerValue.indexOf(lowerNeedle, from)
    if (idx === -1) {
      if (from < value.length) parts.push(value.slice(from))
      break
    }
    if (idx > from) parts.push(value.slice(from, idx))
    parts.push(<MatchMark key={`hl${key++}`}>{value.slice(idx, idx + needle.length)}</MatchMark>)
    from = idx + needle.length
  }
  return <>{parts}</>
}

// A passage the server already marked up, as `{ text, hit }` segments — for matches the client cannot
// find itself, such as a document search, which matches whole words through the full-text index.
export function MatchExcerpt({ segments }) {
  return (segments || []).map((segment, i) => (
    segment.hit ? <MatchMark key={i}>{segment.text}</MatchMark> : <span key={i}>{segment.text}</span>
  ))
}

function MatchMark({ children }) {
  return (
    <mark style={{ background: 'color-mix(in srgb, var(--accent) 30%, transparent)', color: 'inherit', borderRadius: 3, padding: '0 1px' }}>
      {children}
    </mark>
  )
}
