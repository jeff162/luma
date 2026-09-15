// @vitest-environment jsdom

// A detail panel's list pages in a hundred rows at a time, and its copy used to take only the rows scrolled
// to. `usePagedTransactions().copy` is what reaches the rest: through the panel's own `loadPage`, in the
// list's sort, and — for a list past the copy limit — as a download of the filter the panel fetches with.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { DETAIL_PAGE_SIZE, DETAIL_SORT_DEFAULT, usePagedTransactions } from '../detailShared.jsx'
import { downloadUrl } from '../../lib/api.js'

vi.mock('../../lib/api.js', () => ({
  api: { exportTransactionsCsv: vi.fn(params => params) },
  downloadUrl: vi.fn().mockResolvedValue(undefined),
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const ROWS = Array.from({ length: 250 }, (_, i) => ({ id: `t${i}` }))
const EXPORT_PARAMS = { payees: 'Corner Cafe', date_start: '2026-01-01', date_end: '2026-12-31' }

async function renderPaged(exportParams = EXPORT_PARAMS) {
  const loadPage = vi.fn(async (offset, limit) => ({ transactions: ROWS.slice(offset, offset + limit), total: ROWS.length }))
  const hook = renderHook(() => usePagedTransactions({ activeKey: 'panel', loadPage, exportParams }))
  await waitFor(() => expect(hook.result.current.total).toBe(ROWS.length))
  expect(hook.result.current.rows).toHaveLength(DETAIL_PAGE_SIZE)
  loadPage.mockClear()
  return { ...hook, loadPage }
}

describe('usePagedTransactions copy', () => {
  it('copies every row of the list, past the loaded page, through the list fetch and sort', async () => {
    const { result, loadPage } = await renderPaged()

    const rows = await result.current.copy.loadRows()

    expect(rows.map(r => r.id)).toEqual(ROWS.map(r => r.id))
    expect(loadPage).toHaveBeenCalledWith(0, 1000, DETAIL_SORT_DEFAULT)
  })

  it('serves a first-rows copy from the loaded page when it already holds them', async () => {
    const { result, loadPage } = await renderPaged()

    const rows = await result.current.copy.loadRows({ limit: 50 })

    expect(rows.map(r => r.id)).toEqual(ROWS.slice(0, 50).map(r => r.id))
    expect(loadPage).not.toHaveBeenCalled()
  })

  it('downloads the filter the list fetches with, in the list sort', async () => {
    const { result } = await renderPaged()

    await result.current.copy.onDownload()

    expect(downloadUrl).toHaveBeenCalledWith({
      ...EXPORT_PARAMS, sort_by: 'date', sort_dir: 'desc', columns: 'date,merchant_name,category,account,amount',
    })
  })

  it('offers no download without the filter', async () => {
    const { result } = await renderPaged(null)
    expect(result.current.copy.onDownload).toBeNull()
  })
})
