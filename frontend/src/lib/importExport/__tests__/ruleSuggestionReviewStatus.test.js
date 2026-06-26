// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, it, expect, vi } from 'vitest'
import {
  isReturningAcceptedSuggestionToPending,
  reverseAcceptedSuggestionSideEffects,
} from '../ruleSuggestionReviewStatus.js'

describe('rule suggestion review status orchestration', () => {
  it('recognizes only accepted suggestions moving back to pending', () => {
    expect(isReturningAcceptedSuggestionToPending({ review_status: 'accepted' }, 'pending')).toBe(true)
    expect(isReturningAcceptedSuggestionToPending({ review_status: 'skipped' }, 'pending')).toBe(false)
    expect(isReturningAcceptedSuggestionToPending({ review_status: 'accepted' }, 'discarded')).toBe(false)
    expect(isReturningAcceptedSuggestionToPending(null, 'pending')).toBe(false)
  })

  it('restores accepted rows before deleting the owned created rule', async () => {
    const calls = []
    const restoreCategorization = vi.fn(async rows => calls.push(['restore', rows]))
    const deleteRule = vi.fn(async ruleId => calls.push(['delete', ruleId]))
    const priorRows = [{
      id: 'txn-1',
      category_id: 'cat-1',
      category_source: 'import',
      category_overridden: 0,
    }]

    await reverseAcceptedSuggestionSideEffects({
      accepted_prior_rows: priorRows,
      created_rule_id: 'rule-1',
    }, { restoreCategorization, deleteRule })

    expect(restoreCategorization).toHaveBeenCalledWith(priorRows)
    expect(deleteRule).toHaveBeenCalledWith('rule-1')
    expect(calls).toEqual([
      ['restore', priorRows],
      ['delete', 'rule-1'],
    ])
  })

  it('does not delete a rule that was merged or pre-existing', async () => {
    const restoreCategorization = vi.fn(async () => {})
    const deleteRule = vi.fn(async () => {})
    const priorRows = [{ id: 'txn-1' }]

    await reverseAcceptedSuggestionSideEffects({
      accepted_prior_rows: priorRows,
      rule_id: 'preexisting-rule',
      created_rule_id: null,
    }, { restoreCategorization, deleteRule })

    expect(restoreCategorization).toHaveBeenCalledWith(priorRows)
    expect(deleteRule).not.toHaveBeenCalled()
  })

  it('does nothing when there is no row snapshot or owned rule', async () => {
    const restoreCategorization = vi.fn(async () => {})
    const deleteRule = vi.fn(async () => {})

    await reverseAcceptedSuggestionSideEffects({}, { restoreCategorization, deleteRule })

    expect(restoreCategorization).not.toHaveBeenCalled()
    expect(deleteRule).not.toHaveBeenCalled()
  })
})
