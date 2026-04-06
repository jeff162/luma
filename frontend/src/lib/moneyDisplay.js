// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

const DECIMAL_FORMATTER = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

export const MONEY_DISPLAY_CONFIG = {
  currencySymbol: '$',
  transaction: {
    positiveSign: 'none',
    negativeSign: 'minus',
    positiveColor: 'var(--success)',
    negativeColor: null,
    zeroColor: null,
  },
}

export function formatMoneyMagnitude(amount, { currencySymbol = MONEY_DISPLAY_CONFIG.currencySymbol } = {}) {
  return `${currencySymbol}${DECIMAL_FORMATTER.format(Math.abs(Number(amount) || 0))}`
}

export function formatSignedMoneyAmount(
  amount,
  {
    currencySymbol = MONEY_DISPLAY_CONFIG.currencySymbol,
    positiveSign = MONEY_DISPLAY_CONFIG.transaction.positiveSign,
    negativeSign = MONEY_DISPLAY_CONFIG.transaction.negativeSign,
  } = {},
) {
  const magnitude = formatMoneyMagnitude(amount, { currencySymbol })
  if (amount < 0) {
    if (negativeSign === 'parentheses') return `(${magnitude})`
    if (negativeSign === 'none') return magnitude
    return `-${magnitude}`
  }
  if (amount > 0 && positiveSign === 'plus') return `+${magnitude}`
  return magnitude
}

export function getTransactionDisplayAmount(amount) {
  return -(Number(amount) || 0)
}

export function formatTransactionAmount(amount, options = {}) {
  return formatSignedMoneyAmount(getTransactionDisplayAmount(amount), options)
}

export function getTransactionAmountColor(
  amount,
  {
    positiveColor = MONEY_DISPLAY_CONFIG.transaction.positiveColor,
    negativeColor = MONEY_DISPLAY_CONFIG.transaction.negativeColor,
    zeroColor = MONEY_DISPLAY_CONFIG.transaction.zeroColor,
  } = {},
) {
  const displayAmount = getTransactionDisplayAmount(amount)
  if (displayAmount > 0) return positiveColor || 'var(--text)'
  if (displayAmount < 0) return negativeColor || 'var(--text)'
  return zeroColor || 'var(--text)'
}
