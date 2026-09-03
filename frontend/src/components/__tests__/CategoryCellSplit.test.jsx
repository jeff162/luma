// @vitest-environment jsdom

// The two shared split affordances, both in TransactionRow.jsx and both rendered by every transaction
// surface in the app — so each is asserted once here rather than per host.
//
// `CategoryCell`: a split transaction has no single category, so the cell must stop offering the
// picker on those rows. The backend refuses a single-category set on a split, and a control that opens
// and then fails is worse than one that leads somewhere useful.
//
// `ContextMenu`: the split entry is labelled for what the row becomes, and is withheld entirely when
// the host has no category list for the editor's pickers — an empty picker is not a usable editor.

import { afterEach, beforeAll, describe, it, expect, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CategoryCell, ContextMenu } from '../TransactionRow.jsx'

const CATEGORIES = [
  { id: 'g1', name: 'Household', parent_id: null },
  { id: 'groceries', name: 'Groceries', parent_id: 'g1' },
]

// jsdom implements no layout, so it has no scrollIntoView — and the picker calls it on a timer after
// it opens, which lands after this file's last test finishes. Shimmed rather than worked around by
// closing the picker, since what that test is asserting is precisely that it opened.
beforeAll(() => { Element.prototype.scrollIntoView = () => {} })

afterEach(cleanup)

describe('CategoryCell on a split transaction', () => {
  it('labels the row with its part count instead of a category', () => {
    render(
      <CategoryCell
        txn={{ id: 't1', is_split: true, split_part_count: 3, category_id: 'groceries', category_name: 'Groceries' }}
        categories={CATEGORIES}
        onSave={vi.fn()}
      />,
    )
    expect(screen.getByText('Split (3)')).toBeTruthy()
    // The retained pre-split category is not what this row reports any more.
    expect(screen.queryByText('Groceries')).toBeNull()
  })

  it('lists the parts and their amounts on hover', async () => {
    const user = userEvent.setup()
    render(
      <CategoryCell
        txn={{
          id: 't1', amount: 100, is_split: true, split_part_count: 2,
          split_parts: [
            { category_id: 'groceries', category_name: 'Groceries', amount: 60, label: 'Pantry restock' },
            { category_id: 'hardware', category_name: 'Hardware', amount: 40, label: null },
          ],
        }}
        categories={CATEGORIES}
        onSave={vi.fn()}
      />,
    )
    // Absent until hovered — without this the findByText below would pass against a tooltip that
    // simply rendered its content all the time, proving nothing about the hover.
    expect(screen.queryByText('Groceries')).toBeNull()

    await user.hover(screen.getByText('Split (2)'))

    expect(await screen.findByText('Groceries')).toBeTruthy()
    expect(screen.getByText('Hardware')).toBeTruthy()
    expect(screen.getByText('$60.00')).toBeTruthy()
    expect(screen.getByText('$40.00')).toBeTruthy()
    // A part's label rides along where one was recorded, and its absence renders nothing rather than
    // an empty line.
    expect(screen.getByText('Pantry restock')).toBeTruthy()
  })

  it('states a deposit\'s parts the way the deposit itself reads', async () => {
    // Parts are stored in the transaction's direction, so a deposit's are negative on disk. Rendered
    // raw they would read as money out beneath a row reading money in; each is shown in the
    // transaction's own direction instead, and the money-in green is what says which way it went.
    const user = userEvent.setup()
    render(
      <CategoryCell
        txn={{
          id: 't2', amount: -200, is_split: true, split_part_count: 2,
          split_parts: [
            { category_id: 'groceries', category_name: 'Groceries', amount: -120, label: null },
            { category_id: 'hardware', category_name: 'Hardware', amount: -80, label: null },
          ],
        }}
        categories={CATEGORIES}
        onSave={vi.fn()}
      />,
    )

    await user.hover(screen.getByText('Split (2)'))

    const first = await screen.findByText('$120.00')
    expect(screen.getByText('$80.00')).toBeTruthy()
    expect(first.style.color).toBe('var(--success)')
  })

  it('opens the split editor rather than the category picker', async () => {
    const user = userEvent.setup()
    const onOpenSplit = vi.fn()
    const onSave = vi.fn()
    render(
      <CategoryCell
        txn={{ id: 't1', is_split: true, split_part_count: 2 }}
        categories={CATEGORIES}
        onSave={onSave}
        onOpenSplit={onOpenSplit}
      />,
    )
    await user.click(screen.getByText('Split (2)'))
    expect(onOpenSplit).toHaveBeenCalledTimes(1)
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.queryByText('Choose category')).toBeNull()
  })

  it('stays read-only where a host cannot open the editor', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    render(
      <CategoryCell
        txn={{ id: 't1', is_split: true, split_part_count: 2 }}
        categories={CATEGORIES}
        onSave={onSave}
      />,
    )
    await user.click(screen.getByText('Split (2)'))
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.queryByText('Choose category')).toBeNull()
  })

  it('leaves an ordinary transaction on the category picker', async () => {
    const user = userEvent.setup()
    render(
      <CategoryCell
        txn={{ id: 't2', is_split: false, category_id: 'groceries', category_name: 'Groceries' }}
        categories={CATEGORIES}
        onSave={vi.fn()}
        onOpenSplit={vi.fn()}
      />,
    )
    await user.click(screen.getByText('Groceries'))
    expect(await screen.findByText('Household')).toBeTruthy()
  })
})


// A category-scoped list asks the server to expand splits, so the same cell also has to render one
// *allocation* — the case the whole-split branch above gets wrong if it is allowed to claim the row.
describe('CategoryCell on one expanded part of a split', () => {
  // The reported shape: a $250 deposit divided into $10 and $240 within one category, listed under it.
  // Stored negative because a deposit is, and rendered as the money-in magnitudes it reads as.
  const PART = {
    id: 't1', amount: -10, is_split: true, split_part_id: 'p1', split_part_count: 2,
    category_id: 'groceries', category_name: 'Groceries',
    split_parts: [
      { category_id: 'groceries', category_name: 'Groceries', amount: -10, label: null },
      { category_id: 'groceries', category_name: 'Groceries', amount: -240, label: null },
    ],
  }

  it('names the category the part is actually in', () => {
    render(<CategoryCell txn={PART} categories={CATEGORIES} onSave={vi.fn()} onOpenSplit={vi.fn()} />)
    expect(screen.getByText('Groceries')).toBeTruthy()
    // The whole-split marker would say the row is the entire $250 purchase, which is the bug.
    expect(screen.queryByText('Split (2)')).toBeNull()
  })

  it('sends a click on the category to the split editor, not the picker', async () => {
    // One allocation is not the row's to repoint — the editor is where a split's categories are set,
    // and it shows the sibling part while the user is deciding. Same destination the unexpanded row's
    // chip has, so a split behaves one way whichever list it is in.
    const user = userEvent.setup()
    const onSave = vi.fn()
    const onOpenSplit = vi.fn()
    render(<CategoryCell txn={PART} categories={CATEGORIES} onSave={onSave} onOpenSplit={onOpenSplit} />)
    await user.click(screen.getByText('Groceries'))
    expect(onOpenSplit).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Household')).toBeNull()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('says on hover which part it is and what the whole transaction was', async () => {
    const user = userEvent.setup()
    render(<CategoryCell txn={PART} categories={CATEGORIES} onSave={vi.fn()} onOpenSplit={vi.fn()} />)
    // The row's own amount is $10; the $250 is summed from the parts, which the row does not otherwise
    // carry. Absent until hovered, so the assertion below is about the hover and not a tooltip that
    // renders its content unconditionally.
    expect(screen.queryByText('One of 2 parts of $250.00')).toBeNull()

    await user.hover(screen.getByRole('button', { name: /edit the split/ }))

    expect(await screen.findByText('One of 2 parts of $250.00')).toBeTruthy()
    // The sibling allocation is the answer to "why does this row say $10?", so the same hover card the
    // ledger uses lists it.
    expect(screen.getByText('$240.00')).toBeTruthy()
  })

  it('is one control, so the marker leads where the badge does', async () => {
    const user = userEvent.setup()
    const onOpenSplit = vi.fn()
    render(<CategoryCell txn={PART} categories={CATEGORIES} onSave={vi.fn()} onOpenSplit={onOpenSplit} />)
    await user.click(screen.getByText('◧'))
    expect(onOpenSplit).toHaveBeenCalledTimes(1)
  })

  it('names the category in the control, so it is not announced as a bare glyph', () => {
    render(<CategoryCell txn={PART} categories={CATEGORIES} onSave={vi.fn()} onOpenSplit={vi.fn()} />)
    expect(screen.getByRole('button', { name: /^Groceries — one part of a split/ })).toBeTruthy()
  })

  it('still reads as the part\'s category where a host cannot open the editor', () => {
    render(<CategoryCell txn={PART} categories={CATEGORIES} onSave={vi.fn()} />)
    expect(screen.getByText('Groceries')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /edit the split/ })).toBeNull()
  })
})

describe('the row menu\'s split entry', () => {
  const menuProps = {
    onClose: () => {},
    onOpenDetail: vi.fn(),
    onEditNote: vi.fn(),
    onOpenRule: vi.fn(),
  }

  it('offers to divide a transaction that is not split yet', () => {
    render(<ContextMenu {...menuProps} menu={{ x: 10, y: 10, txn: { id: 't1', is_split: false } }} onOpenSplit={vi.fn()} />)
    expect(screen.getByText('◧ Split…')).toBeTruthy()
  })

  it('names the action for what the row already is once it is split', async () => {
    const user = userEvent.setup()
    const onOpenSplit = vi.fn()
    const txn = { id: 't1', is_split: true, split_part_count: 2 }
    render(<ContextMenu {...menuProps} menu={{ x: 10, y: 10, txn }} onOpenSplit={onOpenSplit} />)

    // Labelled by the effect on the row, not by the mechanism behind it.
    expect(screen.queryByText('◧ Split…')).toBeNull()
    await user.click(screen.getByText('◧ Edit split…'))
    expect(onOpenSplit).toHaveBeenCalledWith(txn)
  })

  it('omits the entry where the host cannot supply categories to pick', () => {
    // The controller withholds onOpenSplit rather than opening an editor with an empty picker.
    render(<ContextMenu {...menuProps} menu={{ x: 10, y: 10, txn: { id: 't1', is_split: false } }} />)
    expect(screen.queryByText('◧ Split…')).toBeNull()
    expect(screen.queryByText('◧ Edit split…')).toBeNull()
  })
})
