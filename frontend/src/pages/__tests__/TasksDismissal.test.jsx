// @vitest-environment jsdom

// Dismissing a task from the Tasks page. The ratchet that decides when a dismissed task comes back is
// the server's (routers/tasks.py) and is tested there; what matters here is that the page offers the
// control only where dismissal is actually supported, and that a dismissed card leaves a way back
// rather than simply vanishing — a card that disappears without a trace reads as work that was lost.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import Tasks from '../Tasks.jsx'
import { api } from '../../lib/api.js'

vi.mock('../../lib/api.js', () => ({
  api: { getTasks: vi.fn(), dismissTask: vi.fn(), restoreTask: vi.fn() },
}))
vi.mock('../../lib/FilterContext.jsx', () => ({ useFilters: () => ({ clearAll: vi.fn() }) }))

afterEach(() => { cleanup(); vi.clearAllMocks() })

const DISMISSIBLE = {
  id: 'uncategorized_txns', title: 'Uncategorized transactions', description: '4 transactions have no category.',
  count: 4, link: '/transactions?only=uncategorized', link_label: 'Review transactions', severity: 'info',
  dismiss_key: 'uncategorized_txns',
}
const NOT_DISMISSIBLE = {
  id: 'vault_access_requests', title: 'Vault access requested', description: 'Someone is waiting.',
  count: 1, link: '/accounts?tab=connections', link_label: 'Review vault access', severity: 'info',
}

function payload(tasks, dismissed = []) {
  return { tasks, dismissed, open_items: tasks.length, total_count: tasks.reduce((n, t) => n + t.count, 0) }
}

function renderPage() {
  return render(<MemoryRouter><Tasks /></MemoryRouter>)
}

describe('Tasks dismissal', () => {
  it('offers Dismiss only on tasks that support it', async () => {
    api.getTasks.mockResolvedValue(payload([DISMISSIBLE, NOT_DISMISSIBLE]))
    renderPage()
    await screen.findByText('Uncategorized transactions')
    // One control for the one dismissible card — the vault request is someone else waiting, not a
    // backlog of your own work, so it deliberately cannot be put away.
    expect(screen.getAllByText('Dismiss')).toHaveLength(1)
  })

  it('hides the card, offers an undo, and leaves it listed as dismissed', async () => {
    api.getTasks.mockResolvedValue(payload([DISMISSIBLE]))
    api.dismissTask.mockResolvedValue(payload([], [
      { id: 'uncategorized_txns', dismiss_key: 'uncategorized_txns', title: 'Uncategorized transactions', count: 4 },
    ]))
    renderPage()
    await screen.findByText('Uncategorized transactions')

    await userEvent.click(screen.getByText('Dismiss'))
    await waitFor(() => expect(api.dismissTask).toHaveBeenCalledWith('uncategorized_txns'))

    expect(screen.queryByText('4 transactions have no category.')).toBeNull()
    expect(screen.getByText('Task dismissed')).toBeTruthy()   // the undo toast
    expect(screen.getByText('1 dismissed')).toBeTruthy()      // the durable way back
  })

  it('restores from the dismissed list', async () => {
    api.getTasks.mockResolvedValue(payload([], [
      { id: 'uncategorized_txns', dismiss_key: 'uncategorized_txns', title: 'Uncategorized transactions', count: 4 },
    ]))
    api.restoreTask.mockResolvedValue(payload([DISMISSIBLE]))
    renderPage()

    await userEvent.click(await screen.findByText('1 dismissed'))
    await userEvent.click(screen.getByText('Restore'))
    await waitFor(() => expect(api.restoreTask).toHaveBeenCalledWith('uncategorized_txns'))
    expect(await screen.findByText('4 transactions have no category.')).toBeTruthy()
  })
})
