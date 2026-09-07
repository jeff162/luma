// @vitest-environment jsdom

// The Recurring page's three peer views. This is the structural fix for a real defect: findings and the
// series list originally shared one screen, and a busy ledger's findings pushed the series list and the
// drill-down panel out of the viewport, so opening a series drew its report into a region with no height
// and read as a dead button.
//
// Two things have to stay true. The findings and the series list are never on screen together. And
// opening a series from a finding happens **in place** — the first attempt switched to the series view,
// which took the user out of the list they were working through and could land them on a filtered list
// that excluded the very series being opened. The way in is the arrow on the finding's headline, which
// replaced an Open series button that only two of the five finding kinds ever carried.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import Recurring from '../Recurring.jsx'
import { api } from '../../lib/api.js'

vi.mock('../../lib/api.js', () => ({
  api: {
    getRecurringSeries: vi.fn(),
    getRecurringSignals: vi.fn(),
    getCategories: vi.fn(),
    getTransactions: vi.fn(),
    getTransferReview: vi.fn(),
    getDismissedRecurringSignals: vi.fn(),
    dismissRecurringSignal: vi.fn(),
    restoreRecurringSignal: vi.fn(),
    getTags: vi.fn(() => Promise.resolve([])),
  },
}))
// Preferences and the help layer are orthogonal to what this file is about; stub them to their defaults.
vi.mock('../../lib/UserPreferencesContext.jsx', () => ({
  useUserPreference: (_key, fallback) => [fallback, vi.fn()],
}))
vi.mock('../../help/ContextualExplainer.jsx', () => ({ default: () => null }))

const SERIES = {
  id: 's1', payee_key: 'streamly', display_name: 'Streamly', category_id: 'c1', category_name: 'Streaming',
  account_id: null, account_name: null, cadence: 'monthly', period_days: 30, expected_amount: 19.99,
  amount_min: 15.99, amount_max: 19.99, last_txn_date: '2026-08-14', next_due_date: '2026-09-13',
  occurrence_count: 7, confidence: 0.9, status: 'active', source: 'auto', rule_id: null,
  confirmed: true, money_movement: false,
}
const PRICE_SIGNAL = {
  kind: 'price_change', key: 'price_change:t9', severity: 'warning',
  series_id: 's1', series_name: 'Streamly', category_name: 'Streaming',
  txn_id: 't9', txn_date: '2026-08-14', amount: 19.99, baseline_amount: 15.99,
  delta: 4, percent: 25, direction: 'increase', amount_kind: 'fixed',
}
const UPCOMING_SIGNAL = {
  kind: 'upcoming', key: 'upcoming:s1:2026-09-13', severity: 'info',
  series_id: 's1', series_name: 'Streamly', cadence: 'monthly',
  due_date: '2026-09-13', days_until: 6, expected_amount: 19.99,
}

function mockApi() {
  api.getRecurringSeries.mockResolvedValue({ series: [SERIES] })
  api.getRecurringSignals.mockResolvedValue({
    signals: [PRICE_SIGNAL, UPCOMING_SIGNAL],
    counts: { price_change: 1, upcoming: 1 },
    anomaly_count: 1,
    dismissed_count: 0,
    horizon_days: 30,
  })
  api.getCategories.mockResolvedValue([])
  api.getTransactions.mockResolvedValue({ transactions: [], total: 0 })
  // Movements to review are orthogonal to the views this file is about; empty is the quiet default.
  api.getTransferReview.mockResolvedValue({ ambiguous: [], hidden: [] })
}

// jsdom has no layout, so the "scroll the acted-on card back into view" effect has nothing to call.
Element.prototype.scrollIntoView = vi.fn()

afterEach(() => { cleanup(); vi.clearAllMocks(); sessionStorage.clear() })

function renderPage(entry = '/recurring') {
  mockApi()
  return render(<MemoryRouter initialEntries={[entry]}><Recurring /></MemoryRouter>)
}

describe('Recurring page views', () => {
  it('opens on the series list, with the attention count on the selector', async () => {
    renderPage()
    // The card, not the finding — and the count is visible without switching, which is the whole
    // reason the badge sits on the control rather than inside the view it names.
    expect(await screen.findByText('Streamly')).toBeTruthy()
    expect(screen.queryByText(/from its established amount/)).toBeNull()
    const attention = screen.getByText('Needs attention').closest('button')
    expect(attention.textContent).toContain('1')
  })

  it('never shows findings and the series list at the same time', async () => {
    renderPage()
    await screen.findByText('Streamly')

    await userEvent.click(screen.getByText('Needs attention'))
    await waitFor(() => expect(screen.getByText(/from its established amount/)).toBeTruthy())
    // The series list is gone, and so are the controls that only apply to it.
    expect(screen.queryByPlaceholderText(/Search merchant/)).toBeNull()
    expect(screen.queryByText('Confirm')).toBeNull()
  })

  it('opens a finding\'s transactions in place, without leaving the findings', async () => {
    renderPage()
    await screen.findByText('Streamly')
    await userEvent.click(screen.getByText('Needs attention'))
    await userEvent.click(await screen.findByRole('button', { name: 'Open this series' }))

    // The drill-down loads, and the findings are still what is on screen — no trip to the series list,
    // whose filters might not even include this series.
    await waitFor(() => expect(api.getTransactions).toHaveBeenCalled())
    expect(screen.getByText(/from its established amount/)).toBeTruthy()
    expect(screen.queryByPlaceholderText(/Search merchant/)).toBeNull()
  })

  it('lands on the findings view when the Tasks page links to a kind', async () => {
    renderPage('/recurring?signal=price_change')
    expect(await screen.findByText(/from its established amount/)).toBeTruthy()
    expect(screen.queryByPlaceholderText(/Search merchant/)).toBeNull()
  })

  it('keeps upcoming off the attention view and out of its count', async () => {
    renderPage()
    await screen.findByText('Streamly')
    const attention = screen.getByText('Needs attention').closest('button')
    expect(attention.textContent).not.toContain('2')  // 1 finding + 1 upcoming would be 2

    await userEvent.click(screen.getByText('Upcoming'))
    expect(await screen.findByText('Next 30 days')).toBeTruthy()
  })
})
