// summarizeImportOutcome reconciles the three different shapes the backend hands an import outcome
// (live importResult, a saved batch record, a re-fetched batch) into one stable count set that the
// history cards, completion screen, and undo dialog all read. The precedence + fallback arithmetic is
// exactly the kind of thing a backend field rename would silently break, so these pin it.

import { describe, it, expect } from 'vitest'
import { summarizeImportOutcome, getUndoTargetForSource } from '../importOutcome.js'

describe('summarizeImportOutcome', () => {
  it('returns an all-zero shape for a null source', () => {
    const s = summarizeImportOutcome(null)
    expect(s.totalRows).toBe(0)
    expect(s.importedCount).toBe(0)
    expect(s.rejectedRows).toEqual([])
    expect(s.duplicateRows).toEqual([])
  })

  it('derives importedCount from a batch-record shape (row_count - skipped - deduped)', () => {
    const s = summarizeImportOutcome({ row_count: 100, skipped_count: 10, deduped_count: 15 })
    expect(s.importedCount).toBe(75)
    expect(s.totalRows).toBe(100)
    expect(s.dedupedCount).toBe(15)
  })

  it('uses the live-result shape fields directly', () => {
    const s = summarizeImportOutcome({ imported: 42, skipped: 8, deduped: 3 })
    expect(s.importedCount).toBe(42)
    expect(s.skippedCount).toBe(8)
    // No row_count given: totalRows falls back to imported + skipped + deduped.
    expect(s.totalRows).toBe(53)
  })

  it('prefers the nested import_summary object over flat fields', () => {
    const s = summarizeImportOutcome({
      imported: 1, skipped: 1, deduped: 1, row_count: 3,
      import_summary: { imported_count: 90, skipped_count: 5, deduped_count: 5, total_rows: 100 },
    })
    expect(s.importedCount).toBe(90)
    expect(s.skippedCount).toBe(5)
    expect(s.totalRows).toBe(100)
  })

  it('clamps otherSkippedCount to >= 0 and splits skipped into its sub-buckets', () => {
    const s = summarizeImportOutcome({
      row_count: 50, skipped_count: 12, deduped_count: 0,
      import_summary: { account_skipped_count: 4, zero_amount_count: 2, validation_error_count: 1, trailing_non_transaction_count: 3 },
    })
    // rejected = zero_amount + validation_error = 3; other = 12 - 4 - 3 - 3 = 2
    expect(s.rejectedCount).toBe(3)
    expect(s.otherSkippedCount).toBe(2)
  })

  it('never lets otherSkippedCount go negative when sub-buckets exceed skipped', () => {
    const s = summarizeImportOutcome({
      row_count: 10, skipped_count: 1,
      import_summary: { account_skipped_count: 5, zero_amount_count: 5 },
    })
    expect(s.otherSkippedCount).toBe(0)
  })
})

describe('getUndoTargetForSource', () => {
  it('maps normalized counts onto the batch-style fields the undo dialog needs', () => {
    const target = getUndoTargetForSource({ batch_id: 'b1', imported: 5, skipped: 2, deduped: 1 })
    expect(target.id).toBe('b1')           // id falls back to batch_id
    expect(target.row_count).toBe(8)        // totalRows
    expect(target.skipped_count).toBe(2)
    expect(target.deduped_count).toBe(1)
  })

  it('returns null for a null source', () => {
    expect(getUndoTargetForSource(null)).toBeNull()
  })
})
