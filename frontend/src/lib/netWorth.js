// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { formatDate } from './utils.js'
import { formatSignedMoneyAmount } from './moneyDisplay.js'

/*
 * The Dashboard's Net worth frame groups accounts by type, in this order: what is held, what money passes
 * through, then what is owed. Each type keeps one colour from the categorical palette (`--series-N`,
 * index.html), so a type is the same colour in every chart and filter state. Inside a type the accounts
 * take the palette in their `type_index` order, which the server counts before any owner filter, so an
 * account keeps its colour whichever owners are shown.
 */
export const NET_WORTH_TYPES = [
  { type: 'depository', label: 'Checking' },
  { type: 'savings', label: 'Savings' },
  { type: 'investment', label: 'Investments' },
  { type: 'paypal', label: 'PayPal' },
  { type: 'p2p', label: 'P2P' },
  { type: 'amazon', label: 'Amazon' },
  { type: 'credit', label: 'Credit cards' },
  { type: 'loan', label: 'Loans' },
]

const SERIES_COUNT = 8
// Past the palette, accounts share one quiet colour rather than a generated hue.
const OVERFLOW_COLOR = 'var(--muted)'

export function seriesColor(index) {
  return index >= 0 && index < SERIES_COUNT ? `var(--series-${index + 1})` : OVERFLOW_COLOR
}

export function netWorthTypeLabel(type) {
  return NET_WORTH_TYPES.find(t => t.type === type)?.label || type
}

export function netWorthTypeColor(type) {
  return seriesColor(NET_WORTH_TYPES.findIndex(t => t.type === type))
}

export function accountColor(account) {
  return seriesColor(account.type_index)
}

// The types present among `accounts`, in display order, each with its accounts.
export function groupByType(accounts) {
  const known = NET_WORTH_TYPES.map(t => t.type)
  const types = [...new Set(accounts.map(a => a.type))]
    .sort((a, b) => (known.indexOf(a) + 1 || 99) - (known.indexOf(b) + 1 || 99))
  return types.map(type => ({
    type,
    label: netWorthTypeLabel(type),
    color: netWorthTypeColor(type),
    accounts: accounts.filter(a => a.type === type),
  }))
}

/*
 * The steps of a bridge from net worth at the period's opening to its end: the opening total, one step per
 * group by what its accounts moved, and the closing total. Each step carries `range`, the two ends of its
 * floating bar, and each total its `parts`, what each group made of it. An account whose history starts
 * inside the period opens it at zero (the server sends `opening` 0), so its whole balance is part of its
 * group's step. With no opening (an all-time period) the bridge starts at zero and each group's step is its
 * balance: what net worth is made of.
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
  for (const group of counted) {
    const value = sum(group.accounts.map(account => account.balance.amount - openingOf(account)))
    // A group that moved nothing is no step; its accounts are still in the table beside the chart.
    if (!group.accounts.length || !Math.round(value * 100)) continue
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

// What the history flag says, wherever an account's figures are shown.
export function describeHistoryFlag(flag) {
  return `The transactions do not align with the balance prior to ${formatDate(flag.before)}: working back from `
    + `there ends up with a balance of ${formatSignedMoneyAmount(flag.amount)} on ${formatDate(flag.date)}. Enter an `
    + 'earlier balance from a statement, or leave the account out of net worth.'
}
