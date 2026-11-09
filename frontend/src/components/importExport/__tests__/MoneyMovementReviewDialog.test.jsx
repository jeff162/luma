// @vitest-environment jsdom

// Guards the dialog's initial checked state. The regression: an already-ruled Type that isn't
// fragment-"suggested" must start CHECKED in the post-import (non-editing) review — otherwise it would
// land in the `remove` delta and its rule would be silently deleted on Apply.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MoneyMovementReviewDialog } from '../MoneyMovementReviewDialog.jsx'

// A floating dialog remembers where it was left, a saved preference; local state stands in for the
// app's provider.
vi.mock('../../../lib/UserPreferencesContext.jsx', async (importOriginal) => {
  const { useState } = await import('react')
  return { ...(await importOriginal()), useUserPreference: (_key, initial) => useState(initial) }
})

afterEach(cleanup)

const checkboxFor = label =>
  screen.getByText(label).closest('label').querySelector('input[type="checkbox"]')

describe('MoneyMovementReviewDialog initial state', () => {
  it('checks an already-ruled type even when it is not fragment-suggested (non-editing)', () => {
    const proposals = [
      { type: 'General Transfer', count: 3, money_movement: false, already_ruled: true },
      { type: 'General Withdrawal', count: 2, money_movement: true, already_ruled: false },
      { type: 'Website Payment', count: 5, money_movement: false, already_ruled: false },
    ]
    render(<MoneyMovementReviewDialog proposals={proposals} onApply={() => {}} onClose={() => {}} />)

    // Already-ruled (not suggested) → checked, so it is NOT staged for removal.
    expect(checkboxFor('General Transfer').checked).toBe(true)
    // Fragment-suggested → pre-checked on the auto-review.
    expect(checkboxFor('General Withdrawal').checked).toBe(true)
    // Neither ruled nor suggested → unchecked.
    expect(checkboxFor('Website Payment').checked).toBe(false)
  })

  it('does not stage an unchanged already-ruled type for removal', async () => {
    const onApply = vi.fn()
    const proposals = [
      { type: 'General Transfer', count: 3, money_movement: false, already_ruled: true },
      { type: 'General Withdrawal', count: 2, money_movement: true, already_ruled: false },
    ]
    render(<MoneyMovementReviewDialog proposals={proposals} onApply={onApply} onClose={() => {}} />)

    // Approve the newly-suggested type; leave the already-ruled one as-is.
    await userEvent.click(screen.getByText(/^Apply/))
    expect(onApply).toHaveBeenCalledTimes(1)
    const { add, remove } = onApply.mock.calls[0][0]
    expect(add).toEqual(['General Withdrawal'])
    expect(remove).toEqual([]) // the already-ruled type is NOT removed
  })
})
