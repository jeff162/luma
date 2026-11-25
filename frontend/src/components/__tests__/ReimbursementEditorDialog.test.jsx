// @vitest-environment jsdom

// The settle flow, which is the only thing on this dialog that moves money.
//
// What is worth pinning here rather than in `lib/reimbursements.js` (which covers the decisions) is the
// wiring: that the user is never asked which *side* a residual settles against, that they are asked
// which transaction only when the role has more than one candidate, that the explanation of what
// completing does is on screen before the click, and that Settle cannot go out without a category.
//
// Rendered inside `<StrictMode>` because the dialog fetches on mount and that is what the app runs.

import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ReimbursementEditorDialog from '../ReimbursementEditorDialog.jsx'
import { completeExplanation } from '../../lib/reimbursements.js'
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
    getTransactionReimbursement: vi.fn(),
    getReimbursement: vi.fn(),
    getOutstandingReimbursements: vi.fn(),
    updateReimbursement: vi.fn(),
    createReimbursement: vi.fn(),
    addReimbursementClaims: vi.fn(),
    removeReimbursementTransaction: vi.fn(),
    uncompleteReimbursement: vi.fn(),
    deleteReimbursement: vi.fn(),
    getReimbursementSettings: vi.fn(),
    moveReimbursementClaim: vi.fn(),
    getCategories: vi.fn(),
  },
}))

const CATEGORIES = [
  { id: 'g1', name: 'Entertainment', parent_id: null },
  { id: 'movies', name: 'Movies & Events', parent_id: 'g1' },
]

const EXPENSE = { txn_id: 't1', date: '2026-02-14', amount: 500, payee: 'Concert Tickets', account_name: 'Everyday', trashed: false, claim: 375, receivable: 375, claim_label: null, role: 'expense' }
const SECOND_EXPENSE = { txn_id: 't3', date: '2026-03-02', amount: 120, payee: 'Second Receipt', account_name: 'Everyday', trashed: false, claim: 120, receivable: 120, claim_label: null, role: 'expense' }
const REPAYMENT = { txn_id: 't2', date: '2026-07-03', amount: -350, payee: 'Repayment', account_name: 'Everyday', trashed: false, claim: -350, receivable: -350, claim_label: null, role: 'repayment' }
// One $750 charge whose other $250 belongs to somebody else's reimbursement.
const SHARED_EXPENSE = { ...EXPENSE, amount: 750, claim: 250, receivable: 500, claim_label: "Dana's ticket" }

function record(overrides = {}) {
  return {
    id: 'link-1',
    counterparty: 'Ticket friends',
    note: '',
    owed: 375,
    repaid: -350,
    residual: 25,
    completed: false,
    completion: null,
    members: [EXPENSE, REPAYMENT],
    ...overrides,
  }
}

function open(reimbursement) {
  api.getReimbursement.mockResolvedValue(reimbursement)
  return render(
    <StrictMode>
      <ReimbursementEditorDialog
        linkId="link-1"
        txnId="t1"
        categories={CATEGORIES}
        onClose={() => {}}
        onSaved={() => {}}
      />
    </StrictMode>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  api.getOutstandingReimbursements.mockResolvedValue({
    total: 0, reimbursements: [], loose: [], reminder_days: 30,
  })
  api.getReimbursementSettings.mockResolvedValue({
    reminder_days: 30, default_reminder_days: 30, max_reminder_days: 3650,
  })
})
afterEach(cleanup)

describe('completing', () => {
  it('explains what completing a shortfall does', async () => {
    const reimbursement = record()
    open(reimbursement)
    await userEvent.click(await screen.findByRole('button', { name: 'Mark complete' }))
    expect(screen.getByText(completeExplanation(reimbursement))).toBeTruthy()
  })

  it('says a surplus leaves the original expense alone', async () => {
    open(record({ residual: -25, repaid: -400 }))
    await userEvent.click(await screen.findByRole('button', { name: 'Mark complete' }))
    expect(screen.getByText(/the original expense is left alone/)).toBeTruthy()
  })

  it('never asks which side the residual settles against', async () => {
    // The sign decides the role on the server. Offering it here would be a second decision able to
    // disagree with the ledger, and the user has no way to answer it correctly.
    open(record())
    await userEvent.click(await screen.findByRole('button', { name: 'Mark complete' }))
    expect(screen.queryByText(/expense or repayment/i)).toBeNull()
    // Named specifically: the dialog also carries the reminder control, which is a combobox too.
    expect(screen.queryByLabelText(/Which expense fell short/)).toBeNull()
    expect(screen.queryByLabelText(/Which repayment carries/)).toBeNull()
  })

  it('asks which transaction only when the role has more than one candidate', async () => {
    open(record({ members: [EXPENSE, SECOND_EXPENSE, REPAYMENT], owed: 495, residual: 145 }))
    await userEvent.click(await screen.findByRole('button', { name: 'Mark complete' }))
    expect(screen.getByLabelText(/Which expense fell short/)).toBeTruthy()
    expect(screen.getByText(/Which expense fell short/)).toBeTruthy()
  })

  it('will not settle without a category', async () => {
    // Asserted by clicking and checking the request never went out, rather than by reading the
    // attribute: what matters is that the gate holds, not how the button expresses being unavailable.
    open(record())
    await userEvent.click(await screen.findByRole('button', { name: 'Mark complete' }))
    await userEvent.click(screen.getByRole('button', { name: 'Mark complete' }))
    expect(txnMutations.completeReimbursement).not.toHaveBeenCalled()
  })

  it('offers the reversal, and no settle action, once it is settled', async () => {
    open(record({ completed: true, residual: 0, completion: { txn_id: 't1', residual: 25, category_id: 'movies' } }))
    expect(await screen.findByRole('button', { name: /Reopen/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Mark complete' })).toBeNull()
    // A settled reimbursement cannot be unlinked either: the record is the only thing that can reverse
    // the move, so discarding it would strand the money in a category nothing explains.
    expect(screen.queryByRole('button', { name: /Stop tracking this reimbursement/ })).toBeNull()
  })

  it('surfaces a refusal from the server rather than closing as if it worked', async () => {
    txnMutations.completeReimbursement.mockRejectedValue(new Error('That transaction does not have enough left in the Reimbursable group'))
    open(record())
    await userEvent.click(await screen.findByRole('button', { name: 'Mark complete' }))
    await userEvent.click(screen.getByRole('button', { name: /Choose category|Movies/ }))
    await userEvent.click(await screen.findByText('Movies & Events'))
    await userEvent.click(screen.getByRole('button', { name: 'Move and complete' }))
    // Asserted alongside the message so the test cannot pass by the picker click silently failing and
    // the request never going out at all.
    await waitFor(() => expect(txnMutations.completeReimbursement).toHaveBeenCalledWith(
      'link-1', { category_id: 'movies', target_txn_id: 't1' },
    ))
    expect(screen.getByText(/does not have enough left/)).toBeTruthy()
  })
})

describe('completing one that was repaid in full', () => {
  const square = () => record({ owed: 375, repaid: -375, residual: 0 })

  it('says it is ready to complete, and asks for no category', async () => {
    // The hole this closes: "already square" used to be an error, so the commonest happy ending had no
    // action at all and the record sat on the open list forever.
    open(square())
    expect(await screen.findByText(/ready to complete/)).toBeTruthy()
    expect(screen.queryByText(/Which category does it belong to/)).toBeNull()
  })

  it('completes in one click, with no category and no target', async () => {
    // Balanced is the one case with nothing to decide, so it must not route through the panel that
    // exists to ask where a residual goes.
    txnMutations.completeReimbursement.mockResolvedValue({ ...square(), completed: true })
    open(square())
    await userEvent.click(await screen.findByRole('button', { name: 'Mark complete' }))
    await waitFor(() => expect(txnMutations.completeReimbursement).toHaveBeenCalledWith(
      'link-1', { category_id: null, target_txn_id: null },
    ))
    expect(screen.queryByRole('button', { name: 'Move and complete' })).toBeNull()
  })

  it('reads as finished with nothing moved once it is complete', async () => {
    open(record({ owed: 375, repaid: -375, residual: 0, completed: true, completion: { txn_id: null, residual: 0 } }))
    // The completed note's two branches differ only in their copy, so the copy is the assertion: this
    // is the one test that distinguishes "nothing moved" from a residual having been moved out. A
    // wording change here is therefore expected to fail this test rather than slip past it.
    expect(await screen.findByText(/Repaid in full/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Reopen/ })).toBeTruthy()
  })
})

describe('portions of a transaction', () => {
  it("shows this reimbursement's claim, not the whole row's receivable", async () => {
    // A $250 claim on a $750 charge whose other portions belong to other people. Rendering the row's
    // receivable here would report somebody else's money as part of this debt.
    open(record({ members: [SHARED_EXPENSE, REPAYMENT], owed: 250, repaid: -350, residual: -100 }))
    await screen.findByText(/Concert Tickets/)
    // The claim shows (in the member row and in "Owed"); the row's own $500 receivable never does,
    // because $250 of it is somebody else's reimbursement.
    expect(screen.getAllByText('-$250.00').length).toBeGreaterThan(0)
    expect(screen.queryByText('-$500.00')).toBeNull()
  })

  it("names the portion it covers, so the row says whose money it is", async () => {
    open(record({ members: [SHARED_EXPENSE], owed: 250, repaid: 0, residual: 250 }))
    expect(await screen.findByText(/Dana's ticket/)).toBeTruthy()
  })

  it('offers a divided candidate row one entry per portion when linking', async () => {
    api.getOutstandingReimbursements.mockResolvedValue({
      total: 500, reimbursements: [],
      loose: [{
        txn_id: 'd1', date: '2026-07-03', amount: -600, payee: 'ATM Deposit',
        account_name: 'Everyday', receivable: -500, unclaimed: -500,
        parts: [{ amount: -250, label: 'From Dana' }, { amount: -250, label: 'From Rowan' }],
        role: 'repayment',
      }],
    })
    open(record())
    await userEvent.click(await screen.findByRole('button', { name: /Link another transaction/ }))
    expect(await screen.findByRole('button', { name: /From Dana/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /From Rowan/ })).toBeTruthy()
  })

  it('claims only the picked portion of that row', async () => {
    api.getOutstandingReimbursements.mockResolvedValue({
      total: 500, reimbursements: [],
      loose: [{
        txn_id: 'd1', date: '2026-07-03', amount: -600, payee: 'ATM Deposit',
        account_name: 'Everyday', receivable: -500, unclaimed: -500,
        parts: [{ amount: -250, label: 'From Dana' }, { amount: -250, label: 'From Rowan' }],
        role: 'repayment',
      }],
    })
    api.addReimbursementClaims.mockResolvedValue(record())
    open(record())
    await userEvent.click(await screen.findByRole('button', { name: /Link another transaction/ }))
    await userEvent.click(await screen.findByRole('button', { name: /From Rowan/ }))
    await userEvent.click(screen.getByRole('button', { name: /Add to this reimbursement/ }))
    await waitFor(() => expect(api.addReimbursementClaims).toHaveBeenCalledWith(
      'link-1', [{ txn_id: 'd1', amount: -250, label: 'From Rowan' }],
    ))
  })

  it('takes both portions of a deposit in one claim, since a second would replace the first', async () => {
    // Particular to this surface: `add_claims` merges by transaction id, so attaching a second portion of
    // a row already covered *replaces* the first rather than adding to it. Choosing both together is
    // the only way to claim the whole deposit.
    api.getOutstandingReimbursements.mockResolvedValue({
      total: 500, reimbursements: [],
      loose: [{
        txn_id: 'd1', date: '2026-07-03', amount: -600, payee: 'ATM Deposit',
        account_name: 'Everyday', receivable: -500, unclaimed: -500,
        parts: [{ amount: -250, label: 'From Dana' }, { amount: -250, label: 'From Rowan' }],
        role: 'repayment',
      }],
    })
    api.addReimbursementClaims.mockResolvedValue(record())
    open(record())
    await userEvent.click(await screen.findByRole('button', { name: /Link another transaction/ }))
    await userEvent.click(await screen.findByRole('button', { name: /From Dana/ }))
    await userEvent.click(screen.getByRole('button', { name: /From Rowan/ }))
    await userEvent.click(screen.getByRole('button', { name: /Add to this reimbursement/ }))
    await waitFor(() => expect(api.addReimbursementClaims).toHaveBeenCalledWith(
      'link-1', [{ txn_id: 'd1', amount: -500, label: 'From Dana + From Rowan' }],
    ))
  })
})

// The primary variant paints the accent flat; secondary blends it at 8% into the surface, so testing for
// the bare token is what tells the two apart — `includes('--accent')` matches both.
const accent = button => button.style.background === 'var(--accent)'

describe('which button is the main verb', () => {

  it('accents Complete only when the two sides balance', async () => {
    open(record({ owed: 375, repaid: -375, residual: 0 }))
    expect(accent(await screen.findByRole('button', { name: 'Mark complete' }))).toBe(true)
    expect(accent(screen.getByRole('button', { name: 'Save' }))).toBe(false)
  })

  it('leaves Save as the main verb while money is unaccounted for', async () => {
    // Closing a record with a shortfall is a judgement the user may not want to make on this visit, so
    // the loud button must not be the one that does it.
    open(record())
    expect(accent(await screen.findByRole('button', { name: 'Save' }))).toBe(true)
    expect(accent(screen.getByRole('button', { name: 'Mark complete' }))).toBe(false)
  })

  it('leaves Complete reachable but unaccented when nothing has come back', async () => {
    // Sometimes nobody pays you back, and that write-off is a real outcome. What keeps it from being an
    // accidental click is the emphasis and the category question, not a block.
    open(record({ members: [EXPENSE], owed: 375, repaid: 0, residual: 375 }))
    const complete = await screen.findByRole('button', { name: 'Mark complete' })
    expect(accent(complete)).toBe(false)
    expect(complete.getAttribute('title')).toMatch(/Record the whole amount as spending/)
  })
})

describe('writing one off when nobody paid', () => {
  const unpaid = () => record({ members: [EXPENSE], owed: 375, repaid: 0, residual: 375 })

  it('says it is recording the whole amount, not a portion', async () => {
    // The partial-shortfall text understates a click that is booking the entire expense as spending.
    open(unpaid())
    await userEvent.click(await screen.findByRole('button', { name: 'Mark complete' }))
    expect(screen.getByText(/Nothing has been received against this/)).toBeTruthy()
    expect(screen.getByText(/whole -\$375\.00 as spending/)).toBeTruthy()
  })

  it('will not write it off without a category to put it in', async () => {
    open(unpaid())
    await userEvent.click(await screen.findByRole('button', { name: 'Mark complete' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Move and complete' }))
    expect(txnMutations.completeReimbursement).not.toHaveBeenCalled()
  })

  it('books the whole residual against the expense once a category is chosen', async () => {
    txnMutations.completeReimbursement.mockResolvedValue({ ...unpaid(), completed: true })
    open(unpaid())
    await userEvent.click(await screen.findByRole('button', { name: 'Mark complete' }))
    await userEvent.click(screen.getByRole('button', { name: /Choose category|Movies/ }))
    await userEvent.click(await screen.findByText('Movies & Events'))
    await userEvent.click(screen.getByRole('button', { name: 'Move and complete' }))
    await waitFor(() => expect(txnMutations.completeReimbursement).toHaveBeenCalledWith(
      'link-1', { category_id: 'movies', target_txn_id: 't1' },
    ))
  })
})


/*
 * The counterparty field *is* this record's name — it is what the board, the row cards and the dialog
 * heading all show — and nothing said so. It was labelled by placeholder alone, which reads as a
 * question rather than as a name and disappears the moment it is typed into, so once a record was named
 * there was nothing on screen identifying which field held the name.
 */
describe('naming a reimbursement', () => {
  it('labels the field that holds the name, not just its placeholder', async () => {
    open(record())
    expect(await screen.findByText('Name')).toBeTruthy()
  })

  it('follows the name in the heading as it is typed', async () => {
    // The one place the connection between that field and the record's name can be seen.
    open(record())
    const field = await screen.findByLabelText('Name')
    expect(screen.getByText('Ticket friends')).toBeTruthy()
    await userEvent.clear(field)
    await userEvent.type(field, 'Joe')
    expect(screen.getByText('Joe')).toBeTruthy()
  })

  it('falls back to the untitled name while the field is empty', async () => {
    open(record())
    await userEvent.clear(await screen.findByLabelText('Name'))
    expect(screen.getByText('Untitled reimbursement')).toBeTruthy()
  })
})

describe('the totals and role labels', () => {
  it('names money in the way the rest of the app does', async () => {
    // "Spent" / "Received" is the app's own pair, from the manual-entry direction selector. The earlier
    // sweep replacing "came back" was case-sensitive and missed these two.
    open(record())
    expect(await screen.findByText('Spent')).toBeTruthy()
    // Twice, and deliberately: the role on the repayment row, and the totals line beneath. Both used to
    // read "Came back" / "Come back".
    expect(screen.getAllByText('Received')).toHaveLength(2)
    expect(screen.queryByText('Paid out')).toBeNull()
    expect(screen.queryByText('Come back')).toBeNull()
    expect(screen.queryByText('Came back')).toBeNull()
  })
})


/*
 * A finished record has no pending decision, so its footer should not imply one.
 *
 * Its fields stay editable on purpose — naming is documentation rather than an accounting fact, and
 * `update_reimbursement` deliberately carries no open-record guard — so the answer is not to strip Save
 * but to show it only once there is something to save. Until then Cancel and Save would do the same
 * thing as each other.
 */
describe('the footer of a completed reimbursement', () => {
  const completed = () => record({ completed: true, residual: 0, completion: { txn_id: null } })

  it('offers one Close while nothing has been typed', async () => {
    open(completed())
    expect(await screen.findByText('Close', { selector: 'button' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
  })

  it('offers Cancel and Save once a field is edited', async () => {
    open(completed())
    await userEvent.type(await screen.findByLabelText('Name'), '!')
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy()
    expect(screen.queryByText('Close', { selector: 'button' })).toBeNull()
  })

  it('settles back to Close when the edit is undone', async () => {
    // Compared against the stored record rather than a dirty flag, so typing and undoing leaves
    // nothing to save — which is what the footer then says.
    open(completed())
    const field = await screen.findByLabelText('Name')
    await userEvent.type(field, '!')
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy()
    await userEvent.type(field, '{backspace}')
    expect(screen.getByText('Close', { selector: 'button' })).toBeTruthy()
  })

  it('leaves an open record with its full action row', async () => {
    // Save belongs there permanently: completing is a decision that may be about to be made, and Save
    // is what the dialog's accent falls on until it is. With nothing typed the left button is Close —
    // linking, removing and completing have all already acted, so Cancel would promise an undo of
    // something it cannot undo.
    open(record())
    expect(await screen.findByText('Close', { selector: 'button' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Mark complete' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
  })

  it('offers Cancel on an open record once a field is edited', async () => {
    open(record())
    await userEvent.type(await screen.findByLabelText('Name'), '!')
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy()
    expect(screen.queryByText('Close', { selector: 'button' })).toBeNull()
  })
})


/*
 * Opened from a ledger row's ↩ marker, the dialog is handed no category list.
 *
 * The marker cell holds no categories, and it once passed an empty array: the completion picker then
 * offered nothing but "New group", which read as though a group were wanted, and a leftover could not be
 * moved anywhere. Every other host passes a real list, which is why the tests above (which also do) never
 * saw it. This is the reported case in miniature: no `categories`, no `onAddCategory`.
 */
describe('completing from a host with no category list', () => {
  function openWithoutCategories(reimbursement) {
    api.getReimbursement.mockResolvedValue(reimbursement)
    return render(
      <StrictMode>
        <ReimbursementEditorDialog linkId="link-1" txnId="t1" onClose={() => {}} onSaved={() => {}} />
      </StrictMode>,
    )
  }

  it('loads the categories itself, so the leftover can be moved into a real one', async () => {
    api.getCategories.mockResolvedValue(CATEGORIES)
    txnMutations.completeReimbursement.mockResolvedValue({ ...record(), completed: true })
    openWithoutCategories(record())

    await userEvent.click(await screen.findByRole('button', { name: 'Mark complete' }))
    await userEvent.click(screen.getByRole('button', { name: /Choose category/ }))
    await userEvent.click(await screen.findByText('Movies & Events'))
    await userEvent.click(screen.getByRole('button', { name: 'Move and complete' }))

    await waitFor(() => expect(txnMutations.completeReimbursement).toHaveBeenCalledWith(
      'link-1', { category_id: 'movies', target_txn_id: 't1' },
    ))
    expect(api.getCategories).toHaveBeenCalledTimes(1)
  })

  it('does not fetch when the host already passed the list', async () => {
    open(record())
    await userEvent.click(await screen.findByRole('button', { name: 'Mark complete' }))
    expect(await screen.findByRole('button', { name: /Choose category/ })).toBeTruthy()
    expect(api.getCategories).not.toHaveBeenCalled()
  })
})


/*
 * An untracked expense opened from the report: the same editor, with nothing written until Save. Save
 * creates the record with its name and reminder in one request; linking acts at once, as it does on a
 * record, so it creates the record holding both rows.
 */
describe('a draft from an untracked expense', () => {
  const LOOSE = {
    txn_id: 't9', date: '2026-08-14', amount: 120, payee: 'Hardware Store', account_name: 'Everyday',
    receivable: 120, unclaimed: 120, parts: [],
  }
  const PAYMENT = {
    txn_id: 'r9', date: '2026-09-01', amount: -100, payee: 'From Sam', account_name: 'Everyday',
    receivable: -100, unclaimed: -100, parts: [],
  }

  function openDraft({ onClose = () => {} } = {}) {
    return render(
      <StrictMode>
        <ReimbursementEditorDialog
          untrackedRow={LOOSE}
          txnId="t9"
          categories={CATEGORIES}
          onClose={onClose}
          onSaved={() => {}}
        />
      </StrictMode>,
    )
  }

  it('closes without writing anything', async () => {
    const onClose = vi.fn()
    openDraft({ onClose })
    expect(await screen.findByText('Hardware Store')).toBeTruthy()
    await userEvent.click(screen.getByText('Close', { selector: 'button' }))
    expect(onClose).toHaveBeenCalled()
    expect(api.createReimbursement).not.toHaveBeenCalled()
    expect(api.getReimbursement).not.toHaveBeenCalled()
  })

  it('offers neither completing nor unlinking, which need a record', async () => {
    openDraft()
    expect(await screen.findByRole('button', { name: 'Save' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Mark complete' })).toBeNull()
    expect(screen.queryByRole('button', { name: /Stop tracking/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Remove this transaction/ })).toBeNull()
  })

  it('creates the record with its name and reminder on Save', async () => {
    api.createReimbursement.mockResolvedValue(record({ id: 'link-9' }))
    openDraft()
    await userEvent.type(await screen.findByLabelText('Name'), 'Work')
    await userEvent.selectOptions(screen.getByLabelText('Reminder'), 'off')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.createReimbursement).toHaveBeenCalledWith({
      claims: [{ txn_id: 't9', amount: 120, label: null }],
      counterparty: 'Work',
      remind_on: null,
      clear_reminder: true,
    }))
    expect(api.updateReimbursement).not.toHaveBeenCalled()
  })

  it('creates the record holding both rows when another is linked, without offering itself', async () => {
    api.getOutstandingReimbursements.mockResolvedValue({
      total: 20, reimbursements: [], loose: [LOOSE, PAYMENT], reminder_days: 30,
    })
    api.createReimbursement.mockResolvedValue(record({ id: 'link-9' }))
    openDraft()
    await userEvent.click(await screen.findByRole('button', { name: /Link another transaction/ }))
    expect(await screen.findByText(/From Sam/)).toBeTruthy()
    expect(screen.getAllByText(/Hardware Store/)).toHaveLength(1)
    await userEvent.click(screen.getByRole('button', { name: /This transaction/ }))
    await userEvent.click(screen.getByRole('button', { name: /Add to this reimbursement/ }))
    await waitFor(() => expect(api.createReimbursement).toHaveBeenCalledWith({
      claims: [
        { txn_id: 't9', amount: 120, label: null },
        { txn_id: 'r9', amount: -100, label: null },
      ],
    }))
    expect(api.addReimbursementClaims).not.toHaveBeenCalled()
  })
})
