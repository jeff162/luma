// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import { buildBalancePayload } from '../manualBalance.js'

// A balance stored with the wrong sign raises nothing; it counts a debt as money held.
describe('buildBalancePayload', () => {
  const today = '2026-11-20'

  it('stores an owed amount as a negative position, whatever sign was typed', () => {
    expect(buildBalancePayload({ date: today, amount: '412.50', side: 'owed' }, today))
      .toEqual({ ok: true, date: today, balance: -412.5 })
    expect(buildBalancePayload({ date: today, amount: '-412.50', side: 'owed' }, today).balance).toBe(-412.5)
    expect(buildBalancePayload({ date: today, amount: '-80', side: 'held' }, today).balance).toBe(80)
  })

  it('accepts a zero balance and refuses a future date', () => {
    expect(buildBalancePayload({ date: today, amount: '0', side: 'owed' }, today).balance).toBe(0)
    expect(buildBalancePayload({ date: '2026-11-21', amount: '5', side: 'held' }, today).ok).toBe(false)
  })
})
