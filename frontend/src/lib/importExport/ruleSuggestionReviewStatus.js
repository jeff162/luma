// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

export function isReturningAcceptedSuggestionToPending(suggestion, status) {
  return status === 'pending' && suggestion?.review_status === 'accepted'
}

export async function reverseAcceptedSuggestionSideEffects(suggestion, { restoreCategorization, deleteRule }) {
  if (suggestion?.accepted_prior_rows?.length) {
    await restoreCategorization(suggestion.accepted_prior_rows)
  }
  if (suggestion?.created_rule_id) {
    await deleteRule(suggestion.created_rule_id)
  }
}
