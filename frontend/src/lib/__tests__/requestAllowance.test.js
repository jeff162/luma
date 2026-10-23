import { describe, expect, it } from 'vitest'

import { allowanceSummary, connectionsAllowanceLines } from '../requestAllowance.js'

describe('allowanceSummary', () => {
  const METER = { capacity: 22, refill_per_hour: 1 }

  it('says what is left on the shared pool and how fast it refills', () => {
    expect(allowanceSummary({ ...METER, pools: { shared: 6.4 } }))
      .toBe('6 of 22 requests left · 1 more each hour')
  })

  it('floors rather than rounds, since this is a spendable count', () => {
    // Claiming a request the server has not granted is the error that costs a disabled token.
    expect(allowanceSummary({ ...METER, pools: { shared: 5.9 } })).toBe('5 of 22 requests left · 1 more each hour')
  })

  it('reads an absent pool as a full one', () => {
    expect(allowanceSummary({ ...METER, pools: {} })).toBe('22 of 22 requests left · 1 more each hour')
  })

  it('names how long until the next request when everything is spent', () => {
    const text = allowanceSummary({ ...METER, pools: { shared: 0.25 } })
    expect(text).toBe('0 of 22 requests left · next request in ~45 min')
  })

  it('counts the accounts that ran dry, which a shared figure cannot show', () => {
    const text = allowanceSummary({ ...METER, pools: { shared: 9, 'p:a': 0, 'p:b': 0, 'p:c': 4 } })
    expect(text).toBe('9 of 22 requests left · 2 accounts out of requests · next request in ~1 hr')
  })

  it('reports the lowest account while all of them still have room', () => {
    const text = allowanceSummary({ ...METER, pools: { shared: 20, 'p:a': 3.2 } })
    expect(text).toBe('20 of 22 requests left · 3 left on the lowest account · 1 more each hour')
  })

  it('is null for a provider that meters nothing', () => {
    expect(allowanceSummary(null)).toBeNull()
  })
})

describe('connectionsAllowanceLines', () => {
  const allowance = { capacity: 22, refill_per_hour: 1, pools: { shared: 19.4 } }

  it('is one line for a single metered connection and none when none is metered', () => {
    expect(connectionsAllowanceLines([{ institution: 'A', request_allowance: allowance }]))
      .toEqual(['Requests: 19 of 22 requests left · 1 more each hour'])
    expect(connectionsAllowanceLines([{ institution: 'A', request_allowance: null }])).toEqual([])
  })

  it('names each connection when there are several', () => {
    expect(connectionsAllowanceLines([
      { institution: 'A', request_allowance: allowance },
      { institution: 'B', request_allowance: allowance },
    ])).toEqual([
      'A requests: 19 of 22 requests left · 1 more each hour',
      'B requests: 19 of 22 requests left · 1 more each hour',
    ])
  })
})
