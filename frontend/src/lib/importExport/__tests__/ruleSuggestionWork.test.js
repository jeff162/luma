// The "Generate Rules from imported data" button shows a pending count and dims when there's nothing
// to do, on BOTH the Import page and the Rules page. This shared helper is the single source of that
// math so the two surfaces can't drift. Two distinct signals are pinned: whether the action is
// available at all (hasRuleSuggestionWork — any eligible batch) vs. how many suggestions are pending
// (countPendingRuleSuggestions). A batch only counts if the user opted into its imported categories
// AND it actually carries them.

import { describe, it, expect } from 'vitest'
import { countPendingRuleSuggestions, hasRuleSuggestionWork } from '../ruleSuggestionWork.js'

const batch = (use, has, pending) => ({
  use_imported_categories: use,
  has_imported_categories: has,
  rule_suggestion_review: pending == null ? undefined : { pending_count: pending },
})

describe('countPendingRuleSuggestions', () => {
  it('sums pending counts only for eligible batches', () => {
    const batches = [
      batch(true, true, 3),
      batch(true, true, 2),
      batch(true, false, 9),  // not carrying imported categories → skipped
      batch(false, true, 9),  // user didn't opt in → skipped
      batch(true, true, null), // eligible but no review yet → 0
    ]
    expect(countPendingRuleSuggestions(batches)).toBe(5)
  })

  it('is zero for empty/missing input', () => {
    expect(countPendingRuleSuggestions([])).toBe(0)
    expect(countPendingRuleSuggestions(null)).toBe(0)
  })
})

describe('hasRuleSuggestionWork', () => {
  it('is true when any batch is eligible, even with zero pending (enabled vs. count)', () => {
    expect(hasRuleSuggestionWork([batch(true, true, 0)])).toBe(true)
  })
  it('is false when no batch is eligible', () => {
    expect(hasRuleSuggestionWork([batch(true, false, 5), batch(false, true, 5)])).toBe(false)
    expect(hasRuleSuggestionWork(null)).toBe(false)
  })
})
