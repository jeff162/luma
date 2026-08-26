// @vitest-environment jsdom

/*
 * The date filter's back-step.
 *
 * Clicking a bar on a Dashboard trend re-pins the shared period — a navigation the user did not
 * necessarily read as one and which leaves no record of where they were. That pin is the only thing the
 * history records: an explicit FilterBar pick or a clear is a choice the user can see in the chip, and
 * recording it would let one step back walk over it. These pin that split, along with the shape of the
 * record — that it holds the *outgoing* value, that a re-pick of the same period is not a step, and that
 * a long run of clicks stays bounded.
 */

import { describe, it, expect } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { act } from 'react'
import { FilterProvider, useFilters, describeDateFilter } from '../FilterContext.jsx'

const APRIL = { start: '2026-04-01', end: '2026-04-30', preset: 'April 2026' }
const MAY = { start: '2026-05-01', end: '2026-05-31', preset: 'May 2026' }
const JUNE = { start: '2026-06-01', end: '2026-06-30', preset: 'June 2026' }
const ALL_TIME = { start: null, end: null }

let api

function Probe() {
  api = useFilters()
  return <div data-testid="date">{describeDateFilter(api.filters.date)}</div>
}

function mount({ initialDate = null } = {}) {
  cleanup()
  render(<FilterProvider initialDate={initialDate}><Probe /></FilterProvider>)
}

const shown = () => screen.getByTestId('date').textContent

describe('stepping back through the date filter', () => {
  it('has nothing to go back to before anything has changed', () => {
    mount()
    expect(api.canGoBackDate).toBe(false)
    expect(api.previousDate).toBeNull()
  })

  it('offers the outgoing period, not the one just arrived at', () => {
    mount({ initialDate: MAY })
    act(() => api.pinDateFromChart(JUNE))

    expect(shown()).toBe('June 2026')
    expect(api.canGoBackDate).toBe(true)
    expect(api.previousDate).toEqual(MAY)
  })

  it('restores the previous period and consumes the step', () => {
    mount({ initialDate: MAY })
    act(() => api.pinDateFromChart(JUNE))
    act(() => api.goBackDate())

    expect(shown()).toBe('May 2026')
    expect(api.canGoBackDate).toBe(false)
  })

  it('walks back through a run of bar clicks one step at a time', () => {
    // The trend re-pins the period on every bar click, so a user exploring a timeline generates a
    // sequence rather than a depth. Back has to unwind it in order.
    mount()
    act(() => api.pinDateFromChart(ALL_TIME))
    act(() => api.pinDateFromChart(MAY))
    act(() => api.pinDateFromChart(JUNE))

    expect(shown()).toBe('June 2026')
    act(() => api.goBackDate())
    expect(shown()).toBe('May 2026')
    act(() => api.goBackDate())
    expect(shown()).toBe('All time')
    act(() => api.goBackDate())
    expect(shown()).toBe('the default period')
    expect(api.canGoBackDate).toBe(false)
  })

  it('does not record a period the user picked for themselves', () => {
    // The FilterBar shows the period it just set, so there is nothing to recover — and an offer to step
    // back from it would be a second, competing way to change the date.
    mount({ initialDate: MAY })
    act(() => api.setDate(JUNE))

    expect(shown()).toBe('June 2026')
    expect(api.canGoBackDate).toBe(false)
  })

  it('does not record clearing the date either', () => {
    mount({ initialDate: MAY })
    act(() => api.clearDate())

    expect(shown()).toBe('the default period')
    expect(api.canGoBackDate).toBe(false)
  })

  it('drops pinned history at an explicit pick rather than stepping over it', () => {
    // The failure this prevents: pin June from a bar, choose April from the FilterBar, and a surviving
    // step would take Back to May — a period two changes old that the user never asked to return to.
    mount({ initialDate: MAY })
    act(() => api.pinDateFromChart(JUNE))
    act(() => api.setDate(APRIL))

    expect(api.canGoBackDate).toBe(false)
    act(() => api.goBackDate())
    expect(shown()).toBe('April 2026')
  })

  it('drops pinned history when the whole filter is reset', () => {
    mount({ initialDate: MAY })
    act(() => api.pinDateFromChart(JUNE))
    act(() => api.clearAll())

    expect(shown()).toBe('the default period')
    expect(api.canGoBackDate).toBe(false)
  })

  it('does not record a re-pick of the period already in force', () => {
    // Every setter builds a fresh object, so comparing by identity would log a step for a no-op and put
    // a Back button on screen that goes nowhere.
    mount({ initialDate: MAY })
    act(() => api.pinDateFromChart({ ...MAY }))

    expect(api.canGoBackDate).toBe(false)
  })

  it('leaves a pinned step alone when a re-pick moves nothing', () => {
    // Same no-op, from the resetting side: nothing changed, so there is no explicit pick to protect and
    // the step back the user already earned should survive.
    mount({ initialDate: MAY })
    act(() => api.pinDateFromChart(JUNE))
    act(() => api.setDate({ ...JUNE }))

    expect(api.canGoBackDate).toBe(true)
    expect(api.previousDate).toEqual(MAY)
  })

  it('does nothing when there is nothing to go back to', () => {
    mount({ initialDate: MAY })
    act(() => api.goBackDate())
    expect(shown()).toBe('May 2026')
  })

  it('keeps the history bounded rather than growing with every click', () => {
    mount()
    for (let i = 0; i < 40; i++) {
      act(() => api.pinDateFromChart({ start: `2020-01-0${(i % 9) + 1}`, end: '2020-12-31', preset: `P${i}` }))
    }
    let steps = 0
    while (api.canGoBackDate && steps < 100) {
      act(() => api.goBackDate())
      steps++
    }
    expect(steps).toBeGreaterThan(0)
    expect(steps).toBeLessThanOrEqual(20)
  })
})

describe('describeDateFilter', () => {
  it('tells the three date shapes apart, since they mean different things', () => {
    // Unset falls back to a page's registered default; the truthy no-range sentinel is an explicit
    // all-time that overrides it. A control that says where it leads has to distinguish them.
    expect(describeDateFilter(null)).toBe('the default period')
    expect(describeDateFilter(ALL_TIME)).toBe('All time')
    expect(describeDateFilter(MAY)).toBe('May 2026')
    expect(describeDateFilter({ start: '2026-01-01', end: '2026-03-31' })).toBe('2026-01-01 → 2026-03-31')
  })
})
