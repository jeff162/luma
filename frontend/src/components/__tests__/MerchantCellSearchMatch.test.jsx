// @vitest-environment jsdom

// A ledger row the search found through text its name does not show — the bank's raw wording behind a
// rule's rename, or a memo column an import captured. Every field on screen lacks the term, so without a
// mark the row reads as a wrong result. What is pinned: the name says there is more behind it, and the
// hover that opens from it says the match is in the text it lists — and neither appears for a row the
// search did not find that way.

import { afterEach, describe, it, expect, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { MerchantCell } from '../TransactionRow.jsx'
import { TransactionShareProvider } from '../../contexts/TransactionShareContext.jsx'

vi.mock('../../lib/api.js', () => ({
  api: { updateMerchant: vi.fn() },
}))

const MATCH_NOTE = 'Matched the search in the imported text below.'

const RENAMED = {
  id: 't1',
  display_name: 'City Water',
  merchant_name: 'RIVERSTONE UTILITIES',
  raw_name: 'RIVERSTONE UTILITIES 0412',
}

function renderCell(txn) {
  return render(
    <MemoryRouter>
      <TransactionShareProvider>
        {/* The real ledger passes both; the report link is beside the point here. */}
        <MerchantCell txn={txn} showReport={false} />
      </TransactionShareProvider>
    </MemoryRouter>,
  )
}

afterEach(cleanup)

describe('a row found through text its name does not show', () => {
  it('underlines the name and says on hover where the match was', async () => {
    const user = userEvent.setup()
    renderCell({ ...RENAMED, matched_hidden_text: 1, matched_search_text: 'utilities 04' })

    const name = screen.getByText('City Water')
    expect(name.style.textDecoration).toContain('underline')
    // Absent until hovered, so the assertion below is about the hover rather than a card always rendered.
    expect(screen.queryByText(MATCH_NOTE)).toBeNull()

    await user.hover(name)

    expect(await screen.findByText(MATCH_NOTE)).toBeTruthy()
    // The text that matched is in the same card, which is what "below" promises, with the term highlighted.
    const marks = [...document.querySelectorAll('mark')].map(mark => mark.textContent)
    expect(marks).toContain('UTILITIES 04')
  })

  it('is not marked when the search did not find it that way', async () => {
    const user = userEvent.setup()
    renderCell(RENAMED)

    const name = screen.getByText('City Water')
    expect(name.style.textDecoration).toBe('')

    await user.hover(name)

    expect(await screen.findByText('RIVERSTONE UTILITIES 0412')).toBeTruthy()
    expect(screen.queryByText(MATCH_NOTE)).toBeNull()
  })
})
