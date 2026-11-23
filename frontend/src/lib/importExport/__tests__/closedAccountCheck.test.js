// A mapping to a closed account is undecided for a file with rows after the close, unless chosen in this
// import. Getting it wrong either way is quiet: late rows land on a retired card, or an answer the person just
// gave is taken back. All data here is fabricated.

import { describe, it, expect } from 'vitest'
import { accountCloseDates, applyClosedAccountCheck } from '../closedAccountCheck.js'

const accounts = [
  { id: 'grp', name: 'Card', closed_on: '2026-05-31' },
  { id: 'old', name: 'Card', parent_account_id: 'grp', closed_on: '2026-03-31' },
  { id: 'chk', name: 'Checking', closed_on: null },
]

describe('closed account check', () => {
  it('closes a member at the earlier of its own date and its group\'s', () => {
    expect([...accountCloseDates(accounts)]).toEqual([['grp', '2026-05-31'], ['old', '2026-03-31']])
  })

  it('makes undecided only a closed account the file outlasts and the person did not choose here', () => {
    const map = {
      'Card 1': { accountId: 'old' },
      'Card 2': { accountId: 'grp' },
      'Card 3': { accountId: 'old', closedConfirmed: true },
      Checking: { accountId: 'chk' },
      Skipped: { accountId: '', skip: true },
    }
    const latest = { 'Card 1': '2026-04-01', 'Card 2': '2026-05-31', 'Card 3': '2026-06-01', Checking: '2026-09-01' }
    const next = applyClosedAccountCheck(map, latest, accountCloseDates(accounts))
    expect(next['Card 1']).toEqual({ accountId: '', closedNote: { accountId: 'old', closedOn: '2026-03-31' } })
    expect(next['Card 2']).toBe(map['Card 2'])
    expect(next['Card 3']).toBe(map['Card 3'])
    expect(next.Checking).toBe(map.Checking)
    expect(applyClosedAccountCheck(next, latest, accountCloseDates(accounts))).toBe(next)
  })
})
