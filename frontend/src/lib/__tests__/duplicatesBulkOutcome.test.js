// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// The two rules that made a fully-successful bulk Keep report itself as a failure.
//
// `resolve-suspect` is issued once per selected row, but a cross-account Keep *cascades* — one call
// asserts the two accounts are distinct and resolves every flagged row between them — so the calls after
// the first necessarily name rows that are already resolved. Under `Promise.all` the first of those
// rejections discarded the reload and the selection clear for every row that had worked, and the page's
// pill counts were left describing the state from before the action.
//
// The loader's counter is the other half: the page watches it to know when to re-fetch its counts, and it
// used to start at 0 — the value the watcher skips — so opening the report was the one load that
// refreshed nothing, and a stale pill could not be corrected by clicking it.

import { describe, expect, it, vi } from 'vitest'

vi.mock('../api.js', () => ({
  api: { getBatchDuplicatesUnified: vi.fn(async () => ({ entries: [], soft_flag_count: 0 })) },
}))

const { summarizeBulkOutcome } = await import('../bulkRequestOutcome.js')
const { __testing } = await import('../../contexts/UnifiedDuplicatesViewerContext.jsx')

const ok = () => ({ status: 'fulfilled', value: {} })
const failed = (message) => ({ status: 'rejected', reason: new Error(message) })

describe('summarizeBulkOutcome', () => {
  it('reports nothing when every row succeeded', () => {
    const outcome = summarizeBulkOutcome([ok(), ok(), ok()])
    expect(outcome.error).toBe('')
    expect(outcome.failedIndexes.size).toBe(0)
  })

  it('keeps a partial failure partial rather than reporting the whole bulk as failed', () => {
    // The shape of the bug: 42 rows, nearly all of which did exactly what was asked.
    const results = [...Array(41)].map(ok)
    results.splice(7, 0, failed('Transaction is not flagged as a suspect duplicate'))
    const outcome = summarizeBulkOutcome(results)
    expect(outcome.error).toBe(
      '1 of 42 rows could not be updated: Transaction is not flagged as a suspect duplicate',
    )
    expect([...outcome.failedIndexes]).toEqual([7])
  })

  it('names only the rows that failed, so a retry re-sends exactly those', () => {
    const outcome = summarizeBulkOutcome([ok(), failed('nope'), ok(), failed('nope')])
    expect([...outcome.failedIndexes]).toEqual([1, 3])
  })

  it('drops the count when everything failed, since it adds nothing to the reason', () => {
    expect(summarizeBulkOutcome([failed('Bad request'), failed('Bad request')]).error).toBe('Bad request')
  })

  it('survives a rejection carrying no message', () => {
    expect(summarizeBulkOutcome([{ status: 'rejected', reason: null }]).error).toBe('unknown error')
  })
})

describe('the duplicates report loader', () => {
  it('advances its version on the first load, not only on reloads', async () => {
    // 0 is the page watcher's "no report has loaded" sentinel, so a first load numbered 0 refreshed
    // nothing — which is why a pill that had gone stale stayed stale even when clicking it opened a
    // dialog that already knew better.
    const first = await __testing.loadDuplicates({ batchId: 'b1' }, undefined)
    expect(first.version).toBe(1)
    expect((await __testing.loadDuplicates({ batchId: 'b1' }, first)).version).toBe(2)
  })
})
