import { describe, it, expect } from 'vitest'
import {
  expectedTotalInputValue,
  livePaymentsTotal,
  paymentPositionLabel,
  planPurchaseLink,
  purchaseDisplayLabel,
  purchaseRowSummary,
  purchaseMarkerTooltip,
  signedExpectedTotal,
  suggestPurchaseLabel,
} from '../purchaseLinks.js'

// Spending is stored positive (amount > 0 is money out) and displayed negative, so every expectation
// about a sign here is a claim about that seam rather than about arithmetic.
const deposit = { txn_id: 'dep', amount: 2400, trashed: false }
const balance = { txn_id: 'bal', amount: 3600, trashed: false }
const refund = { txn_id: 'ref', amount: -500, trashed: false }

describe('livePaymentsTotal', () => {
  it('nets the payments, refunds included', () => {
    expect(livePaymentsTotal([deposit, balance, refund])).toBe(5500)
  })

  it('leaves a trashed payment out — it is money not in the ledger', () => {
    expect(livePaymentsTotal([deposit, { ...balance, trashed: true }])).toBe(2400)
  })

  it('is zero for nothing at all', () => {
    expect(livePaymentsTotal([])).toBe(0)
    expect(livePaymentsTotal(undefined)).toBe(0)
  })
})

describe('signedExpectedTotal', () => {
  it('reads a typed magnitude in the direction of the payments', () => {
    expect(signedExpectedTotal('6000', [deposit, balance])).toBe(6000)
  })

  it('points the other way when the payments do', () => {
    expect(signedExpectedTotal('6000', [{ amount: -2400 }, { amount: -3600 }])).toBe(-6000)
  })

  it('honors a sign the user typed rather than overriding it', () => {
    expect(signedExpectedTotal('-6000', [deposit, balance])).toBe(-6000)
  })

  it('defaults to money out when the payments net to nothing', () => {
    expect(signedExpectedTotal('100', [{ amount: 50 }, { amount: -50 }])).toBe(100)
  })

  it('treats an empty box as "not stated", which is not zero', () => {
    expect(signedExpectedTotal('', [deposit])).toBeNull()
    expect(signedExpectedTotal('   ', [deposit])).toBeNull()
    expect(signedExpectedTotal(null, [deposit])).toBeNull()
    expect(signedExpectedTotal('abc', [deposit])).toBeNull()
  })

  it('accepts a typed currency symbol and separators', () => {
    expect(signedExpectedTotal('$6,000.50', [deposit, balance])).toBe(6000.5)
  })

  it('round-trips through the edit box without flipping sign', () => {
    const stored = signedExpectedTotal('6000', [deposit, balance])
    expect(signedExpectedTotal(expectedTotalInputValue(stored), [deposit, balance])).toBe(stored)
    const negative = signedExpectedTotal('6000', [{ amount: -1 }])
    expect(signedExpectedTotal(expectedTotalInputValue(negative), [{ amount: -1 }])).toBe(negative)
  })

  it('has no expected total to put in the box when none was stated', () => {
    expect(expectedTotalInputValue(null)).toBe('')
    expect(expectedTotalInputValue(undefined)).toBe('')
  })
})

describe('paymentPositionLabel', () => {
  it('numbers the payment within its purchase', () => {
    expect(paymentPositionLabel({ position: 1, payment_count: 2 })).toBe('Payment 1 of 2')
  })

  it('does not give a trashed payment a place in the sequence', () => {
    expect(paymentPositionLabel({ position: null, payment_count: 2 }))
      .toBe('Removed payment · 2 in this purchase')
  })

  it('says something sensible with nothing to count', () => {
    expect(paymentPositionLabel({})).toBe('Linked payment')
    expect(paymentPositionLabel()).toBe('Linked payment')
  })
})

describe('purchaseDisplayLabel', () => {
  it('falls back when a purchase was never named', () => {
    expect(purchaseDisplayLabel({ label: 'Kitchen counters' })).toBe('Kitchen counters')
    expect(purchaseDisplayLabel({ label: '   ' })).toBe('Linked purchase')
    expect(purchaseDisplayLabel(null)).toBe('Linked purchase')
  })
})

describe('purchaseMarkerTooltip', () => {
  it('states the ordinal, the name and the totals', () => {
    expect(purchaseMarkerTooltip({
      position: 1, payment_count: 2, label: 'Kitchen counters',
      linked_total: 2400, expected_total: 6000,
    })).toBe('Payment 1 of 2 · Kitchen counters · -$2,400.00 of -$6,000.00')
  })

  it('says less rather than inventing a total that was never stated', () => {
    expect(purchaseMarkerTooltip({
      position: 2, payment_count: 2, label: 'Deck', linked_total: 6000, expected_total: null,
    })).toBe('Payment 2 of 2 · Deck · -$6,000.00 linked')
  })

  it('is empty for a row that is not part of a purchase', () => {
    expect(purchaseMarkerTooltip(null)).toBe('')
  })
})

describe('planPurchaseLink', () => {
  const free = id => ({ id, purchase: null })
  const inPurchase = (id, purchaseId, label) => ({ id, purchase: { id: purchaseId, label } })

  it('creates one from a selection of unlinked payments', () => {
    const plan = planPurchaseLink([free('a'), free('b')])
    expect(plan.mode).toBe('create')
    expect(plan.rows.map(r => r.id)).toEqual(['a', 'b'])
  })

  it('adds to the purchase already represented — the third instalment case', () => {
    const plan = planPurchaseLink([inPurchase('a', 'p1', 'Deck'), free('c')])
    expect(plan.mode).toBe('add')
    expect(plan.purchase.id).toBe('p1')
    expect(plan.rows.map(r => r.id)).toEqual(['c'])
  })

  it('refuses a selection spanning two purchases rather than merging them', () => {
    const plan = planPurchaseLink([inPurchase('a', 'p1'), inPurchase('b', 'p2')])
    expect(plan.mode).toBe('blocked')
    expect(plan.reason).toMatch(/different purchases/)
  })

  it('refuses a selection that is already entirely one purchase', () => {
    const plan = planPurchaseLink([inPurchase('a', 'p1', 'Deck'), inPurchase('b', 'p1', 'Deck')])
    expect(plan.mode).toBe('blocked')
    expect(plan.reason).toMatch(/already grouped as Deck/)
  })

  it('refuses a single payment — one payment is not a purchase', () => {
    expect(planPurchaseLink([free('a')]).mode).toBe('blocked')
    expect(planPurchaseLink([]).mode).toBe('blocked')
  })
})

describe('suggestPurchaseLabel', () => {
  it('proposes the shared payee', () => {
    expect(suggestPurchaseLabel([
      { display_name: 'Riverstone Joinery' },
      { display_name: 'Riverstone Joinery' },
    ])).toBe('Riverstone Joinery')
  })

  it('proposes nothing rather than picking one of several payees', () => {
    expect(suggestPurchaseLabel([{ display_name: 'Riverstone' }, { display_name: 'Northgate' }])).toBe('')
  })

  it('falls back through the name fields the ledger itself uses', () => {
    expect(suggestPurchaseLabel([{ merchant_name: 'Harborline' }, { raw_name: 'Harborline' }]))
      .toBe('Harborline')
  })
})

describe('purchaseRowSummary', () => {
  // The detail panel patches the ledger row behind it from the full record, so this derivation has to
  // agree with the server's (`purchase_map_for`) — the whole reason it exists in one place.
  const record = {
    id: 'p1',
    label: 'Kitchen counters',
    expected_total: 6000,
    payments: [deposit, balance],
  }

  it('numbers the payment within its purchase and totals the rest', () => {
    expect(purchaseRowSummary(record, 'bal')).toEqual({
      id: 'p1',
      label: 'Kitchen counters',
      position: 2,
      payment_count: 2,
      linked_total: 6000,
      expected_total: 6000,
    })
  })

  it('gives a trashed payment no place in the sequence, like the server does', () => {
    const withTrashed = { ...record, payments: [deposit, { ...balance, trashed: true }] }
    const summary = purchaseRowSummary(withTrashed, 'bal')
    expect(summary.position).toBeNull()
    expect(summary.payment_count).toBe(1)
    expect(summary.linked_total).toBe(2400)
  })

  it('reports a missing expected total as null rather than undefined', () => {
    const summary = purchaseRowSummary({ ...record, expected_total: undefined }, 'dep')
    expect(summary.expected_total).toBeNull()
  })

  it('is null when there is no purchase', () => {
    expect(purchaseRowSummary(null, 'dep')).toBeNull()
  })
})
