/*
 * The balance totals bridge has to land on the closing figure the card beside it shows, and its totals have to be
 * drawn as the same parts its steps change.
 */

import { describe, it, expect } from 'vitest'
import { bridgeRows, buildBridge } from '../balanceTotals.js'

const labels = { openingLabel: 'Opening', closingLabel: 'Closing' }

function account(amount, opening) {
  return { balance: amount == null ? null : { amount }, opening }
}

describe('buildBridge', () => {
  it('steps from the opening total by what each group moved, and lands on the closing total', () => {
    const steps = buildBridge([
      { key: 'depository', label: 'Checking', accounts: [account(800, 1000), account(50, 50)] },
      { key: 'credit', label: 'Credit cards', accounts: [account(-300, -100)] },
      // Opened in the period: it opens at zero, so its whole balance is its step.
      { key: 'savings', label: 'Savings', accounts: [account(5000, 0), account(null, null)] },
    ], { hasOpening: true, ...labels })
    expect(steps.map(s => [s.key, s.value, s.range])).toEqual([
      ['__opening', 950, [0, 950]],
      ['depository', -200, [950, 750]],
      ['credit', -200, [750, 550]],
      ['savings', 5000, [550, 5550]],
      ['__closing', 5550, [0, 5550]],
    ])
  })

  it('without an opening, shows what the total is made of', () => {
    const steps = buildBridge([
      { key: 'depository', label: 'Checking', accounts: [account(800, null)] },
      { key: 'loan', label: 'Loans', accounts: [account(-2000, null)] },
    ], { hasOpening: false, ...labels })
    expect(steps.map(s => [s.key, s.range])).toEqual([
      ['depository', [0, 800]],
      ['loan', [800, -1200]],
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
