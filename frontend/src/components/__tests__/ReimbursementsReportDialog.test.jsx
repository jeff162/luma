// @vitest-environment jsdom

// The report's one structural claim: it is the list of *open* reimbursements, and completed ones are
// simply absent rather than filtered into a second tab nobody reads. That decision is made on the
// server so the headline total and the list cannot disagree, so what is asserted here is that the
// screen renders what it is given without inventing a closed pile of its own.
//
// Rendered inside <StrictMode> because it fetches on mount, which is what the app does.

import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ReimbursementsReportDialog from '../ReimbursementsReportDialog.jsx'
import { ownerChipLabels } from '../OwnerChip.jsx'
import { api } from '../../lib/api.js'
import { txnMutations } from '../../lib/txnMutations.js'

// A floating dialog remembers where it was left, a saved preference; local state stands in for the
// app's provider.
vi.mock('../../lib/UserPreferencesContext.jsx', async (importOriginal) => {
  const { useState } = await import('react')
  return { ...(await importOriginal()), useUserPreference: (_key, initial) => useState(initial), useDeviceLayoutPreference: (_key, initial) => useState(initial) }
})

vi.mock('../../lib/txnMutations.js', async importOriginal => ({
  ...await importOriginal(),
  txnMutations: { completeReimbursement: vi.fn(), reopenReimbursement: vi.fn() },
}))

vi.mock('../../lib/api.js', () => ({
  api: {
    getOutstandingReimbursements: vi.fn(),
    getReimbursement: vi.fn(),
    getTransactions: vi.fn(),
    addReimbursementClaims: vi.fn(),
    createReimbursement: vi.fn(),
    removeReimbursementTransaction: vi.fn(),
    deleteReimbursement: vi.fn(),
    getReimbursementSettings: vi.fn(() => Promise.resolve({ reminder_days: 30 })),
  },
}))

// Stubbed to keep the boundary at this dialog: what matters here is *which* surface an untracked row
// opens and what it is handed. The panel's own behaviour — the sign-driven action, the portions — is
// asserted where it lives, and rendering it whole would drag in its entire fetch tail.
vi.mock('../TransactionDetail.jsx', () => ({
  default: ({ txn }) => <div data-testid="txn-panel">{txn.id}</div>,
}))

const LOOSE = {
  txn_id: 't9',
  date: '2026-08-14',
  payee: 'Hardware Store',
  amount: 120,
  receivable: 120,
  unclaimed: 120,
  parts: [],
  role: 'expense',
}

function open(report) {
  api.getOutstandingReimbursements.mockResolvedValue(report)
  return render(
    <StrictMode>
      <ReimbursementsReportDialog categories={[]} onClose={() => {}} />
    </StrictMode>,
  )
}

beforeEach(() => { vi.clearAllMocks() })
afterEach(cleanup)

describe('ReimbursementsReportDialog', () => {
  it('surfaces a failed load rather than sitting on a spinner', async () => {
    api.getOutstandingReimbursements.mockRejectedValue(new Error('nope'))
    render(
      <StrictMode>
        <ReimbursementsReportDialog categories={[]} onClose={() => {}} />
      </StrictMode>,
    )
    expect(await screen.findByText('nope')).toBeTruthy()
  })
})


// Every Expected row opens the reimbursement editor, so the screen a click opens does not depend on
// whether a record exists yet. An untracked expense opens it as an unsaved draft; a received payment is
// not a reimbursement on its own and opens its transaction.
describe('an untracked row', () => {
  const PAYMENT = { txn_id: 'r9', date: '2026-09-01', payee: 'From Sam', unclaimed: -166, parts: [] }

  it('opens an untracked expense in the reimbursement editor, writing nothing', async () => {
    open({ total: 120, reimbursements: [], loose: [LOOSE] })
    await userEvent.click(await screen.findByRole('button', { name: /Hardware Store/ }))

    expect(await screen.findByRole('button', { name: 'Save' })).toBeTruthy()
    expect(screen.queryByTestId('txn-panel')).toBeNull()
    expect(api.getTransactions).not.toHaveBeenCalled()
    expect(api.getReimbursement).not.toHaveBeenCalled()
    expect(api.createReimbursement).not.toHaveBeenCalled()
  })

  it('opens a received payment as its transaction', async () => {
    api.getTransactions.mockResolvedValue({ transactions: [{ id: 'r9', amount: -166 }] })
    open({ total: -166, reimbursements: [], loose: [PAYMENT] })
    await userEvent.click(await screen.findByRole('button', { name: /From Sam/ }))

    await waitFor(() => expect(api.getTransactions).toHaveBeenCalledWith(
      expect.objectContaining({ ids: 'r9' }),
    ))
    expect((await screen.findByTestId('txn-panel')).textContent).toBe('r9')
  })

  it('says so rather than doing nothing when the transaction cannot be fetched', async () => {
    // Silence is what the bug looked like from the outside; a dead click must not be reachable again by
    // way of a failed request.
    api.getTransactions.mockRejectedValue(new Error('That transaction could not be opened.'))
    open({ total: -166, reimbursements: [], loose: [PAYMENT] })
    await userEvent.click(await screen.findByRole('button', { name: /From Sam/ }))
    expect(await screen.findByText(/could not be opened/)).toBeTruthy()
  })
})


/*
 * Dragging money in onto what it repays.
 *
 * Drag is the accelerator over an operation that already works by clicking (the transaction panel's
 * match picker), never the only way — it is unusable by keyboard and miserable in a long scrolling
 * list. What is asserted here is that it performs the *same* operation under the *same* rules, because
 * a second path that quietly does what the first refuses is worse than no second path.
 *
 * The drag is driven through the real pointer handlers; jsdom does no layout, so the hit test that
 * finds the entry under the pointer is pointed at the target directly.
 */
describe('dragging a payment onto what it repays', () => {
  const RECORD = {
    id: 'link-1', counterparty: 'Ticket friends', completed: false, residual: 25,
    members: [{ txn_id: 'e1', date: '2026-02-14', payee: 'Concert Tix', claim: 375, trashed: false }],
  }
  const PAYMENT = { txn_id: 'r9', date: '2026-09-01', payee: 'From Sam', unclaimed: -166, parts: [] }
  const EXPENSE = { txn_id: 'e9', date: '2026-09-02', payee: 'Grocery store', unclaimed: 130, parts: [] }

  function drag(sourceName, targetName) {
    const source = screen.getByRole('button', { name: new RegExp(sourceName) })
    const target = screen.getByRole('button', { name: new RegExp(targetName) })
    document.elementFromPoint = () => target
    const at = { pointerId: 1, pointerType: 'mouse', button: 0, clientY: 0 }
    fireEvent.pointerDown(source, { ...at, clientX: 0 })
    fireEvent.pointerMove(window, { ...at, clientX: 20 })
    fireEvent.pointerUp(window, { ...at, clientX: 20 })
  }

  it('adds the payment to a reimbursement it is dropped on', async () => {
    api.addReimbursementClaims.mockResolvedValue(RECORD)
    open({ total: 25, reimbursements: [RECORD], loose: [PAYMENT] })
    await screen.findByText('Ticket friends')
    drag('From Sam', 'Ticket friends')
    await waitFor(() => expect(api.addReimbursementClaims).toHaveBeenCalledWith(
      'link-1', [{ txn_id: 'r9', amount: -166, label: null }],
    ))
  })

  it('pairs with an untracked expense by creating the record around both', async () => {
    api.createReimbursement.mockResolvedValue({ id: 'link-2' })
    open({ total: 130, reimbursements: [], loose: [EXPENSE, PAYMENT] })
    await screen.findByText('Grocery store')
    drag('From Sam', 'Grocery store')
    await waitFor(() => expect(api.createReimbursement).toHaveBeenCalledWith({
      claims: [
        { txn_id: 'e9', amount: 130, label: null },
        { txn_id: 'r9', amount: -166, label: null },
      ],
    }))
  })

  it('asks which portions when the dragged row is divided', async () => {
    // A divided row cannot be assumed whole, so the drop hands off to the same picker the panel uses
    // rather than inventing a second rule for the same question.
    const divided = { ...PAYMENT, unclaimed: -250, receivable: -250, parts: [
      { amount: -10, label: 'Part i' }, { amount: -240, label: 'part 2' },
    ] }
    open({ total: 25, reimbursements: [RECORD], loose: [divided] })
    await screen.findByText('Ticket friends')
    drag('From Sam', 'Ticket friends')
    expect(await screen.findByText('Which parts of this transaction?')).toBeTruthy()
    expect(api.addReimbursementClaims).not.toHaveBeenCalled()
  })

  it('refuses a drop the click-driven list would not have offered', async () => {
    // Same rules or it is not the same operation: this record already claims that row, so a second
    // claim would replace the first rather than add to it.
    const held = { ...RECORD, members: [{ txn_id: 'r9', date: '2026-09-01', payee: 'From Sam', claim: -100, trashed: false }] }
    open({ total: 25, reimbursements: [held], loose: [PAYMENT] })
    await screen.findByText('Ticket friends')
    drag('From Sam', 'Ticket friends')
    expect(await screen.findByText(/already covers part of this transaction/)).toBeTruthy()
    expect(api.addReimbursementClaims).not.toHaveBeenCalled()
  })
})

/*
 * Taking a pairing back.
 *
 * A drop lands on whatever the cursor was over, so pairing the wrong two rows is the mistake this
 * screen invites — and everything here saves as it happens, so there is no Cancel for it to fall under.
 * The reversal is exact in both directions because pairing changes nothing about the transactions
 * themselves: a record built around two loose rows is deleted, and a transaction added to an existing
 * record is taken off it again.
 */
describe('undoing a pairing', () => {
  const RECORD = {
    id: 'link-1', counterparty: 'Ticket friends', completed: false, residual: 25,
    members: [{ txn_id: 'e1', date: '2026-02-14', payee: 'Concert Tix', claim: 375, trashed: false }],
  }
  const PAYMENT = { txn_id: 'r9', date: '2026-09-01', payee: 'From Sam', unclaimed: -166, parts: [] }
  const EXPENSE = { txn_id: 'e9', date: '2026-09-02', payee: 'Grocery store', unclaimed: 130, parts: [] }

  function drag(sourceName, targetName) {
    const source = screen.getByRole('button', { name: new RegExp(sourceName) })
    const target = screen.getByRole('button', { name: new RegExp(targetName) })
    document.elementFromPoint = () => target
    const at = { pointerId: 1, pointerType: 'mouse', button: 0, clientY: 0 }
    fireEvent.pointerDown(source, { ...at, clientX: 0 })
    fireEvent.pointerMove(window, { ...at, clientX: 20 })
    fireEvent.pointerUp(window, { ...at, clientX: 20 })
  }

  it('offers an undo for a drop onto an existing record, and takes the transaction back off', async () => {
    api.addReimbursementClaims.mockResolvedValue(RECORD)
    open({ total: 25, reimbursements: [RECORD], loose: [PAYMENT] })
    await screen.findByText('Ticket friends')
    drag('From Sam', 'Ticket friends')

    await userEvent.click(await screen.findByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(api.removeReimbursementTransaction).toHaveBeenCalledWith('link-1', 'r9'))
  })

  it('undoes a pairing of two loose rows by deleting the record it created', async () => {
    api.createReimbursement.mockResolvedValue({ id: 'link-2' })
    open({ total: 130, reimbursements: [], loose: [EXPENSE, PAYMENT] })
    await screen.findByText('Grocery store')
    drag('From Sam', 'Grocery store')

    await userEvent.click(await screen.findByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(api.deleteReimbursement).toHaveBeenCalledWith('link-2'))
  })
})

/*
 * Finishing a reimbursement that has nothing left to decide, from the board.
 *
 * Only this ending is offered here: the two sides balance, so completing moves no money and asks for no
 * category. Everything else — a shortfall, a surplus, a write-off — needs the editor, where the residual
 * and its destination are.
 */
describe('completing from the board', () => {
  const SQUARE = {
    id: 'link-9', counterparty: 'Lunch', completed: false, owed: 72, repaid: -72, residual: 0,
    members: [
      { txn_id: 'e1', date: '2026-08-22', payee: 'Taverna', claim: 72, role: 'expense', trashed: false },
      { txn_id: 'r1', date: '2026-08-22', payee: 'Sam', claim: -72, role: 'repayment', trashed: false },
    ],
  }
  const SHORT = { ...SQUARE, id: 'link-8', counterparty: 'Tickets', repaid: -50, residual: 22 }

  it('completes a fully repaid record in one click, and offers it back', async () => {
    txnMutations.completeReimbursement.mockResolvedValue({})
    open({ total: 0, reimbursements: [SQUARE], loose: [] })
    await userEvent.click(await screen.findByRole('button', { name: 'Mark complete' }))
    await waitFor(() => expect(txnMutations.completeReimbursement).toHaveBeenCalledWith('link-9', {}))

    await userEvent.click(await screen.findByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(txnMutations.reopenReimbursement).toHaveBeenCalledWith('link-9'))
  })

  it('leaves a record with a residual to the editor, where its destination is chosen', async () => {
    open({ total: 22, reimbursements: [SHORT], loose: [] })
    await screen.findByText('Tickets')
    expect(screen.queryByRole('button', { name: 'Mark complete' })).toBeNull()
  })
})

/*
 * The narrowing a Tasks reminder arrives with.
 *
 * The property worth pinning is that the report never shows a headline the list under it contradicts:
 * the total is the *group's whole balance* by design, so a narrowed list has to state its own figure
 * rather than leaving the reader to assume the big number describes what they can see.
 */
describe('opened from a reminder', () => {
  const overdue = {
    id: 'r1',
    counterparty: 'Alex trip',
    owed: 375,
    repaid: 0,
    residual: 375,
    completed: false,
    expense_date: '2020-02-14',
    members: [{
      txn_id: 't1', date: '2020-02-14', payee: 'Tickets', claim: 375, receivable: 375,
      trashed: false, role: 'expense', owner_id: 'alex', owner_name: 'Alex',
    }],
  }
  const recent = {
    ...overdue,
    id: 'r2',
    counterparty: 'Robin lunch',
    expense_date: '2099-01-01',
    members: [{ ...overdue.members[0], txn_id: 't2', date: '2099-01-01', owner_id: 'robin', owner_name: 'Robin' }],
  }

  function openReport(props = {}) {
    api.getOutstandingReimbursements.mockResolvedValue({
      total: 750, reimbursements: [overdue, recent], loose: [], reminder_days: 30,
    })
    return render(
      <ReimbursementsReportDialog categories={[]} onClose={() => {}} {...props} />,
    )
  }

  it('shows only the named owner when opened from that owner\'s task', async () => {
    openReport({ ownerId: 'alex' })
    expect(await screen.findByText('Alex trip')).toBeTruthy()
    expect(screen.queryByText('Robin lunch')).toBeNull()
  })

  it('shows only what is due when the link says so', async () => {
    openReport({ dueOnly: true })
    expect(await screen.findByText('Alex trip')).toBeTruthy()
    expect(screen.queryByText('Robin lunch')).toBeNull()
  })

  it('lets the narrowing be dropped', async () => {
    openReport({ ownerId: 'alex' })
    await userEvent.click(await screen.findByRole('button', { name: 'Show everything' }))
    expect(await screen.findByText('Robin lunch')).toBeTruthy()
  })

  it('leaves the report unnarrowed when opened normally', async () => {
    openReport()
    expect(await screen.findByText('Alex trip')).toBeTruthy()
    expect(screen.getByText('Robin lunch')).toBeTruthy()
  })
  it('narrows to one owner from the pills, and back', async () => {
    openReport()
    const pills = await screen.findByRole('group', { name: 'Show whose' })
    await userEvent.click(within(pills).getByRole('button', { name: 'Robin' }))
    expect(screen.queryByText('Alex trip')).toBeNull()
    expect(screen.getByText('Robin lunch')).toBeTruthy()
    await userEvent.click(within(pills).getByRole('button', { name: 'Everyone' }))
    expect(screen.getByText('Alex trip')).toBeTruthy()
  })
})

describe('owner chips', () => {
  it('shortens a name to the first, unless two owners share it', () => {
    const labels = ownerChipLabels([
      { id: 'a', name: 'Alex Rivera' },
      { id: 'b', name: 'Sam Okafor' },
      { id: 'c', name: 'Sam Whitfield' },
    ])
    expect([...labels.values()]).toEqual(['Alex', 'Sam Okafor', 'Sam Whitfield'])
  })
})

// The page's filters narrow the Expected side; the Received side stays whole so a repayment can still be
// dragged onto what it repays, and Show everything drops the narrowing for the report alone.
describe('the page filters', () => {
  const MATCHING = { ...LOOSE, txn_id: 'm1', payee: 'Matching Dinner', matches_filter: true }
  const OTHER = { ...LOOSE, txn_id: 'o1', payee: 'Other Person Dinner', matches_filter: false }
  const PAYMENT = { txn_id: 'r1', date: '2026-09-01', payee: 'From Sam', unclaimed: -50, parts: [], matches_filter: false }
  const FILTERS = { owner_ids: 'frances' }

  function openFiltered() {
    api.getOutstandingReimbursements.mockResolvedValue({
      total: 190, filtered: true, reimbursements: [], loose: [MATCHING, OTHER, PAYMENT],
    })
    return render(
      <StrictMode>
        <ReimbursementsReportDialog categories={[]} filterParams={FILTERS} onClose={() => {}} />
      </StrictMode>,
    )
  }

  it('lists only matching expected rows, keeps every received row, and can show everything', async () => {
    openFiltered()
    expect(await screen.findByRole('button', { name: /Matching Dinner/ })).toBeTruthy()
    expect(api.getOutstandingReimbursements).toHaveBeenCalledWith(FILTERS)
    expect(screen.queryByRole('button', { name: /Other Person Dinner/ })).toBeNull()
    expect(screen.getByRole('button', { name: /From Sam/ })).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: 'Show everything' }))
    expect(screen.getByRole('button', { name: /Other Person Dinner/ })).toBeTruthy()
  })
})
