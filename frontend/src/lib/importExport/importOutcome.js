// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// Pure normalizers for an import's outcome counts. `summarizeImportOutcome`
// reconciles the several shapes the backend uses for a finished import (the live
// importResult, a saved batch record, a re-fetched batch) into one stable set of
// counts the history cards and the landing notice render.

export function summarizeImportOutcome(source) {
  if (!source) {
    return {
      totalRows: 0,
      importedCount: 0,
      skippedCount: 0,
      dedupedCount: 0,
      updatedCount: 0,
      ignoredCount: 0,
      accountSkippedCount: 0,
      zeroAmountCount: 0,
      currencyRejectedCount: 0,
      validationErrorCount: 0,
      rejectedCount: 0,
      trailingNonTransactionCount: 0,
      otherSkippedCount: 0,
      rejectedHeaders: [],
      rejectedRows: [],
      duplicateHeaders: [],
      duplicateRows: [],
      balancesRecorded: 0,
      balanceUnreadableCount: 0,
      balanceRefusedAccounts: [],
    }
  }

  const rawSummary = source.import_summary && typeof source.import_summary === 'object'
    ? source.import_summary
    : null
  // Rows that corrected a transaction already held instead of adding one. Subtracted in the
  // `row_count` fallback below for the same reason skipped and deduped are: row_count counts every row
  // the file accounted for, and only one of those outcomes created a transaction.
  const updatedCount = Number(rawSummary?.updated_count ?? source.updated ?? source.updated_count) || 0
  // Rows the source restated from its own prior import. They hold no duplicate-report row, which is
  // why they are not part of `dedupedCount` — that count's contract is the report's own.
  const ignoredCount = Number(rawSummary?.ignored_count ?? source.ignored ?? source.ignored_count) || 0
  const importedCount = Number(
    rawSummary?.imported_count
    ?? source.imported
    ?? (Number(source.row_count || 0) - Number(source.skipped_count || 0) - Number(source.deduped_count || 0)
        - Number(source.updated_count || 0) - Number(source.ignored_count || 0)),
  ) || 0
  const skippedCount = Number(rawSummary?.skipped_count ?? source.skipped ?? source.skipped_count) || 0
  const dedupedCount = Number(rawSummary?.deduped_count ?? source.deduped ?? source.deduped_count) || 0
  const enrichedCount = Number(rawSummary?.enriched_count ?? source.enriched_count) || 0
  const accountSkippedCount = Number(rawSummary?.account_skipped_count ?? source.account_skipped) || 0
  const zeroAmountCount = Number(rawSummary?.zero_amount_count ?? source.zero_amount_count) || 0
  const currencyRejectedCount = Number(rawSummary?.currency_rejected_count ?? source.currency_rejected_count) || 0
  const validationErrorCount = Number(rawSummary?.validation_error_count ?? source.validation_error_count) || 0
  const trailingNonTransactionCount = Number(
    rawSummary?.trailing_non_transaction_count
    ?? (source.trailing_non_transaction_suspected ? source.trailing_error_count : 0),
  ) || 0
  const rejectedCount = Number(rawSummary?.rejected_count ?? (zeroAmountCount + currencyRejectedCount + validationErrorCount)) || 0
  const totalRows = Number(
    rawSummary?.total_rows
    ?? source.row_count
    ?? (importedCount + skippedCount + dedupedCount + updatedCount + ignoredCount),
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

  // What the file's balance column gave: closing balances recorded, cells that could not be read, and the
  // accounts whose column did not read as a running balance.
  const balancesRecorded = Number(rawSummary?.balances_recorded) || 0
  const balanceUnreadableCount = Number(rawSummary?.balance_unreadable_count) || 0
  const balanceRefusedAccounts = Array.isArray(rawSummary?.balance_refused_accounts)
    ? rawSummary.balance_refused_accounts
    : []

  return {
    totalRows,
    importedCount,
    skippedCount,
    dedupedCount,
    updatedCount,
    ignoredCount,
    enrichedCount,
    accountSkippedCount,
    zeroAmountCount,
    currencyRejectedCount,
    validationErrorCount,
    rejectedCount,
    trailingNonTransactionCount,
    otherSkippedCount,
    rejectedHeaders,
    rejectedRows,
    duplicateHeaders,
    duplicateRows,
    balancesRecorded,
    balanceUnreadableCount,
    balanceRefusedAccounts,
  }
}

// Roll several single-file import results into one aggregate for the multi-file selector's completion
// summary. Each file was imported as its own batch/card, so this only sums the headline counts; per-file
// detail (rejected rows, duplicates, rule suggestions) stays on the individual history cards. `perFile`
// is `[{ filename, result }]`.
export function buildMultiFileResult(perFile) {
  const entries = Array.isArray(perFile) ? perFile : []
  const sum = key => entries.reduce((total, entry) => total + (Number(entry?.result?.[key]) || 0), 0)
  return {
    multiFile: true,
    fileCount: entries.length,
    perFile: entries,
    imported: sum('imported'),
    deduped: sum('deduped'),
    updated: sum('updated'),
    ignored: sum('ignored'),
    skipped: sum('skipped'),
    enriched_count: sum('enriched_count'),
    money_movement_suppressed_count: sum('money_movement_suppressed_count'),
    rejected_count: sum('rejected_count'),
    has_imported_categories: entries.some(entry => entry?.result?.has_imported_categories),
    // The rich single-file review affordances (raw-file review, auto-opened dialogs) don't apply to an
    // aggregate — detail lives on the per-file cards — so these stay off.
    trailing_non_transaction_suspected: false,
    invalid_rows_suspected: false,
  }
}

// The user-facing line for a file skipped during a multi-file import because its content was already
// imported. When the matched file has the same name (or is unknown), name it once; otherwise say which
// already-imported file it duplicates. `skip` is `{ filename, matchedFilename }`.
export function formatSkippedImportMessage(skip) {
  const filename = String(skip?.filename || 'This file').trim() || 'This file'
  const matched = String(skip?.matchedFilename || '').trim()
  if (!matched || matched === filename) {
    return `${filename} has already been imported — Skipping`
  }
  return `${filename} has already been imported as ${matched} — Skipping`
}

// Merge money-movement Type proposals across several PayPal batches (a multi-file import creates one
// batch per file). Same Type sums its counts and stays money-movement if any batch flagged it. Ordered
// money-movement first, then by count, then alphabetically — mirroring the backend's single-batch order.
export function mergeMoneyMovementProposals(proposalLists) {
  const byType = new Map()
  for (const list of proposalLists || []) {
    for (const proposal of list || []) {
      if (!proposal?.type) continue
      const existing = byType.get(proposal.type)
      if (existing) {
        existing.count += Number(proposal.count) || 0
        existing.money_movement = existing.money_movement || !!proposal.money_movement
      } else {
        byType.set(proposal.type, {
          type: proposal.type,
          count: Number(proposal.count) || 0,
          money_movement: !!proposal.money_movement,
        })
      }
    }
  }
  return [...byType.values()].sort(
    (a, b) => (Number(b.money_movement) - Number(a.money_movement)) || (b.count - a.count) || a.type.localeCompare(b.type),
  )
}

// Why one dropped Amazon export was skipped, as the import form's notice states it. The two reasons the
// backend reports (`read_amazon_exports`) need different sentences, and conflating them is what made the
// notice misleading: only `already_imported` is about a past import, and only it has a card to point at.
// A `duplicate_in_drop` file was never imported at all — it is a second copy of a file in the same drop,
// which is what an export saved twice under two names looks like — so saying "imported before" sent a
// reader to the ledger to look for rows that are not there. `skip` is a `skipped_uploads` entry.
export function skippedFileReason(skip) {
  const matched = String(skip?.matched_filename || '').trim()
  if (skip?.reason === 'duplicate_in_drop') {
    return matched
      ? `Identical to ${matched}, also in this import — nothing was imported from it.`
      : 'Identical to another file in this import — nothing was imported from it.'
  }
  return matched
    ? `Already imported as ${matched} — that file's card covers it.`
    : 'Already imported — an existing file card covers it.'
}

// The notice's title. The two reasons get their own wording where a batch is all of one kind, because
// that title is the whole message for a reader who does not open the list.
export function skippedFileNoticeTitle(skips) {
  const entries = Array.isArray(skips) ? skips : []
  const count = entries.length
  const plural = count === 1 ? '' : 's'
  if (entries.every(s => s?.reason === 'duplicate_in_drop')) {
    return `${count} file${plural} duplicated another in this import`
  }
  if (entries.every(s => s?.reason !== 'duplicate_in_drop')) {
    return `${count} file${plural} ${count === 1 ? 'was' : 'were'} already imported`
  }
  return `${count} file${plural} ${count === 1 ? 'was' : 'were'} skipped`
}
