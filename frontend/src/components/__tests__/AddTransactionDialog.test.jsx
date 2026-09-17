// @vitest-environment jsdom

// The manual-entry form's own decisions. The sign rules are covered without a DOM in
// `lib/manualTransaction.test.js`; what is worth asserting here is the wiring that makes them
// trustworthy on screen — that the direction toggle changes what the user is told will be recorded,
// and that what gets sent matches what was shown.
//
// Rendered inside `<StrictMode>` because the dialog fetches accounts on mount and that is what the app
// runs; a plain render mounts once and cannot see an effect that deadlocks on remount.

import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import AddTransactionDialog from '../AddTransactionDialog.jsx'
import { api } from '../../lib/api.js'

vi.mock('../../lib/api.js', () => ({
  api: {
    getAccounts: vi.fn(),
    createTransaction: vi.fn(),
    saveSplit: vi.fn(),
    // The split editor opened from here is handed a draft, so it reads nothing — these exist only so a
    // stray call would fail loudly rather than being swallowed as an undefined function.
    getSplit: vi.fn(),
    getSplitSuggestion: vi.fn(),
  },
}))

const CATEGORIES = [
  { id: 'g1', name: 'Food & Drink', parent_id: null },
  { id: 'coffee', name: 'Coffee & Drinks', parent_id: 'g1' },
]

function open(accounts = [{ id: 'a1', name: 'Wallet', display_name: 'Wallet' }]) {
  api.getAccounts.mockResolvedValue({ accounts })
  return render(
    <StrictMode>
      <AddTransactionDialog
        categories={CATEGORIES}
        onClose={() => {}}
        onCreated={() => {}}
      />
    </StrictMode>,
  )
}

async function fillBasics() {
  await userEvent.type(screen.getByLabelText('Payee or description'), 'Corner Cafe')
  await userEvent.type(screen.getByLabelText('Amount'), '12.50')
}

// The split editor's rows are categorized through the shared picker, by the visible name.
async function pickCategoryForEachRow() {
  for (const trigger of screen.getAllByText('Choose category')) {
    await userEvent.click(trigger)
    // The chosen name stays on screen as the row's badge, so the option is the last match rather than
    // the only one.
    const options = await screen.findAllByText('Coffee & Drinks')
    await userEvent.click(options[options.length - 1])
  }
}

beforeEach(() => { vi.clearAllMocks() })
afterEach(cleanup)

describe('AddTransactionDialog', () => {
  it('shows what will actually be recorded, so the direction is checkable rather than trusted', async () => {
    open()
    await screen.findByLabelText('Amount')
    await fillBasics()
    // Spending is stored positive and displayed negative — the figure the ledger will show.
    expect(screen.getByText(/Will be recorded as -\$12\.50/)).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: 'Received' }))
    expect(screen.getByText(/Will be recorded as \$12\.50/)).toBeTruthy()
  })

  it('sends the amount it showed', async () => {
    api.createTransaction.mockResolvedValue({ id: 't1' })
    open()
    await screen.findByLabelText('Amount')
    await fillBasics()
    await userEvent.click(screen.getByRole('button', { name: 'Received' }))
    await userEvent.click(screen.getByRole('button', { name: 'Add transaction' }))
    await waitFor(() => expect(api.createTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ account_id: 'a1', payee: 'Corner Cafe', amount: -12.5 }),
    ))
  })

  it('preselects the account only when there is no choice to make', async () => {
    open([
      { id: 'a1', name: 'Wallet', display_name: 'Wallet' },
      { id: 'a2', name: 'Cash', display_name: 'Cash' },
    ])
    const picker = await screen.findByLabelText('Account')
    // Guessing between two would put money in the wrong place quietly.
    expect(picker.value).toBe('')
  })

  it('names the box that needs attention instead of failing silently', async () => {
    // The shared Button simulates `disabled` rather than setting the DOM property, so the gate is
    // asserted by clicking and checking nothing was sent.
    open()
    await screen.findByLabelText('Amount')
    await userEvent.click(screen.getByRole('button', { name: 'Add transaction' }))
    expect(await screen.findByText(/Enter who this was paid to/)).toBeTruthy()
    expect(api.createTransaction).not.toHaveBeenCalled()
  })

  it('surfaces a refusal from the server rather than closing as if it worked', async () => {
    api.createTransaction.mockRejectedValue(new Error('date must be YYYY-MM-DD'))
    open()
    await screen.findByLabelText('Amount')
    await fillBasics()
    await userEvent.click(screen.getByRole('button', { name: 'Add transaction' }))
    expect(await screen.findByText(/date must be YYYY-MM-DD/)).toBeTruthy()
  })

  it('will not offer a split before there is an amount to divide', async () => {
    open()
    await screen.findByLabelText('Amount')
    await userEvent.click(screen.getByRole('button', { name: 'Split…' }))
    expect(screen.queryByText('Split across categories')).toBeNull()
  })

  it('divides a transaction as it is entered, creating it and its items together', async () => {
    // The split editor is opened on a draft, so nothing is saved until this form's own button: the
    // transaction is created first, then its items, because the items need its id.
    api.createTransaction.mockResolvedValue({ id: 't1' })
    api.saveSplit.mockResolvedValue({ parts: [{ id: 'p1' }, { id: 'p2' }] })
    open()
    await screen.findByLabelText('Amount')
    await fillBasics()

    await userEvent.click(screen.getByRole('button', { name: 'Split…' }))
    const fields = await screen.findAllByLabelText('Amount')
    // The dialog's own amount box is first; the editor's rows follow it. Both rows take the one leaf
    // this fixture has — two items may share a category, which is a split's normal case rather than a
    // mistake.
    await pickCategoryForEachRow()
    await userEvent.type(fields[1], '8')
    await userEvent.type(fields[2], '4.50')
    await userEvent.click(screen.getByText('Save split'))

    // The picker is replaced by the ledger's own marker for a split.
    expect(await screen.findByRole('button', { name: 'Split (2)' })).toBeTruthy()
    expect(api.saveSplit).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: 'Add transaction' }))
    await waitFor(() => expect(api.saveSplit).toHaveBeenCalledWith('t1', [
      { category_id: 'coffee', amount: 8, label: '' },
      { category_id: 'coffee', amount: 4.5, label: '' },
    ]))
  })

  it('does not enter the transaction twice when only its items failed to save', async () => {
    // The row is already in the ledger at that point, so pressing the button again finishes the job
    // rather than starting it over.
    api.createTransaction.mockResolvedValue({ id: 't1' })
    api.saveSplit.mockRejectedValueOnce(new Error('every item needs a category'))
    open()
    await screen.findByLabelText('Amount')
    await fillBasics()

    await userEvent.click(screen.getByRole('button', { name: 'Split…' }))
    const fields = await screen.findAllByLabelText('Amount')
    await pickCategoryForEachRow()
    await userEvent.type(fields[1], '8')
    await userEvent.type(fields[2], '4.50')
    await userEvent.click(screen.getByText('Save split'))
    await userEvent.click(screen.getByRole('button', { name: 'Add transaction' }))

    expect(await screen.findByText(/transaction was entered, but its items could not be saved/)).toBeTruthy()

    api.saveSplit.mockResolvedValue({ parts: [{ id: 'p1' }, { id: 'p2' }] })
    await userEvent.click(screen.getByRole('button', { name: 'Add transaction' }))
    await waitFor(() => expect(api.saveSplit).toHaveBeenCalledTimes(2))
    expect(api.createTransaction).toHaveBeenCalledTimes(1)
  })

  it('leaves the category empty by default, so the rules get first refusal', async () => {
    api.createTransaction.mockResolvedValue({ id: 't1' })
    open()
    await screen.findByLabelText('Amount')
    await fillBasics()
    await userEvent.click(screen.getByRole('button', { name: 'Add transaction' }))
    await waitFor(() => expect(api.createTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ category_id: null }),
    ))
  })
})
