import { describe, expect, it } from 'vitest'

import {
  buildTransactionPayload,
  isIsoDate,
  signedAmount,
  todayIsoDate,
} from '../manualTransaction.js'

const form = {
  payee: 'Corner Cafe',
  accountId: 'a1',
  date: '2026-08-14',
  amount: '12.50',
  direction: 'out',
  categoryId: null,
  notes: '',
}

describe('signedAmount', () => {
  it('stores money out positive and money in negative, which is the ledger convention', () => {
    // Backwards here would invert every hand-entered transaction while looking plausible on the way in.
    expect(signedAmount('12.50', 'out')).toBe(12.5)
    expect(signedAmount('12.50', 'in')).toBe(-12.5)
  })

  it('ignores a typed sign in favour of the direction control', () => {
    // Unlike an expected total, the direction is a control on screen with the answer already in it, so
    // a stray "-" is a typo rather than a second opinion — and honoring it would contradict the toggle.
    expect(signedAmount('-12.50', 'out')).toBe(12.5)
    expect(signedAmount('-12.50', 'in')).toBe(-12.5)
  })

  it('tolerates the way people actually type money', () => {
    expect(signedAmount('$1,250.00', 'out')).toBe(1250)
    expect(signedAmount(' 40 ', 'in')).toBe(-40)
  })

  it('returns null for anything that is not a usable amount', () => {
    expect(signedAmount('', 'out')).toBeNull()
    expect(signedAmount('   ', 'out')).toBeNull()
    expect(signedAmount('abc', 'out')).toBeNull()
    expect(signedAmount('0', 'out')).toBeNull()
    expect(signedAmount('0.00', 'in')).toBeNull()
  })
})

describe('todayIsoDate', () => {
  it('uses local parts, so the default is not yesterday west of Greenwich', () => {
    // toISOString converts to UTC; an afternoon in a negative-offset zone lands on the previous day.
    const evening = new Date(2026, 7, 14, 21, 30)
    expect(todayIsoDate(evening)).toBe('2026-08-14')
  })

  it('pads single-digit months and days', () => {
    expect(todayIsoDate(new Date(2026, 0, 5, 12))).toBe('2026-01-05')
  })
})

describe('isIsoDate', () => {
  it('accepts the ledger format and rejects the rest', () => {
    expect(isIsoDate('2026-08-14')).toBe(true)
    expect(isIsoDate('14/08/2026')).toBe(false)
    expect(isIsoDate('')).toBe(false)
  })
})

describe('buildTransactionPayload', () => {
  it('builds the request body from a complete form', () => {
    expect(buildTransactionPayload({ ...form, categoryId: 'c1', notes: ' Cash ' })).toEqual({
      ok: true,
      payload: {
        account_id: 'a1',
        date: '2026-08-14',
        amount: 12.5,
        payee: 'Corner Cafe',
        category_id: 'c1',
        notes: 'Cash',
      },
    })
  })

  it('leaves the category out rather than guessing, so the rules can claim it', () => {
    expect(buildTransactionPayload(form).payload.category_id).toBeNull()
  })

  it('names the box that needs attention rather than failing silently', () => {
    expect(buildTransactionPayload({ ...form, payee: '  ' }).reason).toMatch(/paid to/)
    expect(buildTransactionPayload({ ...form, accountId: '' }).reason).toMatch(/account/)
    expect(buildTransactionPayload({ ...form, date: '14/08/2026' }).reason).toMatch(/YYYY-MM-DD/)
    expect(buildTransactionPayload({ ...form, amount: '' }).reason).toMatch(/amount/)
  })
})
