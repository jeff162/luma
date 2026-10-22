// @vitest-environment jsdom

// The split editor's one local rule: a split cannot be saved until its parts account for the
// transaction exactly. Everything else — sign, one-part-per-category, leaf-only — is enforced by the
// backend and surfaced as its message, deliberately not duplicated here, so what is worth pinning in
// the UI is the remainder gate and that a rejection is shown rather than swallowed.
//
// The Save gate is asserted by clicking and checking the save never went out, rather than by reading
// `disabled`: the attribute is a claim about the element, and what matters is that nothing is saved.

import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import SplitEditorDialog from '../SplitEditorDialog.jsx'
import { api } from '../../lib/api.js'
import { txnMutations } from '../../lib/txnMutations.js'
import { BUSY_INDICATOR_DELAY_MS, PAINT_GATE_DELAY_MS } from '../../lib/useBusyIndicator.js'

vi.mock('../../lib/txnMutations.js', async importOriginal => ({
  ...await importOriginal(),
  txnMutations: { saveSplit: vi.fn(), deleteSplit: vi.fn() },
}))

vi.mock('../../lib/api.js', () => ({
  api: {
    getSplit: vi.fn(),
    getSplitSuggestion: vi.fn(),
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
  txnMutations.saveSplit.mockResolvedValue({ parts: [] })
  txnMutations.deleteSplit.mockResolvedValue({ ok: true })
})

afterEach(() => { cleanup(); vi.clearAllMocks() })

/*
 * A transaction that does not exist yet — the manual-entry form's draft. Nothing is read and nothing is
 * saved: the items go back to the caller, which creates the transaction and its split together.
 */
describe('splitting a draft transaction', () => {
  const DRAFT = { amount: 100, display_name: 'New transaction', category_id: null, is_split: false, parts: [] }

  it('opens without reading anything, since there is nothing stored to read', async () => {
    renderEditor({ txn: DRAFT })
    await amountFields()
    expect(api.getSplit).not.toHaveBeenCalled()
    expect(api.getSplitSuggestion).not.toHaveBeenCalled()
  })

  it('hands its items back instead of saving them', async () => {
    const user = userEvent.setup()
    const onSaved = vi.fn()
    renderEditor({ txn: DRAFT, onSaved })
    const fields = await amountFields()

    await user.click(screen.getAllByText('Choose category')[0])
    await user.click(await screen.findByText('Groceries'))
    await user.click(screen.getAllByText('Choose category')[0])
    await user.click(await screen.findByText('Hardware'))
    await user.type(fields[0], '60')
    await user.type(fields[1], '40')
    await user.click(screen.getByText('Save split'))

    expect(txnMutations.saveSplit).not.toHaveBeenCalled()
    expect(onSaved).toHaveBeenCalledWith({
      is_split: true,
      parts: [
        { category_id: 'groceries', amount: 60, label: '' },
        { category_id: 'hardware', amount: 40, label: '' },
      ],
    })
  })

  it('reopens on the items it was given', async () => {
    renderEditor({
      txn: {
        ...DRAFT,
        is_split: true,
        parts: [
          { category_id: 'groceries', amount: 60, label: 'Pantry' },
          { category_id: 'hardware', amount: 40, label: '' },
        ],
      },
    })
    const fields = await amountFields()
    expect(fields.map(field => field.value)).toEqual(['60', '40'])
    expect(screen.getByText('Fully allocated')).toBeTruthy()
  })

  it('clears a draft split without asking the server to delete anything', async () => {
    const user = userEvent.setup()
    const onSaved = vi.fn()
    renderEditor({
      txn: {
        ...DRAFT,
        is_split: true,
        parts: [
          { category_id: 'groceries', amount: 60, label: '' },
          { category_id: 'hardware', amount: 40, label: '' },
        ],
      },
      onSaved,
    })
    await user.click(await screen.findByText('Remove split'))

    expect(txnMutations.deleteSplit).not.toHaveBeenCalled()
    expect(onSaved).toHaveBeenCalledWith({ is_split: false, parts: [] })
  })
})

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

    expect(txnMutations.saveSplit).not.toHaveBeenCalled()
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
    await waitFor(() => expect(txnMutations.saveSplit).toHaveBeenCalledTimes(1))
    expect(txnMutations.saveSplit.mock.calls[0][1]).toEqual([
      { category_id: 'groceries', amount: 60, label: '' },
      { category_id: 'hardware', amount: 40, label: '' },
    ])
  })

  it('puts the remainder in the amount the user selected, not one it picked', async () => {
    const user = userEvent.setup()
    renderEditor()
    await amountFields()

    // Three rows, and the selected one is deliberately *not* the last: with only two, "the selected
    // amount" and "the last amount" are the same field, and the test would pass against the earlier
    // behavior that always filled the final row.
    await user.click(screen.getByText('+ Item'))
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

  it('distributes the remainder across the filled amounts, and undoes every one it changed', async () => {
    const user = userEvent.setup()
    renderEditor()
    await amountFields()
    await user.click(screen.getByText('+ Item'))
    const three = screen.getAllByLabelText('Amount')

    await user.type(three[0], '50')
    await user.type(three[1], '25')   // the third stays empty and must not take a share
    await user.click(screen.getByText('Distribute remainder'))
    expect(three.map(f => f.value)).toEqual(['66.67', '33.33', ''])

    await user.click(screen.getByText('Undo'))
    expect(three.map(f => f.value)).toEqual(['50', '25', ''])
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

    await user.click(screen.getByText('+ Item'))
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
    txnMutations.saveSplit.mockRejectedValue(new Error('Two parts of a split cannot use the same category — combine them into one part.'))
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
      list_total: 100,
      parts: [
        { label: 'Air Widget', amount: 70, category_id: null, unit_price: 35, quantity: 2, list_price: 70 },
        { label: 'Cable', amount: 30, category_id: null, unit_price: 30, quantity: 1, list_price: 30 },
      ],
    })
    renderEditor()

    await user.click(await screen.findByText('Use items'))

    const fields = await amountFields()
    expect(fields.map(f => f.value)).toEqual(['70', '30'])
    expect(screen.getByText('Fully allocated')).toBeTruthy()
    // Nothing was claimed by a rule here, so both pickers wait for the user.
    expect(screen.getAllByText('Choose category').length).toBe(2)
    // Each item's name arrives as an editable label rather than a caption, since a marketplace title
    // is what the user has to cut down to something a ledger can show.
    expect(screen.getAllByLabelText('Description').map(f => f.value)).toEqual(['Air Widget', 'Cable'])
  })

  it('opens on one row per item when the order says how many there are', async () => {
    api.getSplitSuggestion.mockResolvedValue({
      available: true,
      list_total: 41.48,
      parts: [
        { label: 'One', amount: 13.80, category_id: null, unit_price: 12.99, quantity: 1, list_price: 12.99 },
        { label: 'Two', amount: 14.86, category_id: null, unit_price: 13.99, quantity: 1, list_price: 13.99 },
        { label: 'Three', amount: 15.41, category_id: null, unit_price: 14.50, quantity: 1, list_price: 14.50 },
      ],
    })
    render(<SplitEditorDialog txn={TXN} categories={CATEGORIES} onClose={() => {}} onSaved={() => {}} />)

    const fields = await screen.findAllByLabelText('Amount')
    expect(fields.length).toBe(3)
    // Sized, not filled — putting the amounts in is what Use items is for.
    expect(fields.map(f => f.value)).toEqual(['', '', ''])
  })

  it('never opens on fewer than two rows, whatever the order says', async () => {
    api.getSplitSuggestion.mockResolvedValue({
      available: true,
      list_total: 12.99,
      parts: [
        { label: 'Only one', amount: 44.07, category_id: null, unit_price: 12.99, quantity: 1, list_price: 12.99 },
      ],
    })
    render(<SplitEditorDialog txn={TXN} categories={CATEGORIES} onClose={() => {}} onSaved={() => {}} />)

    expect((await screen.findAllByLabelText('Amount')).length).toBe(2)
  })

  it('fills in the categories the user\'s rules claimed, and only those', async () => {
    const user = userEvent.setup()
    api.getSplitSuggestion.mockResolvedValue({
      available: true,
      list_total: 100,
      categorized: 1,
      parts: [
        { label: 'Beans', amount: 60, category_id: 'groceries', unit_price: 60, quantity: 1, list_price: 60 },
        { label: 'Something else', amount: 40, category_id: null, unit_price: 40, quantity: 1, list_price: 40 },
      ],
    })
    renderEditor()

    // The strip says how much was decided, so the result never reads as finished.
    expect(await screen.findByText(/rules categorize 1 of them/)).toBeTruthy()
    await user.click(screen.getByText('Use items'))

    // One picker filled from the rules, one still waiting — a proposal, not a decision.
    expect(screen.getByText('Groceries')).toBeTruthy()
    expect(screen.getAllByText('Choose category').length).toBe(1)
  })

  it('says nothing when there is no item detail to propose from', async () => {
    renderEditor()
    await amountFields()
    expect(screen.queryByText('Use items')).toBeNull()
  })
})

describe('split editor on a deposit', () => {
  // Parts are stored in the transaction's own direction, so a deposit's are negative on disk. The
  // dialog works in that direction throughout — otherwise splitting a $200 deposit would mean typing
  // -120 and -80 beneath a Transaction line reading -$200 — and converts back on the way out, which is
  // what these two assert from both ends.
  const DEPOSIT = { ...TXN, id: 't2', amount: -200, display_name: 'Fixture Employer' }

  it("takes positive amounts and saves them in the transaction's direction", async () => {
    const user = userEvent.setup()
    api.getSplit.mockResolvedValue({ txn_id: 't2', amount: -200, is_split: false, parts: [] })
    renderEditor({ txn: DEPOSIT })
    const fields = await amountFields()

    // The figure being divided reads as the ledger row reads it, not as it is stored — twice over,
    // since nothing is allocated yet and the remainder is the whole of it.
    expect(screen.getAllByText('$200.00').length).toBe(2)

    await user.click(screen.getAllByText('Choose category')[0])
    await user.click(await screen.findByText('Groceries'))
    await user.click(screen.getAllByText('Choose category')[0])
    await user.click(await screen.findByText('Hardware'))

    await user.type(fields[0], '120')
    // What is left to allocate is stated the same way, so the arithmetic on screen is all one sign.
    expect(screen.getByText('$80.00')).toBeTruthy()
    await user.type(fields[1], '80')
    expect(screen.getByText('Fully allocated')).toBeTruthy()

    await user.click(screen.getByText('Save split'))
    await waitFor(() => expect(txnMutations.saveSplit).toHaveBeenCalledTimes(1))
    expect(txnMutations.saveSplit.mock.calls[0][1]).toEqual([
      { category_id: 'groceries', amount: -120, label: '' },
      { category_id: 'hardware', amount: -80, label: '' },
    ])
  })

  it('reopens an existing deposit split on the figures it was entered with', async () => {
    api.getSplit.mockResolvedValue({
      txn_id: 't2', amount: -200, is_split: true,
      parts: [
        { id: 'p1', category_id: 'groceries', amount: -120, label: null },
        { id: 'p2', category_id: 'hardware', amount: -80, label: null },
      ],
    })
    renderEditor({ txn: { ...DEPOSIT, is_split: true } })
    const fields = await amountFields()

    expect(fields.map(f => f.value)).toEqual(['120', '80'])
    expect(screen.getByText('Fully allocated')).toBeTruthy()
  })
})

describe('split editor labels', () => {
  it('sends the label with the amount it annotates', async () => {
    const user = userEvent.setup()
    renderEditor()
    const fields = await amountFields()

    await user.click(screen.getAllByText('Choose category')[0])
    await user.click(await screen.findByText('Groceries'))
    await user.click(screen.getAllByText('Choose category')[0])
    await user.click(await screen.findByText('Hardware'))
    await user.type(fields[0], '60')
    await user.type(fields[1], '40')

    const labels = screen.getAllByLabelText('Description')
    await user.type(labels[0], 'Pantry restock')
    await user.click(screen.getByText('Save split'))

    await waitFor(() => expect(txnMutations.saveSplit).toHaveBeenCalledTimes(1))
    expect(txnMutations.saveSplit.mock.calls[0][1]).toEqual([
      { category_id: 'groceries', amount: 60, label: 'Pantry restock' },
      { category_id: 'hardware', amount: 40, label: '' },
    ])
  })

  it('reopens an existing split on the labels it was saved with', async () => {
    api.getSplit.mockResolvedValue({
      txn_id: 't1', amount: 100, is_split: true,
      parts: [
        { id: 'p1', category_id: 'groceries', amount: 60, label: 'Pantry restock' },
        { id: 'p2', category_id: 'hardware', amount: 40, label: null },
      ],
    })
    renderEditor({ txn: { ...TXN, is_split: true } })
    await amountFields()

    expect(screen.getAllByLabelText('Description').map(f => f.value)).toEqual(['Pantry restock', ''])
  })
})

describe('split editor opening', () => {
  it('shows nothing until it can open fully formed', async () => {
    // Opening on a bare "Loading…" and then growing — first by the order's row count, then by the
    // height of the pre-fill strip — jumps the dialog twice under the cursor before it can be read.
    let settle
    api.getSplit.mockReturnValue(new Promise(resolve => { settle = resolve }))
    api.getSplitSuggestion.mockResolvedValue({
      available: true,
      list_total: 41.48,
      parts: [
        { label: 'One', amount: 14.69, category_id: null, unit_price: 12.99, quantity: 1, list_price: 12.99 },
        { label: 'Two', amount: 14.69, category_id: null, unit_price: 13.99, quantity: 1, list_price: 13.99 },
        { label: 'Three', amount: 14.69, category_id: null, unit_price: 14.50, quantity: 1, list_price: 14.50 },
      ],
    })
    renderEditor()

    expect(screen.queryByText('Split across categories')).toBeNull()
    expect(screen.queryByText('Loading…')).toBeNull()

    settle({ txn_id: 't1', amount: 44.07, is_split: false, parts: [] })

    // When it does appear it is already at its final size: three rows and the strip, in one paint.
    expect(await screen.findByText('Split across categories')).toBeTruthy()
    expect(screen.getAllByLabelText('Amount').length).toBe(3)
    expect(screen.getByText('Use items')).toBeTruthy()
  })

  it('opens on its loading state rather than nothing when the load stalls', async () => {
    // The bound on the wait: a Split… that appears to do nothing forever is the worse failure. The
    // threshold is deliberately far looser than the app's "announce slowness" one — a local request
    // answering in 22ms routinely takes hundreds of milliseconds to *land* once it queues behind the
    // page's other requests, and a gate tuned to the shorter number fired on nearly every open.
    api.getSplit.mockReturnValue(new Promise(() => {}))
    renderEditor()

    // Still hidden well past the announce threshold that used to release it.
    await new Promise(r => setTimeout(r, BUSY_INDICATOR_DELAY_MS * 2))
    expect(screen.queryByText('Loading…')).toBeNull()

    await waitFor(() => expect(screen.getByText('Loading…')).toBeTruthy(),
      { timeout: PAINT_GATE_DELAY_MS * 3 })
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

// A greyed Save says what it is waiting for. The reported case: the amounts added up and Save stayed
// grey with nothing on screen saying a part still had no category.
describe('why Save is unavailable', () => {
  async function hoverSave(user) {
    await user.hover(screen.getByText('Save split').closest('span'))
  }

  it('names the part still missing a category once the amounts add up', async () => {
    const user = userEvent.setup()
    renderEditor()
    const fields = await amountFields()
    await user.click(screen.getAllByText('Choose category')[0])
    await user.click(await screen.findByText('Groceries'))
    await user.type(fields[0], '60')
    await user.type(fields[1], '40')

    await hoverSave(user)
    expect(await screen.findByText('Choose a category for part 2')).toBeTruthy()
  })

  it('names what is left to allocate once every part is filled in', async () => {
    const user = userEvent.setup()
    renderEditor()
    const fields = await amountFields()
    await user.click(screen.getAllByText('Choose category')[0])
    await user.click(await screen.findByText('Groceries'))
    await user.click(screen.getAllByText('Choose category')[0])
    await user.click(await screen.findByText('Hardware'))
    await user.type(fields[0], '60')
    await user.type(fields[1], '30')

    await hoverSave(user)
    expect(await screen.findByText(/\$10\.00 left to allocate/)).toBeTruthy()
  })
})
