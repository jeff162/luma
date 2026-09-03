// @vitest-environment jsdom

/*
 * The shared portion picker: what it stores, and what it refuses.
 *
 * A blocked confirm is asserted by clicking it and finding nothing happened, not by reading
 * `button.disabled`: the shared `Button` renders a dimmed control with its handler removed and never
 * sets the DOM attribute, so the attribute would be false on a control that is plainly refusing.
 *
 * Its host surfaces (the detail panel, the editor) each assert that a chosen portion reaches the right
 * API call. What is asserted here is the picker's own reasoning — the running total, the remainder's
 * exclusivity, and the over-claim guard — because those are the parts that would fail *silently*: a
 * picker that quietly summed to more than the row holds still looks correct until the server rejects it.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ClaimPortionPicker from '../ClaimPortionPicker.jsx'

const SHARES = [
  { amount: 250, label: "Dana's ticket" },
  { amount: 250, label: "Rowan's ticket" },
]

afterEach(cleanup)

function renderPicker(props = {}) {
  const onConfirm = vi.fn()
  render(<ClaimPortionPicker portions={SHARES} unclaimed={500} onConfirm={onConfirm} {...props} />)
  return onConfirm
}

const confirmButton = () => screen.getByRole('button', { name: /Track this reimbursement/ })

describe('ClaimPortionPicker', () => {
  it('will not submit until something is chosen', async () => {
    const onConfirm = renderPicker()
    // The idle slot states the budget rather than an error: this is the moment the limit is worth
    // knowing, and it used to appear only once it had been exceeded.
    expect(screen.getByText('$500.00 available')).toBeTruthy()
    await userEvent.click(confirmButton())
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('states the figure it is about to store, which is the sum of the chosen portions', async () => {
    // Several portions become one claim, so the total is not something the toggles say on their own.
    renderPicker()
    await userEvent.click(screen.getByRole('button', { name: /Dana's ticket/ }))
    expect(screen.getByText('Claiming $250.00')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /Rowan's ticket/ }))
    expect(screen.getByText('Claiming $500.00')).toBeTruthy()
  })

  it('refuses a selection larger than the row has left, rather than submitting into a rejection', async () => {
    // $250 of this row is already claimed elsewhere, so both portions no longer fit.
    const onConfirm = renderPicker({ unclaimed: 250, remainder: 250, receivable: 500 })
    await userEvent.click(screen.getByRole('button', { name: /Dana's ticket/ }))
    await userEvent.click(screen.getByRole('button', { name: /Rowan's ticket/ }))
    expect(screen.getByText(
      'That is $500.00. $250.00 of this transaction is already claimed, so $250.00 is available.',
    )).toBeTruthy()
    await userEvent.click(confirmButton())
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('treats the remainder as an alternative to the portions, never an addition', async () => {
    // Adding "everything not yet claimed" on top of a named portion would count the same money twice.
    const onConfirm = renderPicker({ unclaimed: 250, remainder: 250 })
    await userEvent.click(screen.getByRole('button', { name: /Dana's ticket/ }))
    await userEvent.click(screen.getByRole('button', { name: /Everything not yet claimed/ }))
    expect(screen.getByRole('button', { name: /Dana's ticket/ }).getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByText('Claiming $250.00')).toBeTruthy()

    await userEvent.click(confirmButton())
    // Unlabelled: the remainder is an amount, not one of the row's named pieces.
    expect(onConfirm).toHaveBeenCalledWith({ amount: 250, label: null })
  })

  it('offers no remainder option where the portions already express it', () => {
    renderPicker()
    expect(screen.queryByRole('button', { name: /Everything not yet claimed/ })).toBeNull()
  })

  it('carries the chosen portions\' own names onto the claim', async () => {
    const onConfirm = renderPicker()
    await userEvent.click(screen.getByRole('button', { name: /Dana's ticket/ }))
    await userEvent.click(screen.getByRole('button', { name: /Rowan's ticket/ }))
    await userEvent.click(confirmButton())
    expect(onConfirm).toHaveBeenCalledWith({
      amount: 500, label: "Dana's ticket + Rowan's ticket",
    })
  })

  it('handles a deposit, whose portions are stored negative', async () => {
    // Money in is below zero on disk. The picker must compare magnitudes, or every repayment portion
    // would read as exceeding what is unclaimed.
    const onConfirm = vi.fn()
    render(
      <ClaimPortionPicker
        portions={[{ amount: -10, label: 'Part i' }, { amount: -240, label: 'part 2' }]}
        unclaimed={-250}
        onConfirm={onConfirm}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: /Part i/ }))
    await userEvent.click(screen.getByRole('button', { name: /part 2/ }))
    expect(screen.getByText('Claiming $250.00')).toBeTruthy()
    await userEvent.click(confirmButton())
    expect(onConfirm).toHaveBeenCalledWith({ amount: -250, label: 'Part i + part 2' })
  })
})
