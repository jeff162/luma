// @vitest-environment jsdom

// The needs-review marker. Where the host wires the row actions, clicking the R marks the row reviewed —
// the one-click confirmation for a row that arrived correctly categorized. Where it does not, the marker
// stays informational rather than looking clickable and doing nothing.

import { afterEach, describe, it, expect, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { TransactionMarkersCell } from '../TransactionRow.jsx'

vi.mock('../../lib/api.js', () => ({
  api: { getTags: vi.fn().mockResolvedValue([]) },
}))

vi.mock('../../contexts/UnifiedDuplicatesViewerContext.jsx', () => ({
  useUnifiedDuplicatesViewer: () => ({ open: vi.fn() }),
}))

const TXN = { id: 't1', display_name: 'Fixture Store', tags: [], needs_review: 1 }

function renderRow(txn, props = {}) {
  return render(
    <MemoryRouter>
      <div onClick={props.onRowClick}>
        <TransactionMarkersCell txn={txn} {...props} />
      </div>
    </MemoryRouter>,
  )
}

afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('the needs-review marker', () => {
  it('marks the row reviewed when clicked, without also acting as a click on the row', async () => {
    const onMarkReviewed = vi.fn()
    const onRowClick = vi.fn()
    renderRow(TXN, { onMarkReviewed, onRowClick })

    await userEvent.click(screen.getByRole('button', { name: /mark reviewed/i }))
    expect(onMarkReviewed).toHaveBeenCalledWith(TXN)
    expect(onRowClick).not.toHaveBeenCalled()
  })

  it('stays a plain marker where the host offers no review action', () => {
    renderRow(TXN)
    expect(screen.getByLabelText('Needs review')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /mark reviewed/i })).toBeNull()
  })

  it('is absent on a reviewed row', () => {
    renderRow({ ...TXN, needs_review: 0 }, { onMarkReviewed: vi.fn() })
    expect(screen.queryByLabelText(/needs review/i)).toBeNull()
  })
})
