// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

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

// Shared Recharts tooltip styling. Recharts colors each item's text using the
// data series color by default, which is unreadable on dark surfaces when the
// series happens to be a dark accent. Charts should spread these onto the
// `<Tooltip>` props (contentStyle / labelStyle / itemStyle) so the chrome
// stays themed and the value text always uses the page's text color.
export const CHART_TOOLTIP_CONTENT_STYLE = {
  background: 'var(--surface2)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  color: 'var(--text)',
}

export const CHART_TOOLTIP_LABEL_STYLE = {
  color: 'var(--text)',
}

export const CHART_TOOLTIP_ITEM_STYLE = {
  color: 'var(--text)',
}

// Compact signed axis label for charts whose y-axis can span both sides of zero
// (e.g. monthly-trend with refunds netting expense bars below zero). Renders as
// `-$1.5k` rather than the raw `$-1500` Recharts would otherwise emit.
export function formatSignedAxisTick(
  value,
  {
    currencySymbol = MONEY_DISPLAY_CONFIG.currencySymbol,
    decimals = 1,
    threshold = 1000,
  } = {},
) {
  const num = Number(value) || 0
  const sign = num < 0 ? '-' : ''
  const abs = Math.abs(num)
  if (abs >= threshold) {
    return `${sign}${currencySymbol}${(abs / 1000).toFixed(decimals)}k`
  }
  return `${sign}${currencySymbol}${Math.round(abs)}`
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
  // Bank feeds store debits/credits from the account's perspective; most UI reads better when spending displays as negative.
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
