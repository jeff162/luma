// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

import { format, parseISO, startOfMonth, subMonths } from 'date-fns'
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
