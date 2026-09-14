// @vitest-environment jsdom

// The refresh control's promise is that a press is always answered. A reload here usually finishes in a
// few milliseconds and changes nothing on screen, so the icon turning is the only sign it ran: it has to
// keep turning to the end of a rotation even when the work is already done, refuse a second press while
// it does, and still stop where no animation events ever arrive. Work it did not start is announced only
// once slow, like every other busy indicator.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { REFRESH_TURN_FALLBACK_MS, RefreshButton } from '../ui.jsx'
import { BUSY_INDICATOR_DELAY_MS } from '../../lib/useBusyIndicator.js'

const button = () => screen.getByRole('button', { name: 'Refresh' })
const icon = () => button().querySelector('svg')
const turning = () => button().getAttribute('aria-busy') === 'true'
// The end of one rotation. React listens for the prefixed name wherever `AnimationEvent` is missing, which
// includes jsdom, so the standard `fireEvent.animationIteration` would reach nothing here; every browser the
// app runs in has the standard event.
const completeTurn = () => fireEvent(icon(), new Event('webkitAnimationIteration', { bubbles: true }))

describe('RefreshButton', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('keeps turning after an instant reload until the rotation completes', async () => {
    const onRefresh = vi.fn().mockResolvedValue(undefined)
    render(<RefreshButton onRefresh={onRefresh} />)

    await act(async () => { fireEvent.click(button()) })
    expect(onRefresh).toHaveBeenCalledTimes(1)
    expect(turning()).toBe(true)

    completeTurn()
    expect(turning()).toBe(false)
  })

  it('does not stop at a rotation boundary while the reload is still running', async () => {
    let finish
    render(<RefreshButton onRefresh={() => new Promise(resolve => { finish = resolve })} />)

    await act(async () => { fireEvent.click(button()) })
    completeTurn()
    expect(turning()).toBe(true)

    await act(async () => { finish() })
    completeTurn()
    expect(turning()).toBe(false)
  })

  it('ignores a second press while the first is still turning', async () => {
    const onRefresh = vi.fn().mockResolvedValue(undefined)
    render(<RefreshButton onRefresh={onRefresh} />)

    await act(async () => { fireEvent.click(button()) })
    await act(async () => { fireEvent.click(button()) })
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it('stops anyway where no animation events arrive', async () => {
    render(<RefreshButton onRefresh={() => Promise.resolve()} />)

    await act(async () => { fireEvent.click(button()) })
    expect(turning()).toBe(true)
    act(() => { vi.advanceTimersByTime(REFRESH_TURN_FALLBACK_MS) })
    expect(turning()).toBe(false)
  })

  it('announces a load it did not start only once it is slow', () => {
    const { rerender } = render(<RefreshButton onRefresh={() => {}} loading />)
    expect(turning()).toBe(false)

    act(() => { vi.advanceTimersByTime(BUSY_INDICATOR_DELAY_MS) })
    expect(turning()).toBe(true)

    rerender(<RefreshButton onRefresh={() => {}} loading={false} />)
    act(() => { vi.advanceTimersByTime(1000) })
    completeTurn()
    expect(turning()).toBe(false)
  })
})
