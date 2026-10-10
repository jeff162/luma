// summarizeImportOutcome reconciles the three different shapes the backend hands an import outcome
// (live importResult, a saved batch record, a re-fetched batch) into one stable count set that the
// history cards, completion screen, and undo dialog all read. The precedence + fallback arithmetic is
// exactly the kind of thing a backend field rename would silently break, so these pin it.

import { describe, it, expect } from 'vitest'
import { summarizeImportOutcome, getUndoTargetForSource, buildMultiFileResult, formatSkippedImportMessage, mergeMoneyMovementProposals } from '../importOutcome.js'

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

  it('keeps restated rows out of importedCount in the batch-record fallback', () => {
    // Restated rows are accounted for in row_count but created nothing and hold no report row, so they
    // belong to neither importedCount nor dedupedCount.
    const s = summarizeImportOutcome({ row_count: 100, skipped_count: 0, deduped_count: 5, ignored_count: 90 })
    expect(s.importedCount).toBe(5)
    expect(s.ignoredCount).toBe(90)
    expect(s.dedupedCount).toBe(5)
  })

  it('keeps corrected rows out of importedCount in the batch-record fallback', () => {
    // row_count counts every row the file accounted for, and a corrected row created no transaction —
    // left in, it would inflate "imported" by exactly the rows that were quietly updated instead.
    const s = summarizeImportOutcome({ row_count: 100, skipped_count: 10, deduped_count: 15, updated_count: 2 })
    expect(s.importedCount).toBe(73)
    expect(s.updatedCount).toBe(2)
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

describe('buildMultiFileResult', () => {
  it('sums the headline counts across the per-file results', () => {
    const result = buildMultiFileResult([
      { filename: 'a.csv', result: { imported: 10, deduped: 2, skipped: 1, enriched_count: 3, rejected_count: 0 } },
      { filename: 'b.csv', result: { imported: 5, deduped: 0, skipped: 0, enriched_count: 0, rejected_count: 4 } },
    ])
    expect(result.multiFile).toBe(true)
    expect(result.fileCount).toBe(2)
    expect(result.imported).toBe(15)
    expect(result.deduped).toBe(2)
    expect(result.enriched_count).toBe(3)
    expect(result.rejected_count).toBe(4)
    expect(result.perFile).toHaveLength(2)
  })

  it('keeps the single-file review affordances off (they do not apply to an aggregate)', () => {
    const result = buildMultiFileResult([
      { filename: 'a.csv', result: { imported: 1, trailing_non_transaction_suspected: true, invalid_rows_suspected: true } },
    ])
    expect(result.trailing_non_transaction_suspected).toBe(false)
    expect(result.invalid_rows_suspected).toBe(false)
  })

  it('flags imported categories if any file had them', () => {
    expect(buildMultiFileResult([
      { filename: 'a.csv', result: { imported: 1 } },
      { filename: 'b.csv', result: { imported: 1, has_imported_categories: true } },
    ]).has_imported_categories).toBe(true)
  })

  it('tolerates an empty list', () => {
    const result = buildMultiFileResult([])
    expect(result.fileCount).toBe(0)
    expect(result.imported).toBe(0)
  })
})

describe('formatSkippedImportMessage', () => {
  it('names the file once when the matched file has the same name', () => {
    expect(formatSkippedImportMessage({ filename: 'jan.csv', matchedFilename: 'jan.csv' }))
      .toBe('jan.csv has already been imported — Skipping')
  })

  it('names the matched file when it differs', () => {
    expect(formatSkippedImportMessage({ filename: 'jan-copy.csv', matchedFilename: 'jan.csv' }))
      .toBe('jan-copy.csv has already been imported as jan.csv — Skipping')
  })

  it('degrades gracefully when the matched name is unknown', () => {
    expect(formatSkippedImportMessage({ filename: 'jan.csv' }))
      .toBe('jan.csv has already been imported — Skipping')
  })
})

describe('mergeMoneyMovementProposals', () => {
  it('sums counts for the same Type across batches and keeps money-movement if any flags it', () => {
    const merged = mergeMoneyMovementProposals([
      [{ type: 'Bank Deposit to PP Account', count: 3, money_movement: true }, { type: 'Website Payment', count: 2, money_movement: false }],
      [{ type: 'Bank Deposit to PP Account', count: 5, money_movement: true }, { type: 'General Withdrawal', count: 1, money_movement: true }],
    ])
    const byType = Object.fromEntries(merged.map(p => [p.type, p]))
    expect(byType['Bank Deposit to PP Account'].count).toBe(8)
    expect(byType['General Withdrawal'].money_movement).toBe(true)
    expect(byType['Website Payment'].money_movement).toBe(false)
  })

  it('orders money-movement first, then by count', () => {
    const merged = mergeMoneyMovementProposals([
      [{ type: 'Website Payment', count: 100, money_movement: false },
       { type: 'General Withdrawal', count: 1, money_movement: true },
       { type: 'Bank Deposit to PP Account', count: 9, money_movement: true }],
    ])
    expect(merged.map(p => p.type)).toEqual(['Bank Deposit to PP Account', 'General Withdrawal', 'Website Payment'])
  })

  it('tolerates empty / malformed input', () => {
    expect(mergeMoneyMovementProposals([])).toEqual([])
    expect(mergeMoneyMovementProposals([[{ count: 1 }], null])).toEqual([])
  })
})
