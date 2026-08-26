import { describe, it, expect } from 'vitest'
import {
  CASH_FLOW_DRAWDOWN_ID,
  CASH_FLOW_HUB_ID,
  CASH_FLOW_SAVED_ID,
  INFLOW,
  OUTFLOW,
  buildCashFlowGraph,
  cashFlowLabelLayout,
  cashValueOf,
  nodeFromTooltipPayload,
} from '../cashFlowGraph.js'

// Summary rows as the backend emits them: `total` is signed for the bucket's *own* scope, so an income
// bucket's receipts arrive positive and an expense bucket's spending arrives positive too.
function row(category_id, category_name, category_type, total) {
  return { category_id, category_name, category_type, total }
}

const PALETTE = ['#111111', '#222222', '#333333', '#444444']
const OPTS = { keyField: 'category_id', nameField: 'category_name', palette: PALETTE }

function build(rows, extra = {}) {
  return buildCashFlowGraph(rows, { ...OPTS, ...extra })
}

function nodeNamed(graph, name) {
  const found = graph.nodes.filter(n => n.name === name)
  expect(found, `expected one node named ${name}, got ${graph.nodes.map(n => n.name).join(', ')}`).toHaveLength(1)
  return found[0]
}

describe('cashValueOf', () => {
  it('puts income receipts and expense spending on one axis', () => {
    expect(cashValueOf(row('a', 'Salary', 'income', 3000))).toBe(3000)
    expect(cashValueOf(row('b', 'Rent', 'expense', 1800))).toBe(-1800)
  })

  it('follows the bucket net rather than its type when the two disagree', () => {
    // An expense bucket that net-refunded moved money in; an income bucket clawed back moved money out.
    expect(cashValueOf(row('c', 'Equipment', 'expense', -160))).toBe(160)
    expect(cashValueOf(row('d', 'Bonus', 'income', -400))).toBe(-400)
  })
})

describe('buildCashFlowGraph sides', () => {
  it('splits buckets by the sign of their own net', () => {
    const graph = build([
      row('a', 'Salary', 'income', 3000),
      row('b', 'Rent', 'expense', 1800),
      row('c', 'Equipment', 'expense', -160),
      row('d', 'Bonus', 'income', -400),
    ])

    expect(nodeNamed(graph, 'Salary').side).toBe(INFLOW)
    expect(nodeNamed(graph, 'Equipment').side).toBe(INFLOW)
    expect(nodeNamed(graph, 'Rent').side).toBe(OUTFLOW)
    expect(nodeNamed(graph, 'Bonus').side).toBe(OUTFLOW)
    expect(graph.inflowTotal).toBeCloseTo(3160)
    expect(graph.outflowTotal).toBeCloseTo(2200)
    expect(graph.net).toBeCloseTo(960)
  })

  it('drops buckets that net flat rather than drawing a hairline link on an arbitrary side', () => {
    const graph = build([
      row('a', 'Salary', 'income', 3000),
      row('b', 'Wash', 'expense', 0),
      row('c', 'Dust', 'expense', 0.001),
    ])

    expect(graph.nodes.map(n => n.name)).not.toContain('Wash')
    expect(graph.nodes.map(n => n.name)).not.toContain('Dust')
  })

  it('draws every link with a positive width even where the bucket net is negative', () => {
    const graph = build([
      row('a', 'Salary', 'income', 3000),
      row('b', 'Equipment', 'expense', -160),
      row('c', 'Rent', 'expense', 1800),
    ])

    expect(graph.links.length).toBeGreaterThan(0)
    for (const link of graph.links) expect(link.value).toBeGreaterThan(0)
  })

  it('keeps a bucket colour stable when it changes sides between periods', () => {
    // The same three buckets, with Equipment an outflow in one period and an inflow in the next. Its
    // colour must not move, or two periods cannot be read against each other.
    const spent = build([
      row('a', 'Salary', 'income', 3000),
      row('b', 'Rent', 'expense', 1800),
      row('c', 'Equipment', 'expense', 500),
    ])
    const refunded = build([
      row('a', 'Salary', 'income', 3000),
      row('b', 'Rent', 'expense', 1800),
      row('c', 'Equipment', 'expense', -500),
    ])

    expect(nodeNamed(spent, 'Equipment').side).toBe(OUTFLOW)
    expect(nodeNamed(refunded, 'Equipment').side).toBe(INFLOW)
    expect(nodeNamed(refunded, 'Equipment').color).toBe(nodeNamed(spent, 'Equipment').color)
  })
})

describe('buildCashFlowGraph balancing', () => {
  it('flows a surplus into a Net saved terminal so the two sides agree', () => {
    const graph = build([
      row('a', 'Salary', 'income', 3000),
      row('b', 'Rent', 'expense', 1800),
    ])

    const saved = nodeNamed(graph, 'Net saved')
    expect(saved.key).toBe(CASH_FLOW_SAVED_ID)
    expect(saved.side).toBe(OUTFLOW)
    expect(saved.total).toBeCloseTo(1200)
    expect(graph.nodes.map(n => n.key)).not.toContain(CASH_FLOW_DRAWDOWN_ID)
  })

  it('funds a shortfall from a Net drawdown terminal on the inflow side', () => {
    const graph = build([
      row('a', 'Salary', 'income', 1000),
      row('b', 'Rent', 'expense', 1800),
    ])

    const drawdown = nodeNamed(graph, 'Net drawdown')
    expect(drawdown.key).toBe(CASH_FLOW_DRAWDOWN_ID)
    expect(drawdown.side).toBe(INFLOW)
    expect(drawdown.total).toBeCloseTo(800)
    expect(graph.nodes.map(n => n.key)).not.toContain(CASH_FLOW_SAVED_ID)
  })

  it('balances the hub: everything reaching it leaves it again', () => {
    for (const rows of [
      [row('a', 'Salary', 'income', 3000), row('b', 'Rent', 'expense', 1800)],
      [row('a', 'Salary', 'income', 1000), row('b', 'Rent', 'expense', 1800)],
      [row('a', 'Salary', 'income', 1800), row('b', 'Rent', 'expense', 1800)],
    ]) {
      const graph = build(rows)
      const into = graph.links.filter(l => l.target === graph.hubIndex).reduce((s, l) => s + l.value, 0)
      const outOf = graph.links.filter(l => l.source === graph.hubIndex).reduce((s, l) => s + l.value, 0)
      expect(into).toBeCloseTo(outOf)
    }
  })

  it('adds no terminal when the period nets flat', () => {
    const graph = build([
      row('a', 'Salary', 'income', 1800),
      row('b', 'Rent', 'expense', 1800),
    ])

    const keys = graph.nodes.map(n => n.key)
    expect(keys).not.toContain(CASH_FLOW_SAVED_ID)
    expect(keys).not.toContain(CASH_FLOW_DRAWDOWN_ID)
    expect(keys).toContain(CASH_FLOW_HUB_ID)
  })

  it('reports an empty graph when nothing moved', () => {
    expect(build([]).isEmpty).toBe(true)
    expect(build([row('a', 'Wash', 'expense', 0)]).isEmpty).toBe(true)
  })
})

describe('buildCashFlowGraph long tail', () => {
  // Twelve outflow buckets with a steep tail: past the ten-named floor, the rest fall under the
  // smallest-slice share and collapse.
  const manyOutflows = [
    row('i', 'Salary', 'income', 10000),
    ...Array.from({ length: 12 }, (_, i) => row(`e${i}`, `Expense ${i}`, 'expense', 500 - i * 40)),
  ]

  it('collapses a side tail into one Other node without changing that side total', () => {
    const graph = build(manyOutflows)
    const other = nodeNamed(graph, 'Other (2)')

    expect(other.side).toBe(OUTFLOW)
    expect(graph.outflowTotal).toBeCloseTo(manyOutflows
      .filter(r => r.category_type === 'expense')
      .reduce((s, r) => s + r.total, 0))
    // The collapsed node stands for exactly the buckets that are not drawn.
    expect(other.tailRows.map(r => r.category_name)).toEqual(['Expense 10', 'Expense 11'])
  })

  it('pages a side deeper on its own drill depth, leaving the other side alone', () => {
    const shallow = build(manyOutflows)
    const deep = build(manyOutflows, { depths: { [OUTFLOW]: 1 } })

    expect(shallow.nodes.map(n => n.name)).toContain('Expense 0')
    expect(deep.nodes.map(n => n.name)).not.toContain('Expense 0')
    expect(deep.nodes.map(n => n.name)).toContain('Expense 10')
    // The inflow side is untouched by the outflow side's depth.
    expect(nodeNamed(deep, 'Salary').side).toBe(INFLOW)
    expect(deep.outflowTotal).toBeCloseTo(shallow.outflowTotal)
  })

  it('collapses a dusting of tiny buckets even on a side too short to reach the named floor', () => {
    // The real case: eight inflow buckets, three of them substantial and the rest rounding error. The
    // shared minimum-named-slices floor would name all eight, and the smallest has no height to draw —
    // only its label, sitting on top of its neighbours'.
    const rows = [
      row('a', 'Paychecks', 'income', 84604.50),
      row('b', 'Paycheck', 'income', 33610.91),
      row('c', 'Other Income', 'income', 6296.59),
      row('d', 'Refunds', 'income', 900),
      row('e', 'Rebates', 'income', 300),
      row('f', 'Class Action Settlement', 'income', 120),
      row('g', 'Interest', 'income', 40),
      row('h', 'Interest Income', 'income', 0.55),
    ]
    const graph = build(rows)

    const inflowNames = graph.nodes.filter(n => n.side === INFLOW).map(n => n.name)
    expect(inflowNames).toEqual(['Paychecks', 'Paycheck', 'Other Income', 'Other (5)'])
    // Collapsing is a drawing decision only — the side still reports every penny.
    expect(graph.inflowTotal).toBeCloseTo(rows.reduce((s, r) => s + r.total, 0))
    expect(nodeNamed(graph, 'Other (5)').tailRows.map(r => r.category_name))
      .toEqual(['Refunds', 'Rebates', 'Class Action Settlement', 'Interest', 'Interest Income'])
  })

  it('clamps a drill depth past the last page instead of emptying the side', () => {
    const graph = build(manyOutflows, { depths: { [OUTFLOW]: 99 } })

    expect(graph.nodes.filter(n => n.side === OUTFLOW).length).toBeGreaterThan(0)
    expect(graph.outflowTotal).toBeCloseTo(build(manyOutflows).outflowTotal)
  })
})

describe('nodeFromTooltipPayload', () => {
  // The two shapes recharts actually produces. They differ only in what sits at `.payload`, which is
  // why reading a link as if it were a node fails silently rather than throwing.
  const salary = { name: 'Salary', cashValue: 3000, isHub: false }
  const hub = { name: 'Cash flow', cashValue: 1200, isHub: true }

  it('reads the node under a node hover', () => {
    const rendered = { x: 0, y: 0, width: 14, height: 40, index: 0, payload: salary }
    expect(nodeFromTooltipPayload([{ payload: rendered }])).toBe(salary)
  })

  it('reads the bucket end of a link rather than the hub every link touches', () => {
    const intoHub = { payload: { source: salary, target: hub, value: 3000 } }
    const outOfHub = { payload: { source: hub, target: salary, value: 3000 } }

    expect(nodeFromTooltipPayload([{ payload: intoHub }])).toBe(salary)
    expect(nodeFromTooltipPayload([{ payload: outOfHub }])).toBe(salary)
  })

  it('returns nothing when there is no active element', () => {
    expect(nodeFromTooltipPayload([])).toBeNull()
    expect(nodeFromTooltipPayload(undefined)).toBeNull()
    expect(nodeFromTooltipPayload([{}])).toBeNull()
  })
})

describe('cashFlowLabelLayout', () => {
  // The chart's own node padding. A node's label may use its own height plus this much before it runs
  // into the labels above and below it.
  const PADDING = 14

  function layout(height, name = 'Groceries', amount = '-$1,234.56') {
    return cashFlowLabelLayout({ height, padding: PADDING, name, amount })
  }

  it('stacks the name over the amount where there is room for both', () => {
    const label = layout(40)
    expect(label.lines).toBe(2)
    expect(label.name).toBe('Groceries')
    expect(label.amount).toBe('-$1,234.56')
  })

  it('drops to one line once two would overlap the neighbouring labels', () => {
    // A stacked pair spans ~27px; the slot is height + padding, so 13px of node is the last height that
    // can carry two lines and anything under it must fold onto one.
    expect(layout(13).lines).toBe(2)
    expect(layout(12).lines).toBe(1)
  })

  it('folds a sub-pixel node onto one line rather than overlapping its neighbours', () => {
    // The case from the real ledger: a bucket at 0.0004% of its side, drawn with no height at all.
    const label = layout(0, 'Interest Income', '$0.55')
    expect(label.lines).toBe(1)
    expect(label.name).toBe('Interest Income')
    expect(label.amount).toBe('$0.55')
  })

  it('gives the name whatever the amount leaves on a shared line', () => {
    const short = layout(0, 'Class Action Settlement', '$40.00')
    const long = layout(0, 'Class Action Settlement', '-$1,234,567.89')
    expect(short.name.length).toBeGreaterThan(long.name.length)
    expect(long.name.endsWith('…')).toBe(true)
  })

  it('never trims a name down to nothing but an ellipsis', () => {
    const label = layout(0, 'Class Action Settlement', '-$123,456,789,012.34')
    expect(label.name.length).toBeGreaterThanOrEqual(6)
  })

  it('still truncates a long name on the stacked form', () => {
    const label = layout(40, 'A category name far longer than the label margin allows')
    expect(label.lines).toBe(2)
    expect(label.name.endsWith('…')).toBe(true)
    expect(label.name.length).toBeLessThanOrEqual(26)
  })
})
