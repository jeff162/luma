// Amount formatting renders on every transaction row, chart, and report, and encodes a non-obvious
// invariant: bank feeds store spending as a positive debit, but the UI shows spending as NEGATIVE
// (getTransactionDisplayAmount flips the sign). A regression here silently mislabels every amount's
// sign/color, which is exactly the low-observability kind of bug nobody catches by eye. These pin the
// flip, the sign conventions, the compact axis tick, and the magnitude edge cases.

import { describe, it, expect } from 'vitest'
import {
  formatMoneyMagnitude,
  formatSignedMoneyAmount,
  formatSignedAxisTick,
  getTransactionDisplayAmount,
  formatTransactionAmount,
  getTransactionAmountColor,
} from '../moneyDisplay.js'

describe('formatMoneyMagnitude', () => {
  it('formats the absolute value with a symbol, grouping, and 2 decimals', () => {
    expect(formatMoneyMagnitude(1234.5)).toBe('$1,234.50')
    expect(formatMoneyMagnitude(-7.5)).toBe('$7.50')
  })
  it('coerces non-numeric input to zero rather than NaN', () => {
    expect(formatMoneyMagnitude('abc')).toBe('$0.00')
    expect(formatMoneyMagnitude(undefined)).toBe('$0.00')
  })
})

describe('formatSignedMoneyAmount sign conventions', () => {
  it('applies the negative-sign style', () => {
    expect(formatSignedMoneyAmount(-50)).toBe('-$50.00') // default: minus
    expect(formatSignedMoneyAmount(-50, { negativeSign: 'parentheses' })).toBe('($50.00)')
    expect(formatSignedMoneyAmount(-50, { negativeSign: 'none' })).toBe('$50.00')
  })
  it('applies the positive-sign style', () => {
    expect(formatSignedMoneyAmount(50)).toBe('$50.00') // default: no leading +
    expect(formatSignedMoneyAmount(50, { positiveSign: 'plus' })).toBe('+$50.00')
  })
})

describe('formatSignedAxisTick', () => {
  it('uses compact k-notation above the threshold, signed', () => {
    expect(formatSignedAxisTick(1500)).toBe('$1.5k')
    expect(formatSignedAxisTick(-2000)).toBe('-$2.0k')
  })
  it('rounds to a whole number below the threshold', () => {
    expect(formatSignedAxisTick(500)).toBe('$500')
    expect(formatSignedAxisTick(-750)).toBe('-$750')
    expect(formatSignedAxisTick(0)).toBe('$0')
  })
})

describe('transaction amount: the bank→UI sign flip', () => {
  it('flips the stored sign (spending stored positive shows negative, and vice versa)', () => {
    expect(getTransactionDisplayAmount(50)).toBe(-50)
    expect(getTransactionDisplayAmount(-50)).toBe(50)
  })
  it('renders spending as negative and income/refunds as positive', () => {
    expect(formatTransactionAmount(50)).toBe('-$50.00')  // a debit/purchase
    expect(formatTransactionAmount(-50)).toBe('$50.00')  // a credit/refund
    expect(formatTransactionAmount(0)).toBe('$0.00')
  })
  it('colors income positive and spending with the neutral text color', () => {
    expect(getTransactionAmountColor(-50)).toBe('var(--success)') // displays positive → income
    expect(getTransactionAmountColor(50)).toBe('var(--text)')     // displays negative → spending
    expect(getTransactionAmountColor(50, { negativeColor: 'red' })).toBe('red')
  })
})
