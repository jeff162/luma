// @vitest-environment jsdom

// Contract for the shared overflow menu. Two things are worth pinning because both consumers depend on
// them and neither is visible in a diff: an item's click runs its action AND closes the menu (a caller
// that had to close it itself would leave the menu open on every surface that forgot), and `danger` is
// the one styling hook carrying meaning — it marks an action with no way back, so a refactor that
// dropped it would silently flatten the distinction between "delete this permanently" and the
// reversible items sitting next to it.
//
// Keyboard is pinned too, since every menu in the app now gets it from here: arrows move through the
// items and wrap, a disabled item is still reached (its reason is only readable that way), and closing
// by choosing or by Escape puts focus back on the trigger so the keyboard user is not dropped on <body>.

import { afterEach, describe, it, expect, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ActionMenu } from '../ActionMenu.jsx'

afterEach(cleanup)

const ANCHOR = document.createElement('button')

describe('ActionMenu', () => {
  it('runs the item action and closes on click', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    const onClose = vi.fn()
    render(<ActionMenu anchorElement={ANCHOR} onClose={onClose} items={[{ label: 'Rename', onClick }]} />)
    await user.click(screen.getByRole('menuitem', { name: 'Rename' }))
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('marks only danger items with the danger color', () => {
    render(
      <ActionMenu
        anchorElement={ANCHOR}
        onClose={() => {}}
        items={[
          { label: 'Remove synced transactions', onClick: () => {} },
          { label: 'Disconnect', onClick: () => {}, danger: true },
        ]}
      />,
    )
    expect(screen.getByRole('menuitem', { name: 'Disconnect' }).style.color).toBe('var(--danger)')
    expect(screen.getByRole('menuitem', { name: 'Remove synced transactions' }).style.color)
      .toBe('var(--text)')
  })

  it('does not fire a disabled item', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    const onClose = vi.fn()
    render(
      <ActionMenu anchorElement={ANCHOR} onClose={onClose}
        items={[{ label: 'Fetch more history', onClick, disabled: true }]} />,
    )
    await user.click(screen.getByRole('menuitem', { name: 'Fetch more history' }))
    expect(onClick).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('opens at the pointer for a right-click menu', () => {
    render(<ActionMenu anchorPoint={{ x: 40, y: 50 }} onClose={() => {}} items={[{ label: 'Rename', onClick: () => {} }]} />)
    expect(screen.getByRole('menuitem', { name: 'Rename' })).toBeTruthy()
  })

  it('renders nothing without an anchor', () => {
    const { container } = render(
      <ActionMenu anchorElement={null} onClose={() => {}} items={[{ label: 'Rename', onClick: () => {} }]} />,
    )
    expect(container.innerHTML).toBe('')
  })

  it('moves through the items with the arrow keys, wrapping, and reaches disabled items', () => {
    render(
      <ActionMenu anchorPoint={{ x: 0, y: 0 }} onClose={() => {}} items={[
        { label: 'Rename', onClick: () => {} },
        { label: 'Fetch more history', onClick: () => {}, disabled: true, disabledReason: 'Nothing older' },
        { label: 'Delete', onClick: () => {}, danger: true },
      ]} />,
    )
    const menu = screen.getByRole('menu')
    expect(document.activeElement).toBe(menu)
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Rename' }))
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Fetch more history' }))
    fireEvent.keyDown(menu, { key: 'End' })
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Rename' }))
    fireEvent.keyDown(menu, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Delete' }))
  })

  it('returns focus to the trigger when an item is chosen from the keyboard', async () => {
    const user = userEvent.setup()
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    trigger.focus()
    const onClick = vi.fn()
    render(<ActionMenu anchorElement={trigger} onClose={() => {}} items={[{ label: 'Rename', onClick }]} />)
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' })
    await user.keyboard('{Enter}')
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(trigger)
    trigger.remove()
  })

  it('returns focus to the trigger on Escape', () => {
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    trigger.focus()
    const onClose = vi.fn()
    render(<ActionMenu anchorElement={trigger} onClose={onClose} items={[{ label: 'Rename', onClick: () => {} }]} />)
    // A trigger focused by script is focus-visible, so this opens as from the keyboard, on the first item.
    expect(screen.getByRole('menu').contains(document.activeElement)).toBe(true)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(trigger)
    trigger.remove()
  })

  it('marks the current choice in a one-of-many menu', () => {
    render(
      <ActionMenu anchorPoint={{ x: 0, y: 0 }} onClose={() => {}} items={[
        { label: 'Recurring', checked: true, onClick: () => {} },
        { label: 'Split', checked: false, onClick: () => {} },
      ]} />,
    )
    expect(screen.getByRole('menuitemradio', { name: 'Recurring' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('menuitemradio', { name: 'Split' }).getAttribute('aria-checked')).toBe('false')
  })

  // An on/off item is one of several settings made in one visit, so choosing it must not close the menu.
  it('runs an on/off item and stays open', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    const onClose = vi.fn()
    render(
      <ActionMenu anchorElement={ANCHOR} onClose={onClose} items={[
        { label: 'Source', toggled: false, onClick },
        { label: 'Account', toggled: true, onClick: () => {} },
      ]} />,
    )
    const source = screen.getByRole('menuitemcheckbox', { name: 'Source' })
    expect(source.getAttribute('aria-checked')).toBe('false')
    expect(screen.getByRole('menuitemcheckbox', { name: 'Account' }).getAttribute('aria-checked')).toBe('true')
    await user.click(source)
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
  })
})
