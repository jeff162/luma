// @vitest-environment jsdom

// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// The preview's amounts are the backend's answer, so what matters on this side is that the right
// question gets asked and the answer survives to the row: the request refires when the convention or
// a mapped amount column changes, a request in flight doesn't blank the amounts already on screen,
// and a failure falls back to nulls (the raw cell) rather than a stale or invented number.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'

import {
  PREVIEW_AMOUNTS_DEBOUNCE_MS,
  buildPreviewAmountsRequest,
  mergePreviewAmounts,
  usePreviewAmounts,
} from '../previewAmounts.js'
import { api } from '../../api.js'

vi.mock('../../api.js', () => ({ api: { previewAmounts: vi.fn() } }))

const ROWS = [{ Amount: '27.52', Type: 'debit' }, { Amount: '100.00', Type: 'credit' }]

describe('buildPreviewAmountsRequest', () => {
  it('sends the rows, the convention, and the four amount columns', () => {
    expect(buildPreviewAmountsRequest({
      rows: ROWS,
      amountConvention: 'single_unsigned',
      columnMap: { amount: 'Amount', direction: 'Type' },
    })).toEqual({
      rows: ROWS,
      amount_convention: 'single_unsigned',
      column_map: { amount: 'Amount', debit: null, credit: null, direction: 'Type' },
    })
  })

  it('asks for nothing when there are no rows', () => {
    expect(buildPreviewAmountsRequest({
      rows: [], amountConvention: 'single_signed', columnMap: { amount: 'Amount' },
    })).toBe(null)
  })

  it('asks for nothing until an amount-bearing column is mapped', () => {
    expect(buildPreviewAmountsRequest({
      rows: ROWS, amountConvention: 'single_signed', columnMap: { direction: 'Type' },
    })).toBe(null)
  })

  it('still asks when only one side of a two-column mapping is picked', () => {
    // Half-configured is the server's call to answer with nulls — not a question the client withholds.
    expect(buildPreviewAmountsRequest({
      rows: ROWS, amountConvention: 'two_column', columnMap: { debit: 'Debit' },
    })).toEqual({
      rows: ROWS,
      amount_convention: 'two_column',
      column_map: { amount: null, debit: 'Debit', credit: null, direction: null },
    })
  })
})

describe('mergePreviewAmounts', () => {
  const rows = [{ i: 0, amount: null }, { i: 1, amount: null }]

  it('places each amount on the row at the same position', () => {
    expect(mergePreviewAmounts(rows, [27.52, -100]).map(r => r.amount)).toEqual([27.52, -100])
  })

  it('keeps a null amount null, including zero-vs-null', () => {
    expect(mergePreviewAmounts(rows, [0, null]).map(r => r.amount)).toEqual([0, null])
  })

  it('leaves rows unparsed when no amounts have arrived, or the answer is short', () => {
    expect(mergePreviewAmounts(rows, null)).toBe(rows)
    expect(mergePreviewAmounts(rows, [27.52]).map(r => r.amount)).toEqual([27.52, null])
  })
})

describe('usePreviewAmounts', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    api.previewAmounts.mockReset()
    api.previewAmounts.mockResolvedValue({ amounts: [27.52, -100] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const mount = (props) => renderHook(
    ({ rows, convention, columnMap }) => usePreviewAmounts(rows, convention, columnMap),
    { initialProps: props },
  )

  // The debounce means nothing resolves until time is advanced; this settles both.
  async function settle() {
    await act(async () => {
      vi.advanceTimersByTime(PREVIEW_AMOUNTS_DEBOUNCE_MS)
    })
  }

  it('fetches the amounts for the current mapping', async () => {
    const { result } = mount({
      rows: ROWS, convention: 'single_unsigned', columnMap: { amount: 'Amount', direction: 'Type' },
    })
    expect(result.current).toBe(null)
    await settle()
    expect(api.previewAmounts).toHaveBeenCalledWith({
      rows: ROWS,
      amount_convention: 'single_unsigned',
      column_map: { amount: 'Amount', debit: null, credit: null, direction: 'Type' },
    })
    expect(result.current).toEqual([27.52, -100])
  })

  it('refetches when the amount convention changes', async () => {
    const props = { rows: ROWS, convention: 'single_signed', columnMap: { amount: 'Amount' } }
    const { rerender } = mount(props)
    await settle()
    expect(api.previewAmounts).toHaveBeenCalledTimes(1)

    rerender({ ...props, convention: 'single_unsigned' })
    await settle()
    expect(api.previewAmounts).toHaveBeenCalledTimes(2)
    expect(api.previewAmounts.mock.calls[1][0].amount_convention).toBe('single_unsigned')
  })

  it('refetches when a mapped amount column changes', async () => {
    const props = { rows: ROWS, convention: 'single_unsigned', columnMap: { amount: 'Amount' } }
    const { rerender } = mount(props)
    await settle()

    rerender({ ...props, columnMap: { amount: 'Amount', direction: 'Type' } })
    await settle()
    expect(api.previewAmounts).toHaveBeenCalledTimes(2)
    expect(api.previewAmounts.mock.calls[1][0].column_map.direction).toBe('Type')
  })

  it('does not refetch when an unrelated column mapping changes', async () => {
    const props = { rows: ROWS, convention: 'single_signed', columnMap: { amount: 'Amount' } }
    const { rerender } = mount(props)
    await settle()

    rerender({ ...props, columnMap: { amount: 'Amount' } })   // new object, same mapping
    await settle()
    expect(api.previewAmounts).toHaveBeenCalledTimes(1)
  })

  it('coalesces a burst of mapping edits into one request', async () => {
    const props = { rows: ROWS, convention: 'single_signed', columnMap: { amount: 'Amount' } }
    const { rerender } = mount(props)
    act(() => { vi.advanceTimersByTime(PREVIEW_AMOUNTS_DEBOUNCE_MS - 50) })
    rerender({ ...props, convention: 'single_unsigned' })
    await settle()
    expect(api.previewAmounts).toHaveBeenCalledTimes(1)
    expect(api.previewAmounts.mock.calls[0][0].amount_convention).toBe('single_unsigned')
  })

  it('keeps the amounts on screen while the next request is in flight', async () => {
    const props = { rows: ROWS, convention: 'single_signed', columnMap: { amount: 'Amount' } }
    const { result, rerender } = mount(props)
    await settle()
    expect(result.current).toEqual([27.52, -100])

    api.previewAmounts.mockReturnValue(new Promise(() => { }))   // never resolves
    rerender({ ...props, convention: 'single_unsigned' })
    await settle()
    expect(result.current).toEqual([27.52, -100])
  })

  it('falls back to no amounts when the request fails', async () => {
    api.previewAmounts.mockRejectedValue(new Error('offline'))
    const { result } = mount({
      rows: ROWS, convention: 'single_signed', columnMap: { amount: 'Amount' },
    })
    await settle()
    expect(result.current).toEqual([])
    expect(mergePreviewAmounts([{ i: 0 }], result.current)[0].amount).toBe(null)
  })

  it('asks for nothing, and reports nothing, until an amount column is mapped', async () => {
    const { result, rerender } = mount({
      rows: ROWS, convention: 'single_signed', columnMap: {},
    })
    await settle()
    expect(api.previewAmounts).not.toHaveBeenCalled()
    expect(result.current).toBe(null)

    rerender({ rows: ROWS, convention: 'single_signed', columnMap: { amount: 'Amount' } })
    await settle()
    expect(result.current).toEqual([27.52, -100])
  })

  it('drops the amounts when the mapping is cleared', async () => {
    const { result, rerender } = mount({
      rows: ROWS, convention: 'single_signed', columnMap: { amount: 'Amount' },
    })
    await settle()
    expect(result.current).toEqual([27.52, -100])

    rerender({ rows: ROWS, convention: 'single_signed', columnMap: {} })
    await settle()
    expect(result.current).toBe(null)
  })
})
