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
