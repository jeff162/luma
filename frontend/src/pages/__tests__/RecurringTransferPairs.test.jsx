// @vitest-environment jsdom

// One card for a two-legged money movement.
//
// A transfer between two tracked accounts is one movement the ledger records twice, once per account.
// Detection now pairs those rows and reads the rhythm off the pairs, so a movement arrives as a single
// series that owns both legs (`counterpart_account_id` is what marks it). This file covers the page's
// half of that: the card names both accounts and counts both legs, its actions are one set because
// there is one series, and the one pairing the detector refuses to make (a tie) is answerable from
// *Needs attention* and can be taken back.
//
// Most series are not movements. An ordinary payee series must be completely unaffected, which is the
// last test here and the one that would catch a card learning to assume a counterpart.

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
    decideTransferPair: vi.fn(),
    restoreTransferDecision: vi.fn(),
    getDismissedRecurringSignals: vi.fn(),
    confirmRecurring: vi.fn(),
    getTags: vi.fn(() => Promise.resolve([])),
  },
}))
vi.mock('../../lib/UserPreferencesContext.jsx', () => ({
  useUserPreference: (_key, fallback) => [fallback, vi.fn()],
  useDeviceLayoutPreference: (_key, fallback) => [fallback, vi.fn()],
}))
vi.mock('../../help/ContextualExplainer.jsx', () => ({ default: () => null }))
vi.mock('../../contexts/SyncStatusContext.jsx', () => ({ useAfterLedgerChange: () => {} }))

const MOVEMENT = {
  id: 'mv1', payee_key: 'transfer:a1:a2', display_name: 'Card Payment',
  category_id: 'c1', category_name: 'Transfers',
  account_id: 'a1', account_name: 'Harborline Checking',
  counterpart_account_id: 'a2', counterpart_account_name: 'Riverstone Card',
  cadence: 'monthly', period_days: 30, expected_amount: 120, amount_min: 120, amount_max: 120,
  last_txn_date: '2026-08-25', next_due_date: '2026-09-24', occurrence_count: 16, transfer_count: 8,
  confidence: 0.9, status: 'active', source: 'auto', rule_id: null, confirmed: true,
  money_movement: true, suppressed_member_ids: null,
}
const SUBSCRIPTION = {
  ...MOVEMENT, id: 's1', payee_key: 'streamly', display_name: 'Streamly',
  category_name: 'Streaming', counterpart_account_id: null, counterpart_account_name: null,
  transfer_count: null, occurrence_count: 7, expected_amount: 19.99, amount_min: 19.99,
  amount_max: 19.99, money_movement: false,
}
Element.prototype.scrollIntoView = vi.fn()
afterEach(() => { cleanup(); vi.clearAllMocks(); sessionStorage.clear() })

const AMBIGUITY = {
  row: { id: 't1', date: '2026-02-02', amount: 5000, name: 'BACKDATED DEBIT TRANSFER',
         account_id: 'a1', account_name: 'Harborline Checking' },
  day_offset: 0,
  candidates: [
    { id: 't2', date: '2026-02-02', amount: -5000, name: 'TRANSFER CREDIT', account_id: 'a2', account_name: 'Riverstone Card' },
    { id: 't3', date: '2026-02-02', amount: -5000, name: 'TRANSFER CREDIT', account_id: 'a3', account_name: 'Joint Savings' },
  ],
}

function renderPage({ series = [MOVEMENT], review = { ambiguous: [], resolved: [] } } = {}) {
  api.getRecurringSeries.mockResolvedValue({ series })
  api.getRecurringSignals.mockResolvedValue({ signals: [], counts: {}, anomaly_count: 0, dismissed_count: 0, horizon_days: 30 })
  api.getCategories.mockResolvedValue([])
  api.getTransactions.mockResolvedValue({ transactions: [], total: 0 })
  api.getTransferReview.mockResolvedValue(review)
  return render(<MemoryRouter initialEntries={['/recurring']}><Recurring /></MemoryRouter>)
}

describe('a money movement on the Recurring page', () => {
  it('is one card naming both accounts, with one set of actions', async () => {
    renderPage()
    await screen.findByText('Card Payment')
    expect(screen.getByText('Harborline Checking')).toBeTruthy()
    expect(screen.getByText('Riverstone Card')).toBeTruthy()
    // One series, so one of everything — there is no second card to act on separately.
    expect(screen.getAllByText('Not recurring')).toHaveLength(1)
  })

  it('counts both legs, because that is what the drill-down lists', async () => {
    renderPage()
    expect(await screen.findByText('16 transactions')).toBeTruthy()
    await userEvent.click(screen.getByText('16 transactions'))
    await waitFor(() => expect(api.getTransactions).toHaveBeenCalledWith(
      expect.objectContaining({ recurring_series_id: 'mv1' }),
    ))
  })

  it('does not repeat the paying account beside the category', async () => {
    // The from → to block already names it; a chip repeating one half reads as the whole scope.
    renderPage()
    await screen.findByText('Card Payment')
    expect(screen.getAllByText('Harborline Checking')).toHaveLength(1)
  })

  it('will not record a pair until one is chosen', async () => {
    renderPage({ review: { ambiguous: [AMBIGUITY], resolved: [] } })
    await userEvent.click(await screen.findByRole('button', { name: /Needs attention/ }))
    const accept = await screen.findByRole('button', { name: 'Accept' })
    expect(accept.disabled).toBe(true)

    await userEvent.click(screen.getByRole('radio', { name: /Joint Savings/ }))
    expect(accept.disabled).toBe(false)
    api.decideTransferPair.mockResolvedValue({ ok: true })
    await userEvent.click(accept)
    expect(api.decideTransferPair).toHaveBeenCalledWith('t1', 't3')
  })

  it('dismisses a tie without pairing anything, and the toast takes it back', async () => {
    renderPage({ review: { ambiguous: [AMBIGUITY], resolved: [] } })
    await userEvent.click(await screen.findByRole('button', { name: /Needs attention/ }))
    api.decideTransferPair.mockResolvedValue({ ok: true })
    await userEvent.click(await screen.findByRole('button', { name: 'Dismiss' }))
    expect(api.decideTransferPair).toHaveBeenCalledWith('t1', null)

    api.restoreTransferDecision.mockResolvedValue({ ok: true })
    await userEvent.click(await screen.findByRole('button', { name: 'Undo' }))
    expect(api.restoreTransferDecision).toHaveBeenCalledWith({ paying_txn_id: 't1' })
  })

  it('can take an answer back from the resolved list with nothing open', async () => {
    // With no open ties the section is gone, so the resolved list is the only way back to an answer.
    renderPage({ review: { ambiguous: [], resolved: [
      { kind: 'paired', paying_txn_id: 't1', row: AMBIGUITY.row, counterpart: AMBIGUITY.candidates[1] },
    ] } })
    api.getDismissedRecurringSignals.mockResolvedValue({ signals: [] })
    await userEvent.click(await screen.findByRole('button', { name: /Needs attention/ }))
    await userEvent.click(await screen.findByRole('button', { name: /1 resolved/ }))
    api.restoreTransferDecision.mockResolvedValue({ ok: true })
    await userEvent.click(await screen.findByRole('button', { name: 'Restore' }))
    expect(api.restoreTransferDecision).toHaveBeenCalledWith({ paying_txn_id: 't1' })
  })

  it('leaves an ordinary series exactly as it was', async () => {
    // Most series are not movements. No accounts block, no counterpart, and the account chip stays.
    renderPage({ series: [SUBSCRIPTION] })
    await screen.findByText('Streamly')
    expect(screen.getByText('7 transactions')).toBeTruthy()
    expect(screen.getByText('Harborline Checking')).toBeTruthy()
    expect(screen.queryByText('Riverstone Card')).toBeNull()
  })
})
