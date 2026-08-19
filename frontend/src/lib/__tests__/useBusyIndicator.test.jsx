// @vitest-environment jsdom

// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  BUSY_INDICATOR_DELAY_MS, BUSY_INDICATOR_MIN_VISIBLE_MS, useBusyIndicator,
} from '../useBusyIndicator.js'

const DELAY = BUSY_INDICATOR_DELAY_MS
const MIN = BUSY_INDICATOR_MIN_VISIBLE_MS

// Both halves of the rule are load-bearing, and each is a different kind of flicker: without the delay,
// every fast operation repaints the screen for a few frames; without the minimum, an operation that
// finishes just past the delay flashes the indicator it was supposed to earn.
describe('useBusyIndicator', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  const advance = ms => act(() => { vi.advanceTimersByTime(ms) })

  it('says nothing at all about work that finishes quickly', () => {
    const { result, rerender } = renderHook(({ busy }) => useBusyIndicator(busy), {
      initialProps: { busy: true },
    })
    advance(DELAY - 20)
    expect(result.current).toBe(false)
    rerender({ busy: false })
    advance(1000)
    expect(result.current).toBe(false)
  })

  it('speaks up once the work outlasts the delay', () => {
    const { result } = renderHook(() => useBusyIndicator(true))
    expect(result.current).toBe(false)
    advance(DELAY)
    expect(result.current).toBe(true)
  })

  it('stays up long enough to be read, even if the work ends immediately after', () => {
    const { result, rerender } = renderHook(({ busy }) => useBusyIndicator(busy), {
      initialProps: { busy: true },
    })
    advance(DELAY)
    expect(result.current).toBe(true)
    rerender({ busy: false })
    advance(MIN - 50)
    expect(result.current).toBe(true)   // the flash this exists to prevent
    advance(60)
    expect(result.current).toBe(false)
  })

  it('comes down at once when the minimum has already passed', () => {
    const { result, rerender } = renderHook(({ busy }) => useBusyIndicator(busy), {
      initialProps: { busy: true },
    })
    advance(DELAY + MIN + 100)
    expect(result.current).toBe(true)
    rerender({ busy: false })
    advance(0)
    expect(result.current).toBe(false)
  })

  it('does not restart its delay when the busy flag is re-asserted', () => {
    // A component that re-renders mid-request must not push the indicator further away each time, or a
    // busy surface that renders often would never announce anything.
    const { result, rerender } = renderHook(({ busy }) => useBusyIndicator(busy), {
      initialProps: { busy: true },
    })
    advance(DELAY - 20)
    rerender({ busy: true })
    advance(30)
    expect(result.current).toBe(true)
  })
})
