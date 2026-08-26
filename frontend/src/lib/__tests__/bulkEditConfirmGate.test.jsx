// @vitest-environment jsdom

/*
 * The size gate on a bulk apply.
 *
 * "Select all matching" resolves server-side, so the only thing standing between a filter that quietly
 * failed to narrow and a rewrite of the whole ledger is the count — and the count was previously only
 * legible afterwards, in the result notice. These pin that a large selection is confirmed first, that
 * the gate lives deep enough that no action routes around it, and that the trash path (which already
 * names its own count) is not made to ask twice.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  useBulkTransactionEditing,
  BulkEditChrome,
  BULK_CONFIRM_THRESHOLD,
} from '../useBulkTransactionEditing.jsx'
import { api } from '../api.js'

vi.mock('../api.js', () => ({
  api: {
    bulkUpdateTransactions: vi.fn(() => Promise.resolve({ updated_count: 1 })),
    getTags: vi.fn(() => Promise.resolve([])),
  },
}))

const ROWS = [{ id: 'a' }, { id: 'b' }]

function Host({ total }) {
  const bulk = useBulkTransactionEditing({
    rows: ROWS,
    setRows: () => {},
    total,
    filterParams: { needs_review: true },
  })
  return (
    <>
      <button onClick={bulk.toggle}>Bulk Edit</button>
      <button onClick={() => bulk.selection.selectAllMatching()}>Select all</button>
      <BulkEditChrome controller={bulk} />
    </>
  )
}

async function selectAll(user, total) {
  render(<Host total={total} />)
  await user.click(screen.getByText('Bulk Edit'))
  await user.click(screen.getByText('Select all'))
}

let user

beforeEach(() => {
  user = userEvent.setup()
  api.bulkUpdateTransactions.mockClear()
})

afterEach(cleanup)

describe('confirming a large bulk apply', () => {
  it('applies an ordinary selection without asking', async () => {
    await selectAll(user, BULK_CONFIRM_THRESHOLD - 1)
    await user.click(screen.getByText('Mark reviewed'))

    await waitFor(() => expect(api.bulkUpdateTransactions).toHaveBeenCalledTimes(1))
  })

  it('holds a large selection at a dialog naming the count and the action', async () => {
    await selectAll(user, BULK_CONFIRM_THRESHOLD)
    await user.click(screen.getByText('Mark reviewed'))

    expect(api.bulkUpdateTransactions).not.toHaveBeenCalled()
    expect(screen.getByText(`Apply to ${BULK_CONFIRM_THRESHOLD} transactions?`)).toBeTruthy()
    // Naming the action and the scope is the point: a count alone does not say what is about to happen,
    // and these rows are not all on screen to be looked at.
    expect(screen.getByText(/^Mark reviewed — this runs on every row matching the current filter/)).toBeTruthy()
  })

  it('runs the held actions once confirmed', async () => {
    await selectAll(user, BULK_CONFIRM_THRESHOLD)
    await user.click(screen.getByText('Mark reviewed'))
    await user.click(screen.getByText(`Apply to ${BULK_CONFIRM_THRESHOLD}`))

    await waitFor(() => expect(api.bulkUpdateTransactions).toHaveBeenCalledTimes(1))
    const [, actions] = api.bulkUpdateTransactions.mock.calls[0]
    expect(actions).toEqual([{ type: 'mark_reviewed' }])
  })

  it('leaves everything untouched when the confirm is declined', async () => {
    await selectAll(user, BULK_CONFIRM_THRESHOLD)
    await user.click(screen.getByText('Mark reviewed'))
    await user.click(screen.getByText('Cancel'))

    expect(api.bulkUpdateTransactions).not.toHaveBeenCalled()
    expect(screen.queryByText(`Apply to ${BULK_CONFIRM_THRESHOLD} transactions?`)).toBeNull()
  })

  it('does not ask twice on the trash path, which already names its count', async () => {
    await selectAll(user, BULK_CONFIRM_THRESHOLD)
    await user.click(screen.getByText('Move to trash'))
    // The action bar's button and the confirm's both read "Move to trash"; the dialog renders last.
    const trashButtons = screen.getAllByText('Move to trash')
    await user.click(trashButtons[trashButtons.length - 1])

    await waitFor(() => expect(api.bulkUpdateTransactions).toHaveBeenCalledTimes(1))
    const [, actions] = api.bulkUpdateTransactions.mock.calls[0]
    expect(actions).toEqual([{ type: 'trash' }])
  })
})
