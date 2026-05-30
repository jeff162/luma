// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

/* eslint-disable react-refresh/only-export-components -- shared tag UI: TAG_COLOR_PALETTE + tag-rendering components live together so callers get one import */

/*
 * Tags are lightweight cross-cutting markers, so this file keeps their shared visual language stable across
 * settings, rules, filters, and transaction rows. The shape stays fixed; only the user-selected color varies.
 */

export const TAG_COLOR_PALETTE = [
  '#ef4444',
  '#f97316',
  '#f59e0b',
  '#eab308',
  '#84cc16',
  '#22c55e',
  '#10b981',
  '#14b8a6',
  '#06b6d4',
  '#0ea5e9',
  '#3b82f6',
  '#6366f1',
  '#8b5cf6',
  '#a855f7',
  '#d946ef',
  '#ec4899',
  '#f43f5e',
  '#64748b',
]

export function TagGlyph({
  color = 'var(--muted)',
  size = 13,
  outline = false,
  style = null,
}) {
  const fill = outline ? 'none' : color
  const stroke = outline ? color : 'color-mix(in srgb, #0f172a 22%, transparent)'
  const holeFill = outline ? color : 'rgba(255,255,255,0.92)'

  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size,
        height: size,
        flexShrink: 0,
        ...style,
      }}
    >
      <svg viewBox="0 0 16 16" width={size} height={size} fill="none">
        <path
          d="M3.1 2.5h5.2l5.2 5.2v4.1l-5.7 1.7-6-6V4.1A1.6 1.6 0 0 1 3.1 2.5Z"
          fill={fill}
          stroke={stroke}
          strokeWidth="1.15"
          strokeLinejoin="round"
        />
        <circle cx="7.1" cy="5.3" r="1.15" fill={holeFill} />
      </svg>
    </span>
  )
}

export function TagBadge({ tag, muted = false }) {
  return (
    <span
      title={tag.name}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 9px',
        borderRadius: 999,
        border: `1px solid ${muted ? 'var(--border)' : `color-mix(in srgb, ${tag.color} 32%, var(--border))`}`,
        background: muted
          ? 'var(--surface2)'
          : `color-mix(in srgb, ${tag.color} 12%, var(--surface))`,
        color: muted ? 'var(--muted)' : 'var(--text)',
        fontSize: 12,
        lineHeight: 1,
        minHeight: 24,
      }}
    >
      <TagGlyph color={tag.color} size={12} />
      <span>{tag.name}</span>
    </span>
  )
}

