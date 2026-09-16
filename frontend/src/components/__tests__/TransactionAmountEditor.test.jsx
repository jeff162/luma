// @vitest-environment jsdom

/*
 * The amount editor's own decisions. The rules about *which* rows may be edited are covered without a
 * DOM in `lib/__tests__/amountEdit.test.js`; what is worth asserting here is the wiring that makes the
 * stored sign trustworthy on screen — that the direction control changes what the user is told will be
 * recorded, and that what gets sent matches what was shown.
 *
 * That pairing is the thing to protect: amounts are stored with positive meaning money *out* and shown
 * the other way round, so a direction wired backwards inverts what is saved while every screen still
 * looks plausible.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import TransactionAmountEditor from '../TransactionAmountEditor.jsx'

const HAND_ENTERED = {
  id: 't1',
  amount: 12.5,
  import_batch_id: null,
  external_transaction_id: null,
  is_split: false,
  reimbursements: [],
}

globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }

beforeEach(() => { vi.clearAllMocks() })
afterEach(cleanup)

describe('TransactionAmountEditor', () => {
  it('shows what will actually be recorded, and sends exactly that', async () => {
    const onSave = vi.fn(() => Promise.resolve())
    render(<TransactionAmountEditor txn={HAND_ENTERED} onSave={onSave} />)

    await userEvent.click(screen.getByTitle('Edit amount'))

    const amount = screen.getByLabelText('Amount')
    await userEvent.clear(amount)
    await userEvent.type(amount, '9.99')
    // A spend displays negated, so the echo reads as money out while the stored figure is positive.
    // Matched on the figure, not the sentence around it, so rewording the echo does not break this.
    expect(screen.getByText(/-\$9\.99/)).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: 'Received' }))
    expect(screen.queryByText(/-\$9\.99/)).toBeNull()
    expect(screen.getByText(/\$9\.99/)).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    // Received → money in → stored negative. The sign the user was shown is the sign that travels.
    expect(onSave).toHaveBeenCalledWith(-9.99)
  })

  it('refuses to save an unchanged figure', async () => {
    const onSave = vi.fn(() => Promise.resolve())
    render(<TransactionAmountEditor txn={HAND_ENTERED} onSave={onSave} />)

    await userEvent.click(screen.getByTitle('Edit amount'))
    // The editor opens on the row's own figure, so Save has nothing to write until something changes.
    // Asserted through the click rather than a `disabled` attribute, which would pass against an
    // implementation that only dimmed the button.
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).not.toHaveBeenCalled()
  })

  it('keeps the edit on screen when the server refuses it', async () => {
    const onSave = vi.fn(() => Promise.reject(new Error('This transaction is part of a reimbursement.')))
    render(<TransactionAmountEditor txn={HAND_ENTERED} onSave={onSave} />)

    await userEvent.click(screen.getByTitle('Edit amount'))
    const amount = screen.getByLabelText('Amount')
    await userEvent.clear(amount)
    await userEvent.type(amount, '20')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    // The backend's own wording, and the field still open for a retry rather than closed over a
    // correction that never landed.
    expect(await screen.findByText('This transaction is part of a reimbursement.')).toBeTruthy()
    expect(screen.getByLabelText('Amount')).toBeTruthy()
  })

  it('explains itself on a hand-entered row that cannot be edited', () => {
    render(<TransactionAmountEditor txn={{ ...HAND_ENTERED, is_split: true }} onSave={vi.fn()} />)
    // No way in, but the marker is still there to hang the reason off — the user has seen it work on
    // their other hand-entered rows, so silence here would be the mystery.
    expect(screen.queryByTitle('Edit amount')).toBeNull()
    expect(screen.getByText('✎').getAttribute('aria-disabled')).toBe('true')
  })

  it('says nothing about editing an imported row', () => {
    render(<TransactionAmountEditor txn={{ ...HAND_ENTERED, import_batch_id: 'b1' }} onSave={vi.fn()} />)
    expect(screen.queryByTitle('Edit amount')).toBeNull()
    expect(screen.queryByText('✎')).toBeNull()
    // The amount itself still renders — this is the panel's header figure, not an optional extra.
    expect(screen.getByText('$12.50')).toBeTruthy()
  })
})
