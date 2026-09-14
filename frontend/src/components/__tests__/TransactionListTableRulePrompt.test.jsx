// @vitest-environment jsdom

// Every list built on TransactionListTable offers to turn a category pick into a rule. The offer used to be
// wired per host, and most lists outside the Transactions page (a sync report, the detail panels) never
// were: picking a category there saved it and offered nothing. The table owns it now, so a host that
// passes nothing but a category save still gets it — and it comes on any change, not only a first
// categorization.

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import TransactionListTable from '../TransactionListTable.jsx'

// Nothing asserted here reaches the server; the rows' own affordances (tags, the rule lookup a menu makes)
// may still ask on mount, so every call answers with an empty list.
vi.mock('../../lib/api.js', () => ({ api: new Proxy({}, { get: () => () => Promise.resolve([]) }) }))
// A row's duplicate marker opens an app-level viewer; the provider lives at the App root.
vi.mock('../../contexts/UnifiedDuplicatesViewerContext.jsx', () => ({ useUnifiedDuplicatesViewer: () => ({ open: () => {} }) }))

// jsdom does no layout, so the windowing renders no rows; what is under test is the rows' behaviour,
// not which of them are mounted.
vi.mock('../WindowedRows.jsx', () => ({
  default: ({ items, getItemKey, renderRow }) => (
    <>{items.map((item, index) => <div key={getItemKey(item, index)}>{renderRow(item, index)}</div>)}</>
  ),
}))

const CATEGORIES = [
  { id: 'g1', name: 'Household', parent_id: null },
  { id: 'groceries', name: 'Groceries', parent_id: 'g1' },
  { id: 'dining', name: 'Dining Out', parent_id: 'g1' },
]

// The picker scrolls its active row into view on a timer; jsdom has no scrollIntoView.
beforeAll(() => { Element.prototype.scrollIntoView = () => {} })

afterEach(cleanup)

// The search field's placeholder is the row's current category when it has one.
async function pickCategory(user, name, placeholder = /type to search/i) {
  await user.click(screen.getByTitle('Click to change category'))
  await user.type(await screen.findByPlaceholderText(placeholder), name)
  // Rows commit on mousedown.
  fireEvent.mouseDown(document.querySelector('[data-picker-row-active]'))
}

function renderTable(txn) {
  const onCategorySave = vi.fn()
  // The row menu the table owns can navigate, so it needs a router like the app provides.
  render(
    <MemoryRouter>
      <TransactionListTable
        rows={[txn]}
        categories={CATEGORIES}
        onCategorySave={onCategorySave}
      />
    </MemoryRouter>,
  )
  return onCategorySave
}

describe('TransactionListTable rule offer', () => {
  it('offers a rule after a category is picked, with nothing wired by the host', async () => {
    const user = userEvent.setup()
    const onCategorySave = renderTable({ id: 't1', date: '2026-09-01', merchant_name: 'Harborline Market', amount: 42 })

    await pickCategory(user, 'Groc')

    expect(onCategorySave).toHaveBeenCalledWith('t1', 'groceries', undefined)
    expect(await screen.findByText('Create a rule?')).toBeTruthy()
  })

  it('offers it when a category is changed, not only when one is first set', async () => {
    const user = userEvent.setup()
    renderTable({
      id: 't2', date: '2026-09-02', merchant_name: 'Riverstone Grill', amount: 18,
      category_id: 'groceries', category_name: 'Groceries',
    })

    await pickCategory(user, 'Dining', 'Groceries')

    expect(await screen.findByText('Create a rule?')).toBeTruthy()
  })
})
