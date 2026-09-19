// @vitest-environment jsdom

// `SearchInput` sits inside pages and floating panels that close or deselect on a window-level Escape, so
// what those hosts rely on is pinned here: Escape clears a field with text *instead of* reaching them, and
// passes through an empty one exactly as before.

import { useState } from 'react'
import { describe, it, expect, afterEach, onTestFinished } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SearchInput } from '../ui.jsx'

function Host() {
  const [value, setValue] = useState('')
  return <SearchInput value={value} onChange={setValue} aria-label="Search" />
}

afterEach(cleanup)

describe('SearchInput', () => {
  it('clears from the × and keeps focus in the field', async () => {
    render(<Host />)
    const field = screen.getByRole('searchbox', { name: 'Search' })
    expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull()

    await userEvent.type(field, 'rent')
    await userEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    expect(field.value).toBe('')
    expect(document.activeElement).toBe(field)
    expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull()
  })

  it('takes Escape only while there is text to clear', async () => {
    let windowEscapes = 0
    const countEscape = event => { if (event.key === 'Escape') windowEscapes += 1 }
    window.addEventListener('keydown', countEscape)
    onTestFinished(() => window.removeEventListener('keydown', countEscape))
    render(<Host />)
    const field = screen.getByRole('searchbox', { name: 'Search' })

    await userEvent.type(field, 'rent{Escape}')
    expect(field.value).toBe('')
    expect(windowEscapes).toBe(0)

    await userEvent.keyboard('{Escape}')
    expect(windowEscapes).toBe(1)
  })
})
