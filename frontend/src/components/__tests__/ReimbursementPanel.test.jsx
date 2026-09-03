// @vitest-environment jsdom

// The reimbursement panel's own decisions, which are the ones the backend cannot make for it: when to
// render at all, and what a row that holds receivable money but has no reimbursement yet should say.
//
// Rendered inside `<StrictMode>` because that is what `main.jsx` runs, and this panel fetches on mount:
// an effect guarded by both a "once" ref and a cancel flag deadlocks under StrictMode's mount/unmount/
// mount, holding the surface on its empty state forever. A plain render() cannot see that.
//
// The notify callback is passed deliberately **unstable** — a new arrow on every render, which is what
// a careless host supplies — because that is the shape that turns a report-to-host into an infinite
// fetch loop. A stable vi.fn() would pass against an implementation that depends on the callback.

import { StrictMode, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ReimbursementPanel from '../ReimbursementPanel.jsx'
import { api } from '../../lib/api.js'

vi.mock('../../lib/api.js', () => ({
  api: {
    getTransactionReimbursement: vi.fn(),
    getReimbursement: vi.fn(),
    createReimbursement: vi.fn(),
    getOutstandingReimbursements: vi.fn(),
    updateReimbursement: vi.fn(),
    addReimbursementClaims: vi.fn(),
    removeReimbursementTransaction: vi.fn(),
    completeReimbursement: vi.fn(),
    uncompleteReimbursement: vi.fn(),
    deleteReimbursement: vi.fn(),
    getReimbursementSettings: vi.fn(),
    moveReimbursementClaim: vi.fn(),
  },
}))

const REIMBURSEMENT = {
  id: 'link-1',
  counterparty: 'Ticket friends',
  note: '',
  owed: 375,
  repaid: -350,
  residual: 25,
  completed: false,
  completion: null,
  members: [
    { txn_id: 't1', date: '2026-02-14', amount: 500, payee: 'Concert Tickets', account_name: 'Everyday', trashed: false, claim: 375, receivable: 375, role: 'expense' },
    { txn_id: 't2', date: '2026-07-03', amount: -350, payee: 'Repayment', account_name: 'Everyday', trashed: false, claim: -350, receivable: -350, role: 'repayment' },
  ],
}

// One $750 charge split three ways: the buyer's own ticket plus two owed by different people.
const TWO_SHARES = {
  reimbursements: [],
  receivable: 500,
  unclaimed: 500,
  parts: [{ amount: 250, label: "Dana's ticket" }, { amount: 250, label: "Rowan's ticket" }],
}

// A host that re-renders on every report, passing a fresh callback each time — the real-app shape.
function Host({ txnId = 't1' }) {
  const [seen, setSeen] = useState(0)
  return (
    <StrictMode>
      <div data-testid="reports">{seen}</div>
      <ReimbursementPanel
        txnId={txnId}
        categories={[]}
        onReimbursementsChange={() => setSeen(count => count + 1)}
      />
    </StrictMode>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  // Starting a reimbursement opens the editor, which fetches on mount. Left unmocked that returns
  // undefined and throws inside a passive effect — a test-only crash that says nothing about the panel.
  api.getReimbursement.mockResolvedValue(REIMBURSEMENT)
  api.getOutstandingReimbursements.mockResolvedValue({
    total: 0, reimbursements: [], loose: [], reminder_days: 30,
  })
  api.getReimbursementSettings.mockResolvedValue({
    reminder_days: 30, default_reminder_days: 30, max_reminder_days: 3650,
  })
})

afterEach(cleanup)

describe('ReimbursementPanel', () => {
  it('renders nothing for a row with no receivable money and no reimbursement', async () => {
    api.getTransactionReimbursement.mockResolvedValue({ reimbursements: [], receivable: 0, unclaimed: 0, parts: [] })
    const { container } = render(<Host />)
    await waitFor(() => expect(api.getTransactionReimbursement).toHaveBeenCalled())
    expect(screen.queryByText('Reimbursement')).toBeNull()
    expect(container.textContent).not.toMatch(/Track this reimbursement/)
  })

  it('speaks for an unlinked receivable, which is where every reimbursement starts', async () => {
    // The divergence from PurchasePanel: money in the holding group is a receivable before anything
    // has been linked to it, so the gap between purchase and repayment is a state to act on rather
    // than an unfinished step to hide.
    api.getTransactionReimbursement.mockResolvedValue({ reimbursements: [], receivable: 375, unclaimed: 375, parts: [{ amount: 375, label: null }] })
    render(<Host />)
    // The line is folded into the button where the button names the amount — one portion, one click,
    // one figure.
    expect(await screen.findByRole('button', { name: 'Expect $375.00 back' })).toBeTruthy()
    expect(screen.queryByText(/awaiting reimbursement/)).toBeNull()
  })

  it('shows where a tracked reimbursement stands', async () => {
    api.getTransactionReimbursement.mockResolvedValue({ reimbursements: [REIMBURSEMENT], receivable: 375, unclaimed: 0, parts: [] })
    render(<Host />)
    expect(await screen.findByText('Ticket friends')).toBeTruthy()
    expect(screen.getByText(/outstanding/)).toBeTruthy()
  })

  it('does not loop when the host re-renders it with a fresh callback', async () => {
    // The failure this pins is silent and total: a fetch effect that depends on the notify callback
    // refetches on every report, and each report re-renders the host. One settled fetch is correct.
    api.getTransactionReimbursement.mockResolvedValue({ reimbursements: [REIMBURSEMENT], receivable: 375, unclaimed: 0, parts: [] })
    render(<Host />)
    await screen.findByText('Ticket friends')
    const settled = api.getTransactionReimbursement.mock.calls.length
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(api.getTransactionReimbursement.mock.calls.length).toBe(settled)
  })

  it('starts tracking with this row alone, since "nobody has paid me back" is a real reimbursement', async () => {
    api.getTransactionReimbursement.mockResolvedValue({ reimbursements: [], receivable: 375, unclaimed: 375, parts: [{ amount: 375, label: null }] })
    api.createReimbursement.mockResolvedValue({ ...REIMBURSEMENT, repaid: 0, residual: 375, members: [REIMBURSEMENT.members[0]] })
    render(<Host />)
    await userEvent.click(await screen.findByRole('button', { name: 'Expect $375.00 back' }))
    await waitFor(() => expect(api.createReimbursement).toHaveBeenCalledWith({
      claims: [{ txn_id: 't1', amount: 375, label: null }],
    }))
  })

  it('surfaces a refused create rather than leaving a dead button', async () => {
    api.getTransactionReimbursement.mockResolvedValue({ reimbursements: [], receivable: 375, unclaimed: 375, parts: [{ amount: 375, label: null }] })
    api.createReimbursement.mockRejectedValue(new Error('Every transaction in a reimbursement needs an amount in the Reimbursable group'))
    render(<Host />)
    await userEvent.click(await screen.findByRole('button', { name: 'Expect $375.00 back' }))
    expect(await screen.findByText(/needs an amount in the Reimbursable group/)).toBeTruthy()
  })
})

// Money in repays something; money out is money to expect back. The action follows the sign, because
// offering "track this" on both put a repayment into a record of its own — and a claim belongs to one
// record, so the expense could then never be joined to it. Every expense in the reporter's ledger had
// been stranded that way.
describe('a repayment row', () => {
  const CREDIT = {
    reimbursements: [], receivable: -250, unclaimed: -250,
    parts: [{ amount: -250, label: null }],
  }
  const OPEN = {
    id: 'link-9', counterparty: 'Ticket friends', note: '', owed: 375, repaid: 0,
    residual: 375, completed: false, completion: null, members: [],
  }

  it('offers to match it rather than to track it', async () => {
    api.getTransactionReimbursement.mockResolvedValue(CREDIT)
    render(<Host />)
    expect(await screen.findByRole('button', { name: 'Match $250.00 to an expense' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Expect/ })).toBeNull()
  })

  it('adds the portion to the reimbursement it repays instead of creating a rival record', async () => {
    api.getTransactionReimbursement.mockResolvedValue(CREDIT)
    api.getOutstandingReimbursements.mockResolvedValue({ total: 375, reimbursements: [OPEN], loose: [] })
    api.addReimbursementClaims.mockResolvedValue(OPEN)
    render(<Host />)
    await userEvent.click(await screen.findByRole('button', { name: 'Match $250.00 to an expense' }))
    await userEvent.click(await screen.findByRole('button', { name: /Ticket friends/ }))
    await waitFor(() => expect(api.addReimbursementClaims).toHaveBeenCalledWith(
      'link-9', [{ txn_id: 't1', amount: -250, label: null }],
    ))
    expect(api.createReimbursement).not.toHaveBeenCalled()
  })

  it('pairs with an expense nobody has tracked, in one step', async () => {
    // The dead end this closes: an untracked expense could not be chosen, so "this repays that" needed
    // the expense turned into a record by hand first — through a picker, an editor, and a second trip.
    api.getTransactionReimbursement.mockResolvedValue(CREDIT)
    api.getOutstandingReimbursements.mockResolvedValue({
      total: 333, reimbursements: [],
      loose: [{ txn_id: 'e9', date: '2026-09-02', payee: 'Concert Tix', unclaimed: 333, parts: [] }],
    })
    api.createReimbursement.mockResolvedValue({ ...OPEN, id: 'link-11' })
    render(<Host />)
    await userEvent.click(await screen.findByRole('button', { name: 'Match $250.00 to an expense' }))
    await userEvent.click(await screen.findByRole('button', { name: /Concert Tix/ }))
    // One record holding both sides, rather than a bare one for each.
    await waitFor(() => expect(api.createReimbursement).toHaveBeenCalledWith({
      claims: [
        { txn_id: 'e9', amount: 333, label: null },
        { txn_id: 't1', amount: -250, label: null },
      ],
    }))
  })

  it('does not offer an expense in the same direction as the repayment', async () => {
    api.getTransactionReimbursement.mockResolvedValue(CREDIT)
    api.getOutstandingReimbursements.mockResolvedValue({
      total: 0, reimbursements: [],
      loose: [{ txn_id: 'r9', date: '2026-09-02', payee: 'Another deposit', unclaimed: -100, parts: [] }],
    })
    render(<Host />)
    await userEvent.click(await screen.findByRole('button', { name: 'Match $250.00 to an expense' }))
    expect(await screen.findByText(/Nothing is waiting to be repaid yet/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Another deposit/ })).toBeNull()
  })

  it('still lets a repayment stand alone, since it can arrive before its expense is entered', async () => {
    // Refusing it would leave that money with nowhere to go at all. It is the quiet option, not an
    // invalid one.
    api.getTransactionReimbursement.mockResolvedValue(CREDIT)
    api.getOutstandingReimbursements.mockResolvedValue({ total: 0, reimbursements: [], loose: [] })
    api.createReimbursement.mockResolvedValue({ ...OPEN, id: 'link-10' })
    render(<Host />)
    await userEvent.click(await screen.findByRole('button', { name: 'Match $250.00 to an expense' }))
    expect(await screen.findByText(/Nothing is waiting to be repaid yet/)).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /Record on its own/ }))
    await waitFor(() => expect(api.createReimbursement).toHaveBeenCalledWith({
      claims: [{ txn_id: 't1', amount: -250, label: null }],
    }))
  })
})

describe('a row divided between people', () => {
  it('asks which portion is being tracked instead of claiming the whole row', async () => {
    // The failure this pins: summing a row's portions made a $750 charge split between two friends look
    // like one $500 debt, so only one of them could ever be tracked.
    api.getTransactionReimbursement.mockResolvedValue(TWO_SHARES)
    render(<Host />)
    await userEvent.click(await screen.findByRole('button', { name: /Expect money back/ }))
    expect(screen.getByText('Which parts of this transaction?')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Dana's ticket/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Rowan's ticket/ })).toBeTruthy()
  })

  it('claims only the portion that was picked', async () => {
    api.getTransactionReimbursement.mockResolvedValue(TWO_SHARES)
    api.createReimbursement.mockResolvedValue({ ...REIMBURSEMENT, id: 'link-2' })
    render(<Host />)
    await userEvent.click(await screen.findByRole('button', { name: /Expect money back/ }))
    await userEvent.click(screen.getByRole('button', { name: /Rowan's ticket/ }))
    await userEvent.click(screen.getByRole('button', { name: /Track this reimbursement/ }))
    await waitFor(() => expect(api.createReimbursement).toHaveBeenCalledWith({
      claims: [{ txn_id: 't1', amount: 250, label: "Rowan's ticket" }],
    }))
  })

  it('claims both portions as one claim when both are chosen', async () => {
    // The gap this closes: a charge split between two people is routinely owed back by one of them in
    // full, and the buttons this replaced accepted exactly one. A reimbursement holds one claim per
    // transaction, so both portions become a single claim for their sum rather than two.
    api.getTransactionReimbursement.mockResolvedValue(TWO_SHARES)
    api.createReimbursement.mockResolvedValue({ ...REIMBURSEMENT, id: 'link-3' })
    render(<Host />)
    await userEvent.click(await screen.findByRole('button', { name: /Expect money back/ }))
    await userEvent.click(screen.getByRole('button', { name: /Dana's ticket/ }))
    await userEvent.click(screen.getByRole('button', { name: /Rowan's ticket/ }))
    await userEvent.click(screen.getByRole('button', { name: /Track this reimbursement/ }))
    await waitFor(() => expect(api.createReimbursement).toHaveBeenCalledWith({
      claims: [{ txn_id: 't1', amount: 500, label: "Dana's ticket + Rowan's ticket" }],
    }))
  })

  it('clears a portion when it is chosen twice, so a mis-tap is undone in place', async () => {
    api.getTransactionReimbursement.mockResolvedValue(TWO_SHARES)
    render(<Host />)
    await userEvent.click(await screen.findByRole('button', { name: /Expect money back/ }))
    const dana = screen.getByRole('button', { name: /Dana's ticket/ })
    await userEvent.click(dana)
    expect(dana.getAttribute('aria-pressed')).toBe('true')
    await userEvent.click(dana)
    expect(dana.getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByText('$500.00 available')).toBeTruthy()
  })

  it('lists every reimbursement a row has a portion in', async () => {
    api.getTransactionReimbursement.mockResolvedValue({
      reimbursements: [
        { ...REIMBURSEMENT, id: 'a', counterparty: 'Dana' },
        { ...REIMBURSEMENT, id: 'b', counterparty: 'Rowan' },
      ],
      receivable: 500, unclaimed: 0, parts: [],
    })
    render(<Host />)
    expect(await screen.findByText('Dana')).toBeTruthy()
    expect(screen.getByText('Rowan')).toBeTruthy()
    expect(screen.getByText('Reimbursements')).toBeTruthy()
  })

  it('still offers what is left when a row is only partly claimed', async () => {
    api.getTransactionReimbursement.mockResolvedValue({
      reimbursements: [{ ...REIMBURSEMENT, id: 'a', counterparty: 'Dana' }],
      receivable: 500, unclaimed: 250,
      parts: [{ amount: 250, label: "Dana's ticket" }, { amount: 250, label: "Rowan's ticket" }],
    })
    render(<Host />)
    expect(await screen.findByText('Dana')).toBeTruthy()
    expect(screen.getByText(/awaiting reimbursement/)).toBeTruthy()
  })
})
