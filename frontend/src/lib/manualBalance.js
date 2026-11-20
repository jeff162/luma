// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { parseAmountInput } from './displayFormat.js'
import { isIsoDate, round2 } from './manualTransaction.js'

/*
 * Turning a balance typed by hand into the position the ledger stores: positive held, negative owed
 * (`services/account_balances.py`). As with a hand-entered transaction, which way the money stands is a
 * control and the box takes a magnitude, so a card's "I owe 412.50" is typed as written and a typed "-"
 * cannot contradict the control on screen. Zero is a real balance, a card paid off.
 */

export const BALANCE_SIDES = [
  { value: 'held', label: 'Held' },
  { value: 'owed', label: 'Owed' },
]

// Credit and loan accounts are what the household owes on, so their balance is asked for that way round.
export function defaultBalanceSide(accountType) {
  return accountType === 'credit' || accountType === 'loan' ? 'owed' : 'held'
}

export function buildBalancePayload({ date, amount, side }, today) {
  const day = String(date || '').trim()
  if (!isIsoDate(day)) return { ok: false, reason: 'Enter the date as YYYY-MM-DD.' }
  if (day > today) return { ok: false, reason: "A balance can't be dated in the future." }
  const text = String(amount ?? '').trim()
  const value = text ? parseAmountInput(text) : NaN
  if (!Number.isFinite(value)) return { ok: false, reason: 'Enter an amount.' }
  const magnitude = round2(Math.abs(value))
  return { ok: true, date: day, balance: side === 'owed' && magnitude ? -magnitude : magnitude }
}
