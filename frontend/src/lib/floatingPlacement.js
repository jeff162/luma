// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * Where a floating card goes along one axis, given what it is attached to and the space it must stay in.
 * A portaled DOM card cannot paint past its bounds the way a native `title` can, so the most it can do is
 * stay fully inside them. Shared by the app's hover tooltip (`Tooltip` in components/ui.jsx) and the
 * tooltip of the charts that pan (components/PanningChartTooltip.jsx), which is why it is stated once.
 *
 * Coordinates are one axis of screen space. `lo`/`hi` are the edges of the space the card must stay in and
 * `margin` is kept clear inside them; a card larger than that space pins to its start.
 */

function clampInto(position, size, lo, hi, margin) {
  return Math.max(lo + margin, Math.min(position, hi - margin - size))
}

// Aligned to a start position (a trigger's left edge, say) and slid back inside the bounds if it overhangs.
export function alignOnAxis({ start, size, lo, hi, margin = 8 }) {
  return clampInto(start, size, lo, hi, margin)
}

// Beside an anchor span [`before`, `after`] — a trigger's top and bottom, or a single point where the two
// are equal — on the `after` side (below / to the right) by preference, on the `before` side when that
// would overhang, and clamped inside the bounds when neither side fits.
//
// A side is taken only if the *whole* card lands inside the bounds on it, not merely its near edge. The
// anchor itself can lie outside them — a chart's tooltip anchors on the hovered bar's centre, which can
// already be scrolled out of view — and a flip that cleared only one edge then put the card past the other.
export function besideOnAxis({ before, after, size, lo, hi, gap = 6, margin = 8 }) {
  const fits = position => position >= lo + margin && position + size <= hi - margin
  const afterPosition = after + gap
  if (fits(afterPosition)) return afterPosition
  const beforePosition = before - gap - size
  if (fits(beforePosition)) return beforePosition
  return clampInto(afterPosition, size, lo, hi, margin)
}
