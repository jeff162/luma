// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * Placing the average-line pill inside a chart's value-axis column without burying a tick label.
 *
 * The single-period trend chart holds its value axis out of the horizontal scroll, so the axis stays
 * readable at any pan position. The average reference line's pill belongs there for the same reason —
 * drawn in the plot it scrolls away, and on a long timeline it spends most of its life off screen. But
 * the column is the one place already spoken for: it is nothing but tick labels.
 *
 * **The collision is the normal case, not an edge case.** Measured on this chart's geometry, recharts
 * lays out five ticks 41px apart; a pill needs about 15px of vertical clearance, so roughly two thirds
 * of the possible positions overlap a label. Worse, the overlap is *biased toward the worst tick*: a
 * net cash-flow average sits near zero by its nature, and zero is always a tick on an axis that
 * straddles it — so the label the pill would swallow is usually `$0`, the most load-bearing gradation
 * on the chart.
 *
 * So the pill moves and the ticks do not. When the line's own height would overlap a label, the pill
 * slides to the nearest height that clears every label; the reference line itself stays exactly where
 * it is and runs on underneath, which is what keeps the association readable. **A clear height always
 * exists** whenever the clearance fits inside half the tick spacing — the midpoint between two ticks is
 * the furthest any label can be — so on this chart the slide is never more than the clearance.
 *
 * That bound is enforced rather than assumed, because a pill placed further than that stops reading as
 * a label on its line and starts reading as a value of its own. On an axis crowded past what this was
 * designed for, no height within the bound clears, and the pill then stays put and overlaps — a
 * legibility cost, where drifting away would instead be a lie about where the average is.
 */

import { formatSignedAxisTick } from './moneyDisplay.js'

// The pill's drawn height, and the height of the tick text it must not sit on top of. Together these
// set how far apart the two have to be before neither is hard to read.
export const AVG_PILL_HEIGHT = 15
export const AXIS_TICK_TEXT_HEIGHT = 11
const PILL_TICK_GAP = 2
export const TICK_CLEARANCE = (AVG_PILL_HEIGHT + AXIS_TICK_TEXT_HEIGHT) / 2 + PILL_TICK_GAP

/*
 * Where to draw the average pill's centre, given where its line falls and where the tick labels are.
 *
 * Everything is in the chart's own pixel space, so `lineY` and `tickYs` come straight from the axis
 * scale rather than being recomputed from a domain. Returns `null` when the line falls outside the plot
 * area — an average outside the axis domain has no place on the chart, matching what recharts does with
 * an overflowing reference line — and otherwise `{ y, nudged }`.
 */
export function placeAvgPillY({
  lineY,
  tickYs = [],
  plotTop,
  plotBottom,
  clearance = TICK_CLEARANCE,
  pillHeight = AVG_PILL_HEIGHT,
  maxNudge = TICK_CLEARANCE,
}) {
  const line = Number(lineY)
  if (!Number.isFinite(line)) return null
  if (Number.isFinite(plotTop) && Number.isFinite(plotBottom) && (line < plotTop || line > plotBottom)) {
    return null
  }

  const ticks = tickYs.map(Number).filter(Number.isFinite)
  const clearsEveryTick = y => ticks.every(tick => Math.abs(tick - y) >= clearance)
  if (clearsEveryTick(line)) return { y: line, nudged: false }

  // Keeping the whole pill inside the plot matters more than landing exactly `clearance` away: a pill
  // half off the top of the chart is worse than one sharing a little space with the end tick.
  const half = pillHeight / 2
  const lowest = Number.isFinite(plotTop) ? plotTop + half : -Infinity
  const highest = Number.isFinite(plotBottom) ? plotBottom - half : Infinity
  const withinPlot = y => Math.min(Math.max(y, lowest), highest)

  // Just clear of one tick or the other is the closest a moved pill can ever sit to its line, so the
  // nearest viable one of those is the best available answer.
  const candidates = ticks.flatMap(tick => [tick - clearance, tick + clearance])
    .map(withinPlot)
    .filter(y => Math.abs(y - line) <= maxNudge + 1e-9 && clearsEveryTick(y))
    .sort((a, b) => Math.abs(a - line) - Math.abs(b - line))

  if (candidates.length === 0) return { y: withinPlot(line), nudged: false }
  return { y: candidates[0], nudged: true }
}

// --- What the pill says, and how much room that needs -----------------------------------------------

// SVG has no measurement API here, so the width is approximated from the character count. Deliberately
// a slight over-estimate: a pill wider than its text looks intentional, one narrower is clipped text.
const CHAR_WIDTH = 5.4
const PILL_PADDING = 12

export function avgPillWidth(text) {
  return Math.round(String(text ?? '').length * CHAR_WIDTH + PILL_PADDING)
}

/*
 * The pill's text, trimmed to fit the room available.
 *
 * `Avg -$12.3k` is the intended label and fits the axis column comfortably. A ledger with six-figure
 * yearly buckets pushes it past the column's width, where it would be clipped rather than merely tight,
 * so the word is dropped and the figure kept — the same trade the Sankey's slice labels make. The pill
 * is still tellable from a tick label: it is a filled accent badge in the colour of its own dashed line,
 * against grey axis text.
 */
export function avgPillText(value, { maxWidth = Infinity } = {}) {
  const amount = formatSignedAxisTick(value)
  const full = `Avg ${amount}`
  return avgPillWidth(full) <= maxWidth ? full : amount
}
