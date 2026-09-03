import { describe, expect, it } from 'vitest'

import {
  UNNAMED_REIMBURSEMENT_LABEL,
  claimablePortions,
  claimRemainder,
  matchCandidates,
  reimbursementBoard,
  dropRefusal,
  claimOnRowSummary,
  reimbursementCardSummary,
  reimbursementListLabel,
  receivableActionLabel,
  isRepaymentRow,
  portionSelectionLabel,
  portionSelectionProblem,
  repaidProgressSummary,
  isSquare,
  looseReceivableSummary,
  needsTargetChoice,
  reimbursementDisplayLabel,
  reimbursementListSummary,
  hasRepayment,
  primaryAction,
  reimbursementStatus,
  residualSummary,
  completeExplanation,
  completionTargets,
} from '../reimbursements.js'

const expense = { txn_id: 'e1', role: 'expense', trashed: false, claim: 375 }
const secondExpense = { txn_id: 'e2', role: 'expense', trashed: false, claim: 100 }
const repayment = { txn_id: 'r1', role: 'repayment', trashed: false, claim: -350 }

// `owed`/`repaid` ride along because the surfaces read them too, and because a reimbursement with no
// expense recorded is a distinct state that the residual alone cannot express — with nothing owed,
// every repayment is a surplus of its whole self.
const sides = { owed: 375, repaid: -350 }
const outstanding = { ...sides, residual: 25, completed: false, members: [expense, repayment] }
const surplus = { ...sides, residual: -25, completed: false, members: [expense, repayment] }
const square = { ...sides, residual: 0, completed: false, members: [expense, repayment] }
const completed = { ...sides, residual: 0, completed: true, members: [expense, repayment] }

describe('reimbursementStatus', () => {
  it('separates the four states', () => {
    expect(reimbursementStatus(outstanding)).toBe('outstanding')
    expect(reimbursementStatus(surplus)).toBe('surplus')
    expect(reimbursementStatus(square)).toBe('square')
    expect(reimbursementStatus(completed)).toBe('completed')
    expect(reimbursementStatus(null)).toBe('none')
  })

  it('reports a completed reimbursement as complete, not merely square', () => {
    // Settling is what moved the residual out, so a settled record is square by construction. Testing
    // the number first would lose the fact that a decision was recorded.
    expect(reimbursementStatus({ residual: 0, completed: true })).toBe('completed')
  })

  it('treats a sub-cent residual as square', () => {
    expect(isSquare(0.001)).toBe(true)
    expect(isSquare(0.02)).toBe(false)
    expect(reimbursementStatus({ residual: 0.001, completed: false })).toBe('square')
  })
})

describe('residualSummary', () => {
  it('does not describe a surplus as if it were outstanding', () => {
    // The bug this pins: rendering Math.abs(residual) under one label would make these two identical
    // on screen while they settle against different transactions.
    expect(residualSummary(outstanding)).not.toEqual(residualSummary(surplus))
    expect(residualSummary(outstanding)).toMatch(/outstanding/)
    expect(residualSummary(surplus)).toMatch(/extra/)
  })

  it('distinguishes repaid-in-full from finished, because one still has an action', () => {
    // Square is not an ending: nothing needs to move, but the record still has to be closed or it sits
    // on the open list forever. That was the hole — "already square" used to be an error.
    expect(residualSummary(square)).toMatch(/ready to complete/)
    expect(residualSummary(completed)).toBe('Complete')
  })
})

describe('settleExplanation', () => {
  it('warns that settling a shortfall changes the expense month', () => {
    // The design's one surprising consequence has to be said at the point of the click.
    expect(completeExplanation(outstanding)).toMatch(/month the expense is in/)
  })

  it('says a surplus leaves the original expense alone', () => {
    expect(completeExplanation(surplus)).toMatch(/left alone/)
  })

  it('says explicitly that a repaid-in-full one moves nothing', () => {
    // Without this the Complete button reads as though it were about to move money.
    expect(completeExplanation(square)).toMatch(/nothing needs to move/)
  })

  it('offers no explanation once it is finished', () => {
    expect(completeExplanation(completed)).toBe('')
  })
})

describe('settlementCandidates', () => {
  it('offers expenses for a shortfall and repayments for a surplus', () => {
    expect(completionTargets(outstanding).map(m => m.txn_id)).toEqual(['e1'])
    expect(completionTargets(surplus).map(m => m.txn_id)).toEqual(['r1'])
  })

  it('leaves trashed members out — they are not part of the figures either', () => {
    const withTrashed = { residual: 25, completed: false, members: [expense, { ...secondExpense, trashed: true }] }
    expect(completionTargets(withTrashed).map(m => m.txn_id)).toEqual(['e1'])
  })

  it('asks the user to choose only when the role has more than one candidate', () => {
    expect(needsTargetChoice(outstanding)).toBe(false)
    expect(needsTargetChoice({ residual: 25, completed: false, members: [expense, secondExpense] })).toBe(true)
  })

  it('offers nothing for a square or settled reimbursement', () => {
    expect(completionTargets(square)).toEqual([])
    expect(completionTargets(completed)).toEqual([])
  })
})

describe('labels', () => {
  it('falls back to a generic name rather than an empty heading', () => {
    expect(reimbursementDisplayLabel({ counterparty: '  ' })).toBe(UNNAMED_REIMBURSEMENT_LABEL)
    expect(reimbursementDisplayLabel({ counterparty: 'Ticket friends' })).toBe('Ticket friends')
  })

  it('reads a loose receivable by direction, and says nothing when there is none', () => {
    expect(looseReceivableSummary(375)).toMatch(/awaiting reimbursement/)
    expect(looseReceivableSummary(-350)).toMatch(/not yet matched/)
    expect(looseReceivableSummary(0)).toBe('')
  })

  it('states what is left of the whole once part of the row is claimed', () => {
    // On its own the remainder is a number with no visible cause: a $250 deposit with $10 claimed
    // reported "$240.00 not yet matched" and nothing on the panel accounted for the missing $10.
    expect(looseReceivableSummary(-240, -250)).toBe('$240.00 of $250.00 not yet matched to a reimbursement')
    // Nothing claimed — the whole is the remainder, so saying it twice adds nothing.
    expect(looseReceivableSummary(-250, -250)).toBe('$250.00 not yet matched to a reimbursement')
  })

  it('prints a magnitude, because the words already say which way the money went', () => {
    // Asserting only the phrase is how a $350 deposit came to be announced as "-$350.00 came back". A
    // signed figure beside "awaiting reimbursement" is redundant at best and, on the other branch, a
    // contradiction.
    expect(looseReceivableSummary(375)).toBe('$375.00 awaiting reimbursement')
    expect(looseReceivableSummary(-350)).toBe('$350.00 not yet matched to a reimbursement')
  })

  it('does not claim a reimbursement for money nothing has claimed', () => {
    // This line renders only for *unclaimed* receivable money, so naming a reimbursement it "came back
    // against" described the opposite of the state it appears in.
    expect(looseReceivableSummary(-350)).not.toMatch(/against a reimbursement/)
  })
})


describe('reimbursementListLabel', () => {
  it('drops the noun inside a list that already carries it', () => {
    // A column of "Untitled reimbursement" under a heading reading REIMBURSEMENTS repeats the word on
    // every row; the standalone label keeps it, because a dialog title has nothing else to say what it
    // is showing.
    expect(reimbursementListLabel({ counterparty: '  ' })).toBe('Untitled')
    expect(reimbursementDisplayLabel({ counterparty: '  ' })).toBe(UNNAMED_REIMBURSEMENT_LABEL)
  })

  it('uses the counterparty wherever there is one', () => {
    expect(reimbursementListLabel({ counterparty: 'Ticket friends' })).toBe('Ticket friends')
  })
})

describe('reimbursementCardSummary', () => {
  const link = {
    owed: 0, repaid: -250, residual: -250, completed: false,
    members: [{ txn_id: 't1', claim: -240 }, { txn_id: 't2', claim: -10 }],
  }

  it('does not say this row\'s figure twice', () => {
    // "Unmatched $240.00 credit · claims $240.00 of this transaction" is one fact stated two ways.
    expect(reimbursementCardSummary(link, { txnId: 't1', receivable: -250 }))
      .toBe('Unmatched $240.00 credit')
  })

  it('still accounts for a shared row once there is an expense to report against', () => {
    const withExpense = { ...link, owed: 500, repaid: -250, residual: 250 }
    expect(reimbursementCardSummary(withExpense, { txnId: 't1', receivable: -250 }))
      .toBe('$250.00 outstanding · $250.00 of $500.00 repaid · claims $240.00 of this transaction')
  })
})

describe('reimbursementBoard', () => {
  const REPORT = {
    reimbursements: [{
      id: 'link-1', completed: false, residual: 25,
      members: [
        { txn_id: 'e1', date: '2026-02-14', payee: 'Concert Tix', claim: 375, trashed: false },
        { txn_id: 'r1', date: '2026-07-03', payee: 'From Joe', claim: -350, trashed: false },
        { txn_id: 'x1', date: '2026-01-01', payee: 'Removed', claim: -10, trashed: true },
      ],
    }],
    loose: [
      { txn_id: 'e9', date: '2026-09-02', payee: 'Grocery store', unclaimed: 130 },
      { txn_id: 'r9', date: '2026-09-01', payee: 'From Sam', unclaimed: -166 },
    ],
  }

  it('splits by direction rather than by whether a record exists', () => {
    // The old Tracked / Not-tracked split made a storage fact the reader's first question. Both a
    // record and a bare expense are money owed back, so both belong on the same side.
    const { expenses, income } = reimbursementBoard(REPORT)
    expect(expenses.map(entry => entry.id)).toEqual(['e9', 'link-1'])
    expect(income.map(entry => entry.id)).toEqual(['r9'])
  })

  it('dates a record by its earliest member, so it sorts where the debt started', () => {
    const record = reimbursementBoard(REPORT).expenses.find(entry => entry.kind === 'record')
    expect(record.date).toBe('2026-02-14')
  })

  it('leaves a removed member out of the nesting', () => {
    const record = reimbursementBoard(REPORT).expenses.find(entry => entry.kind === 'record')
    expect(record.members.map(member => member.txn_id)).toEqual(['e1', 'r1'])
  })

  it('is empty rather than throwing on nothing at all', () => {
    expect(reimbursementBoard(null)).toEqual({ expenses: [], income: [] })
  })
})

describe('dropRefusal', () => {
  const record = { kind: 'record', id: 'link-1', reimbursement: { members: [{ txn_id: 'r1', claim: -10 }] } }
  const expense = { kind: 'row', id: 'e9', row: { txn_id: 'e9', unclaimed: 130 } }
  const repayment = { kind: 'row', id: 'r9', row: { txn_id: 'r9', unclaimed: -166 } }
  const dragged = { txn_id: 'r9', unclaimed: -166 }

  it('accepts a payment onto an expense and onto a record', () => {
    expect(dropRefusal(expense, dragged)).toBe('')
    expect(dropRefusal(record, dragged)).toBe('')
  })

  it('refuses a same-direction pairing, which is not a pairing', () => {
    expect(dropRefusal(repayment, dragged)).toMatch(/only be matched to an expense/)
  })

  it('refuses a record that already claims the dragged row', () => {
    // One claim per transaction per record: a second would replace the first, so a drag must not do
    // silently what the click-driven list refuses to offer.
    expect(dropRefusal(record, { txn_id: 'r1', unclaimed: -240 })).toMatch(/already covers part/)
  })

  it('refuses a row with nothing left on it', () => {
    expect(dropRefusal(expense, { txn_id: 'r9', unclaimed: 0 })).toMatch(/nothing left to claim/)
  })
})

describe('matchCandidates', () => {
  const REPORT = {
    reimbursements: [
      { id: 'open', completed: false, members: [{ txn_id: 'e1', claim: 375 }] },
      { id: 'done', completed: true, members: [{ txn_id: 'e2', claim: 100 }] },
      { id: 'holds-this', completed: false, members: [{ txn_id: 'r1', claim: -10 }] },
    ],
    loose: [
      { txn_id: 'e9', payee: 'Concert Tix', unclaimed: 333 },
      { txn_id: 'r9', payee: 'A deposit', unclaimed: -166 },
      { txn_id: 'r1', payee: 'This very row', unclaimed: -240 },
      { txn_id: 'e8', payee: 'Fully claimed', unclaimed: 0 },
    ],
  }

  it('offers untracked expenses beside the records', () => {
    // The gap this closes: an expense nobody has tracked could not be chosen, so "this repays that" was
    // impossible until the expense had been made into a record by hand first.
    const { untracked } = matchCandidates(REPORT, { txnId: 'r1', amount: -240 })
    expect(untracked.map(row => row.txn_id)).toEqual(['e9'])
  })

  it('offers only the opposite side, so it never proposes a pairing the server would refuse', () => {
    const { untracked } = matchCandidates(REPORT, { txnId: 'r1', amount: -240 })
    expect(untracked.some(row => row.unclaimed < 0)).toBe(false)

    // From an expense the sides swap: every repayment with money left is a candidate, including one
    // that is already partly claimed elsewhere — what is left of it is still available.
    const fromExpense = matchCandidates(REPORT, { txnId: 'e1', amount: 375 })
    expect(fromExpense.untracked.map(row => row.txn_id)).toEqual(['r9', 'r1'])
    expect(fromExpense.untracked.every(row => row.unclaimed < 0)).toBe(true)
  })

  it('leaves out the row being matched, and rows with nothing left', () => {
    const { untracked } = matchCandidates(REPORT, { txnId: 'r1', amount: -240 })
    expect(untracked.map(row => row.txn_id)).not.toContain('r1')
    expect(untracked.map(row => row.txn_id)).not.toContain('e8')
  })

  it('excludes a record that already claims this row, which would replace rather than add', () => {
    // A reimbursement holds at most one claim per transaction, so offering it here would look like
    // accumulating and quietly overwrite the claim already standing.
    const { tracked } = matchCandidates(REPORT, { txnId: 'r1', amount: -240 })
    expect(tracked.map(item => item.id)).toEqual(['open'])
  })

  it('excludes completed records, which have no work left', () => {
    const { tracked } = matchCandidates(REPORT, { txnId: 'r9', amount: -166 })
    expect(tracked.map(item => item.id)).toEqual(['open', 'holds-this'])
  })
})

describe('receivableActionLabel', () => {
  it('names the amount where the click is the claim', () => {
    expect(receivableActionLabel({ unclaimed: 375, receivable: 375, portionCount: 1 }))
      .toBe('Expect $375.00 back')
  })

  it('offers a different act on money that came in', () => {
    // The sign is the whole rule: an expense is money to expect back, a repayment is money that repays
    // something. Offering "track this" on both is what sent a repayment into a record of its own, which
    // no expense could then ever be joined to.
    expect(receivableActionLabel({ unclaimed: -250, receivable: -250, portionCount: 1 }))
      .toBe('Match $250.00 to an expense')
    expect(isRepaymentRow(-250)).toBe(true)
    expect(isRepaymentRow(375)).toBe(false)
  })

  it('says "remaining" only where part of the row is already claimed', () => {
    // With nothing claimed the remainder is simply the whole receivable, and the word is noise.
    expect(receivableActionLabel({ unclaimed: -240, receivable: -250, portionCount: 1 }))
      .toBe('Match remaining $240.00 to an expense')
    expect(receivableActionLabel({ unclaimed: 240, receivable: 250, portionCount: 1 }))
      .toBe('Expect remaining $240.00 back')
  })

  it('promises no amount where the click only opens a chooser', () => {
    // With several portions the button does not claim anything — naming a figure would be a promise it
    // does not keep.
    expect(receivableActionLabel({ unclaimed: 500, receivable: 500, portionCount: 2 }))
      .toBe('Expect money back…')
    expect(receivableActionLabel({ unclaimed: -500, receivable: -500, portionCount: 2 }))
      .toBe('Match to an expense…')
  })
})

describe('claimOnRowSummary', () => {
  const link = { members: [{ txn_id: 't1', claim: -10 }, { txn_id: 'e1', claim: 250 }] }

  it('accounts for a shared row, which is where the arithmetic goes unexplained', () => {
    expect(claimOnRowSummary(link, 't1', -250)).toBe('claims $10.00 of this transaction')
  })

  it('says nothing where the reimbursement covers the whole row', () => {
    // It would only restate the figure beside it.
    expect(claimOnRowSummary(link, 't1', -10)).toBe('')
  })

  it('says nothing for a row this reimbursement has no claim on', () => {
    expect(claimOnRowSummary(link, 'other', -250)).toBe('')
  })
})

describe('claimRemainder', () => {
  const parts = [{ amount: 250, label: "Dana's ticket" }, { amount: 250, label: "Rowan's ticket" }]

  it('is offered only where no combination of portions already names it', () => {
    // With nothing claimed, selecting every portion *is* the remainder, so a separate option would be a
    // second button for the same money — and with $250 left, one portion carries that figure already.
    expect(claimRemainder({ unclaimed: 500, parts })).toBeNull()
    expect(claimRemainder({ unclaimed: 250, parts })).toBeNull()
    // $200 is expressible by neither portion nor by both, so it needs an option of its own.
    expect(claimRemainder({ unclaimed: 200, parts })).toBe(200)
  })

  it('is not offered where a single portion already names that amount', () => {
    // A $250 row divided $10/$240 with $240 claimed leaves $10 — the same figure "Part i" already
    // carries, so offering both is the same money twice under two names.
    expect(claimRemainder({ unclaimed: -10, parts: [
      { amount: -10, label: 'Part i' }, { amount: -240, label: 'part 2' },
    ] })).toBeNull()
  })

  it('is not offered where there is nothing to disambiguate', () => {
    expect(claimRemainder({ unclaimed: 375, parts: [{ amount: 375, label: 'Tickets' }] })).toBeNull()
    expect(claimRemainder({ unclaimed: 0, parts })).toBeNull()
  })
})

describe('portionSelectionProblem', () => {
  it('accepts a selection that fits inside what is unclaimed', () => {
    expect(portionSelectionProblem([250, 240], 500)).toBe('')
  })

  it('refuses more than the row has left, rather than letting the server say so', () => {
    // The picker knows the limit, so submitting into a rejection would be a round trip to learn
    // something already on screen.
    expect(portionSelectionProblem([250, 250], 240)).toMatch(/Only \$240\.00/)
  })

  it('states the budget rather than an error before anything is chosen', () => {
    // The starting state is not a fault, and it is the moment the reader most needs to know what there
    // is to claim — the limit used to appear only once it had already been exceeded. The budget alone:
    // telling the reader to choose restates the question the picker's heading already asks.
    expect(portionSelectionProblem([], 500)).toBe('$500.00 available')
  })

  it('accounts for the limit instead of merely stating it', () => {
    // "Only $240.00 is unclaimed" on a $250 transaction reads as being about some other figure. Naming
    // the selection and the standing claim is what makes the number account for itself.
    expect(portionSelectionProblem([-10, -240], -240, -250))
      .toBe('That is $250.00. $10.00 of this transaction is already claimed, so $240.00 is available.')
  })

  it('judges a repayment by size, not by sign', () => {
    // Money in is stored negative; a deposit's portions must not read as "more than unclaimed" merely
    // for being below zero.
    expect(portionSelectionProblem([-10, -240], -250)).toBe('')
    expect(portionSelectionProblem([-250], -240)).toMatch(/Only \$240\.00/)
  })
})

describe('portionSelectionLabel', () => {
  it('names the chosen portions together, since they become one claim', () => {
    expect(portionSelectionLabel([{ label: 'Part i' }, { label: 'part 2' }])).toBe('Part i + part 2')
  })

  it('stays unnamed where the portions were', () => {
    expect(portionSelectionLabel([{ label: null }, { label: null }])).toBeNull()
    expect(portionSelectionLabel([])).toBeNull()
  })
})

describe('repaidProgressSummary', () => {
  it('reports progress against what is owed', () => {
    expect(repaidProgressSummary({ owed: 750, repaid: -250 })).toBe('$250.00 of $750.00 repaid')
  })

  it('says nothing while no expense is recorded', () => {
    // "$10.00 back of $0.00" is arithmetically true and tells the reader nothing; the headline names
    // that state instead.
    expect(repaidProgressSummary({ owed: 0, repaid: -10 })).toBe('')
  })
})

describe('the state before any expense is recorded', () => {
  const repaymentOnly = { owed: 0, repaid: -10, residual: -10, completed: false }

  it('is named rather than reported as an overpayment', () => {
    // A repayment entered before its expense makes every penny a surplus by arithmetic. Called "extra"
    // it reads as an error on a reimbursement whose only entry is that repayment.
    expect(residualSummary(repaymentOnly)).toBe('Unmatched $10.00 credit')
  })

  it('names the row in front of the reader where a surface describes one', () => {
    // A reimbursement spanning several rows has a total of its own, but a card inside one
    // transaction's panel is talking about that transaction's portion of it.
    expect(residualSummary({ ...repaymentOnly, repaid: -250 }, { creditAmount: -240 }))
      .toBe('Unmatched $240.00 credit')
  })

  it('still reads as a surplus once there is an expense to exceed', () => {
    expect(residualSummary({ owed: 240, repaid: -250, residual: -10, completed: false }))
      .toBe('$10.00 extra')
  })
})

describe('claimablePortions', () => {
  const portions = { unclaimed: 500, parts: [
    { amount: 250, label: "Dana's ticket" },
    { amount: 250, label: "Rowan's ticket" },
  ] }

  it('offers a divided row one entry per portion, so picking one says whose money it is', () => {
    // The reading this feature had to be corrected out of was the summed figure, which described the
    // model rather than the money and made a two-friend charge look like one debt.
    expect(claimablePortions(portions)).toEqual([
      { amount: 250, label: "Dana's ticket" },
      { amount: 250, label: "Rowan's ticket" },
    ])
  })

  it('asks nothing of an ordinary single-portion row', () => {
    expect(claimablePortions({ unclaimed: 375, parts: [{ amount: 375, label: 'Tickets' }] }))
      .toEqual([{ amount: 375, label: null }])
    expect(claimablePortions({ unclaimed: 375, parts: [] })).toEqual([{ amount: 375, label: null }])
  })

  it('lists the portions themselves and nothing else', () => {
    // The remainder used to be appended here, which put an unnamed entry of the same value directly
    // beneath a named portion — "The rest of it · $240.00" under "part 2 · $240.00". It is a different
    // kind of answer and now has its own helper.
    const partly = claimablePortions({ unclaimed: 250, parts: portions.parts })
    expect(partly).toEqual(portions.parts)
  })

  it('offers nothing when the row is fully claimed', () => {
    expect(claimablePortions({ unclaimed: 0, parts: portions.parts })).toEqual([])
  })
})

describe('reimbursementListSummary', () => {
  it('says a row is in several rather than naming one and hiding the rest', () => {
    const summary = reimbursementListSummary([outstanding, completed])
    expect(summary).toMatch(/2 reimbursements/)
    expect(summary).toMatch(/1 still to resolve/)
  })

  it('counts a repaid-in-full one as still to resolve, since completing it is real work', () => {
    expect(reimbursementListSummary([square, completed])).toMatch(/1 still to resolve/)
  })

  it('reads a single reimbursement exactly as the one-line summary does', () => {
    expect(reimbursementListSummary([outstanding])).toBe(residualSummary(outstanding))
  })

  it('says nothing for a row in none', () => {
    expect(reimbursementListSummary([])).toBe('')
  })
})

describe('hasRepayment', () => {
  it('is false when nothing has come back yet', () => {
    expect(hasRepayment({ members: [expense] })).toBe(false)
    expect(hasRepayment({ members: [expense, repayment] })).toBe(true)
  })

  it('ignores a trashed repayment, which is money not in the ledger', () => {
    expect(hasRepayment({ members: [expense, { ...repayment, trashed: true }] })).toBe(false)
  })
})

describe('primaryAction', () => {
  it('makes Complete the main verb only when the two sides balance', () => {
    // Balanced is the one case with nothing to decide and nothing to move. Everywhere else the loud
    // button must not be the one that closes a record with money still unaccounted for.
    expect(primaryAction(square)).toBe('complete')
    expect(primaryAction(outstanding)).toBe('save')
    expect(primaryAction(surplus)).toBe('save')
  })

  it('does not promote Complete on a balance of zero that nothing was ever repaid against', () => {
    // Vacuously square — no expense, no repayment — is not an ending worth featuring.
    expect(primaryAction({ residual: 0, completed: false, members: [expense] })).toBe('save')
  })

  it('leaves Save primary once it is finished', () => {
    expect(primaryAction(completed)).toBe('save')
  })
})
