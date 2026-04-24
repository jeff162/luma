// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

import { forwardRef, useEffect, useRef } from 'react'
import { getCategoryBadgeTheme } from '../lib/categoryAppearance.js'

/*
 * These primitives define the app-wide visual language for everyday UI chrome: category markers and badges,
 * floating panels and overlays, shared form controls, and compact action rows. Feature components build on this
 * file so stacked windows, dialogs, and routine editing surfaces stay visually aligned instead of drifting apart.
 */

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
}) {
  return (
    <div
      onClick={onClick}
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
}) {
  return (
    <OverlayBackdrop
      zIndex={zIndex}
      tint={tint}
      onClick={dismissOnBackdrop ? onClose : undefined}
    >
      <FloatingPanel
        onClick={event => event.stopPropagation()}
        style={{
          width,
          border: `1px solid ${borderColor}`,
          ...panelStyle,
        }}
      >
        {(title || description) ? (
          <FloatingPanelHeader style={{ padding: headerPadding }}>
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

export function PageHeader({ title, children }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      marginBottom: 24,
    }}>
      <h1 style={{ fontSize: 22, fontWeight: 600 }}>{title}</h1>
      <div style={{ display: 'flex', gap: 8 }}>{children}</div>
    </div>
  )
}

export function Button({ children, onClick, variant = 'primary', small, disabled, style, title }) {
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
      style={{ ...base, ...variants[variant] }}
      title={title}
    >
      {children}
    </button>
  )
}

export function Select({ value, onChange, options, style }) {
  return (
    <select
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

export function Input({ value, onChange, placeholder, style }) {
  return (
    <input
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

export function GroupedSelect({ value, onChange, groups, extra = [], style }) {
  return (
    <select
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
