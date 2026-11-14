// @vitest-environment jsdom

// CategoryPicker is the shared recategorization control reused across the transactions, rules, and
// category screens, so its search quality is load-bearing and exactly the low-observability UI a
// refactor can quietly degrade. This pins the contract that matters: typing filters to matching
// leaves, ranks them prefix > word-prefix > substring (so the best match is reachable first), brings in
// a matching group's categories behind the direct matches, and picking one reports that category's id
// via onChange. Real keydown/portal behavior needs a DOM, so
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

  it('shows every category in a group whose name matches, after categories matched by their own name', async () => {
    const user = userEvent.setup()
    render(
      <CategoryPicker
        categories={[
          { id: 'g1', name: 'Travel' },
          { id: 'c1', parent_id: 'g1', name: 'Flights' },
          { id: 'c2', parent_id: 'g1', name: 'Hotels' },
          { id: 'g2', name: 'Reimbursable' },
          { id: 'c3', parent_id: 'g2', name: 'Work Travel' },
          { id: 'g3', name: 'Untraveled' }, // mid-word only: a group must not expand on that
          { id: 'c4', parent_id: 'g3', name: 'Other' },
        ]}
        value={null}
        onChange={() => {}}
      />,
    )

    await user.click(screen.getByTitle('Browse categories'))
    await user.type(screen.getByPlaceholderText(/type to search/i), 'travel')

    const texts = rowTexts()
    expect(texts).toHaveLength(3)
    expect(texts[0]).toContain('Work Travel')
    expect(texts[1]).toContain('Flights')
    expect(texts[2]).toContain('Hotels')
  })

  it('starts a search from a key typed on the closed picker', async () => {
    // Tabbing in lands on the closed picker's button; typing there has to reach the search, every
    // character of it, rather than needing a click or Space first.
    const user = userEvent.setup()
    render(<CategoryPicker categories={categories} value={null} onChange={() => {}} />)

    await user.tab()
    await user.keyboard('pro')

    expect(screen.getByPlaceholderText(/type to search/i).value).toBe('pro')
    expect(rowTexts()).toHaveLength(3)
  })

  it('accepts the highlighted match when tabbed out of, and focus carries on to the next field', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(
      <>
        <CategoryPicker categories={categories} value={null} onChange={onChange} />
        <input aria-label="Next field" />
      </>,
    )

    await user.tab()
    await user.keyboard('pro')
    await user.tab()

    expect(onChange).toHaveBeenCalledWith('c1')
    expect(rowTexts()).toHaveLength(0)
    expect(document.activeElement).toBe(screen.getByLabelText('Next field'))
  })
})
