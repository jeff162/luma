// @vitest-environment jsdom

/*
 * One Escape press reaches one layer: the one activated most recently. Before the shared stack, every
 * layer listened on the window and all of them ran, so Escape in a panel's `⋯` menu closed the panel too.
 */

import { memo } from 'react'
import { afterEach, describe, it, expect, vi } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { useEscapeAction } from '../uiInteractions.js'
import { DetailPanelShell } from '../../components/detailShared.jsx'
import { ActionMenu } from '../../components/ActionMenu.jsx'

afterEach(cleanup)

// Memoized so a test can re-render one layer and not the other.
const Layer = memo(function Layer({ onEscape, enabled = true, ignoreEditableTarget = false }) {
  // A new handler on every render, as an inline callback is.
  useEscapeAction(event => onEscape(event), { enabled, ignoreEditableTarget })
  return null
})

function pressEscape(target = window) {
  fireEvent.keyDown(target, { key: 'Escape' })
}

describe('useEscapeAction', () => {
  it('gives the press to the most recently activated layer only', () => {
    const lower = vi.fn()
    const upper = vi.fn()
    const { rerender } = render(<><Layer onEscape={lower} /><Layer onEscape={upper} enabled={false} /></>)
    rerender(<><Layer onEscape={lower} /><Layer onEscape={upper} /></>)
    pressEscape()
    expect(upper).toHaveBeenCalledTimes(1)
    expect(lower).not.toHaveBeenCalled()
  })

  it('keeps a layer in its place when it re-renders with a new handler', () => {
    const upper = vi.fn()
    const lower = vi.fn()
    const { rerender } = render(<><Layer onEscape={vi.fn()} /><Layer onEscape={upper} /></>)
    // Only the lower layer re-renders; it must not move above the upper one.
    rerender(<><Layer onEscape={lower} /><Layer onEscape={upper} /></>)
    pressEscape()
    expect(upper).toHaveBeenCalledTimes(1)
    expect(lower).not.toHaveBeenCalled()
  })

  it('hands the press back to the layer below once the top one is disabled', () => {
    const lower = vi.fn()
    const upper = vi.fn()
    const { rerender } = render(<><Layer onEscape={lower} /><Layer onEscape={upper} /></>)
    rerender(<><Layer onEscape={lower} /><Layer onEscape={upper} enabled={false} /></>)
    pressEscape()
    expect(lower).toHaveBeenCalledTimes(1)
    expect(upper).not.toHaveBeenCalled()
  })

  it('lets nothing below act when the top layer declines a press from a field', () => {
    const lower = vi.fn()
    const upper = vi.fn()
    render(<><Layer onEscape={lower} /><Layer onEscape={upper} ignoreEditableTarget /></>)
    const input = document.createElement('input')
    document.body.appendChild(input)
    pressEscape(input)
    expect(upper).not.toHaveBeenCalled()
    expect(lower).not.toHaveBeenCalled()
    input.remove()
  })

  it('ignores a press a field already handled', () => {
    const layer = vi.fn()
    render(<Layer onEscape={layer} />)
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    event.preventDefault()
    window.dispatchEvent(event)
    expect(layer).not.toHaveBeenCalled()
  })
})

describe('Escape in a menu opened from a detail panel', () => {
  it('closes the menu and leaves the panel open', () => {
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    const closePanel = vi.fn()
    const closeMenu = vi.fn()
    const { rerender } = render(<DetailPanelShell onClose={closePanel} header="Panel">body</DetailPanelShell>)
    rerender(
      <DetailPanelShell onClose={closePanel} header="Panel">
        <ActionMenu anchorElement={trigger} onClose={closeMenu} items={[{ label: 'Rename', onClick: () => {} }]} />
      </DetailPanelShell>,
    )
    pressEscape()
    expect(closeMenu).toHaveBeenCalledTimes(1)
    expect(closePanel).not.toHaveBeenCalled()

    rerender(<DetailPanelShell onClose={closePanel} header="Panel">body</DetailPanelShell>)
    pressEscape()
    expect(closePanel).toHaveBeenCalledTimes(1)
    trigger.remove()
  })
})
