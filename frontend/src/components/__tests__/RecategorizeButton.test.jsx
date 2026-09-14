// @vitest-environment jsdom

// A recategorization walks every transaction, so on a real ledger it runs long enough to be pressed again
// with nothing on screen saying the first press started anything. The button takes itself out of play for
// the length of the run and says what it is doing once the run is slow enough to mention.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { RecategorizeButton } from '../RecategorizeControl.jsx'
import { BUSY_INDICATOR_DELAY_MS } from '../../lib/useBusyIndicator.js'

vi.mock('../../lib/api.js', () => ({ api: { getRecategorizePreview: vi.fn(), recategorize: vi.fn() } }))

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('RecategorizeButton', () => {
  it('is out of play for the length of a run and names it once slow', async () => {
    vi.useFakeTimers()
    let finish
    const onRun = vi.fn(() => new Promise(resolve => { finish = resolve }))
    render(<RecategorizeButton pendingCount={3} onRun={onRun} />)
    const button = screen.getByRole('button')

    await act(async () => { fireEvent.click(button) })
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(onRun).toHaveBeenCalledTimes(1)

    act(() => { vi.advanceTimersByTime(BUSY_INDICATOR_DELAY_MS) })
    expect(button.textContent).toBe('Categorizing…')

    await act(async () => { finish() })
    expect(button.disabled).toBe(false)
  })
})
