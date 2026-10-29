// @vitest-environment jsdom

// Covers the two behaviors that make a hint safe to attach to a row of a long scrolling list: it must
// require a dwell before opening, and it must get out of the way when the list scrolls. Both exist
// because the reconciliation report's order/charge cells strobed a hover card at every row that slid
// under a resting cursor during wheel/page-down scrolling.
//
// The default (no openDelay) must stay instant — most callers are small buttons where a dwell would
// just feel laggy — so that path is pinned here too.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, act, cleanup, fireEvent } from '@testing-library/react'
import { Tooltip, ROW_HOVER_OPEN_DELAY_MS } from '../ui.jsx'

// This project doesn't run vitest with `globals: true`, so testing-library's auto-cleanup never registers.
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

// React synthesizes onMouseEnter/onMouseLeave from native mouseover/mouseout (its enter-leave plugin),
// so dispatching a native mouseenter would never reach the handler. `relatedTarget` is what tells that
// plugin the pointer actually crossed the boundary rather than moving within the trigger's subtree.
function hover(element) {
  fireEvent.mouseOver(element, { relatedTarget: document.body })
}

function unhover(element) {
  fireEvent.mouseOut(element, { relatedTarget: document.body })
}

function renderTooltip(props = {}) {
  const { container } = render(
    <Tooltip content="origin detail" {...props}><span>cell</span></Tooltip>,
  )
  return container.firstChild
}

describe('Tooltip open delay', () => {
  it('opens immediately when no delay is configured', () => {
    const trigger = renderTooltip()

    hover(trigger)

    expect(screen.getByRole('tooltip')).toBeTruthy()
  })

  it('does not open while the dwell is still running', () => {
    vi.useFakeTimers()
    const trigger = renderTooltip({ openDelay: ROW_HOVER_OPEN_DELAY_MS })

    hover(trigger)
    act(() => { vi.advanceTimersByTime(ROW_HOVER_OPEN_DELAY_MS - 50) })

    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('opens once the dwell elapses', () => {
    vi.useFakeTimers()
    const trigger = renderTooltip({ openDelay: ROW_HOVER_OPEN_DELAY_MS })

    hover(trigger)
    act(() => { vi.advanceTimersByTime(ROW_HOVER_OPEN_DELAY_MS) })

    expect(screen.getByRole('tooltip')).toBeTruthy()
  })

  it('never opens when the pointer leaves before the dwell elapses', () => {
    vi.useFakeTimers()
    const trigger = renderTooltip({ openDelay: ROW_HOVER_OPEN_DELAY_MS })

    // The scrolling case in miniature: a row passes under the cursor and is gone before the dwell.
    hover(trigger)
    act(() => { vi.advanceTimersByTime(100) })
    unhover(trigger)
    act(() => { vi.advanceTimersByTime(ROW_HOVER_OPEN_DELAY_MS * 2) })

    expect(screen.queryByRole('tooltip')).toBeNull()
  })
})

describe('Tooltip scroll handling', () => {
  it('closes an open tooltip when something scrolls', () => {
    const trigger = renderTooltip()
    hover(trigger)
    expect(screen.getByRole('tooltip')).toBeTruthy()

    // Capture-phase listener: a scroll in any ancestor container counts, and scroll doesn't bubble.
    act(() => { window.dispatchEvent(new Event('scroll', { bubbles: false })) })

    // Otherwise it would hang at fixed coordinates while its trigger scrolled away.
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  // The dismissal has to be attached by the hover itself, not by the render the hover schedules: on a
  // transaction row the right-click lands ~2ms after the pointer, with no commit in between. These two
  // events are dispatched raw, outside `act`, so nothing is flushed between them — an effect-registered
  // listener is not there yet at that point and the card opens over the menu it should have yielded to.
  it('cancels a pending open when a right-click lands before React has re-rendered', () => {
    vi.useFakeTimers()
    const trigger = renderTooltip({ openDelay: ROW_HOVER_OPEN_DELAY_MS, interactive: true })

    trigger.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }))
    trigger.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
    act(() => { vi.advanceTimersByTime(ROW_HOVER_OPEN_DELAY_MS * 2) })

    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('cancels a pending open when a scroll starts during the dwell', () => {
    vi.useFakeTimers()
    const trigger = renderTooltip({ openDelay: ROW_HOVER_OPEN_DELAY_MS })

    hover(trigger)
    act(() => { vi.advanceTimersByTime(100) })
    act(() => { window.dispatchEvent(new Event('scroll', { bubbles: false })) })
    act(() => { vi.advanceTimersByTime(ROW_HOVER_OPEN_DELAY_MS * 2) })

    // A scroll that begins mid-dwell must not resolve into a hint after the list has moved on.
    expect(screen.queryByRole('tooltip')).toBeNull()
  })
})

describe('Tooltip describeTrigger', () => {
  it('gives a disabled control its reason as the accessible description without a hover', () => {
    render(
      <Tooltip describeTrigger content="Enter an amount first">
        <button type="button" disabled aria-describedby="other-note">Split</button>
      </Tooltip>,
    )
    const button = screen.getByRole('button', { name: 'Split' })
    expect(button).toHaveAccessibleDescription(/Enter an amount first/)
    expect(button.getAttribute('aria-describedby')).toMatch(/^other-note /)
  })
})
