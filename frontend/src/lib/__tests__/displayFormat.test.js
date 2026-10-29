// The viewer's date order and number format reach every date and amount in the app through shared
// formatters, and typed amounts are read back in the same convention. The parse is the part that can be
// wrong about a number: `12,50` read with a decimal point is twelve hundred and fifty, accepted silently.

import { afterEach, describe, expect, it } from 'vitest'
import {
  applyDisplayFormat, formatAmountInput, formatCount, parseAmountInput,
} from '../displayFormat.js'
import { formatDate, formatDateRange, monthLabel } from '../utils.js'
import { applyLedgerCurrency, formatSignedAxisTick, formatTransactionAmount } from '../moneyDisplay.js'

afterEach(() => {
  applyDisplayFormat({})
  applyLedgerCurrency('USD')
})

describe('parseAmountInput', () => {
  it('reads each convention, and refuses the other one rather than guessing', () => {
    expect(parseAmountInput('1,234.56', 'point')).toBe(1234.56)
    expect(parseAmountInput('12,50', 'point')).toBeNaN()
    expect(parseAmountInput('1.234,56', 'comma')).toBe(1234.56)
    expect(parseAmountInput('12,5', 'comma')).toBe(12.5)
    expect(parseAmountInput('12.50', 'comma')).toBeNaN()
    expect(parseAmountInput('1 234,56', 'space')).toBe(1234.56)
  })

  it('accepts a symbol, a sign and accounting parentheses around the number', () => {
    expect(parseAmountInput('$1,234.56', 'point')).toBe(1234.56)
    expect(parseAmountInput('-12.5', 'point')).toBe(-12.5)
    expect(parseAmountInput('(12,50 €)', 'comma')).toBe(-12.5)
    expect(parseAmountInput('', 'point')).toBeNaN()
    expect(parseAmountInput('12abc', 'point')).toBeNaN()
  })

  it('round-trips what formatAmountInput writes', () => {
    for (const format of ['point', 'comma', 'space']) {
      expect(parseAmountInput(formatAmountInput(1234.5, { cents: true, numberFormat: format }), format)).toBe(1234.5)
    }
  })
})

describe('applied formats', () => {
  it('writes dates in the chosen order', () => {
    applyDisplayFormat({ dateOrder: 'dmy' })
    expect(formatDate('2026-02-01')).toBe('1 Feb 2026')
    expect(formatDateRange('2026-02-01', '2026-02-05')).toBe('1 – 5 Feb 2026')
    expect(formatDateRange('2026-02-01', '2026-03-05')).toBe('1 Feb – 5 Mar 2026')
    applyDisplayFormat({ dateOrder: 'ymd' })
    expect(formatDate('2026-02-01')).toBe('2026-02-01')
    expect(formatDateRange('2026-02-01', '2026-02-05')).toBe('2026-02-01 – 2026-02-05')
    expect(monthLabel('2026-02')).toBe('2026-02')
  })

  it('places separators and the symbol as the chosen format does', () => {
    // Intl separates with no-break spaces; compared as plain ones.
    const plain = text => text.replace(/\s/g, ' ')
    applyLedgerCurrency('EUR')
    applyDisplayFormat({ numberFormat: 'comma' })
    expect(plain(formatTransactionAmount(1234.56))).toBe('-1.234,56 €')
    expect(formatCount(12345)).toBe('12.345')
    expect(plain(formatSignedAxisTick(1500000))).toBe('1,5 Mio. €')
  })

  it('falls back to the defaults for an unknown stored value', () => {
    applyDisplayFormat({ dateOrder: 'nonsense', numberFormat: 'nonsense' })
    expect(formatDate('2026-02-01')).toBe('Feb 1, 2026')
    expect(formatTransactionAmount(-1234.5)).toBe('$1,234.50')
  })
})
