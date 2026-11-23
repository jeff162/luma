// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { formatDate } from './utils.js'
import { formatMoneyMagnitude, formatSignedMoneyAmount } from './moneyDisplay.js'
import { normalBalanceSide, unusualBalanceColor } from './accountTypes.js'
import { niceOutward } from './chartOutliers.js'

/*
 * The Dashboard's Balances frame groups accounts by type, in this order: the accounts watched most closely
 * first, the slow-moving ones last. Each type keeps one colour from the categorical palette (`--series-N`,
 * index.html), its `color` index, so a type is the same colour in every chart and filter state and
 * reordering the types does not recolour them. Inside a type the accounts take the palette in their
 * `type_index` order, which the server counts before any owner filter, so an account keeps its colour
 * whichever owners are shown.
 */
export const BALANCE_TYPES = [
  { type: 'depository', label: 'Checking', color: 0 },
  { type: 'credit', label: 'Credit cards', color: 6 },
  { type: 'p2p', label: 'P2P', color: 4 },
  { type: 'paypal', label: 'PayPal', color: 3 },
  { type: 'amazon', label: 'Amazon', color: 5 },
  { type: 'savings', label: 'Savings', color: 1 },
  { type: 'investment', label: 'Investments', color: 2 },
  { type: 'loan', label: 'Loans', color: 7 },
]

const SERIES_COUNT = 8
// Past the palette, accounts share one quiet colour rather than a generated hue.
const OVERFLOW_COLOR = 'var(--muted)'

export function seriesColor(index) {
  return index >= 0 && index < SERIES_COUNT ? `var(--series-${index + 1})` : OVERFLOW_COLOR
}

export function balanceTypeLabel(type) {
  return BALANCE_TYPES.find(t => t.type === type)?.label || type
}

export function balanceTypeColor(type) {
  return seriesColor(BALANCE_TYPES.find(t => t.type === type)?.color ?? -1)
}

// Drilled into a type whose balances normally sit below zero, a balance chart turns its value axis over,
// so what is owed grows upward and a credit balance falls below the line. The figures keep their sign.
export function isOwedBalanceType(type) {
  return normalBalanceSide(type) === 'owed'
}

/*
 * A change in a balance as an arrow and an amount, `text`, with `title` spelling it out. The arrow is the way
 * the balance moves on its type's chart: up is more held, or for a type whose balances run below zero more
 * owed, as those charts are drawn turned over. A signed change says what it does to the total, which reads
 * backwards on a credit card (−$24 for $24 more owed), so the arrow carries the direction and the amount is
 * a magnitude.
 */
export function describeBalanceChange(type, change) {
  const amount = formatMoneyMagnitude(change)
  const cents = Math.round(change * 100)
  if (!cents) return { text: amount, title: null }
  const owed = isOwedBalanceType(type)
  const up = owed ? cents < 0 : cents > 0
  return {
    text: `${up ? '↑' : '↓'} ${amount}`,
    title: owed ? `${amount} ${up ? 'more' : 'less'} owed` : `${amount} ${up ? 'higher' : 'lower'}`,
  }
}

// A balance bar's colour when it is on the wrong side of zero for its type, as the table colours the
// figure (`unusualBalanceColor`), or null. Only for types that are clearly held or owed: a wallet or
// marketplace often holds money, and a chart of one would come out mostly flagged.
export function unusualBalanceBarColor(type, amount) {
  const side = normalBalanceSide(type)
  return side === 'held' || side === 'owed' ? unusualBalanceColor(type, amount) : null
}

export function accountColor(account) {
  return seriesColor(account.type_index)
}

// The types present among `accounts`, in display order, each with its accounts.
export function groupByType(accounts) {
  const known = BALANCE_TYPES.map(t => t.type)
  const types = [...new Set(accounts.map(a => a.type))]
    .sort((a, b) => (known.indexOf(a) + 1 || 99) - (known.indexOf(b) + 1 || 99))
  return types.map(type => ({
    type,
    label: balanceTypeLabel(type),
    color: balanceTypeColor(type),
    accounts: accounts.filter(a => a.type === type),
  }))
}

/*
 * The steps of a bridge from the total at the period's opening to its end: the opening total, one step per
 * group by what its accounts moved, and the closing total. Each step carries `range`, the two ends of its
 * floating bar, and each total its `parts`, what each group made of it. An account whose history starts
 * inside the period opens it at zero (the server sends `opening` 0), so its whole balance is part of its
 * group's step. With no opening (an all-time period) the bridge starts at zero and each group's step is its
 * balance: what the total is made of.
 *
 * The steps run in the direction of the whole change first, largest first, then back the other way, smallest
 * first: a sort by value, descending when the total rose and ascending when it fell. So the bars travel one
 * way and finish with a short turn back, rather than zig-zagging in the groups' order, which only breaks
 * ties. On a chart with its axis turned over the same order is mirrored, and still reads the same way.
 *
 * `groups` are `{ key, label, color, accounts }`; each account carries `balance` (`{ amount }` or null)
 * and `opening` (a number, or null when the period has no opening).
 */
export function buildBridge(groups, { hasOpening, openingLabel, closingLabel }) {
  const steps = []
  let run = 0
  const counted = groups.map(group => ({
    ...group,
    accounts: group.accounts.filter(a => a.balance),
  }))
  const sum = values => values.reduce((total, value) => total + value, 0)
  const openingOf = account => (hasOpening ? account.opening ?? 0 : 0)
  if (hasOpening) {
    const parts = Object.fromEntries(counted.map(g => [g.key, sum(g.accounts.map(openingOf))]))
    const opening = sum(Object.values(parts))
    steps.push({ key: '__opening', label: openingLabel, kind: 'total', value: opening, range: [0, opening], parts })
    run = opening
  }
  const moves = counted
    .map(group => ({ group, value: sum(group.accounts.map(account => account.balance.amount - openingOf(account))) }))
    // A group that moved nothing is no step; its accounts are still in the table beside the chart.
    .filter(({ group, value }) => group.accounts.length && Math.round(value * 100))
  const rose = sum(moves.map(m => m.value)) >= 0
  moves.sort((a, b) => (rose ? b.value - a.value : a.value - b.value))
  for (const { group, value } of moves) {
    steps.push({ key: group.key, label: group.label, color: group.color, kind: 'step', value, range: [run, run + value] })
    run += value
  }
  const closingParts = Object.fromEntries(counted.map(g => [g.key, sum(g.accounts.map(a => a.balance.amount))]))
  steps.push({ key: '__closing', label: closingLabel, kind: 'total', value: run, range: [0, run], parts: closingParts })
  return steps
}

/*
 * A bridge's steps as the rows of one chart stacked about zero (`stackOffset="sign"`), so a total can be drawn
 * as its groups' parts and a step as a floating bar in the same stack. A total's parts sit under each
 * group's key (`part:<key>`). A step on one side of zero is a transparent spacer out to where it starts and
 * the step beyond it; one that crosses zero is drawn as its two sides.
 */
export function bridgeRows(steps) {
  return steps.map(step => {
    const row = { key: step.key, label: step.label, kind: step.kind, value: step.value, color: step.color }
    if (step.kind === 'total') {
      for (const [key, value] of Object.entries(step.parts || {})) row[`part:${key}`] = value
      return row
    }
    const [from, to] = step.range
    const low = Math.min(from, to)
    const high = Math.max(from, to)
    if (low >= 0) Object.assign(row, { spacerHeld: low, stepHeld: high - low })
    else if (high <= 0) Object.assign(row, { spacerOwed: high, stepOwed: low - high })
    else Object.assign(row, { stepHeld: high, stepOwed: low })
    return row
  })
}

/*
 * The value axis for a bridge's rows (`bridgeRows`): `domain` and `ticks`, or null with nothing drawn.
 *
 * Left to itself the axis spaces its ticks evenly and must reach a tick past every bar, so a total that dips
 * a little below zero (a card's part of it) pushes the axis a whole step out: -$200K on an axis whose bars
 * reach -$3K. Here the axis runs from the bars' extent, zero always in it, with a small margin past each
 * side that has bars, and the ticks count out from zero in a round step sized to the larger side. The
 * smaller side's end is labelled only where it stands far enough from zero for the labels not to collide;
 * the figures beside the chart give each bar exactly.
 */
const BRIDGE_AXIS_MARGIN = 0.03
// The fraction of a step the small side's end must lie from zero to carry a label of its own.
const EDGE_LABEL_MIN = 0.4

export function bridgeAxis(rows) {
  let lo = 0
  let hi = 0
  for (const row of rows) {
    if (row.kind === 'total') {
      // Stacked about zero: the parts above it add up one way, the parts below it the other.
      const parts = Object.entries(row).filter(([key]) => key.startsWith('part:')).map(([, value]) => value)
      hi = Math.max(hi, parts.filter(v => v > 0).reduce((s, v) => s + v, 0))
      lo = Math.min(lo, parts.filter(v => v < 0).reduce((s, v) => s + v, 0))
    } else {
      hi = Math.max(hi, (row.spacerHeld || 0) + (row.stepHeld || 0))
      lo = Math.min(lo, (row.spacerOwed || 0) + (row.stepOwed || 0))
    }
  }
  const larger = Math.max(hi, -lo)
  if (!(larger > 0)) return null
  const step = niceOutward(larger / 4)
  const margin = (hi - lo) * BRIDGE_AXIS_MARGIN
  const domain = [lo < 0 ? lo - margin : 0, hi > 0 ? hi + margin : 0]
  const ticks = []
  for (let k = Math.ceil(domain[0] / step); k * step <= domain[1]; k++) ticks.push(k * step || 0)
  // A side with bars but no round tick of its own gets its extent, to two figures, when there is room.
  for (const end of [lo, hi]) {
    const hasTick = ticks.some(t => t !== 0 && Math.sign(t) === Math.sign(end))
    if (end && !hasTick && Math.abs(end) >= step * EDGE_LABEL_MIN) {
      const scale = 10 ** (Math.floor(Math.log10(Math.abs(end))) - 1)
      ticks.push(Math.sign(end) * Math.floor(Math.abs(end) / scale) * scale)
    }
  }
  return { domain, ticks: ticks.sort((a, b) => a - b) }
}

// What the history flag says, wherever an account's figures are shown.
export function describeHistoryFlag(flag) {
  return `The transactions do not align with the balance prior to ${formatDate(flag.before)}: working back from `
    + `there ends up with a balance of ${formatSignedMoneyAmount(flag.amount)} on ${formatDate(flag.date)}. Enter an `
    + 'earlier balance from a statement, or leave the account out of the balance totals.'
}
