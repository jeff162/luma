/*
 * The balance totals bridge has to land on the closing figure the card beside it shows, and its totals have to be
 * drawn as the same parts its steps change.
 */

import { describe, it, expect } from 'vitest'
import { bridgeAxis, bridgeRows, buildBridge } from '../balanceTotals.js'

const labels = { openingLabel: 'Opening', closingLabel: 'Closing' }

function account(amount, opening) {
  return { balance: amount == null ? null : { amount }, opening }
}

describe('buildBridge', () => {
  it('steps from the opening total by what each group moved, the way the total went first', () => {
    const steps = buildBridge([
      { key: 'depository', label: 'Checking', accounts: [account(800, 1000), account(50, 50)] },
      { key: 'credit', label: 'Credit cards', accounts: [account(-300, -100)] },
      // Opened in the period: it opens at zero, so its whole balance is its step.
      { key: 'savings', label: 'Savings', accounts: [account(5000, 0), account(null, null)] },
    ], { hasOpening: true, ...labels })
    expect(steps.map(s => [s.key, s.value, s.range])).toEqual([
      ['__opening', 950, [0, 950]],
      // The total rose, so the rise comes first; the two equal falls keep the groups' order.
      ['savings', 5000, [950, 5950]],
      ['depository', -200, [5950, 5750]],
      ['credit', -200, [5750, 5550]],
      ['__closing', 5550, [0, 5550]],
    ])
  })

  it('without an opening, shows what the total is made of', () => {
    const steps = buildBridge([
      { key: 'depository', label: 'Checking', accounts: [account(800, null)] },
      { key: 'loan', label: 'Loans', accounts: [account(-2000, null)] },
    ], { hasOpening: false, ...labels })
    expect(steps.map(s => [s.key, s.range])).toEqual([
      // From zero the total fell, so the loan pulling it down comes first.
      ['loan', [0, -2000]],
      ['depository', [-2000, -1200]],
      ['__closing', [0, -1200]],
    ])
  })
})

describe('bridgeRows', () => {
  it('draws a total as its parts and a step as a spacer out to where it starts', () => {
    const rows = bridgeRows([
      { key: '__opening', kind: 'total', value: 700, range: [0, 700], parts: { depository: 1000, credit: -300 } },
      { key: 'depository', kind: 'step', value: -200, range: [700, 500] },
      { key: 'credit', kind: 'step', value: -900, range: [500, -400] },
      { key: 'loan', kind: 'step', value: -100, range: [-400, -500] },
    ])
    expect(rows[0]).toMatchObject({ 'part:depository': 1000, 'part:credit': -300 })
    expect(rows[1]).toMatchObject({ spacerHeld: 500, stepHeld: 200 })
    // Crossing zero, the step is drawn as its two sides.
    expect(rows[2]).toMatchObject({ stepHeld: 500, stepOwed: -400 })
    expect(rows[3]).toMatchObject({ spacerOwed: -400, stepOwed: -100 })
  })
})

describe('bridgeAxis', () => {
  it('reaches only a little past a small dip below zero, with no tick out there', () => {
    const axis = bridgeAxis(bridgeRows([
      { key: '__opening', kind: 'total', value: 58000, range: [0, 58000], parts: { savings: 61000, credit: -3000 } },
      { key: 'savings', kind: 'step', value: 520000, range: [58000, 578000] },
      { key: '__closing', kind: 'total', value: 578000, range: [0, 578000], parts: { savings: 580000, credit: -2000 } },
    ]))
    expect(axis.domain[0]).toBeGreaterThan(-25000)
    expect(axis.domain[1]).toBeGreaterThan(580000)
    expect(axis.ticks).toEqual([0, 150000, 300000, 450000])
  })

  it('labels the smaller side at its extent when it stands clear of zero', () => {
    const axis = bridgeAxis(bridgeRows([
      { key: '__opening', kind: 'total', value: 88000, range: [0, 88000], parts: { depository: 100000, loan: -12000 } },
    ]))
    // The step is $25K, so -$12K has no round tick of its own but is far enough out for a label.
    expect(axis.ticks).toEqual([-12000, 0, 25000, 50000, 75000, 100000])
  })
})
