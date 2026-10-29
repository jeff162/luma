// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * How dates and numbers are written for the person looking at them: the order of a date's parts and
 * the separators of a number. Both are per-person preferences, not ledger state — two people reading
 * the same ledger may write `1 Feb` and `Feb 1` — unlike the ledger's currency, which says what the
 * stored numbers *mean* (`docs/data-model.md` → *Preferences*).
 *
 * - **Applied into a shared config, the way the currency is** (`MONEY_DISPLAY_CONFIG`). Every
 *   formatter reads it at call time, so nothing threads a context through the call sites. The
 *   consequence is the same too: a change does not re-render what is already on screen, so the
 *   control that changes it reloads the app.
 * - **Each number format names a locale**, and `Intl` derives everything from it: the separators, and
 *   where the currency symbol goes (`1.234,56 €`). The locale is a representative of the convention,
 *   not a claim about the person's language.
 * - **Typed input follows the same choice.** An amount typed into a box is read in the chosen
 *   convention (`parseAmountInput`), and the backend reads the quick filter from the same stored
 *   preferences (`backend/services/input_format.py`, whose keys and values match these).
 * - **The defaults are month first and a decimal point**, so a person who never chooses sees what the
 *   app always showed.
 */

export const DATE_ORDER_PREF_KEY = 'ui.format.dateOrder'
export const NUMBER_FORMAT_PREF_KEY = 'ui.format.number'

export const DATE_ORDER_MDY = 'mdy'
export const DATE_ORDER_DMY = 'dmy'
export const DATE_ORDER_YMD = 'ymd'
export const DATE_ORDERS = [DATE_ORDER_MDY, DATE_ORDER_DMY, DATE_ORDER_YMD]

export const NUMBER_FORMAT_POINT = 'point'
export const NUMBER_FORMAT_COMMA = 'comma'
export const NUMBER_FORMAT_SPACE = 'space'
export const NUMBER_FORMATS = [NUMBER_FORMAT_POINT, NUMBER_FORMAT_COMMA, NUMBER_FORMAT_SPACE]

export const DEFAULT_DATE_ORDER = DATE_ORDER_MDY
export const DEFAULT_NUMBER_FORMAT = NUMBER_FORMAT_POINT

const NUMBER_LOCALES = {
  [NUMBER_FORMAT_POINT]: 'en-US',
  [NUMBER_FORMAT_COMMA]: 'de-DE',
  [NUMBER_FORMAT_SPACE]: 'fr-FR',
}

export const DISPLAY_FORMAT = {
  dateOrder: DEFAULT_DATE_ORDER,
  numberFormat: DEFAULT_NUMBER_FORMAT,
  numberLocale: NUMBER_LOCALES[DEFAULT_NUMBER_FORMAT],
}

export function normalizeDateOrder(value) {
  return DATE_ORDERS.includes(value) ? value : DEFAULT_DATE_ORDER
}

export function normalizeNumberFormat(value) {
  return NUMBER_FORMATS.includes(value) ? value : DEFAULT_NUMBER_FORMAT
}

export function numberLocaleFor(numberFormat) {
  return NUMBER_LOCALES[normalizeNumberFormat(numberFormat)]
}

// Idempotent, so it is safe to call on every render of the component that owns the preferences.
export function applyDisplayFormat({ dateOrder, numberFormat } = {}) {
  DISPLAY_FORMAT.dateOrder = normalizeDateOrder(dateOrder)
  DISPLAY_FORMAT.numberFormat = normalizeNumberFormat(numberFormat)
  DISPLAY_FORMAT.numberLocale = NUMBER_LOCALES[DISPLAY_FORMAT.numberFormat]
}

const numberFormatters = new Map()

// A plain number in the chosen format, with exactly `digits` decimals: `1.234` for a count rather than a
// `1,234` that a reader of decimal commas takes for one and a quarter, `1,5` for a size or a share.
export function formatDecimal(value, digits) {
  const locale = DISPLAY_FORMAT.numberLocale
  const key = `${locale}|${digits}`
  let formatter = numberFormatters.get(key)
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits })
    numberFormatters.set(key, formatter)
  }
  return formatter.format(Number(value) || 0)
}

export function formatCount(value) {
  return formatDecimal(value, 0)
}

export function decimalSeparator(numberFormat = DISPLAY_FORMAT.numberFormat) {
  return normalizeNumberFormat(numberFormat) === NUMBER_FORMAT_POINT ? '.' : ','
}

// The grouped forms a convention accepts, with the same strictness as the import's parser
// (`backend/services/amount_text.py`): groups of exactly three, one decimal mark. A space group is
// whitespace, which is dropped before matching, so the comma pattern serves both comma conventions.
const AMOUNT_BODY = {
  '.': /^(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d*)?$/,
  ',': /^(?:\d{1,3}(?:\.\d{3})+|\d+)?(?:,\d*)?$/,
}

/*
 * The number a person typed into an amount box, in their chosen convention, or NaN when it is not one.
 *
 * Strict for the same reason the import is: `12,50` read with a decimal point is twelve hundred and
 * fifty, a wrong number accepted without a word. Refusing makes the box say "enter an amount" instead,
 * which the person can see and fix. A currency symbol, spaces, a sign and accounting parentheses are
 * accepted around the number.
 */
export function parseAmountInput(text, numberFormat = DISPLAY_FORMAT.numberFormat) {
  const separator = decimalSeparator(numberFormat)
  const compact = String(text ?? '').replace(/[\s\p{Sc}]/gu, '')
  const match = /^(?:([+\-−]?)([\d.,]+)|\(([\d.,]+)\))$/.exec(compact)
  if (!match) return NaN
  const body = match[2] ?? match[3]
  if (!AMOUNT_BODY[separator].test(body) || !/\d/.test(body)) return NaN
  const group = separator === '.' ? ',' : '.'
  const value = Number(body.split(group).join('').replace(separator, '.'))
  const negative = match[3] !== undefined || match[1] === '-' || match[1] === '−'
  return negative ? -value : value
}

// A figure written into an amount box for editing, in the chosen convention and with no grouping, so what
// the box shows is exactly what `parseAmountInput` reads back. Rounded to the cent and written as briefly
// as it can be (`60`, `12.5`), or with both decimals where the box is filled with a computed figure.
export function formatAmountInput(value, { cents = false, numberFormat = DISPLAY_FORMAT.numberFormat } = {}) {
  const rounded = Math.round((Number(value) || 0) * 100) / 100
  const text = cents ? rounded.toFixed(2) : String(rounded)
  return decimalSeparator(numberFormat) === '.' ? text : text.replace('.', ',')
}
