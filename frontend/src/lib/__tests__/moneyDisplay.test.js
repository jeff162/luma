// Amount formatting renders on every transaction row, chart, and report, and encodes a non-obvious
// invariant: bank feeds store spending as a positive debit, but the UI shows spending as NEGATIVE
// (getTransactionDisplayAmount flips the sign). A regression here silently mislabels every amount's
// sign/color, which is exactly the low-observability kind of bug nobody catches by eye. These pin the
// flip, the sign conventions, the compact axis tick, and the magnitude edge cases.

import { describe, it, expect } from 'vitest'
import {
  MONEY_DISPLAY_CONFIG,
  applyLedgerCurrency,
  currencySymbolFor,
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
  it('uses the locale\'s compact notation from a thousand up, signed', () => {
    expect(formatSignedAxisTick(1500)).toBe('$1.5K')
    expect(formatSignedAxisTick(-2000)).toBe('-$2K')
    expect(formatSignedAxisTick(1500000)).toBe('$1.5M')
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

describe('ledger currency', () => {
  // The app holds one currency at a time and which one is a user setting, so the symbol has to follow it.
  // The bug this guards is the inverse of a formatting slip: a ledger set to AUD still rendering `$` is
  // *correct* (narrow symbol), while one set to EUR rendering `$` would mislabel every figure on screen.
  const restore = () => applyLedgerCurrency('USD')

  it('derives the symbol from the code rather than a hand-kept table', () => {
    expect(currencySymbolFor('USD')).toBe('$')
    expect(currencySymbolFor('EUR')).toBe('€')
    expect(currencySymbolFor('GBP')).toBe('£')
  })

  it('uses the narrow symbol, so an AUD ledger reads as $ not A$', () => {
    // Within an Australian ledger there is no other dollar to disambiguate from, and `A$12.00` on every
    // row would be noise rather than information.
    expect(currencySymbolFor('AUD')).toBe('$')
  })

  it('falls back to the code itself when there is no symbol', () => {
    // The backend validates a code's *shape*, not its membership of ISO-4217, so an unknown-but-plausible
    // code reaches here. Showing the code beats defaulting to a `$` that would be actively wrong.
    expect(currencySymbolFor('XYZ')).toBe('XYZ')
  })

  it('applying a currency changes what every formatter renders', () => {
    try {
      applyLedgerCurrency('EUR')
      expect(MONEY_DISPLAY_CONFIG.currencyCode).toBe('EUR')
      expect(formatMoneyMagnitude(1234.5)).toBe('€1,234.50')
      expect(formatSignedMoneyAmount(-50)).toBe('-€50.00')
    } finally {
      restore()
    }
  })

  it('normalizes case and falls back to the default when given nothing', () => {
    try {
      expect(applyLedgerCurrency('eur')).toBe('€')
      expect(MONEY_DISPLAY_CONFIG.currencyCode).toBe('EUR')
      applyLedgerCurrency('')
      expect(MONEY_DISPLAY_CONFIG.currencyCode).toBe('USD')
    } finally {
      restore()
    }
  })
})
