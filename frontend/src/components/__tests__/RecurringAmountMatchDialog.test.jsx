// @vitest-environment jsdom

// Amount matching for a recurring series. The dialog holds two decisions the user must be able to make
// independently — whether amount gates membership at all, and whether the range is theirs or the scan's
// — and what is worth pinning is the translation between what is typed and what is sent, because every
// part of it is invisible on screen and wrong in a way no error would report.
//
// Three properties in particular: a typed magnitude takes the series' own direction (nobody types a
// minus sign for a bill), retracting a pinned range travels as an explicit flag rather than as nulls
// (null means "unchanged" for every other field on that endpoint), and turning the gate off clears the
// range with it rather than leaving a bound behind that nothing is reading.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import RecurringAmountMatchDialog from '../RecurringAmountMatchDialog.jsx'

// A floating dialog remembers where it was left, a saved preference; local state stands in for the
// app's provider.
vi.mock('../../lib/UserPreferencesContext.jsx', async (importOriginal) => {
  const { useState } = await import('react')
  return { ...(await importOriginal()), useUserPreference: (_key, initial) => useState(initial), useDeviceLayoutPreference: (_key, initial) => useState(initial) }
})

afterEach(cleanup)

const SERIES = {
  id: 's1',
  display_name: 'Harborline Digest',
  expected_amount: -4.0,
  amount_min: -4.0,
  amount_max: -4.0,
  amount_mode: 'variable',
  expected_min: null,
  expected_max: null,
}

function open(series = SERIES) {
  const onSave = vi.fn().mockResolvedValue({})
  const onClose = vi.fn()
  render(<RecurringAmountMatchDialog series={series} onSave={onSave} onClose={onClose} />)
  return { onSave, onClose }
}

describe('RecurringAmountMatchDialog', () => {
  it('sends variable with the band cleared when the gate is left off', async () => {
    const { onSave } = open()
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).toHaveBeenCalledWith({ amount_mode: 'variable', clear_expected_band: true })
  })

  it('turns the gate on without pinning a range, so the observed one keeps following the charges', async () => {
    const { onSave } = open()
    await userEvent.click(screen.getByRole('switch', { name: /Match by amount/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).toHaveBeenCalledWith({ amount_mode: 'fixed', clear_expected_band: true })
  })

  it('applies the series’ direction to typed magnitudes and orders the bounds', async () => {
    const { onSave } = open()
    await userEvent.click(screen.getByRole('switch', { name: /Match by amount/ }))
    await userEvent.click(screen.getByRole('switch', { name: /Set the range myself/ }))

    const low = screen.getByLabelText('Lowest amount')
    const high = screen.getByLabelText('Highest amount')
    await userEvent.clear(low)
    await userEvent.type(low, '3')
    await userEvent.clear(high)
    await userEvent.type(high, '5')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    // Typed as sizes, sent as ledger amounts: an expense series is negative, and min is the lower one.
    expect(onSave).toHaveBeenCalledWith({ amount_mode: 'fixed', expected_min: -5, expected_max: -3 })
  })

  it('retracts an existing pin through the explicit flag rather than by sending nulls', async () => {
    const { onSave } = open({ ...SERIES, amount_mode: 'fixed', expected_min: -5.0, expected_max: -3.0 })
    await userEvent.click(screen.getByRole('switch', { name: /Set the range myself/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).toHaveBeenCalledWith({ amount_mode: 'fixed', clear_expected_band: true })
  })

  it('opens on a proposed band with matching and pinning already on', async () => {
    // Arriving from an accepted price change: the user lands on the proposal and can adjust either end
    // before saving, which is the whole reason it is not applied for them.
    const onSave = vi.fn().mockResolvedValue({})
    render(
      <RecurringAmountMatchDialog
        series={SERIES}
        suggested={{ low: 4, high: 4.4, note: 'A note about the charge.' }}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByText(/A note about the charge\./)).toBeTruthy()
    expect(screen.getByLabelText('Lowest amount').value).toBe('4')
    expect(screen.getByLabelText('Highest amount').value).toBe('4.4')

    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).toHaveBeenCalledWith({ amount_mode: 'fixed', expected_min: -4.4, expected_max: -4 })
  })

  it('lets the far end of a proposal be moved too, for a rise that lifted every bill', async () => {
    const onSave = vi.fn().mockResolvedValue({})
    render(
      <RecurringAmountMatchDialog
        series={{ ...SERIES, expected_amount: -100, amount_min: -120, amount_max: -80 }}
        suggested={{ low: 80, high: 150, note: 'n' }}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    )
    const low = screen.getByLabelText('Lowest amount')
    await userEvent.clear(low)
    await userEvent.type(low, '95')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).toHaveBeenCalledWith({ amount_mode: 'fixed', expected_min: -150, expected_max: -95 })
  })

  it('refuses to save a half-typed range', async () => {
    const { onSave } = open()
    await userEvent.click(screen.getByRole('switch', { name: /Match by amount/ }))
    await userEvent.click(screen.getByRole('switch', { name: /Set the range myself/ }))
    await userEvent.clear(screen.getByLabelText('Highest amount'))
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).not.toHaveBeenCalled()
  })
})
