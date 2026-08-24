// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { StaleWhileRefreshing } from '../ui.jsx'
import { BUSY_INDICATOR_DELAY_MS } from '../../lib/useBusyIndicator.js'

// The point of this wrapper is that the content never leaves — what changes is whether it still claims to
// be the answer. So every assertion here is about the content still being present.
describe('StaleWhileRefreshing', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { cleanup(); vi.useRealTimers() })

  const advance = ms => act(() => { vi.advanceTimersByTime(ms) })
  const box = () => screen.getByText('Total 42').parentElement

  it('leaves content untouched while nothing is refreshing', () => {
    render(<StaleWhileRefreshing refreshing={false}><span>Total 42</span></StaleWhileRefreshing>)
    expect(box().style.opacity).toBe('1')
    expect(box().getAttribute('aria-busy')).toBeNull()
  })

  it('keeps the figures on screen while marking them not-current', () => {
    const { rerender } = render(
      <StaleWhileRefreshing refreshing={false}><span>Total 42</span></StaleWhileRefreshing>,
    )
    rerender(<StaleWhileRefreshing refreshing><span>Total 42</span></StaleWhileRefreshing>)
    advance(BUSY_INDICATOR_DELAY_MS)
    expect(screen.getByText('Total 42')).toBeTruthy()   // never swapped for a spinner
    expect(box().style.opacity).toBe('0.45')
    expect(box().getAttribute('aria-busy')).toBe('true')
    // Stale figures must not be clickable: drilling into them would open a view of numbers that are
    // already being replaced.
    expect(box().style.pointerEvents).toBe('none')
  })

  it('does not dim a refresh too quick to notice', () => {
    const { rerender } = render(
      <StaleWhileRefreshing refreshing><span>Total 42</span></StaleWhileRefreshing>,
    )
    advance(BUSY_INDICATOR_DELAY_MS - 20)
    rerender(<StaleWhileRefreshing refreshing={false}><span>Total 42</span></StaleWhileRefreshing>)
    advance(500)
    expect(box().style.opacity).toBe('1')
  })
})
