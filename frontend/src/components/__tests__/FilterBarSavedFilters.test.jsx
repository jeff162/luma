// @vitest-environment jsdom

// Saving names the filters in force; clicking the saved chip later puts exactly those filters back,
// replacing whatever was set since. The chip reads as pressed only while the filters in force are its
// filters, and Save is offered only when they are not already one of the saved ones.

import { afterEach, describe, it, expect, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import FilterBar from '../FilterBar.jsx'
import { FilterProvider, useFilters } from '../../lib/FilterContext.jsx'
import { UserPreferencesProvider } from '../../lib/UserPreferencesContext.jsx'

const server = vi.hoisted(() => ({ prefs: {} }))
vi.mock('../../lib/api.js', () => ({
  api: new Proxy({}, {
    get: (_, name) => {
      if (name === 'saveUserPreference') return (key, value) => { server.prefs[key] = value; return Promise.resolve({ ok: true }) }
      if (name === 'getCategories') return () => Promise.resolve([{ id: 'c1', name: 'Groceries', parent_id: 'g1' }, { id: 'c2', name: 'Dining', parent_id: 'g1' }])
      return () => Promise.resolve([])
    },
  }),
}))

afterEach(cleanup)

let filtersApi
function Probe() {
  filtersApi = useFilters()
  return <output data-testid="chips">{filtersApi.filters.selections.map(s => s.label).join(',')}</output>
}

function renderBar() {
  render(
    <UserPreferencesProvider initialPreferences={{}}>
      <FilterProvider>
        <Probe />
        <FilterBar />
      </FilterProvider>
    </UserPreferencesProvider>,
  )
  return userEvent.setup()
}

describe('FilterBar saved filters', () => {
  it('saves the filters in force and puts them back in place of later ones', async () => {
    const user = renderBar()
    expect(screen.queryByRole('button', { name: 'Save…' })).toBeNull()

    filtersApi.addSelection({ type: 'category', id: 'c1', label: 'Groceries' })
    await user.click(await screen.findByRole('button', { name: 'Save…' }))
    await user.type(screen.getByPlaceholderText('Saved filter name'), 'Food')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    const chip = await screen.findByRole('button', { name: 'Food' })
    expect(chip.getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByRole('button', { name: 'Save…' })).toBeNull()
    expect(server.prefs['ui.filterBar.savedFilters']).toHaveLength(1)

    filtersApi.addSelection({ type: 'category', id: 'c2', label: 'Dining' })
    await waitFor(() => expect(chip.getAttribute('aria-pressed')).toBe('false'))
    expect(screen.getByRole('button', { name: 'Save…' })).toBeTruthy()

    await user.click(chip)
    await waitFor(() => expect(screen.getByTestId('chips').textContent).toBe('Groceries'))
    expect(chip.getAttribute('aria-pressed')).toBe('true')
  })
})
