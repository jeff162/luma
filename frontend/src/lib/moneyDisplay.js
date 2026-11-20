// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { DISPLAY_FORMAT } from './displayFormat.js'

export const DEFAULT_LEDGER_CURRENCY = 'USD'

export const MONEY_DISPLAY_CONFIG = {
  // The ledger's currency, which every amount in the app is written in. Mutable and set once at boot from
  // the ledger's currency setting (`applyLedgerCurrency`) rather than passed through props: every
  // formatter below reads it at call time, so assigning it propagates to everything that renders
  // afterwards without threading a context through several hundred call sites. The cost of that is
  // honest — a change does not re-render on its own — which is why the Settings screen reloads after
  // saving rather than pretending the update is reactive. The separators and where the symbol sits come
  // from the viewer's number format (`displayFormat.js`), applied the same way.
  currencyCode: DEFAULT_LEDGER_CURRENCY,
  transaction: {
    positiveSign: 'none',
    negativeSign: 'minus',
    positiveColor: 'var(--success)',
    negativeColor: null,
    zeroColor: null,
  },
}

// A balance that needs a look (stale, or disagreeing with its transactions): the warning color toned toward
// the muted text these figures sit in, so it is easy to spot without the warning color's full weight.
export const BALANCE_WARNING_COLOR = 'color-mix(in srgb, var(--warning) 80%, var(--muted))'

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
  return currencySymbolFor(normalized)
}

// One formatter per locale, currency and shape, built on first use. A formatter is costly to construct and
// these run for every amount in a batch of thousands, so they are never built per call. `Intl` writes the
// currency's symbol and places it as the locale does (`$1,234.56`, `1.234,56 €`).
const moneyFormatters = new Map()

const MONEY_SHAPES = {
  exact: {},
  whole: { minimumFractionDigits: 0, maximumFractionDigits: 0 },
  compact: { notation: 'compact', minimumFractionDigits: 0, maximumFractionDigits: 1 },
}

function formatMoney(value, shape, currency = MONEY_DISPLAY_CONFIG.currencyCode) {
  const locale = DISPLAY_FORMAT.numberLocale
  const key = `${locale}|${currency}|${shape}`
  let formatter = moneyFormatters.get(key)
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, {
      style: 'currency', currency, currencyDisplay: 'narrowSymbol', ...MONEY_SHAPES[shape],
    })
    moneyFormatters.set(key, formatter)
  }
  return formatter.format(value)
}

export function formatMoneyMagnitude(amount) {
  return formatMoney(Math.abs(Number(amount) || 0), 'exact')
}

// A figure in a currency the ledger may not be in yet, for the currency setting's preview.
export function formatMoneyInCurrency(amount, currency) {
  return formatMoney(Math.abs(Number(amount) || 0), 'exact', currency)
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

// The label (the hovered month, year or slice) heads the card rather than reading as one more row.
export const CHART_TOOLTIP_LABEL_STYLE = {
  color: 'var(--text)',
  fontWeight: 600,
  paddingBottom: 4,
  marginBottom: 4,
  borderBottom: '1px solid var(--border)',
}

export const CHART_TOOLTIP_ITEM_STYLE = {
  color: 'var(--text)',
}

// Compact signed axis label for charts whose y-axis can span both sides of zero (e.g. monthly-trend with
// refunds netting expense bars below zero). Renders as `-$1.5K` rather than the raw `$-1500` Recharts
// would otherwise emit. Below a thousand it is a whole amount; above, the locale's own abbreviation
// (`1,5 k €`, and none at all for a German thousand, which writes `1500 €`).
//
// Takes the value alone: Recharts calls a `tickFormatter` with the tick's index as a second argument.
export function formatSignedAxisTick(value) {
  const num = Number(value) || 0
  const sign = num < 0 ? '-' : ''
  const abs = Math.abs(num)
  return `${sign}${formatMoney(abs, abs >= 1000 ? 'compact' : 'whole')}`
}

export function formatSignedMoneyAmount(
  amount,
  {
    positiveSign = MONEY_DISPLAY_CONFIG.transaction.positiveSign,
    negativeSign = MONEY_DISPLAY_CONFIG.transaction.negativeSign,
  } = {},
) {
  const magnitude = formatMoneyMagnitude(amount)
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

// Which way a transaction moves money: -1 when it is money in, 1 when it is money out. Named rather
// than written inline because two surfaces have to agree on it.
//
// It exists for splits. A part is stored in the transaction's own direction — every part shares its
// sign (`services/txn_splits.py`) — so rendering one raw inverts it against every other amount on
// screen: a deposit's parts read as negative beneath a row that reads positive, and its split has to be
// entered as a column of negative numbers. Multiplying by the direction states a part as what it
// contributes to the whole, so a charge and a deposit both read as magnitudes and direction is left to
// the transaction's own amount and color, the one place it is not redundant.
//
// Deliberately not `Math.abs`. Should a part ever be allowed to oppose its transaction — a refunded
// item inside an order, a relaxation the splits design leaves open — abs would print that refund as one
// more charge and the parts would visibly stop summing to the transaction, while this keeps it negative.
export function transactionDirection(amount) {
  return Number(amount) < 0 ? -1 : 1
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
