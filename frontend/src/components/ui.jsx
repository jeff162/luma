// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/* eslint-disable react-refresh/only-export-components -- shared UI kit: primitive components live alongside style helpers used to compose them */

import { forwardRef, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { getCategoryBadgeTheme } from '../lib/categoryAppearance.js'

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
 */
export function Tooltip({ children, content, maxWidth = 280, align = 'left', tone = 'neutral', interactive = false, bare = false, triggerStyle = null }) {
  const triggerRef = useRef(null)
  const tipRef = useRef(null)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState(null)
  const closeTimer = useRef(null)
  useEffect(() => () => clearTimeout(closeTimer.current), [])
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
    setOpen(true)
  }
  function hide() {
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

export function FormLabel({ children, style }) {
  return (
    <label
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
      <FloatingPanel
        ref={panelRef}
        onClick={event => event.stopPropagation()}
        style={{
          width,
          border: `1px solid ${borderColor}`,
          ...(draggable ? { pointerEvents: 'auto', transform: `translate(${drag.x}px, ${drag.y}px)` } : null),
          ...panelStyle,
        }}
      >
        {(title || description) ? (
          <FloatingPanelHeader
            onMouseDown={draggable ? startDrag : undefined}
            style={{ padding: headerPadding, ...(draggable ? { cursor: 'move', userSelect: 'none' } : null) }}
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
          <div style={{ padding: bodyPadding, display: 'grid', gap: 12, ...bodyStyle }}>
            {children}
          </div>
        ) : null}
        {actions ? (
          <DialogActions align={footerAlign}>
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
export function PageHeader({ title, children, leftAdornment, help }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      marginBottom: 24,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {help}
          <h1 style={{ fontSize: 22, fontWeight: 600 }}>{title}</h1>
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

export function Input({ value, onChange, placeholder, style, id, ...rest }) {
  // `...rest` forwards a11y/form props (aria-label, name, type, …) the wrapper used to swallow —
  // a placeholder alone isn't an accessible name, so callers can give the field a real label.
  // A stable auto-`id` (caller-supplied wins) satisfies the browser's "field needs an id/name"
  // check for every Input without each call site having to invent one.
  const autoId = useId()
  return (
    <input
      {...rest}
      id={id || autoId}
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
