// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { format, parseISO, subMonths } from 'date-fns'
import { formatMoneyMagnitude } from './moneyDisplay.js'

export function formatCurrency(amount) {
  return formatMoneyMagnitude(amount)
}

export function formatDate(dateStr) {
  return format(parseISO(dateStr), 'MMM d, yyyy')
}

// **The backend's timestamps are UTC and say so nowhere.** `utcnow_iso()` emits
// `2026-10-16T21:53:00.123456` and SQLite's `datetime('now')` column defaults emit
// `2026-10-16 21:53:00` — both UTC, neither carrying a `Z` or an offset. `new Date` is specified to
// read a zone-less *date-time* as **local**, so every displayed time came out shifted by the viewer's
// own offset: four hours late in New York. Worse for the relative form, which clamps a
// seemingly-future value to zero and so read a sync from three hours ago as "just now" — the one
// thing that label exists to rule out.
//
// Corrected on the way in rather than at the writer, because the rows already in every database are
// naive: changing what the backend writes would fix new timestamps and leave every stored one wrong.
//
// Anything that already states a zone passes through untouched, as do a `Date`, a number, and a
// date-only string — `new Date('2026-10-16')` is UTC by specification already, and appending to it
// would change which day it lands on.
const ZONELESS_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/

export function parseTimestamp(value) {
  if (value == null) return new Date(NaN)
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (ZONELESS_DATETIME.test(trimmed)) return new Date(`${trimmed.replace(' ', 'T')}Z`)
  }
  return new Date(value)
}

// A past moment ("last used", "last synced") as an absolute date and time. This is the default, and the
// right choice wherever a timestamp sits in a list beside other timestamps: absolute values compare
// against each other, and a column of "2h ago" / "3h ago" makes the reader do arithmetic to order rows
// that a date orders for them. It is also true whenever it happens to be drawn, which a relative label
// computed at render time is not — on a page left open, "5m ago" can be an hour old with nothing to say
// so. See `formatRelativeTimestamp` below for the narrow case that outweighs both, and the hook that
// keeps it honest. Returns null for a missing or unparseable value so callers can supply their own
// empty-state wording.
export function formatTimestamp(value) {
  if (!value) return null
  const parsed = parseTimestamp(value)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed.toLocaleString([], {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

// The same moment as an age ("2h ago"), for the one place an absolute timestamp does not fit: a single
// standing figure in narrow chrome, where the question is "how stale is this?" rather than "when exactly?"
// — the navigation pane's sync control is the case it was written for, and a resizable pane has no room
// for "9/5/2026, 07:40 AM" whatever it is doing.
//
// Two rules keep it from being the lie the absolute form is not. A caller must pair it with the absolute
// value on hover, so the exact moment is never actually lost; and a caller that stands on screen must
// re-render it as it ages (`useRelativeTimestamp`), because the drift a render-time label accumulates is
// real and is why this is the exception rather than the default.
//
// A value in the future is reported as "just now" rather than as a negative age: the only way to get one
// is clock skew between this machine and the server, and an age counting upward from a moment that has
// not happened reads as a bug in the app rather than as a disagreement about the time.
export function formatRelativeTimestamp(value, now = Date.now()) {
  if (!value) return null
  const parsed = parseTimestamp(value)
  if (Number.isNaN(parsed.getTime())) return null
  const seconds = Math.max(0, Math.round((now - parsed.getTime()) / 1000))
  if (seconds < 45) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${Math.max(1, minutes)}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  // Past a week the age stops being the useful form — "23d ago" is harder to place than a date, and the
  // reason for a relative label (a number that fits in narrow chrome) is satisfied by a short date too.
  if (days <= 7) return `${days}d ago`
  return parsed.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

// A date as the ledger writes one, from its local parts, so it is the user's calendar day. Not toISOString,
// which converts to UTC and hands back yesterday for anyone west of Greenwich after their afternoon.
export function localIsoDate(date = new Date()) {
  return format(date, 'yyyy-MM-dd')
}

export function currentMonth() {
  return format(new Date(), 'yyyy-MM')
}

export function monthLabel(yyyyMM) {
  return format(parseISO(`${yyyyMM}-01`), 'MMM yyyy')
}

export function lastNMonths(n = 6) {
  const months = []
  for (let i = n - 1; i >= 0; i--) {
    months.push(format(subMonths(new Date(), i), 'yyyy-MM'))
  }
  return months
}

export function isIncome(amount) {
  // Plaid amounts are account-centric, so income detection has to invert the usual "positive means money in" intuition.
  return amount < 0
}

// The href we're willing to render for a URL that came out of an imported file (an Amazon order's own
// page, say). Only http(s) survives: a crafted import could otherwise carry a `javascript:` URL, and
// React renders those with a warning rather than blocking them — so an innocuous-looking link in a hover
// card would execute script in the app's origin. Returns null for anything unsafe or unparseable
// (including relative URLs, which have no absolute target to open), so callers can skip the link.
export function safeExternalUrl(value) {
  const text = String(value ?? '').trim()
  if (!text) return null
  try {
    const { protocol } = new URL(text)
    return protocol === 'http:' || protocol === 'https:' ? text : null
  } catch {
    return null
  }
}
