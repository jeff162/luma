// @vitest-environment jsdom

// Removing an account used to answer "and the transactions?" without asking — a root hard-deleted them
// behind a count, a merged child folded them into its parent. These pin what makes it a question: the
// two answers are the same two for every row, the parent is the one preselected for a group member,
// and the answer handed back is the one that was chosen.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import AccountRemovalDialog from '../AccountRemovalDialog.jsx'

afterEach(cleanup)

const replacement = { id: 'replacement', name: 'Harborline Rewards', mask: '4455', type: 'credit' }
const other = { id: 'other', name: 'Riverstone Checking', type: 'depository' }
const retired = {
  id: 'retired', name: 'Harborline Rewards', mask: '1111', type: 'credit',
  parent_account_id: 'replacement', transaction_count: 42,
}
const standalone = { id: 'standalone', name: 'Northgate Card', type: 'credit', transaction_count: 7 }

function show(account, props = {}) {
  const onSubmit = vi.fn()
  render(
    <AccountRemovalDialog
      account={account}
      accounts={[replacement, other, retired, standalone]}
      onCancel={() => {}}
      onSubmit={onSubmit}
      {...props}
    />,
  )
  return onSubmit
}

describe('AccountRemovalDialog', () => {
  it('offers a merged child and a root the same two answers, moving first', () => {
    show(retired)
    expect(screen.getByText(/42 transactions/)).toBeTruthy()
    expect(screen.getByRole('radio', { name: /another account/i }).checked).toBe(true)
    const childRungs = screen.getAllByRole('radio').length
    cleanup()

    show(standalone)
    expect(screen.getByRole('radio', { name: /another account/i }).checked).toBe(true)
    expect(screen.getAllByRole('radio')).toHaveLength(childRungs)
  })

  it('says plainly that removal cannot be undone', () => {
    show(standalone)

    expect(screen.getByText(/cannot be undone/i)).toBeTruthy()
  })

  it('preselects the parent as the account that keeps the transactions', async () => {
    const onSubmit = show(retired)

    const picker = screen.getByLabelText('Account to keep the transactions')
    expect(picker.value).toBe('replacement')

    await userEvent.click(screen.getByRole('button', { name: 'Move and remove' }))
    expect(onSubmit).toHaveBeenCalledWith({ mode: 'reassign', targetAccountId: 'replacement' })
  })

  it('never offers the account being removed as its own target', async () => {
    show(standalone)

    const options = [...screen.getByLabelText('Account to keep the transactions').options]
    expect(options.map(o => o.value)).not.toContain('standalone')
    expect(options.map(o => o.value)).toContain('replacement')
  })

  it('takes a new account instead of a target, and will not submit it unnamed', async () => {
    const onSubmit = show(standalone)

    await userEvent.selectOptions(
      screen.getByLabelText('Account to keep the transactions'), '__new__',
    )
    const confirm = screen.getByRole('button', { name: 'Move and remove' })
    expect(confirm.disabled).toBe(true)

    await userEvent.type(screen.getByLabelText('New account name'), 'Northgate Card 2')
    await userEvent.click(confirm)
    expect(onSubmit).toHaveBeenCalledWith({
      mode: 'reassign',
      newAccount: { name: 'Northgate Card 2', type: 'credit' },
    })
  })

  it('refuses a new account whose name is already taken', async () => {
    show(standalone)

    await userEvent.selectOptions(
      screen.getByLabelText('Account to keep the transactions'), '__new__',
    )
    await userEvent.type(screen.getByLabelText('New account name'), 'Riverstone Checking')

    expect(screen.getByRole('button', { name: 'Move and remove' }).disabled).toBe(true)
  })

  it('hands back the delete answer when it is the one chosen', async () => {
    const onSubmit = show(standalone)

    await userEvent.click(screen.getByRole('radio', { name: /Delete the transactions/i }))
    await userEvent.click(screen.getByRole('button', { name: /Delete them and remove/ }))

    expect(onSubmit).toHaveBeenCalledWith({ mode: 'delete' })
  })

  it('asks nothing of an account holding no transactions', async () => {
    const onSubmit = show({ ...standalone, transaction_count: 0 })

    expect(screen.queryByRole('radio')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(onSubmit).toHaveBeenCalledWith({ mode: 'delete' })
  })
})
