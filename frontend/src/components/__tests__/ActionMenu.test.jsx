// @vitest-environment jsdom

// Contract for the shared overflow menu. Two things are worth pinning because both consumers depend on
// them and neither is visible in a diff: an item's click runs its action AND closes the menu (a caller
// that had to close it itself would leave the menu open on every surface that forgot), and `danger` is
// the one styling hook carrying meaning — it marks an action with no way back, so a refactor that
// dropped it would silently flatten the distinction between "delete this permanently" and the
// reversible items sitting next to it.

import { afterEach, describe, it, expect, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ActionMenu } from '../ActionMenu.jsx'

afterEach(cleanup)

const ANCHOR = { top: 100, bottom: 120, left: 200, right: 260, width: 60, height: 20 }

describe('ActionMenu', () => {
  it('runs the item action and closes on click', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    const onClose = vi.fn()
    render(<ActionMenu anchorRect={ANCHOR} onClose={onClose} items={[{ label: 'Rename', onClick }]} />)
    await user.click(screen.getByRole('menuitem', { name: 'Rename' }))
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('marks only danger items with the danger color', () => {
    render(
      <ActionMenu
        anchorRect={ANCHOR}
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
      <ActionMenu anchorRect={ANCHOR} onClose={onClose}
        items={[{ label: 'Fetch more history', onClick, disabled: true }]} />,
    )
    await user.click(screen.getByRole('menuitem', { name: 'Fetch more history' }))
    expect(onClick).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('renders nothing without an anchor', () => {
    const { container } = render(
      <ActionMenu anchorRect={null} onClose={() => {}} items={[{ label: 'Rename', onClick: () => {} }]} />,
    )
    expect(container.innerHTML).toBe('')
  })

  // The vertical axis is the one that needs measuring, because the menu's height follows the caller's
  // item count. Clamping only the horizontal axis — which needs no measurement — is what let a trigger
  // near the bottom of a long list of connection cards open its menu off the bottom of the screen.
  describe('staying on screen vertically', () => {
    // jsdom gives every element a zero offsetHeight, so the height under test has to be supplied.
    function withMenuHeight(height) {
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: height })
    }
    afterEach(() => {
      delete HTMLElement.prototype.offsetHeight
    })

    const items = [{ label: 'Rename', onClick: () => {} }]
    const menu = () => screen.getByRole('menu')

    it('opens below the anchor when there is room', () => {
      withMenuHeight(100)                                   // window.innerHeight is 768 in jsdom
      render(<ActionMenu anchorRect={ANCHOR} onClose={() => {}} items={items} />)
      expect(menu().style.top).toBe('124px')                // anchor bottom 120 + the 4px gap
    })

    it('flips above the anchor when it would run off the bottom', () => {
      withMenuHeight(100)
      render(
        <ActionMenu
          anchorRect={{ ...ANCHOR, top: 700, bottom: 720 }}
          onClose={() => {}}
          items={items}
        />,
      )
      expect(menu().style.top).toBe('596px')                // anchor top 700 − 4px gap − 100px tall
    })

    it('sits against the bottom edge when it fits neither above nor below', () => {
      // A menu taller than the window. Pinning it to the margin and letting it scroll is worse than
      // fitting, and better than the alternative of rendering it where it cannot be reached.
      withMenuHeight(900)
      render(<ActionMenu anchorRect={ANCHOR} onClose={() => {}} items={items} />)
      expect(menu().style.top).toBe('8px')
      expect(menu().style.overflowY).toBe('auto')
    })
  })
})
