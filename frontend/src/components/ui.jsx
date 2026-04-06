// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

import { getCategoryBadgeTheme } from '../lib/categoryAppearance.js'

// Shared UI primitives

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
    fontSize: small ? 13 : 14, fontWeight: 500, transition: 'opacity 0.15s',
    opacity: disabled ? 0.5 : 1, ...style,
  }
  const variants = {
    primary:  { background: 'var(--accent)',  color: '#fff' },
    ghost:    { background: 'var(--surface2)', color: 'var(--text)' },
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
        background: 'var(--surface2)', color: 'var(--text)',
        border: '1px solid var(--border)', borderRadius: 8,
        padding: '8px 12px', fontSize: 14, cursor: 'pointer', ...style,
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
        background: 'var(--surface2)', color: 'var(--text)',
        border: '1px solid var(--border)', borderRadius: 8,
        padding: '8px 12px', fontSize: 14, outline: 'none', ...style,
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
  // groups: [{ label, color, options: [{ value, label }] }]
  // extra:  flat options appended after the groups (e.g. "+ New category...")
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      style={{
        background: 'var(--surface2)', color: 'var(--text)',
        border: '1px solid var(--border)', borderRadius: 8,
        padding: '8px 12px', fontSize: 14, cursor: 'pointer', ...style,
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
