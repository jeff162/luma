import { beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '../api.js'
import { fetchAllMatchingTransactions, TRANSACTIONS_REQUEST_MAX_ROWS } from '../allMatchingTransactions.js'

vi.mock('../api.js', () => ({ api: { getTransactions: vi.fn() }, downloadUrl: vi.fn() }))

// A server holding `ids` that behaves like the real endpoint: pages by offset, refuses an oversized limit.
function serve(ids) {
  api.getTransactions.mockImplementation(async ({ limit, offset }) => {
    if (limit > TRANSACTIONS_REQUEST_MAX_ROWS) throw new Error('422')
    return { transactions: ids.slice(offset, offset + limit).map(id => ({ id })), total: ids.length }
  })
}

describe('fetchAllMatchingTransactions', () => {
  // Braced: a function returned from beforeEach is run as the test's cleanup, and the mock is a function.
  beforeEach(() => { api.getTransactions.mockReset() })

  it('reaches past the per-request cap, in order, without asking for more than the server allows', async () => {
    // The copy it replaced asked for `limit: total`, which the server refuses once a ledger passes 1000 rows.
    const ids = Array.from({ length: 2345 }, (_, i) => `t${i}`)
    serve(ids)

    const rows = await fetchAllMatchingTransactions({ sort_by: 'date', sort_dir: 'desc' })

    expect(rows.map(r => r.id)).toEqual(ids)
    expect(api.getTransactions).toHaveBeenCalledTimes(3)
    expect(api.getTransactions).toHaveBeenLastCalledWith({ sort_by: 'date', sort_dir: 'desc', limit: 1000, offset: 2000 })
  })

  it('stops at maxRows, asking only for the rows still wanted', async () => {
    const ids = Array.from({ length: 2345 }, (_, i) => `t${i}`)
    serve(ids)

    const rows = await fetchAllMatchingTransactions({}, { maxRows: 1500 })

    expect(rows.map(r => r.id)).toEqual(ids.slice(0, 1500))
    expect(api.getTransactions).toHaveBeenCalledTimes(2)
    expect(api.getTransactions).toHaveBeenLastCalledWith({ limit: 500, offset: 1000 })
  })

  it('stops when the result shrinks underneath the walk', async () => {
    api.getTransactions
      .mockResolvedValueOnce({ transactions: [{ id: 'a' }, { id: 'b' }], total: 4 })
      .mockResolvedValueOnce({ transactions: [], total: 2 })

    await expect(fetchAllMatchingTransactions({}, { pageSize: 2 })).resolves.toEqual([{ id: 'a' }, { id: 'b' }])
    expect(api.getTransactions).toHaveBeenCalledTimes(2)
  })
})
