// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// Column resizing moves one divider and nothing else: the column on its left grows by exactly what the
// column on its right gives up, so the columns further along stay where they are and stay in view. A
// fluid (string-width) column takes up the change on its side by itself.
//
// The last column's two dividers change the table's width instead. The one after it has no neighbour;
// without it a table could never grow into free space or recover from a layout that is too narrow. The
// one before it slides the last column along whole, because that column is usually right-aligned
// numbers, which a trade would leave standing still while only the gap before them changed.
//
// A side can move when it is a resizable pixel column or a fluid one. A fixed column (a drag handle, a
// checkbox, an actions spacer) cannot, so a divider beside one has no grip.

export const MAX_COLUMN_WIDTH = 640
const FALLBACK_MIN_COLUMN_WIDTH = 44

function isFluid(column) {
  return typeof column?.width === 'string'
}

function canMove(column) {
  if (!column || column.kind === 'spacer') return false
  return isFluid(column) || (typeof column.width === 'number' && column.resizable !== false)
}

function minWidthOf(column) {
  return Number(column.minWidth || FALLBACK_MIN_COLUMN_WIDTH)
}

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value))
}

// Whether the divider on the right edge of columns[index] has a grip.
export function dividerIsDraggable(columns, index) {
  const left = columns[index]
  const right = columns[index + 1]
  if (!canMove(left)) return false
  if (!right) return !isFluid(left)
  return canMove(right) && !(isFluid(left) && isFluid(right))
}

// The columns after dragging the divider on `leftKey`'s right edge by `delta` pixels.
export function moveDivider(columns, leftKey, delta) {
  const next = columns.map(column => ({ ...column }))
  const index = next.findIndex(column => column.key === leftKey)
  if (index === -1 || !dividerIsDraggable(next, index)) return next
  const left = next[index]
  const right = next[index + 1]

  if (!right || (index + 1 === next.length - 1 && !isFluid(left) && !isFluid(right))) {
    left.width = clamp(left.width + delta, minWidthOf(left), MAX_COLUMN_WIDTH)
  } else if (isFluid(left)) {
    right.width = clamp(right.width - delta, minWidthOf(right), MAX_COLUMN_WIDTH)
  } else if (isFluid(right)) {
    left.width = clamp(left.width + delta, minWidthOf(left), MAX_COLUMN_WIDTH)
  } else {
    // Both bounds hold at once, so the pair's total never changes.
    const low = Math.max(minWidthOf(left) - left.width, right.width - MAX_COLUMN_WIDTH)
    const high = Math.min(MAX_COLUMN_WIDTH - left.width, right.width - minWidthOf(right))
    const applied = low > high ? 0 : clamp(delta, low, high)
    left.width += applied
    right.width -= applied
  }
  return next
}
