// @vitest-environment jsdom

// A view that ignores the shared date (the Dashboard's Trends tab) marks it inapplicable, and the date
// button then has to *be* unavailable, not only look it: it was dimmed while still opening the picker, so a
// change made there did nothing on the view in front of the user and surfaced later on another one. The
// reason stays readable on hover, which is why the button is not `disabled` — so what is asserted here is
// the consequence (the picker does not open), not an attribute.

import { afterEach, describe, it, expect, vi } from 'vitest'
import { useEffect } from 'react'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import FilterBar from '../FilterBar.jsx'
import { FilterProvider, useFilters } from '../../lib/FilterContext.jsx'
import { UserPreferencesProvider } from '../../lib/UserPreferencesContext.jsx'

vi.mock('../../lib/api.js', () => ({
  api: new Proxy({}, { get: () => () => Promise.resolve([]) }),
}))

afterEach(cleanup)

function DateApplies({ applies }) {
  const { setDateApplies } = useFilters()
  useEffect(() => { setDateApplies(applies) }, [applies, setDateApplies])
  return null
}

function renderBar(applies) {
  const tree = value => (
    <UserPreferencesProvider initialPreferences={{}}>
      <FilterProvider>
        <DateApplies applies={value} />
        <FilterBar />
      </FilterProvider>
    </UserPreferencesProvider>
  )
  const view = render(tree(applies))
  return { ...view, setApplies: value => view.rerender(tree(value)), user: userEvent.setup() }
}

const dateButton = () => screen.getByRole('button', { name: /📅/ })
const pickerIsOpen = () => screen.queryByText('Month to date') !== null

describe('FilterBar date button', () => {
  it('opens the date picker where the date applies', async () => {
    const { user } = renderBar(true)
    await user.click(dateButton())
    expect(pickerIsOpen()).toBe(true)
  })

  it('does not open where the date does not apply, and says why', async () => {
    const { user } = renderBar(false)
    await user.click(dateButton())
    expect(pickerIsOpen()).toBe(false)
    expect(dateButton().getAttribute('aria-disabled')).toBe('true')
    expect(dateButton().getAttribute('title')).toBe('The date filter does not apply to this view.')
  })

  it('closes an open picker when the view stops reading the date', async () => {
    const { user, setApplies } = renderBar(true)
    await user.click(dateButton())
    expect(pickerIsOpen()).toBe(true)
    setApplies(false)
    expect(pickerIsOpen()).toBe(false)
    // …and it does not come back on its own when the date applies again.
    setApplies(true)
    expect(pickerIsOpen()).toBe(false)
  })
})
