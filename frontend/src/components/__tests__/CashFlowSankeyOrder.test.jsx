// @vitest-environment jsdom

/*
 * The cash-flow diagram draws each column in the order the graph gives it — the period's result at the
 * top, the buckets largest first, `Other` at the bottom. That order is decided in lib/cashFlowGraph.js and
 * tested there, but it only reaches the screen if recharts keeps it: by default its Sankey re-sorts each
 * column by where its layout passes left the nodes, which put `Other` in the middle of the column. So
 * this renders the real component and reads the order back off the drawn nodes.
 *
 * jsdom has no layout, so the responsive wrapper is replaced by one that hands the chart a fixed size.
 */

import { afterEach, describe, it, expect, vi } from 'vitest'
import { cloneElement } from 'react'
import { render, cleanup } from '@testing-library/react'
import CashFlowSankey from '../CashFlowSankey.jsx'
import { OUTFLOW, INFLOW, buildCashFlowGraph } from '../../lib/cashFlowGraph.js'

vi.mock('recharts', async importOriginal => {
  const actual = await importOriginal()
  return { ...actual, ResponsiveContainer: ({ children }) => cloneElement(children, { width: 900, height: 640 }) }
})

afterEach(cleanup)

function row(category_id, category_name, category_type, total) {
  return { category_id, category_name, category_type, total }
}

// Top-to-bottom names in one column, read off the drawn rectangles. Each node group carries a <title>
// of "name · amount" beside its rect.
function drawnOrder(container, side) {
  const nodes = [...container.querySelectorAll('g')]
    .map(g => ({ title: g.querySelector(':scope > title'), rect: g.querySelector(':scope > rect') }))
    .filter(({ title, rect }) => title && rect)
    .map(({ title, rect }) => ({
      name: title.textContent.split(' · ')[0],
      x: Number(rect.getAttribute('x')),
      y: Number(rect.getAttribute('y')),
    }))
  const xs = nodes.map(n => n.x)
  const columnX = side === INFLOW ? Math.min(...xs) : Math.max(...xs)
  return nodes.filter(n => n.x === columnX).sort((a, b) => a.y - b.y).map(n => n.name)
}

describe('CashFlowSankey column order', () => {
  it('draws each side in the graph order, result first and Other last', () => {
    const graph = buildCashFlowGraph([
      row('pay', 'Salary', 'income', 9000),
      row('side', 'Side work', 'income', 700),
      row('rent', 'Rent', 'expense', 2400),
      row('food', 'Groceries', 'expense', 900),
      row('car', 'Car', 'expense', 450),
      row('fun', 'Going out', 'expense', 300),
      row('gift', 'Gifts', 'expense', 220),
      row('util', 'Utilities', 'expense', 180),
      row('phone', 'Phone', 'expense', 90),
      row('books', 'Books', 'expense', 60),
      row('pets', 'Pets', 'expense', 45),
      row('fees', 'Fees', 'expense', 30),
      ...Array.from({ length: 6 }, (_, i) => row(`s${i}`, `Small ${i}`, 'expense', 2)),
    ], { keyField: 'category_id', nameField: 'category_name', palette: ['#111', '#222', '#333'] })

    const expected = graph.nodes.filter(n => n.side === OUTFLOW).map(n => n.name)
    expect(expected[0]).toBe('Net saved')
    expect(expected[expected.length - 1]).toMatch(/^Other \(/)

    const { container } = render(<CashFlowSankey graph={graph} depths={{}} onNodeClick={() => {}} onBack={() => {}} />)
    expect(drawnOrder(container, OUTFLOW)).toEqual(expected)
    expect(drawnOrder(container, INFLOW)).toEqual(graph.nodes.filter(n => n.side === INFLOW).map(n => n.name))
  })
})
