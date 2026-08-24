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
          id: 't1', is_split: true, split_part_count: 2,
          split_parts: [
            { category_id: 'groceries', category_name: 'Groceries', amount: 60 },
            { category_id: 'hardware', category_name: 'Hardware', amount: -40 },
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
    // Signed, not magnitudes — a displayed number always carries its true sign.
    expect(screen.getByText('$60.00')).toBeTruthy()
    expect(screen.getByText('-$40.00')).toBeTruthy()
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
