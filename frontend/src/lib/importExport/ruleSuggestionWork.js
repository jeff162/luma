// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// System-wide rule-suggestion work, derived from the batch list the Import page already holds. Only
// imports the user marked to use their categories (`use_imported_categories`) AND that actually carry
// categories (`has_imported_categories`) feed the suggester; each such batch's review tracks how many
// suggestions are still pending. The Rules page, which holds no history, asks the server for the same two
// figures (`GET /import-export/rule-suggestion-work`), so a change to this rule is made in both.

export function countPendingRuleSuggestions(batches) {
  return (batches || []).reduce((total, batch) => {
    if (!batch.use_imported_categories || !batch.has_imported_categories) return total
    return total + Number(batch.rule_suggestion_review?.pending_count || 0)
  }, 0)
}

export function hasRuleSuggestionWork(batches) {
  return (batches || []).some(batch => batch.use_imported_categories && batch.has_imported_categories)
}
