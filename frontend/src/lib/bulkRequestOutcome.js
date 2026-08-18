// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// How a bulk of N independent requests reports itself, given their settled results.
//
// The rule that matters is that a partial failure is a partial *success*, and both halves have to be
// stated: the rows that worked stay done, and the ones that did not are named so the caller can keep them
// selected and a retry re-sends exactly them.
//
// It exists because the alternative is `Promise.all`, which rejects on the first failure and hands the
// caller nothing about the rest. That cost a real bug: a bulk "Keep both" over 42 flagged duplicates
// issues one request per row, but a cross-account Keep *cascades* — one call asserts the two accounts are
// distinct and resolves every flagged row between them — so the calls after the first named rows that
// were already resolved and were refused. `Promise.all` then rejected, skipping the caller's reload and
// its selection clear, and the whole operation reported failure having done every bit of the work.

export function summarizeBulkOutcome(results) {
  const failedIndexes = new Set()
  results.forEach((r, i) => { if (r?.status === 'rejected') failedIndexes.add(i) })
  if (!failedIndexes.size) return { error: '', failedIndexes }
  // Only the first reason is quoted. N independent requests that fail together almost always fail for one
  // reason, and a list of forty identical sentences buries the count — which is the part that tells the
  // user how much is left to deal with.
  const reason = results.find(r => r?.status === 'rejected')?.reason?.message || 'unknown error'
  return {
    error: failedIndexes.size === results.length
      ? reason
      : `${failedIndexes.size} of ${results.length} rows could not be updated: ${reason}`,
    failedIndexes,
  }
}
