// @vitest-environment jsdom

// The split editor's one local rule: a split cannot be saved until its parts account for the
// transaction exactly. Everything else — sign, one-part-per-category, leaf-only — is enforced by the
// backend and surfaced as its message, deliberately not duplicated here, so what is worth pinning in
// the UI is the remainder gate and that a rejection is shown rather than swallowed.
//
// Note the assertion style on the Save button. The shared `Button` simulates `disabled` (it dims and
// drops the handler but never sets the DOM property), so `expect(button.disabled).toBe(true)` passes
// against every implementation of everything — see docs/shared-components.md. The gate is therefore
// asserted by clicking and checking the save never went out.

import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import SplitEditorDialog from '../SplitEditorDialog.jsx'
import { api } from '../../lib/api.js'

vi.mock('../../lib/api.js', () => ({
  api: {
    getSplit: vi.fn(),
    getSplitSuggestion: vi.fn(),
    saveSplit: vi.fn(),
    deleteSplit: vi.fn(),
  },
}))

const CATEGORIES = [
  { id: 'g1', name: 'Household', parent_id: null },
  { id: 'groceries', name: 'Groceries', parent_id: 'g1' },
  { id: 'hardware', name: 'Hardware', parent_id: 'g1' },
]

const TXN = { id: 't1', amount: 100, display_name: 'Fixture Store', category_id: null, is_split: false }

function renderEditor(props = {}) {
  return render(
    <SplitEditorDialog
      txn={TXN}
      categories={CATEGORIES}
      onClose={() => {}}
      onSaved={() => {}}
      {...props}
    />,
  )
}

async function amountFields() {
  return waitFor(() => {
    const fields = screen.getAllByLabelText('Amount')
    expect(fields.length).toBeGreaterThan(1)
    return fields
  })
}

beforeEach(() => {
  api.getSplit.mockResolvedValue({ txn_id: 't1', amount: 100, is_split: false, parts: [] })
  api.getSplitSuggestion.mockResolvedValue({ available: false, parts: [] })
  api.saveSplit.mockResolvedValue({ parts: [] })
  api.deleteSplit.mockResolvedValue({ ok: true })
})

afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('split editor remainder gate', () => {
  it('reports what is still unallocated as the parts are filled in', async () => {
    const user = userEvent.setup()
    renderEditor()
    const [first] = await amountFields()

    await user.type(first, '60')
    expect(screen.getByText('Remaining')).toBeTruthy()
    expect(screen.getByText('$40.00')).toBeTruthy()
  })

  it('refuses to save while the parts do not add up to the transaction', async () => {
    const user = userEvent.setup()
    renderEditor()
    const fields = await amountFields()

    await user.type(fields[0], '60')
    await user.type(fields[1], '30')   // 90 of 100 — short by ten
    await user.click(screen.getByText('Save split'))

    expect(api.saveSplit).not.toHaveBeenCalled()
  })

  it('saves once the parts account for the whole amount', async () => {
    const user = userEvent.setup()
    const onSaved = vi.fn()
    renderEditor({ onSaved })
    const fields = await amountFields()

    // Categories are picked through the shared CategoryPicker; select them by their visible names.
    await user.click(screen.getAllByText('Choose category')[0])
    await user.click(await screen.findByText('Groceries'))
    await user.click(screen.getAllByText('Choose category')[0])
    await user.click(await screen.findByText('Hardware'))

    await user.type(fields[0], '60')
    await user.type(fields[1], '40')
    expect(screen.getByText('Fully allocated')).toBeTruthy()

    await user.click(screen.getByText('Save split'))
    await waitFor(() => expect(api.saveSplit).toHaveBeenCalledTimes(1))
    expect(api.saveSplit.mock.calls[0][1]).toEqual([
      { category_id: 'groceries', amount: 60 },
      { category_id: 'hardware', amount: 40 },
    ])
  })

  it('puts the remainder in the amount the user selected, not one it picked', async () => {
    const user = userEvent.setup()
    renderEditor()
    await amountFields()

    // Three rows, and the selected one is deliberately *not* the last: with only two, "the selected
    // amount" and "the last amount" are the same field, and the test would pass against the earlier
    // behavior that always filled the final row.
    await user.click(screen.getByText('+ Category'))
    const three = screen.getAllByLabelText('Amount')
    expect(three.length).toBe(3)

    await user.type(three[2], '10')
    await user.click(three[0])
    await user.click(screen.getByText('Add remainder to selected'))

    expect(three[0].value).toBe('90.00')
    expect(three[2].value).toBe('10')
    expect(screen.getByText('Fully allocated')).toBeTruthy()
  })

  it('adds to whatever the selected amount already holds', async () => {
    const user = userEvent.setup()
    renderEditor()
    const fields = await amountFields()

    await user.type(fields[0], '30')
    await user.type(fields[1], '20')   // 50 of 100 allocated, 50 remaining
    await user.click(fields[1])
    await user.click(screen.getByText('Add remainder to selected'))

    expect(fields[1].value).toBe('70.00')
    expect(screen.getByText('Fully allocated')).toBeTruthy()
  })

  it('will not place the remainder until an amount is selected', async () => {
    const user = userEvent.setup()
    render(
      <SplitEditorDialog txn={TXN} categories={CATEGORIES} onClose={() => {}} onSaved={() => {}} />,
    )
    await amountFields()

    // Nothing focused yet, so the action has no destination and must not guess one.
    await user.click(screen.getByText('Add remainder to selected'))
    const fields = screen.getAllByLabelText('Amount')
    expect(fields.map(f => f.value)).toEqual(['', ''])
  })

  it('offers to undo the remainder, restoring exactly what the field held', async () => {
    const user = userEvent.setup()
    renderEditor()
    const fields = await amountFields()

    await user.type(fields[0], '30')
    await user.click(fields[1])
    await user.type(fields[1], '20')
    await user.click(screen.getByText('Add remainder to selected'))
    expect(fields[1].value).toBe('70.00')

    await user.click(screen.getByText('Undo'))
    // Verbatim: the field held "20", so undo puts "20" back — not a re-formatted "20.00", which
    // would be a second edit wearing an undo's label.
    expect(fields[1].value).toBe('20')
    expect(screen.getByText('Add remainder to selected')).toBeTruthy()
  })

  it('undoes into an amount that was empty before the remainder landed', async () => {
    const user = userEvent.setup()
    renderEditor()
    const fields = await amountFields()

    await user.type(fields[0], '100')
    await user.click(fields[1])
    await user.click(screen.getByText('Add remainder to selected'))
    expect(fields[1].value).toBe('0.00')

    await user.click(screen.getByText('Undo'))
    expect(fields[1].value).toBe('')
  })

  it('retires the undo as soon as anything else is edited', async () => {
    // A stash that outlived a later edit would restore a figure unrelated to what is on screen —
    // worse than offering no undo. Any change to the form takes the offer away.
    const user = userEvent.setup()
    renderEditor()
    const fields = await amountFields()

    await user.type(fields[0], '60')
    await user.click(fields[1])
    await user.click(screen.getByText('Add remainder to selected'))
    expect(screen.getByText('Undo')).toBeTruthy()

    await user.type(fields[0], '5')   // 60 -> 605, an edit to a different row
    expect(screen.queryByText('Undo')).toBeNull()
    expect(screen.getByText('Add remainder to selected')).toBeTruthy()
  })

  it('retires the undo when a category is added or a row removed', async () => {
    const user = userEvent.setup()
    renderEditor()
    const fields = await amountFields()

    await user.type(fields[0], '60')
    await user.click(fields[1])
    await user.click(screen.getByText('Add remainder to selected'))
    expect(screen.getByText('Undo')).toBeTruthy()

    await user.click(screen.getByText('+ Category'))
    expect(screen.queryByText('Undo')).toBeNull()
  })

  it('hides the remainder action once nothing is left, without resizing the panel', async () => {
    // Hidden rather than unmounted so the row keeps its height — finishing a split must not make the
    // dialog jump under the cursor. Asserted on visibility rather than presence for that reason: a
    // `queryByText(...).toBeNull()` here would pass only for the unmounting version this replaced.
    const user = userEvent.setup()
    renderEditor()
    const fields = await amountFields()

    const action = screen.getByText('Add remainder to selected')
    expect(action.style.visibility).toBe('visible')

    await user.type(fields[0], '60')
    await user.type(fields[1], '40')

    expect(screen.getByText('Add remainder to selected').style.visibility).toBe('hidden')
  })

  it("shows the backend's refusal instead of failing silently", async () => {
    const user = userEvent.setup()
    api.saveSplit.mockRejectedValue(new Error('Two parts of a split cannot use the same category — combine them into one part.'))
    renderEditor()
    const fields = await amountFields()

    await user.click(screen.getAllByText('Choose category')[0])
    await user.click(await screen.findByText('Groceries'))
    await user.click(screen.getAllByText('Choose category')[0])
    await user.click(await screen.findByText('Hardware'))
    await user.type(fields[0], '60')
    await user.type(fields[1], '40')
    await user.click(screen.getByText('Save split'))

    expect(await screen.findByText(/cannot use the same category/)).toBeTruthy()
  })
})

describe('split editor pre-fill', () => {
  it('offers the captured item detail and fills amounts without choosing categories', async () => {
    const user = userEvent.setup()
    api.getSplitSuggestion.mockResolvedValue({
      available: true,
      parts: [
        { description: 'Air Widget', amount: 70, category_id: null },
        { description: 'Cable', amount: 30, category_id: null },
      ],
    })
    renderEditor()

    await user.click(await screen.findByText('Use items'))

    const fields = await amountFields()
    expect(fields.map(f => f.value)).toEqual(['70', '30'])
    expect(screen.getByText('Fully allocated')).toBeTruthy()
    // The categories stay the user's call — a suggestion never picks them.
    expect(screen.getAllByText('Choose category').length).toBe(2)
  })

  it('says nothing when there is no item detail to propose from', async () => {
    renderEditor()
    await amountFields()
    expect(screen.queryByText('Use items')).toBeNull()
  })
})

describe('split editor load under StrictMode', () => {
  // StrictMode mounts, tears down, and remounts every effect in development, which is the environment
  // the user actually runs. A loader that guards "fetch only once" with a ref *and* discards results
  // with a cancel flag deadlocks under exactly that sequence: the ref makes the second run a no-op, the
  // teardown has already cancelled the first, and the surface is left on its loading state forever with
  // a request that succeeded. A plain mount cannot see it, so this test does the double-invoke.
  it('finishes loading when the effect is mounted twice', async () => {
    render(
      <StrictMode>
        <SplitEditorDialog txn={TXN} categories={CATEGORIES} onClose={() => {}} onSaved={() => {}} />
      </StrictMode>,
    )
    const fields = await screen.findAllByLabelText('Amount', {}, { timeout: 2000 })
    expect(fields.length).toBe(2)
    expect(screen.queryByText('Loading…')).toBeNull()
  })
})
