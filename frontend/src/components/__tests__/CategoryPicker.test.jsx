// @vitest-environment jsdom

// CategoryPicker is the shared recategorization control reused across the transactions, rules, and
// category screens, so its search quality is load-bearing and exactly the low-observability UI a
// refactor can quietly degrade. This pins the contract that matters: typing filters to matching
// leaves, ranks them prefix > word-prefix > substring (so the best match is reachable first), and
// picking one reports that category's id via onChange. Real keydown/portal behavior needs a DOM, so
// this runs under jsdom (api is stubbed — the select path never calls it).

import { afterEach, describe, it, expect, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('../../lib/api.js', () => ({ api: {} }))
import CategoryPicker from '../CategoryPicker.jsx'

afterEach(cleanup)

// One group with four leaves; against the query "pro" they exercise each match rank, plus one
// non-match that must be filtered out entirely.
const categories = [
  { id: 'g1', name: 'Housing' },
  { id: 'c1', parent_id: 'g1', name: 'Property Tax' },  // prefix → rank 0
  { id: 'c2', parent_id: 'g1', name: 'Home Projects' }, // word-prefix → rank 1
  { id: 'c3', parent_id: 'g1', name: 'Improvements' },  // substring only → rank 2
  { id: 'c4', parent_id: 'g1', name: 'Groceries' },     // no "pro" → excluded
]

const rowTexts = () =>
  [...document.querySelectorAll('[data-picker-row-active]')].map(el => el.textContent.trim())

describe('CategoryPicker search + selection', () => {
  it('filters to matches, ranks prefix > word-prefix > substring, and reports the picked id', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<CategoryPicker categories={categories} value={null} onChange={onChange} />)

    await user.click(screen.getByTitle('Browse categories')) // open the panel
    await user.type(screen.getByPlaceholderText(/type to search/i), 'pro')

    const texts = rowTexts()
    expect(texts).toHaveLength(3) // Groceries filtered out
    expect(texts[0]).toContain('Property Tax')
    expect(texts[1]).toContain('Home Projects')
    expect(texts[2]).toContain('Improvements')

    // Rows commit on mousedown (preventDefault keeps focus); picking the top match reports its id.
    fireEvent.mouseDown(document.querySelectorAll('[data-picker-row-active]')[0])
    expect(onChange).toHaveBeenCalledWith('c1')
  })
})
