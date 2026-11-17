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
    deleteRecurring: vi.fn(() => Promise.resolve({ ok: true })),
    getTags: vi.fn(() => Promise.resolve([])),
  },
}))
// Preferences and the help layer are orthogonal to what this file is about. A preference is plain component
// state here, so a control that writes one (the status pills) still takes effect on screen.
vi.mock('../../lib/UserPreferencesContext.jsx', async () => {
  const { useState } = await import('react')
  return { useUserPreference: (_key, fallback) => useState(fallback) }
})
vi.mock('../../help/ContextualExplainer.jsx', () => ({ default: () => null }))
vi.mock('../../contexts/SyncStatusContext.jsx', () => ({ useAfterLedgerChange: () => {} }))
vi.mock('../../help/FeatureExplainer.jsx', () => ({ default: () => null }))

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
  api.getTransferReview.mockResolvedValue({ ambiguous: [], resolved: [] })
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
    expect(screen.queryByText(/from its usual amount/)).toBeNull()
    const attention = screen.getByText('Needs attention').closest('button')
    expect(attention.textContent).toContain('1')
  })

  it('never shows findings and the series list at the same time', async () => {
    renderPage()
    await screen.findByText('Streamly')

    await userEvent.click(screen.getByText('Needs attention'))
    await waitFor(() => expect(screen.getByText(/from its usual amount/)).toBeTruthy())
    // The series list is gone, and so are the controls that only apply to it.
    expect(screen.queryByRole('button', { name: 'Deselect all' })).toBeNull()
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
    expect(screen.getByText(/from its usual amount/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Deselect all' })).toBeNull()
  })

  it('shows a finding\'s series card under Details, without leaving the findings', async () => {
    // A finding reports a problem; the card is the state it was judged against (cadence, amount
    // setting, range, dates). It is the Series view's own card, so its controls are there too.
    renderPage()
    await screen.findByText('Streamly')
    await userEvent.click(screen.getByText('Needs attention'))
    const details = await screen.findByRole('button', { name: /Details/ })
    expect(screen.queryByLabelText('Cadence')).toBeNull()

    await userEvent.click(details)
    expect(screen.getByLabelText('Cadence')).toBeTruthy()
    expect(screen.getByText(/from its usual amount/)).toBeTruthy()

    await userEvent.click(details)
    expect(screen.queryByLabelText('Cadence')).toBeNull()
  })

  it('asks before deleting a series, and deletes only on the confirm', async () => {
    // Delete is the one card action with no way back, so it says what is lost for this kind of series.
    renderPage()
    await screen.findByText('Streamly')
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(screen.getByText(/next scan finds it again as a suggestion/)).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: 'Keep series' }))
    expect(api.deleteRecurring).not.toHaveBeenCalled()
    expect(screen.getByText('Streamly')).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await userEvent.click(screen.getByRole('button', { name: 'Delete series' }))
    expect(api.deleteRecurring).toHaveBeenCalledWith('s1')
    await waitFor(() => expect(screen.queryByText('Streamly')).toBeNull())
  })

  it('lands on the findings view when the Tasks page links to a kind', async () => {
    renderPage('/recurring?signal=price_change')
    expect(await screen.findByText(/from its usual amount/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Deselect all' })).toBeNull()
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

// A movement between two of the user's accounts: one series owning both legs.
const MOVEMENT = {
  ...SERIES, id: 's2', payee_key: 'transfer:a1:a2', display_name: 'Alpha Transfer', category_name: 'Transfers',
  account_id: 'a1', account_name: 'Riverstone Checking', counterpart_account_id: 'a2',
  counterpart_account_name: 'Harborline Savings', expected_amount: 200, amount_min: 200, amount_max: 200,
  money_movement: true,
}
const MOVEMENT_PRICE_SIGNAL = {
  ...PRICE_SIGNAL, key: 'price_change:t8', series_id: 's2', series_name: 'Alpha Transfer',
  category_name: 'Transfers', account_name: 'Riverstone Checking', txn_id: 't8', amount: 210,
  baseline_amount: 200, delta: 10, percent: 5,
}
const MOVEMENT_UPCOMING_SIGNAL = {
  ...UPCOMING_SIGNAL, key: 'upcoming:s2:2026-09-20', series_id: 's2', series_name: 'Alpha Transfer',
  due_date: '2026-09-20', days_until: 13, expected_amount: 200,
}

function renderWithMovement() {
  mockApi()
  api.getRecurringSeries.mockResolvedValue({ series: [SERIES, MOVEMENT] })
  api.getRecurringSignals.mockResolvedValue({
    signals: [PRICE_SIGNAL, MOVEMENT_PRICE_SIGNAL, UPCOMING_SIGNAL, MOVEMENT_UPCOMING_SIGNAL],
    counts: { price_change: 2, upcoming: 2 },
    anomaly_count: 2,
    dismissed_count: 0,
    horizon_days: 30,
  })
  return render(<MemoryRouter initialEntries={['/recurring']}><Recurring /></MemoryRouter>)
}

const searchBox = () => screen.getByPlaceholderText(/Search merchant/)

describe('Recurring page controls', () => {
  it('sorts a movement between two accounts among the bills rather than after them', async () => {
    renderWithMovement()
    const movement = await screen.findByText('Alpha Transfer')
    const bill = screen.getByText('Streamly')
    // "Alpha Transfer" precedes "Streamly" by name; clustering movements last put it after.
    expect(movement.compareDocumentPosition(bill) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('deselects every status in one click, and says why the list is empty', async () => {
    renderWithMovement()
    await screen.findByText('Streamly')
    await userEvent.click(screen.getByRole('button', { name: 'Deselect all' }))
    expect(await screen.findByText(/No statuses are selected/)).toBeTruthy()
    expect(screen.queryByText('Streamly')).toBeNull()
    expect(screen.getByRole('button', { name: 'Deselect all' }).getAttribute('aria-disabled')).toBe('true')
  })

  it('narrows the findings by the same search, matching a movement by its second account', async () => {
    renderWithMovement()
    await screen.findByText('Streamly')
    await userEvent.click(screen.getByText('Needs attention'))
    await waitFor(() => expect(screen.getAllByText(/from its usual amount/)).toHaveLength(2))

    // The finding itself names only the paying account; the receiving one comes from its series.
    await userEvent.type(searchBox(), 'harborline')
    await waitFor(() => expect(screen.getAllByText(/from its usual amount/)).toHaveLength(1))
    expect(screen.getByText('Alpha Transfer')).toBeTruthy()
    // The kind pill still counts what is open, not what the search leaves.
    expect(screen.getByRole('button', { name: /All/ }).textContent).toContain('2')

    await userEvent.clear(searchBox())
    await userEvent.type(searchBox(), 'nothing like this')
    expect(await screen.findByText('No findings match your search.')).toBeTruthy()
  })

  it('totals only the upcoming charges the search leaves', async () => {
    renderWithMovement()
    await screen.findByText('Streamly')
    await userEvent.click(screen.getByText('Upcoming'))
    const header = (await screen.findByText('Next 30 days')).parentElement
    expect(header.textContent).toContain('2 charges')

    await userEvent.type(searchBox(), 'streamly')
    await waitFor(() => expect(header.textContent).toContain('1 charge ·'))
    expect(header.textContent).toContain('$19.99')
    expect(header.textContent).not.toContain('$219.99')
    expect(screen.queryByText('Alpha Transfer')).toBeNull()
  })
})
