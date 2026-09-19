// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/* eslint-disable react-refresh/only-export-components -- shared UI kit: primitive components live alongside style helpers used to compose them */

import { forwardRef, useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { getCategoryBadgeTheme } from '../lib/categoryAppearance.js'
import { useBusyIndicator } from '../lib/useBusyIndicator.js'
import { alignOnAxis, besideOnAxis } from '../lib/floatingPlacement.js'

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
  const used = Math.max(...lines.map(rect => rect.right)) - Math.min(...lines.map(rect => rect.left))
  // Rounded up with a pixel spare, so sub-pixel text never finds itself a hair too wide and re-wraps.
  const fitted = Math.ceil(used + inset) + 1
  return fitted < el.getBoundingClientRect().width - 1 ? fitted : null
}

export function Tooltip({ children, content, maxWidth = 280, align = 'left', tone = 'neutral', interactive = false, bare = false, triggerStyle = null, openDelay = 0 }) {
  const triggerRef = useRef(null)
  const tipRef = useRef(null)
  const [open, setOpen] = useState(false)
  // Distinct from `open`: the hover has landed and the dwell timer is running, but nothing is shown yet.
  // Tracked in state rather than a ref so the scroll effect below can observe it and arm itself.
  const [pending, setPending] = useState(false)
  const [pos, setPos] = useState(null)
  // `{ content, width }` — the fitted width, keyed to the content it was measured for so a hint whose
  // text changes while open is measured again rather than squeezed into the old one's width.
  const [fit, setFit] = useState(null)
  const closeTimer = useRef(null)
  const openTimer = useRef(null)
  useEffect(() => () => { clearTimeout(closeTimer.current); clearTimeout(openTimer.current) }, [])

  // An open tooltip is positioned once, in fixed coordinates, against where its trigger was at the time.
  // Scrolling moves the trigger but not the tooltip, so it would hang detached in mid-air until the
  // pointer left. Close on any scroll instead, and cancel a pending open so a scroll that starts during
  // the dwell never resolves into a hint. Capture phase because the scroll almost always happens in an
  // ancestor container and scroll events don't bubble. Only listens while this tooltip is showing or
  // armed, so the many idle tooltips in a list cost nothing.
  //
  // The same dismissal serves a right-click. A context menu opens at the pointer without the pointer
  // moving, so no `mouseleave` ever fires and the hint stays up — and since this tooltip sits at the top
  // of the app's stacking order (see `zIndex` below), it paints over the menu; an `interactive` hint also
  // keeps pointer events, so the menu items it covers stop being clickable. Capture phase and window-wide
  // because the menu may be opened from an ancestor of the trigger (transaction rows put the handler on
  // the row, not the cell) or from somewhere else on the page entirely.
  useEffect(() => {
    if (!open && !pending) return undefined
    function dismiss() {
      clearTimeout(openTimer.current)
      clearTimeout(closeTimer.current)
      setPending(false)
      setOpen(false)
    }
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('contextmenu', dismiss, true)
    return () => {
      window.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('contextmenu', dismiss, true)
    }
  }, [open, pending])
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
    const left = alignOnAxis({
      start: align === 'right' ? trigger.right - tip.width : trigger.left, size: tip.width, lo: 0, hi: vw,
    })
    const top = besideOnAxis({ before: trigger.top, after: trigger.bottom, size: tip.height, lo: 0, hi: vh })
    setPos({ top, left })
  }, [open, content, align, bare, fit])
  if (!content) return children
  function show() {
    clearTimeout(closeTimer.current)
    if (!openDelay) { setOpen(true); return }
    // Re-entering the same trigger while already open (e.g. crossing a child element) must not drop the
    // hint and re-serve the delay, so only an unopened tooltip arms the dwell timer.
    if (open) return
    setPending(true)
    openTimer.current = setTimeout(() => {
      setPending(false)
      setOpen(true)
    }, openDelay)
  }
  function hide() {
    clearTimeout(openTimer.current)
    setPending(false)
    if (interactive) closeTimer.current = setTimeout(() => setOpen(false), 140)
    else setOpen(false)
  }
  const borderColor = tone === 'warning'
    ? 'color-mix(in srgb, var(--danger) 55%, var(--border))'
    : 'color-mix(in srgb, var(--text) 24%, var(--border))'
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
    background: 'var(--surface)',
    border: `1px solid ${borderColor}`,
    borderRadius: 8,
    padding: '6px 10px',
    fontSize: 12,
    color: 'var(--text)',
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
    boxShadow: '0 8px 24px rgba(0,0,0,0.28)',
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
      {children}
      {open ? createPortal(
        <div
          ref={tipRef}
          role="tooltip"
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
      ? 'linear-gradient(180deg, color-mix(in srgb, var(--surface) 92%, white 2%), var(--surface))'
      : 'linear-gradient(180deg, color-mix(in srgb, var(--surface) 94%, black 3%), var(--surface))',
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
    ? 'linear-gradient(180deg, color-mix(in srgb, var(--surface2) 72%, var(--surface)), color-mix(in srgb, var(--surface) 82%, var(--accent) 8%))'
    : 'linear-gradient(180deg, color-mix(in srgb, var(--surface2) 62%, var(--surface)), color-mix(in srgb, var(--surface) 92%, black 4%))'
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
  return (
    <div
      onClick={onClick}
      // Marks an active modal layer so lower surfaces (e.g. detail panels' Escape-to-close)
      // can tell a dialog is open above them and let the dialog own the Escape instead.
      data-modal-overlay=""
      style={{
        position: 'fixed',
        inset: 0,
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

export function FloatingPanelHeader({ children, active = true, onMouseDown, style }) {
  return (
    <div
      onMouseDown={onMouseDown}
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
  // Opt-in: the header becomes a drag handle and the backdrop turns transparent + click-through, so the
  // dialog floats over live content the user can still see and interact with (e.g. drag the bulk-edit
  // form aside to read the transactions behind it). Position is session-only — re-centers on reopen.
  draggable = false,
  // A `RefreshButton`, attached to the title like a page's (see `PageHeader`).
  refresh = null,
}) {
  const [drag, setDrag] = useState({ x: 0, y: 0 })
  const panelRef = useRef(null)

  function startDrag(event) {
    if (!draggable || event.button !== 0) return
    event.preventDefault()
    const panel = panelRef.current
    const rect = panel?.getBoundingClientRect()
    const startX = event.clientX
    const startY = event.clientY
    const origin = drag
    // Clamp against the panel's untranslated base position so a margin always stays grabbable on-screen.
    const margin = 56
    const baseLeft = rect ? rect.left - origin.x : 0
    const baseTop = rect ? rect.top - origin.y : 0
    const minX = rect ? margin - rect.width - baseLeft : -Infinity
    const maxX = rect ? window.innerWidth - margin - baseLeft : Infinity
    const minY = rect ? -baseTop : -Infinity
    const maxY = rect ? window.innerHeight - margin - baseTop : Infinity
    const clamp = (value, lo, hi) => Math.min(Math.max(value, lo), hi)
    function onMove(moveEvent) {
      setDrag({
        x: clamp(origin.x + moveEvent.clientX - startX, minX, maxX),
        y: clamp(origin.y + moveEvent.clientY - startY, minY, maxY),
      })
    }
    function onUp() {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <OverlayBackdrop
      zIndex={zIndex}
      tint={draggable ? 'transparent' : tint}
      blur={draggable ? 0 : 2}
      pointerEvents={draggable ? 'none' : 'auto'}
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
        ref={panelRef}
        onClick={event => event.stopPropagation()}
        style={{
          width,
          border: `1px solid ${borderColor}`,
          maxHeight: 'calc(100vh - 48px)',
          display: 'flex',
          flexDirection: 'column',
          ...(draggable ? { pointerEvents: 'auto', transform: `translate(${drag.x}px, ${drag.y}px)` } : null),
          ...panelStyle,
        }}
      >
        {(title || description) ? (
          <FloatingPanelHeader
            onMouseDown={draggable ? startDrag : undefined}
            style={{ padding: headerPadding, flexShrink: 0, ...(draggable ? { cursor: 'move', userSelect: 'none' } : null) }}
          >
            <div>
              {title ? (
                <div style={{ fontSize: 16, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
                  {title}
                  {/* Kept out of the drag: a press on it must not also pick the dialog up. */}
                  {refresh ? <span onMouseDown={event => event.stopPropagation()} style={{ display: 'inline-flex' }}>{refresh}</span> : null}
                </div>
              ) : null}
              {description ? (
                <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4, lineHeight: 1.5 }}>
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
          <Button variant="ghost" onClick={onCancel} disabled={cancelDisabled}>
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
          <Button variant="ghost" onClick={onCancel}>
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
      marginBottom: 24,
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
export function Button({ children, onClick, onMouseDown, variant = 'primary', small, disabled, style, title,
  type = 'button', 'aria-label': ariaLabel, 'aria-busy': ariaBusy }) {
  const base = {
    padding: small ? '6px 12px' : '9px 16px',
    borderRadius: 8, border: 'none', cursor: disabled ? 'not-allowed' : 'pointer',
    fontSize: small ? 13 : 14, fontWeight: 500,
    // The press itself is quick, so it reads as the button going down under the pointer rather than easing.
    transition: 'opacity 0.15s, background 0.15s, border-color 0.15s, box-shadow 0.15s, transform 0.06s, filter 0.06s',
    opacity: disabled ? 0.5 : 1, ...style,
  }
  const variants = {
    primary:  { background: 'var(--accent)',  color: '#fff' },
    ghost:    {
      background: 'color-mix(in srgb, var(--surface2) 76%, var(--accent) 8%)',
      color: 'var(--text)',
      border: '1px solid color-mix(in srgb, var(--accent2) 24%, var(--border))',
      boxShadow: '0 1px 0 rgba(255,255,255,0.03), 0 8px 18px rgba(0,0,0,0.10)',
    },
    danger:   { background: 'var(--danger)',  color: '#fff' },
  }
  return (
    <button
      // Carries the pressed look (`index.html`), the one state an inline style cannot express. Without it
      // a click gave no sign of having landed unless the action happened to change the screen.
      className="ui-button"
      type={type}
      aria-label={ariaLabel}
      aria-busy={ariaBusy}
      // The DOM attribute, not just the dimmed look and the dropped handlers. Without it the control
      // stays focusable, still announces as enabled to a screen reader, and still submits a form it
      // sits in — so a button that looks unavailable is only unavailable to a mouse. The handlers stay
      // guarded as well: `disabled` blocks activation, but a caller can pass one through a wrapper.
      disabled={!!disabled}
      onClick={disabled ? undefined : onClick}
      onMouseDown={disabled ? undefined : onMouseDown}
      style={{ ...base, ...variants[variant] }}
      title={title}
    >
      {children}
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
export function RefreshButton({ onRefresh, loading = false, disabled = false, title = 'Refresh', onMouseDown }) {
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
      variant="ghost"
      small
      onClick={refresh}
      onMouseDown={onMouseDown}
      disabled={disabled}
      title={title}
      aria-label="Refresh"
      aria-busy={spinning || undefined}
      style={{ padding: '5px 7px', lineHeight: 0 }}
    >
      <svg
        className={spinning ? 'ui-refresh-icon is-spinning' : 'ui-refresh-icon'}
        aria-hidden="true"
        width="14"
        height="14"
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

// Compact action-button sizing — the tighter, flatter footprint for a run of repeated ghost actions
// that should read as a quiet toolbar rather than as the surface's main verb: dense report rows
// (duplicate detection, Amazon reconciliation) and the per-card maintenance actions on a connection.
// Pair with `variant="ghost"`; it overrides Button's default padding/font/radius through the caller
// `style` seam (the variant only owns colour/border/shadow, so size props here win).
export const COMPACT_ACTION_BTN_STYLE = { padding: '3px 8px', fontSize: 11.5, borderRadius: 6 }

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
export const Input = forwardRef(function Input(
  { value, onChange, placeholder, style, id, suppressAutofillId = false, ...rest }, ref,
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
        ...getFormControlStyle({ size: 'lg' }),
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
export const PasswordInput = forwardRef(function PasswordInput(
  { as: Field = Input, style, wrapperStyle, disabled = false, onReveal, ...rest }, ref,
) {
  const [revealed, setRevealed] = useState(false)
  const [revealing, setRevealing] = useState(false)

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

  return (
    <div style={{ position: 'relative', ...wrapperStyle }}>
      <Field
        {...rest}
        ref={ref}
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

export function Badge({ label, toneKey, markerKind = 'category' }) {
  const theme = getCategoryBadgeTheme(toneKey || label || 'badge')
  return (
    <span style={{
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
// the dimming. It gates on `useBusyIndicator`, so a reload quick enough to be imperceptible does not dim
// at all — otherwise this would reintroduce the flicker it exists to replace, in a subtler form.
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
        pointerEvents: stale ? 'none' : undefined,
        ...style,
      }}
    >
      {children}
    </div>
  )
}

export function Spinner() {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 40, color: 'var(--muted)', fontSize: 14,
    }}>
      Loading…
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
// e.g. an exclude chip removing a slice the Dashboard report breaks down, or a search whose matches
// the date filter is hiding. Informational only (the filter still applies); muted and accent-tinted so
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
        <button
          type="button"
          onClick={onAction}
          style={{
            background: 'none', border: 'none', padding: 0,
            color: 'var(--accent2)', cursor: 'pointer', fontSize: 12.5,
            whiteSpace: 'nowrap', fontWeight: 500,
          }}
        >
          {actionLabel}
        </button>
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
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      onChange={onChange}
      // A controlled checkbox needs a handler *or* `readOnly`, else React warns. When a caller renders
      // this without an `onChange` (a read-only/display table), mark it read-only rather than warning.
      readOnly={!onChange}
      title={title}
      style={{ cursor: 'pointer', margin: 0 }}
    />
  )
}

/*
 * Shared segmented control: a row of mutually exclusive options in one enclosed track, for choosing
 * which *view* of a surface is on screen. The Dashboard uses it twice in its header (the reporting
 * frame and the analysis mode) and the Recurring page once (series / findings / forward view).
 *
 * Prefer this over an in-page tab row when the options are peer views of one subject rather than
 * several separate management surfaces — see `ui-patterns.md` → Page structure for that distinction.
 *
 * An option may carry a `badge` (a count, usually), with `badgeTone: 'warning'` where the number is
 * the reason to look. The badge belongs on the control rather than the view it names: a count that is
 * only visible once you have switched cannot tell you to switch.
 */
export function SegmentedToggle({ value, options, onChange, ariaLabel }) {
  return (
    <div role="group" aria-label={ariaLabel} style={{
      display: 'flex', background: 'var(--surface2)',
      borderRadius: 8, border: '1px solid var(--border)', overflow: 'hidden',
    }}>
      {options.map(opt => {
        const on = value === opt.value
        const warn = opt.badgeTone === 'warning'
        return (
          <button key={opt.value} onClick={() => onChange(opt.value)} aria-pressed={on} style={{
            display: 'inline-flex', alignItems: 'center', gap: 7,
            padding: '7px 14px', border: 'none', fontSize: 13, cursor: 'pointer',
            background: on ? 'var(--accent)' : 'transparent',
            color: on ? '#fff' : 'var(--muted)',
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
export function Toggle({ checked, onChange, label, ariaLabel, disabled = false, style }) {
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
        width: 34, height: 20, padding: 2, boxSizing: 'border-box',
        borderRadius: 999,
        background: checked ? 'var(--accent)' : 'var(--surface2)',
        border: '1px solid color-mix(in srgb, var(--accent) 20%, var(--border))',
        transition: 'background 120ms ease',
      }}>
        <span style={{
          width: 14, height: 14, borderRadius: '50%',
          background: '#fff',
          boxShadow: '0 1px 2px rgba(15, 23, 42, 0.35)',
        }} />
      </span>
      {label ? <span>{label}</span> : null}
    </button>
  )
}

// Shared inline match highlighter for search surfaces (the category tree, pickers): wraps
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
    parts.push(
      <mark
        key={`hl${key++}`}
        style={{ background: 'color-mix(in srgb, var(--accent) 30%, transparent)', color: 'inherit', borderRadius: 3, padding: '0 1px' }}
      >
        {value.slice(idx, idx + needle.length)}
      </mark>,
    )
    from = idx + needle.length
  }
  return <>{parts}</>
}
