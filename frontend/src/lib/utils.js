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
  const parsed = new Date(value)
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
  const parsed = new Date(value)
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
