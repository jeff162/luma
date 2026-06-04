// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

// Small presentational building blocks local to the Import / Export page: the
// section heading, the rounded data-source/account selector pill (with its
// recommended/secondary emphasis treatments and "possible match" badge), the
// superscript filter pill, the imported-category usage sentence that hosts it,
// and the count badge used on import action chips. These are page-local product
// chrome, not shared primitives — they encode this page's specific copy and
// emphasis vocabulary.

import {
  IMPORTED_CATEGORY_FILTER_PILL_LABEL,
  IMPORTED_CATEGORY_USAGE_SENTENCE,
} from '../../lib/importExport/constants.js'

export function SectionTitle({ children }) {
  return <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 6, marginTop: 28 }}>{children}</div>
}

export function DataSourcePill({
  label,
  selected,
  onClick,
  muted,
  subtle,
  title,
  showMarker = true,
  likelyMatch = false,
  emphasis = 'normal',
}) {
  const highlighted = emphasis !== 'normal'
  const recommended = emphasis === 'recommended'
  const secondary = emphasis === 'secondary'
  const borderColor = selected
    ? 'color-mix(in srgb, var(--accent) 42%, var(--border))'
    : highlighted
      ? (recommended
        ? 'color-mix(in srgb, var(--accent2) 72%, white 8%)'
        : secondary
          ? 'color-mix(in srgb, var(--accent) 68%, white 6%)'
          : 'color-mix(in srgb, var(--accent) 18%, var(--border))')
      : 'color-mix(in srgb, var(--border) 88%, transparent)'
  const background = selected
    ? 'color-mix(in srgb, var(--accent) 11%, var(--surface2))'
    : highlighted
      ? (recommended
        ? 'linear-gradient(180deg, color-mix(in srgb, var(--accent) 40%, var(--surface2)), color-mix(in srgb, var(--accent) 28%, var(--surface2)))'
        : secondary
          ? 'linear-gradient(180deg, color-mix(in srgb, var(--accent) 34%, var(--surface2)), color-mix(in srgb, var(--accent) 22%, var(--surface2)))'
          : 'color-mix(in srgb, var(--accent) 6%, var(--surface2))')
      : (subtle ? 'transparent' : 'var(--surface2)')
  const color = selected
    ? 'var(--accent2)'
    : highlighted
      ? 'color-mix(in srgb, var(--text) 94%, white 6%)'
      : (muted ? 'var(--muted)' : 'var(--text)')
  const boxShadow = selected
    ? '0 0 0 1px color-mix(in srgb, var(--accent) 12%, transparent)'
    : highlighted
      ? (recommended
        ? '0 1px 0 rgba(255,255,255,0.08), inset 0 1px 0 rgba(255,255,255,0.08), 0 16px 34px rgba(15, 23, 42, 0.28)'
        : secondary
          ? '0 1px 0 rgba(255,255,255,0.07), inset 0 1px 0 rgba(255,255,255,0.06), 0 14px 30px rgba(15, 23, 42, 0.24)'
          : '0 1px 0 rgba(255,255,255,0.03), 0 5px 16px rgba(15, 23, 42, 0.09)')
      : 'none'
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        minHeight: 36,
        padding: '7px 14px',
        borderRadius: 999,
        border: `1px solid ${borderColor}`,
        background,
        color,
        cursor: 'pointer',
        fontSize: 13,
        fontWeight: selected || highlighted ? 600 : 500,
        boxShadow,
        transition: 'background 0.15s ease, border-color 0.15s ease, color 0.15s ease, box-shadow 0.15s ease',
      }}
    >
      {showMarker ? (
        <span
          aria-hidden="true"
          style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: selected ? 'currentColor' : 'color-mix(in srgb, currentColor 58%, transparent)',
            opacity: selected ? 0.9 : 0.42,
            flexShrink: 0,
          }}
        />
      ) : null}
      {label}
      {likelyMatch ? (
        <span
          style={{
            fontSize: 10,
            fontWeight: 600,
            color: 'var(--success)',
            background: 'color-mix(in srgb, var(--success) 14%, transparent)',
            borderRadius: 999,
            padding: '1px 5px',
            marginLeft: 2,
            flexShrink: 0,
          }}
        >
          possible match
        </span>
      ) : null}
    </button>
  )
}

export function InlineFilterPill({ onClick, disabled = false, title = '' }) {
  return (
    <button
      type="button"
      onClick={event => {
        event.preventDefault()
        event.stopPropagation()
        if (!disabled) onClick?.()
      }}
      disabled={disabled}
      title={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '0 6px',
        borderRadius: 999,
        border: `1px solid ${disabled
          ? 'color-mix(in srgb, var(--border) 82%, transparent)'
          : 'color-mix(in srgb, var(--accent) 28%, var(--border))'}`,
        background: disabled
          ? 'color-mix(in srgb, var(--surface2) 72%, var(--surface))'
          : 'color-mix(in srgb, var(--accent) 10%, var(--surface2))',
        color: disabled ? 'var(--muted)' : 'var(--accent2)',
        fontSize: '0.88em',
        fontWeight: 600,
        lineHeight: '1.15',
        cursor: disabled ? 'not-allowed' : 'pointer',
        whiteSpace: 'nowrap',
        verticalAlign: 'super',
        position: 'relative',
        top: '-0.1em',
      }}
    >
      {IMPORTED_CATEGORY_FILTER_PILL_LABEL}
    </button>
  )
}

export function ImportedCategoryUsageInline({ showFilter = false, filterDisabled = false, filterTitle = '', onFilterClick = null }) {
  return (
    <span>
      <span>{IMPORTED_CATEGORY_USAGE_SENTENCE}</span>
      {showFilter ? (
        <>
          {' '}
          <InlineFilterPill
            onClick={onFilterClick}
            disabled={filterDisabled}
            title={filterTitle}
          />
        </>
      ) : null}
    </span>
  )
}

export function ActionCountBadge({ count, tone = 'accent' }) {
  if (!count) return null
  const palette = tone === 'warning'
    ? {
      background: 'color-mix(in srgb, #f59e0b 18%, var(--surface))',
      border: '1px solid color-mix(in srgb, #f59e0b 42%, var(--border))',
      color: '#f59e0b',
    }
    : {
      background: 'color-mix(in srgb, var(--accent) 14%, var(--surface))',
      border: '1px solid color-mix(in srgb, var(--accent2) 24%, var(--border))',
      color: 'var(--accent2)',
    }
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      minWidth: 20,
      minHeight: 20,
      padding: '0 6px',
      borderRadius: 999,
      fontSize: 11,
      fontWeight: 700,
      lineHeight: 1,
      ...palette,
    }}>
      {count}
    </span>
  )
}
