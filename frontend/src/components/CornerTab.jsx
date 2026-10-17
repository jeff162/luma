// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * A tab set into one corner of a card: it sits over the card's own border, its outer corner takes the
 * card's radius and the diagonally opposite corner is rounded the same, so it reads as cut out of the
 * card rather than placed on it. The host card is `position: relative` and leaves room for the tab in its
 * padding.
 *
 * `CornerTab` draws the muted tab: a button when given `onClick`, a label otherwise. A host that needs a
 * different control in the corner takes the geometry alone from `cornerTabStyle`.
 */

const RADIUS_BY_CORNER = {
  // CSS order: top-left, top-right, bottom-right, bottom-left.
  'top-left': r => `${r}px 0 ${r}px 0`,
  'top-right': r => `0 ${r}px 0 ${r}px`,
  'bottom-right': r => `${r}px 0 ${r}px 0`,
  'bottom-left': r => `0 ${r}px 0 ${r}px`,
}

export function cornerTabStyle({ corner, radius }) {
  const [vertical, horizontal] = corner.split('-')
  return {
    position: 'absolute',
    [vertical]: -1,
    [horizontal]: -1,
    borderRadius: RADIUS_BY_CORNER[corner](radius),
  }
}

const SIZES = {
  md: { minHeight: 26, padding: '4px 14px', fontSize: 12 },
  sm: { minHeight: 20, padding: '2px 10px', fontSize: 11 },
}

export default function CornerTab({
  corner, radius = 10, borderColor = 'var(--border)', size = 'md', onClick, title, children,
}) {
  const style = {
    ...cornerTabStyle({ corner, radius }),
    ...SIZES[size],
    boxSizing: 'border-box',
    background: 'var(--surface2)',
    border: `1px solid ${borderColor}`,
    color: 'var(--muted)',
    fontWeight: 500,
  }
  if (!onClick) return <span style={{ ...style, display: 'inline-flex', alignItems: 'center' }} title={title}>{children}</span>
  return (
    <button type="button" onClick={onClick} title={title} style={{ ...style, cursor: 'pointer' }}>
      {children}
    </button>
  )
}
