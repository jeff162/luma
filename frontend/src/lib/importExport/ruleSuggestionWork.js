// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// System-wide rule-suggestion work, derived from the batch list. Only imports the user marked to use
// their categories (`use_imported_categories`) AND that actually carry categories (`has_imported_categories`)
// feed the suggester; each such batch's review tracks how many suggestions are still pending. Shared so
// the Import page and the Rules-page entry button count identically rather than re-deriving and drifting.

export function countPendingRuleSuggestions(batches) {
  return (batches || []).reduce((total, batch) => {
    if (!batch.use_imported_categories || !batch.has_imported_categories) return total
    return total + Number(batch.rule_suggestion_review?.pending_count || 0)
  }, 0)
}

export function hasRuleSuggestionWork(batches) {
  return (batches || []).some(batch => batch.use_imported_categories && batch.has_imported_categories)
}
