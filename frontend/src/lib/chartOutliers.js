// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * Keeping one enormous bar from flattening every other bar on a money-over-time chart.
 *
 * A ledger reliably produces the occasional month or year that dwarfs the rest — a house purchase, a
 * tax settlement, a run of miscategorised transfers. Left to scale itself, the chart devotes its whole
 * axis to that one bar and draws every other period as a hairline against zero, which reads as "nothing
 * happened" rather than as "one period was exceptional".
 *
 * The answer is the same trade the rest of the app already makes for floored pie wedges and stacked
 * bands: **bound the geometry, keep every number true.** The axis is clamped to a value the ordinary
 * bars can be read against, the outlier is drawn to the edge with a break through it so it reads as
 * running off the scale rather than as merely the tallest bar, and its real figure stays in the label
 * and the tooltip.
 *
 * **The extreme is judged against the bulk of the data, not against the next largest bar.** Comparing
 * the top two is the intuitive rule and it is wrong for real ledgers: a personal one has a *heavy tail*
 * rather than a lone freak. Measured on a real 136-month ledger, the largest month was $222k and the
 * next largest $142k — a ratio of 1.6, which any "one bar dwarfs the rest" test waves through — while
 * the median month was $4.0k and 90% of months were under $16.2k. Ten Decembers carrying a year's bonus
 * do not make each other ordinary; they are all off the scale of the other 126 months. So the ordinary
 * scale is a **high percentile of the magnitudes**, which a handful of giants cannot move, and the top
 * two are never compared with each other at all.
 *
 * Three properties make this safe to apply by default:
 *
 * - **It is a no-op unless the tail is genuinely far out.** The largest magnitude has to exceed the
 *   ordinary scale by `ENGAGE_MULTIPLE`. Merely spiky data is left alone.
 * - **A chart can never become mostly torn edges**, and that follows from the percentile rather than
 *   from a second rule policing it. The bound sits above the 75th-percentile magnitude, so at most a
 *   quarter of the bars can exceed it however the data is shaped — and a distribution lopsided enough
 *   to put a giant *at* the 75th percentile fails the engage test instead, because the ordinary scale
 *   has risen to meet the tail.
 * - **The bound never cuts off the average line.** A mean is itself dragged toward the extremes, so a
 *   bound derived from the ordinary bars alone can leave the average reference line off the chart.
 */

// Which magnitude stands for "an ordinary bar on this chart". High enough to sit above the everyday
// noise, low enough that a run of giants cannot drag it upward.
export const ORDINARY_PERCENTILE = 0.75
// How far the largest magnitude must exceed that ordinary scale before the chart is treated as having a
// tail worth clamping at all.
export const ENGAGE_MULTIPLE = 6
// Where the axis lands, as a multiple of the ordinary scale. Four leaves the everyday bars occupying a
// readable share of the axis while keeping the number of torn bars small.
export const BOUND_MULTIPLE = 4
// Space above the largest thing the axis must still show, so a clamped bar or the average line does not
// sit exactly on the frame.
export const CLAMP_HEADROOM = 1.25
// Below this many bars a percentile is not describing a distribution, and every bar is readable anyway.
export const MIN_BARS_TO_CLAMP = 5

/*
 * Work out the axis bound for a set of signed bar values.
 *
 * Returns `{ clamped, bound, domain }`. `domain` always covers zero, sized to whichever sides actually
 * carry bars — an all-negative chart is not given an empty positive half. When `clamped` is false the
 * chart scales itself, which is the overwhelmingly common case, and `domain` only says where zero goes.
 *
 * `average` is optional and is the value of any average reference line the caller draws.
 */
// Recharts' own default, `[0, 'auto']`, pins zero only at the bottom of the axis, so an all-negative
// chart runs from its lowest bar to its highest with no zero at all, and a single bar spans an axis a few
// dollars tall. The mirror of the default puts zero at the top instead; every other chart keeps the default.
function unclamped(numbers) {
  const negativeOnly = numbers.some(v => v < 0) && numbers.every(v => v <= 0)
  return { clamped: false, bound: null, domain: negativeOnly ? ['auto', 0] : undefined }
}

// Rounding an axis end outward to one of these keeps the ticks legible. It matters more with an explicit
// domain than without one: recharts pins the ticks to the exact ends it is given, so a domain of
// [-27792, 27792] produces an axis reading -27792 / -12792 / 2208 / 27792, with no zero tick and nothing
// a reader can hold on to. Rounding outward never hides a bar — it only adds headroom — and it restores
// the round ticks, and the zero, that an auto-scaled axis would have had.
const NICE_STEPS = [1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10]

function niceOutward(value) {
  if (!Number.isFinite(value) || value === 0) return 0
  const magnitude = 10 ** Math.floor(Math.log10(Math.abs(value)))
  const ratio = Math.abs(value) / magnitude
  const step = NICE_STEPS.find(s => ratio <= s + 1e-9) ?? 10
  return Math.sign(value) * step * magnitude
}

export function computeClampedDomain(values, { average = null } = {}) {
  const numbers = (values || []).map(Number).filter(Number.isFinite)
  const magnitudes = numbers.map(Math.abs).filter(v => v > 0).sort((a, b) => a - b)

  if (numbers.length < MIN_BARS_TO_CLAMP || magnitudes.length < MIN_BARS_TO_CLAMP) return unclamped(numbers)

  const ordinary = magnitudes[Math.floor((magnitudes.length - 1) * ORDINARY_PERCENTILE)]
  const largest = magnitudes[magnitudes.length - 1]
  if (ordinary <= 0 || largest <= ordinary * ENGAGE_MULTIPLE) return unclamped(numbers)

  const avg = Number.isFinite(Number(average)) ? Math.abs(Number(average)) : 0
  const bound = Math.max(ordinary * BOUND_MULTIPLE, avg * CLAMP_HEADROOM)

  // Only the sides that carry bars get axis space, and each is capped independently: a chart whose
  // outlier is negative keeps its true positive extent rather than being made artificially symmetric.
  // Bars are clipped at the raw bound while the axis ends a little beyond it, so a torn bar stops short
  // of the frame instead of pressing against it.
  const max = Math.min(Math.max(0, ...numbers), bound)
  const min = Math.max(Math.min(0, ...numbers), -bound)
  return { clamped: true, bound, domain: [niceOutward(min), niceOutward(max)] }
}

/*
 * Split a bar's value into what gets drawn and what gets said.
 *
 * The drawn value is clamped to the axis bound so the bar ends at the frame; `clipped` tells the shape
 * to draw the break, and the caller keeps the original value for the tooltip and any label. This is the
 * same two-value pattern the stacked group bands already use to keep a floored band honest.
 */
export function clampBarValue(value, bound) {
  const num = Number(value) || 0
  if (!Number.isFinite(bound) || bound === null || Math.abs(num) <= bound) {
    return { plotted: num, clipped: false }
  }
  return { plotted: num < 0 ? -bound : bound, clipped: true }
}

// --- Drawing a clipped bar ------------------------------------------------------------------------

// The break's zigzag: shallow enough not to eat the bar, coarse enough to read as deliberate.
export const TEAR_AMPLITUDE = 3
export const TEAR_TEETH = 5
// The gap between the two halves of a broken bar. The gap is left empty rather than painted over in the
// surface colour: a patch has to match whatever is behind it, which is a theme-dependent guess that goes
// wrong on exactly the surfaces it was not tuned against.
export const TEAR_GAP = 7
// Below this the bar has no room for a break in the middle with a readable piece either side, so it gets
// a single torn edge at the value end instead.
const MIN_SPLIT_SPAN = 30
// Insets differ because a text baseline sits near the bottom of its glyphs: the same visual clearance
// needs more room measured from the top edge than from the bottom.
const LABEL_INSET_FROM_TOP = 13
const LABEL_INSET_FROM_BOTTOM = 6

/*
 * Where to draw a clipped bar's pieces and its label.
 *
 * **Recharts hands a negative bar a negative `height`.** It anchors every bar at the zero line and
 * extends it toward the value, so for a bar below the axis `y` is the *far* edge and `y + height` is the
 * zero line — measured, not assumed: a -$27,792 bar arrives as `y: 189, height: -92`. Treating height as
 * always positive inverts the bar end-for-end, which puts the break on the zero line and the label
 * outside the bar altogether, on the card background where white text is invisible. Normalising to
 * top/bottom first is what keeps everything below sign-agnostic.
 *
 * **The break goes in the middle of the bar, not at the clipped end.** A break at the end sits on the
 * chart frame, where it reads as a rendering artefact rather than as a deliberate mark, and on the zero
 * side it collides with the baseline every other bar shares. In the middle it is unambiguous, it is in
 * the same place whichever direction the bar runs, and the bar still visibly reaches the frame.
 *
 * The label goes inside the bar at the **value** end — the top of a bar that rises, the bottom of one
 * that falls — because a clipped bar reaches the frame and there is no room outside it.
 */
export function clippedBarGeometry({ x, y, width, height, value }) {
  const top = Math.min(y, y + height)
  const bottom = Math.max(y, y + height)
  const negative = Number(value) < 0
  const labelY = negative ? bottom - LABEL_INSET_FROM_BOTTOM : top + LABEL_INSET_FROM_TOP

  if (bottom - top < MIN_SPLIT_SPAN) {
    const valueEdge = negative ? bottom : top
    const zeroEdge = negative ? top : bottom
    return { x, width, top, bottom, labelY, segments: [{ flatY: zeroEdge, tornY: valueEdge }] }
  }
  const middle = (top + bottom) / 2
  return {
    x,
    width,
    top,
    bottom,
    labelY,
    segments: [
      { flatY: top, tornY: middle - TEAR_GAP / 2 },
      { flatY: bottom, tornY: middle + TEAR_GAP / 2 },
    ],
  }
}

/*
 * One piece of a broken bar: a rectangle whose `tornY` edge is a zigzag and whose `flatY` edge is not.
 */
export function tornSegmentPath({ x, width, flatY, tornY }) {
  const step = width / TEAR_TEETH
  let d = `M ${x} ${flatY} L ${x} ${tornY}`
  for (let i = 0; i < TEAR_TEETH; i++) {
    const midX = x + step * (i + 0.5)
    const endX = x + step * (i + 1)
    d += ` L ${midX} ${tornY + (i % 2 === 0 ? -TEAR_AMPLITUDE : TEAR_AMPLITUDE)} L ${endX} ${tornY}`
  }
  return `${d} L ${x + width} ${flatY} Z`
}
