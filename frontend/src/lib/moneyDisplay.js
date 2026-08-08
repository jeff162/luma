// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

const DECIMAL_FORMATTER = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

export const DEFAULT_LEDGER_CURRENCY = 'USD'

export const MONEY_DISPLAY_CONFIG = {
  // The symbol every amount in the app is prefixed with. Mutable and set once at boot from the ledger's
  // currency setting (`applyLedgerCurrency`) rather than passed through props: every formatter below
  // already reads it as a *default argument*, which is evaluated per call, so assigning it propagates to
  // everything that renders afterwards without threading a context through several hundred call sites.
  // The cost of that is honest — a change does not re-render on its own — which is why the Settings
  // screen reloads after saving rather than pretending the update is reactive.
  currencySymbol: '$',
  currencyCode: DEFAULT_LEDGER_CURRENCY,
  transaction: {
    positiveSign: 'none',
    negativeSign: 'minus',
    positiveColor: 'var(--success)',
    negativeColor: null,
    zeroColor: null,
  },
}

export function currencySymbolFor(code) {
  // Asked of Intl rather than kept as a table: the browser already ships CLDR, and a hand-maintained map
  // would be one more thing to update per currency — the exact kind of omission that blocks a user for no
  // real reason. `narrowSymbol` is deliberate: an Australian ledger should read `$12.00`, not `A$12.00`,
  // because within it there is no other dollar to disambiguate from.
  try {
    const parts = new Intl.NumberFormat(undefined, {
      style: 'currency', currency: code, currencyDisplay: 'narrowSymbol',
    }).formatToParts(0)
    return parts.find(p => p.type === 'currency')?.value || code
  } catch {
    // An unknown-but-well-formed code (the backend validates shape, not membership) has no symbol. The
    // code itself is a perfectly readable stand-in and is better than falling back to a wrong `$`.
    return code
  }
}

export function applyLedgerCurrency(code) {
  const normalized = String(code || '').trim().toUpperCase() || DEFAULT_LEDGER_CURRENCY
  MONEY_DISPLAY_CONFIG.currencyCode = normalized
  MONEY_DISPLAY_CONFIG.currencySymbol = currencySymbolFor(normalized)
  return MONEY_DISPLAY_CONFIG.currencySymbol
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
