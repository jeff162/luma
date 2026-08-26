// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { OTHER_SLICE_COLOR, OTHER_SLICE_KEY, computeSlicePages } from './longTailSlices.js'

/*
 * The node/link graph behind the cash-flow Sankey.
 *
 * Cash flow is a third dashboard frame beside spending and income, and its single-period form is a
 * Sankey: what came in on one side, what went out on the other, joined through one hub. The rules it
 * has to encode are all consequences of one decision — **a bucket's side follows the sign of its own
 * net, not its `category_type`** — which is what keeps the diagram honest under signed-net reporting.
 * An expense category that refunded more than it spent moved money *in* and belongs on the inflow side;
 * an income category running a clawback belongs on the outflow side. The alternative would be an ABS
 * somewhere, since no link can be drawn with a negative width.
 *
 * Three things follow, and each is load-bearing:
 *
 * - **Cash sign, not scope sign.** Summary rows arrive signed for *their own* scope: the backend
 *   negates income-type buckets so received income reads positive. This frame has a single axis
 *   instead — positive is money in, whatever the bucket is — so `cashValueOf` converts, and every
 *   number the diagram shows is on that axis. It matches `/summary/monthly-trend?view=cash_flow` and
 *   `/summary/monthly-cash-flow`, so the frame's two forms report the same net.
 *
 * - **Magnitude draws, the signed value labels.** A link's width is the magnitude; the node label and
 *   tooltip carry the true signed figure. Same split the pie wedges and stacked bands already use.
 *
 * - **Colour and order ignore which side a bucket landed on.** A bucket can change sides between
 *   periods, so colours are assigned over the combined magnitude-sorted list *before* the split. Were
 *   they assigned per side, a bucket crossing over would change colour as well as position and the
 *   comparison between two periods would be unreadable.
 *
 * **The balancing node.** The two sides do not agree — that difference *is* the period's net — so the
 * diagram is completed with one synthetic terminal: money left over flows into `Net saved` on the
 * outflow side, and a shortfall is funded by `Net drawdown` on the inflow side. Without it the hub's
 * two halves are visibly unequal and read as a rendering fault rather than as a surplus.
 *
 * Long tails are collapsed per side by the shared slicing in `longTailSlices.js`: each side pages
 * independently, since a ledger typically has a handful of income buckets and a great many expense ones,
 * and each side passes that helper a `minShare` floor — on this surface a named bucket costs a label row
 * whether or not its band has any height to it.
 */

export const CASH_FLOW_HUB_ID = '__cash_flow_hub__'
export const CASH_FLOW_SAVED_ID = '__cash_flow_saved__'
export const CASH_FLOW_DRAWDOWN_ID = '__cash_flow_drawdown__'

export const INFLOW = 'inflow'
export const OUTFLOW = 'outflow'

// Cents, so a bucket whose parts cancel to floating-point dust is treated as flat rather than drawn as
// a hairline link on whichever side the rounding error happened to land.
const FLAT = 0.005

// A bucket below this share of its own side is never named, however few buckets that side holds. The
// shared slicing's minimum-named-slices floor is written for a pie, where naming a hairline wedge costs
// nothing because the legend beside it lists the item anyway; here every named bucket claims a label row
// next to a band that may be under a pixel tall. One percent of a side is roughly where a band stops
// being thick enough to hover, and it sits below the shared 3% peeling threshold, which answers the
// different question of when to stop peeling rather than what is too small to name at all.
const MIN_NAMED_SIDE_SHARE = 0.01

/*
 * A summary row's value on the cash axis: positive = money in, negative = money out.
 *
 * The backend's signed total is relative to the bucket's own scope (income negated so receipts read
 * positive), which makes an income row and an expense row incomparable as-is. Undoing that negation
 * recovers the stored sign — where positive is money leaving — and one more negation puts both on the
 * single axis this frame reports.
 */
export function cashValueOf(row) {
  const total = Number(row?.total) || 0
  return (row?.category_type === 'income') ? total : -total
}

function sideOf(cashValue) {
  if (cashValue > FLAT) return INFLOW
  if (cashValue < -FLAT) return OUTFLOW
  return null
}

/*
 * Build the graph for one period.
 *
 * `rows` are summary rows at whichever granularity the breakdown selector is on (groups or leaf
 * categories); `keyField` / `nameField` name their identity columns at that granularity. `depths` is
 * the per-side Other-drill depth, which pages that side deeper into its own tail.
 */
export function buildCashFlowGraph(rows, {
  keyField,
  nameField,
  palette = [],
  depths = {},
  hubLabel = 'Cash flow',
} = {}) {
  const priced = (rows || [])
    .map(row => ({ row, cashValue: cashValueOf(row) }))
    .filter(entry => sideOf(entry.cashValue) !== null)
    // One combined ordering drives both the colour assignment and each side's slicing, so a bucket that
    // crosses sides between periods keeps its colour and its relative position.
    .sort((a, b) => Math.abs(b.cashValue) - Math.abs(a.cashValue))

  const entries = priced.map((entry, index) => ({
    key: String(entry.row[keyField]),
    name: entry.row[nameField],
    color: palette.length ? palette[index % palette.length] : OTHER_SLICE_COLOR,
    cashValue: entry.cashValue,
    // `total` is what the shared slicing reads, and on this surface the magnitude is what gets drawn.
    total: Math.abs(entry.cashValue),
    side: sideOf(entry.cashValue),
    row: entry.row,
  }))

  const sides = {
    [INFLOW]: buildSide(entries.filter(e => e.side === INFLOW), depths[INFLOW] || 0),
    [OUTFLOW]: buildSide(entries.filter(e => e.side === OUTFLOW), depths[OUTFLOW] || 0),
  }

  const inflowTotal = sides[INFLOW].total
  const outflowTotal = sides[OUTFLOW].total
  const net = inflowTotal - outflowTotal

  const inflowNodes = sides[INFLOW].nodes.slice()
  const outflowNodes = sides[OUTFLOW].nodes.slice()
  if (net > FLAT) {
    outflowNodes.push(balanceNode(CASH_FLOW_SAVED_ID, 'Net saved', net, OUTFLOW))
  } else if (net < -FLAT) {
    inflowNodes.push(balanceNode(CASH_FLOW_DRAWDOWN_ID, 'Net drawdown', -net, INFLOW))
  }

  const hub = {
    key: CASH_FLOW_HUB_ID,
    name: hubLabel,
    color: 'var(--accent)',
    // The hub carries the larger side, which after balancing is both sides.
    total: Math.max(inflowTotal, outflowTotal),
    cashValue: net,
    side: null,
    isHub: true,
  }

  const nodes = [...inflowNodes, hub, ...outflowNodes]
  const hubIndex = inflowNodes.length
  const links = [
    ...inflowNodes.map((node, i) => ({ source: i, target: hubIndex, value: node.total })),
    ...outflowNodes.map((node, i) => ({ source: hubIndex, target: hubIndex + 1 + i, value: node.total })),
  ]

  return {
    nodes,
    links,
    hubIndex,
    inflowTotal,
    outflowTotal,
    net,
    pageCounts: {
      [INFLOW]: sides[INFLOW].pageCount,
      [OUTFLOW]: sides[OUTFLOW].pageCount,
    },
    isEmpty: nodes.length <= 1,
  }
}

const MAX_LABEL_CHARS = 26
// The vertical slot a node's label may use without running into its neighbours': the node itself plus
// half the padding on each side. Stacking the name over the amount spans ~27px — the name's baseline
// sits 2px above the node's middle and the amount's 13px below it, plus their ascent and descent — so a
// node shorter than about 13px cannot hold two lines, and the pair would overlap the labels above and
// below it. That is not an edge case: node height is proportional to value, so any long tail produces
// several near-zero nodes in a row.
const TWO_LINE_SLOT = 27
// A one-line label ends up sharing its row with the amount, so the name gets whatever the amount leaves.
// Never so little that the name is all ellipsis.
const MIN_NAME_CHARS = 6

function truncate(text, max = MAX_LABEL_CHARS) {
  const value = String(text ?? '')
  return value.length > max ? `${value.slice(0, Math.max(max - 1, 1))}…` : value
}

/*
 * How one node's label is drawn, given the vertical room it actually has.
 *
 * Two lines where they fit, and name-and-amount on one line where they do not — one line needs about the
 * node padding alone, so it always fits and the diagram can no longer produce overlapping text. It lives
 * beside the graph rather than in the chart because it is the piece of the drawing with a decision in it,
 * and the chart itself cannot be rendered under the unit runner to check it. `padding` is the chart's own
 * node padding, passed in rather than defaulted so the two cannot drift apart.
 */
export function cashFlowLabelLayout({ height, padding, name, amount }) {
  const amountText = String(amount ?? '')
  if ((Number(height) || 0) + padding >= TWO_LINE_SLOT) {
    return { lines: 2, name: truncate(name), amount: amountText }
  }
  const budget = Math.max(MAX_LABEL_CHARS - amountText.length - 2, MIN_NAME_CHARS)
  return { lines: 1, name: truncate(name, budget), amount: amountText }
}

/*
 * The node a Sankey tooltip is describing, given recharts' tooltip payload.
 *
 * Recharts hands the tooltip one entry whose `payload` is the *renderer props* it built, and those
 * differ by what the cursor is over: hovering a node nests the node object one level down, while
 * hovering a link nests `{...link, source, target}` in the same place. Reading it as a node either way
 * looks right and silently produces nothing for every link on the diagram, so the two shapes are told
 * apart here. For a link the informative end is the bucket, not the hub every link touches.
 */
export function nodeFromTooltipPayload(payload) {
  const rendered = payload?.[0]?.payload
  const inner = rendered?.payload
  if (!inner) return null
  if (inner.source && inner.target) {
    return inner.source.isHub ? inner.target : inner.source
  }
  return inner
}


function balanceNode(key, name, magnitude, side) {
  return {
    key,
    name,
    // Neutral like the Other slice: it is an accounting remainder, not one of the user's buckets, and a
    // palette colour would claim it is.
    color: OTHER_SLICE_COLOR,
    total: magnitude,
    cashValue: side === INFLOW ? magnitude : -magnitude,
    side,
    isBalance: true,
  }
}

/*
 * One side's visible nodes at the given drill depth: the page's named buckets, plus an `Other (N)` node
 * standing for the rest of the tail when there is one. The side's total is the *whole* side, tail
 * included — collapsing the tail must not change what the diagram says came in or went out.
 */
function buildSide(entries, depth) {
  const total = entries.reduce((sum, e) => sum + e.total, 0)
  const pages = computeSlicePages(entries, { minShare: MIN_NAMED_SIDE_SHARE })
  const safeDepth = Math.min(Math.max(depth, 0), Math.max(0, pages.length - 1))
  const page = pages[safeDepth] || { start: 0, end: entries.length }
  const named = entries.slice(page.start, page.end)
  const tail = entries.slice(page.end)

  const nodes = named.map(entry => ({ ...entry, isOther: false }))
  if (tail.length > 0) {
    const tailTotal = tail.reduce((sum, e) => sum + e.total, 0)
    nodes.push({
      key: `${OTHER_SLICE_KEY}:${entries[0]?.side || ''}:${safeDepth}`,
      name: `Other (${tail.length})`,
      color: OTHER_SLICE_COLOR,
      total: tailTotal,
      cashValue: entries[0]?.side === INFLOW ? tailTotal : -tailTotal,
      side: entries[0]?.side || null,
      isOther: true,
      tailRows: tail.map(e => e.row),
    })
  }
  return { nodes, total, pageCount: pages.length }
}
