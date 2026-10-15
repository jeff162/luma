// The bulk notice has to account for every selected row, because the server declines two kinds of row
// and keeps them out of the total it returns. A notice that reported only the total would leave the
// difference between "40 selected" and "37 updated" unexplained — and those rows kept their old
// categorization, which is the case the user has to know about to act on.

import { describe, expect, it } from 'vitest'

const { describeBulkOutcome } = await import('../useBulkTransactionEditing.jsx')

describe('describeBulkOutcome', () => {
  it('reports the total alone when nothing was declined', () => {
    expect(describeBulkOutcome({ updated_count: 12 })).toBe('Updated 12 transactions.')
  })

  it('singularizes the total', () => {
    expect(describeBulkOutcome({ updated_count: 1 })).toBe('Updated 1 transaction.')
  })

  it('names declined split rows, which keep their allocations', () => {
    const notice = describeBulkOutcome({ updated_count: 37, skipped_splits: 3 })
    expect(notice).toContain('Updated 37 transactions.')
    expect(notice).toContain('3 split transactions kept their categories.')
  })

  it('names rows a reimbursement claims, separately from splits', () => {
    const notice = describeBulkOutcome({ updated_count: 5, skipped_splits: 2, skipped_claimed: 1 })
    // Kept apart rather than summed: what to do about each differs.
    expect(notice).toContain('2 split transactions kept their categories.')
    expect(notice).toContain('1 transaction is claimed by a reimbursement and was left alone.')
  })

  it('reads correctly for one of each', () => {
    const notice = describeBulkOutcome({ updated_count: 1, skipped_splits: 1, skipped_claimed: 1 })
    expect(notice).toBe(
      'Updated 1 transaction. 1 split transaction kept its categories. '
      + '1 transaction is claimed by a reimbursement and was left alone.',
    )
  })

  it('treats a missing or empty result as nothing updated rather than throwing', () => {
    expect(describeBulkOutcome(undefined)).toBe('Updated 0 transactions.')
    expect(describeBulkOutcome({})).toBe('Updated 0 transactions.')
  })
})
