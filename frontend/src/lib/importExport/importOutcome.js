// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// Pure normalizers for an import's outcome counts. `summarizeImportOutcome`
// reconciles the several shapes the backend uses for a finished import (the live
// importResult, a saved batch record, a re-fetched batch) into one stable set of
// counts the history cards and completion screen render. `getUndoTargetForSource`
// wraps that so the undo dialog's arithmetic always has real numbers regardless
// of which shape it was handed.

export function summarizeImportOutcome(source) {
  if (!source) {
    return {
      totalRows: 0,
      importedCount: 0,
      skippedCount: 0,
      dedupedCount: 0,
      accountSkippedCount: 0,
      zeroAmountCount: 0,
      validationErrorCount: 0,
      rejectedCount: 0,
      trailingNonTransactionCount: 0,
      otherSkippedCount: 0,
      rejectedHeaders: [],
      rejectedRows: [],
      duplicateHeaders: [],
      duplicateRows: [],
    }
  }

  const rawSummary = source.import_summary && typeof source.import_summary === 'object'
    ? source.import_summary
    : null
  const importedCount = Number(
    rawSummary?.imported_count
    ?? source.imported
    ?? (Number(source.row_count || 0) - Number(source.skipped_count || 0) - Number(source.deduped_count || 0)),
  ) || 0
  const skippedCount = Number(rawSummary?.skipped_count ?? source.skipped ?? source.skipped_count) || 0
  const dedupedCount = Number(rawSummary?.deduped_count ?? source.deduped ?? source.deduped_count) || 0
  const enrichedCount = Number(rawSummary?.enriched_count ?? source.enriched_count) || 0
  const accountSkippedCount = Number(rawSummary?.account_skipped_count ?? source.account_skipped) || 0
  const zeroAmountCount = Number(rawSummary?.zero_amount_count ?? source.zero_amount_count) || 0
  const validationErrorCount = Number(rawSummary?.validation_error_count ?? source.validation_error_count) || 0
  const trailingNonTransactionCount = Number(
    rawSummary?.trailing_non_transaction_count
    ?? (source.trailing_non_transaction_suspected ? source.trailing_error_count : 0),
  ) || 0
  const rejectedCount = Number(rawSummary?.rejected_count ?? (zeroAmountCount + validationErrorCount)) || 0
  const totalRows = Number(
    rawSummary?.total_rows
    ?? source.row_count
    ?? (importedCount + skippedCount + dedupedCount),
  ) || 0
  const otherSkippedCount = Math.max(
    0,
    skippedCount - accountSkippedCount - rejectedCount - trailingNonTransactionCount,
  )
  const rejectedHeaders = Array.isArray(rawSummary?.rejected_headers)
    ? rawSummary.rejected_headers
    : []
  const rejectedRows = Array.isArray(rawSummary?.rejected_rows)
    ? rawSummary.rejected_rows
    : Array.isArray(source.rejected_rows)
      ? source.rejected_rows
      : []
  const duplicateHeaders = Array.isArray(rawSummary?.duplicate_headers)
    ? rawSummary.duplicate_headers
    : []
  const duplicateRows = Array.isArray(rawSummary?.duplicate_rows)
    ? rawSummary.duplicate_rows
    : Array.isArray(source.duplicate_rows)
      ? source.duplicate_rows
      : []

  return {
    totalRows,
    importedCount,
    skippedCount,
    dedupedCount,
    enrichedCount,
    accountSkippedCount,
    zeroAmountCount,
    validationErrorCount,
    rejectedCount,
    trailingNonTransactionCount,
    otherSkippedCount,
    rejectedHeaders,
    rejectedRows,
    duplicateHeaders,
    duplicateRows,
  }
}

export function getUndoTargetForSource(source) {
  if (!source) return null
  // importResult and batch records expose count fields under different shapes.
  // Normalize them here so the undo dialog arithmetic always has real numbers.
  const summary = summarizeImportOutcome(source)
  return {
    ...source,
    id: source.id || source.batch_id || '',
    row_count: summary.totalRows,
    skipped_count: summary.skippedCount,
    deduped_count: summary.dedupedCount,
  }
}
