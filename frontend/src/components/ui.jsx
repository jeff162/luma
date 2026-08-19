// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/* eslint-disable react-refresh/only-export-components -- shared UI kit: primitive components live alongside style helpers used to compose them */

import { forwardRef, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { getCategoryBadgeTheme } from '../lib/categoryAppearance.js'
import { useBusyIndicator } from '../lib/useBusyIndicator.js'

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

export function Tooltip({ children, content, maxWidth = 280, align = 'left', tone = 'neutral', interactive = false, bare = false, triggerStyle = null, openDelay = 0 }) {
  const triggerRef = useRef(null)
  const tipRef = useRef(null)
  const [open, setOpen] = useState(false)
  // Distinct from `open`: the hover has landed and the dwell timer is running, but nothing is shown yet.
  // Tracked in state rather than a ref so the scroll effect below can observe it and arm itself.
  const [pending, setPending] = useState(false)
  const [pos, setPos] = useState(null)
  const closeTimer = useRef(null)
  const openTimer = useRef(null)
  useEffect(() => () => { clearTimeout(closeTimer.current); clearTimeout(openTimer.current) }, [])

  // An open tooltip is positioned once, in fixed coordinates, against where its trigger was at the time.
  // Scrolling moves the trigger but not the tooltip, so it would hang detached in mid-air until the
  // pointer left. Close on any scroll instead, and cancel a pending open so a scroll that starts during
  // the dwell never resolves into a hint. Capture phase because the scroll almost always happens in an
  // ancestor container and scroll events don't bubble. Only listens while this tooltip is showing or
  // armed, so the many idle tooltips in a list cost nothing.
  useEffect(() => {
    if (!open && !pending) return undefined
    function onScroll() {
      clearTimeout(openTimer.current)
      clearTimeout(closeTimer.current)
      setPending(false)
      setOpen(false)
    }
    window.addEventListener('scroll', onScroll, true)
    return () => window.removeEventListener('scroll', onScroll, true)
  }, [open, pending])
  // Position only once the tooltip is mounted, so its real measured size is known. A portaled DOM
  // tooltip can't paint past the window the way a native `title` can, so the best it can do is stay
  // fully inside the viewport: clamp horizontally to keep it on-screen, and flip above the trigger
  // when placing it below would run off the bottom edge.
  useLayoutEffect(() => {
    if (!open) { setPos(null); return }
    const trigger = triggerRef.current?.getBoundingClientRect()
    const tip = tipRef.current?.getBoundingClientRect()
    if (!trigger || !tip) return
    const margin = 8
    const vw = document.documentElement.clientWidth
    const vh = document.documentElement.clientHeight
    let left = align === 'right' ? trigger.right - tip.width : trigger.left
    left = Math.min(Math.max(margin, left), Math.max(margin, vw - margin - tip.width))
    let top = trigger.bottom + 6
    if (top + tip.height > vh - margin) {
      const above = trigger.top - 6 - tip.height
      top = above >= margin ? above : Math.max(margin, vh - margin - tip.height)
    }
    setPos({ top, left })
  }, [open, content, align])
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
    // max-content keeps the tooltip from inheriting a tiny trigger's width as its wrap budget.
    width: 'max-content',
    maxWidth,
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
              {title ? <div style={{ fontSize: 16, fontWeight: 600 }}>{title}</div> : null}
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
export function PageHeader({ title, children, leftAdornment, help, titleAdornment }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      marginBottom: 24,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {help}
          <h1 style={{ fontSize: 22, fontWeight: 600 }}>{title}</h1>
          {titleAdornment}
        </div>
        {leftAdornment}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>{children}</div>
    </div>
  )
}

export function Button({ children, onClick, onMouseDown, variant = 'primary', small, disabled, style, title }) {
  const base = {
    padding: small ? '6px 12px' : '9px 16px',
    borderRadius: 8, border: 'none', cursor: disabled ? 'not-allowed' : 'pointer',
    fontSize: small ? 13 : 14, fontWeight: 500, transition: 'opacity 0.15s, background 0.15s, border-color 0.15s, box-shadow 0.15s',
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
      onClick={disabled ? undefined : onClick}
      onMouseDown={disabled ? undefined : onMouseDown}
      style={{ ...base, ...variants[variant] }}
      title={title}
    >
      {children}
    </button>
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

export function Input({ value, onChange, placeholder, style, id, suppressAutofillId = false, ...rest }) {
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
}

// Password field with an inline show/hide reveal. Controlled like `Input` (value/onChange as a string).
// `wrapperStyle` sizes the field (e.g. a maxWidth so it doesn't stretch to the full card); the reveal
// button is non-tabbable so it never sits between the field and the submit button in tab order.
//
// `onReveal` (optional, may be async) runs before the field is revealed, for a value the browser does
// not hold yet — the provider secret is stored write-only, so showing it means fetching it first. If it
// throws, the field stays hidden: a failed fetch (locked vault, no secret on file) must not flip the
// control to "revealed" over an empty box, which would read as "the stored secret is blank".
export function PasswordInput({
  value,
  onChange,
  placeholder,
  disabled = false,
  autoComplete = 'new-password',
  id,
  suppressAutofillId = false,
  wrapperStyle,
  onReveal,
  ...rest
}) {
  // `suppressAutofillId`: render with no id/name so the browser has no handle to key form-field
  // history on — see the Input component for the full rationale (reused `useId` leaks suggestions).
  const autoId = useId()
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
      <input
        {...rest}
        id={suppressAutofillId ? undefined : (id || autoId)}
        type={revealed ? 'text' : 'password'}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete={autoComplete}
        style={{ ...getFormControlStyle({ size: 'md', surface: 'base' }), width: '100%', paddingRight: 58 }}
      />
      <button
        type="button"
        tabIndex={-1}
        disabled={disabled || revealing}
        onClick={toggleReveal}
        aria-label={revealed ? 'Hide password' : 'Show password'}
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

// Shared on/off switch for boolean settings. A pill track with a sliding knob (flex alignment
// positions the knob, so there is no manual offset math), rendered as an accessible role="switch"
// button with an optional trailing label. Prefer this over a bare checkbox for settings toggles so
// the look stays consistent across the app.
export function Toggle({ checked, onChange, label, disabled = false, style }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
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
