// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * Reimbursable expenses — the presentation rules the reimbursement surfaces portion.
 *
 * The detail panel's summary, the editor dialog and (later) the ledger row's marker all have to read
 * one record the same way: who owes it, how much is still outstanding, and what settling it would do.
 * Keeping those decisions here rather than in each component is what stops three components drifting
 * into three readings of one record — the same reason `purchaseLinks.js` exists.
 *
 * **A reimbursement covers a *portion* of a transaction, not the transaction.** One $750 charge split
 * between two friends is two debts, and one ATM deposit can repay both at once — so a row may appear in
 * several reimbursements and the surfaces have to render a list rather than pick one. What is left over
 * on a row after every claim is *unclaimed*, which is what the picker offers.
 *
 * **The residual's sign carries the meaning, and it is not the same meaning in both directions.** A
 * positive residual is money still owed (or a shortfall the buyer absorbed); a negative one is a
 * surplus that came back. They settle against different transactions, so a surface that rendered
 * `Math.abs(residual)` with one label would be describing two different situations identically. Every
 * helper here branches on the sign and says which case it is.
 *
 * **The sentences then print magnitudes, not signed amounts.** Once the words name the direction —
 * "outstanding", "extra", "awaiting reimbursement" — a signed figure beside them is at best redundant
 * and at worst a contradiction: `-$375.00 still outstanding` reads as a double negative, and taken
 * literally asserts an over-repayment of $375. The sign lives in the branch, the magnitude in the
 * number. This is not the rule for a ledger amount or a chart value, where nothing else states the
 * direction and the true signed figure has to show.
 */

import { formatMoneyMagnitude, formatTransactionAmount } from './moneyDisplay.js'

// What a reimbursement with no counterparty is called. Naming is optional on purpose: an expense is
// worth tracking as reimbursable before it is worth saying who owes it.
// Deliberately **not** "Reimbursable", which is the name of the holding category group: a confirm
// reading "Stop tracking Reimbursable?" was taken as an offer to remove the category rather than to
// ungroup two transactions. A fallback name must not collide with a real object's name.
export const UNNAMED_REIMBURSEMENT_LABEL = 'Untitled reimbursement'

export function reimbursementDisplayLabel(reimbursement) {
  return (reimbursement?.counterparty || '').trim() || UNNAMED_REIMBURSEMENT_LABEL
}

// The same name inside a list that is *already* headed "Reimbursements" — the panel's section, the
// report's Tracked list. There the noun is redundant on every row, and repeating it turns a list of
// records into a column of the same word. Standalone uses keep the full label: the editor dialog's own
// title has nothing else to say what it is editing, and "Untitled" alone would name nothing.
export const UNNAMED_REIMBURSEMENT_LIST_LABEL = 'Untitled'

export function reimbursementListLabel(reimbursement) {
  return (reimbursement?.counterparty || '').trim() || UNNAMED_REIMBURSEMENT_LIST_LABEL
}

export function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100
}

// Cent tolerance, matching the backend's. A residual that survived a JSON round-trip should not read as
// outstanding because it came back as 0.000000001.
const CENT = 0.005

export function isSquare(residual) {
  return Math.abs(Number(residual) || 0) < CENT
}

/*
 * What state a reimbursement is in, as one word the surfaces switch on.
 *
 * `completed` is checked before the residual, because a completed reimbursement is usually square *by
 * construction* — completing is what moved any residual out — so testing the number first would report
 * a finished one as merely "square" and lose that a decision was recorded. `square` is therefore
 * "repaid in full and not yet finished": a state with an action attached rather than an ending.
 */
export function reimbursementStatus(reimbursement) {
  if (!reimbursement) return 'none'
  if (reimbursement.completed) return 'completed'
  if (isSquare(reimbursement.residual)) return 'square'
  return reimbursement.residual > 0 ? 'outstanding' : 'surplus'
}

/*
 * The one-line reading of where a reimbursement stands. Written so the *number on screen* and the
 * sentence agree: an outstanding reimbursement names what is still owed, a surplus names what came back
 * over, and neither is described as the other with the sign stripped off.
 */
export function residualSummary(reimbursement, { creditAmount = null } = {}) {
  const status = reimbursementStatus(reimbursement)
  const residual = Math.abs(round2(reimbursement?.residual))
  // What the credit reading below names. A surface describing one *row* passes that row's claim, since
  // that is the money it is talking about; one describing the whole record passes nothing and gets the
  // record's own total. Same sentence either way, each naming what is in front of the reader.
  const credit = Math.abs(round2(creditAmount) || round2(reimbursement?.repaid))
  switch (status) {
    case 'completed':
      return 'Complete'
    case 'square':
      return 'Fully repaid — ready to complete'
    case 'surplus':
      // A repayment recorded before the expense is a normal waypoint, not an overpayment, but the
      // arithmetic cannot tell them apart: with nothing owed, every repayment is a surplus of its whole
      // self. Reported as a surplus it read as an error ("$10.00 extra" on a reimbursement whose only
      // entry *is* that $10). Named separately here rather than in `reimbursementStatus`, because the
      // state genuinely is a surplus for every other purpose — completing it settles the same way.
      return hasOwedSide(reimbursement)
        ? `${formatMoneyMagnitude(residual)} extra`
        : `Unmatched ${formatMoneyMagnitude(credit)} credit`
    case 'outstanding':
      return `${formatMoneyMagnitude(residual)} outstanding`
    default:
      return ''
  }
}

/** Whether an expense has been recorded against this reimbursement at all. */
export function hasOwedSide(reimbursement) {
  return Math.abs(round2(reimbursement?.owed)) >= CENT
}

/*
 * The progress line under the headline: what has come back, against what is owed.
 *
 * Says nothing while no expense is recorded — "$10.00 back of $0.00" is arithmetically true and tells
 * the reader nothing, and the headline already names that state.
 */
export function repaidProgressSummary(reimbursement) {
  if (!hasOwedSide(reimbursement)) return ''
  const repaid = formatMoneyMagnitude(Math.abs(round2(reimbursement?.repaid)))
  const owed = formatMoneyMagnitude(Math.abs(round2(reimbursement?.owed)))
  return `${repaid} of ${owed} repaid`
}

/*
 * What settling would do, in the user's terms, before they do it.
 *
 * This is the sentence that has to carry the design's one surprising consequence: settling a shortfall
 * **changes an earlier period on purpose**, because the money was genuinely spent then. Saying so at
 * the point of the click is the difference between a deliberate correction and a number that moved for
 * no visible reason next time the user looks at February.
 */
export function completeExplanation(reimbursement) {
  const status = reimbursementStatus(reimbursement)
  if (status === 'square') {
    // Nothing to decide: the two sides already cancel inside the excluded group. Saying so is what
    // stops "Complete" reading as though it were about to move money.
    return 'The repayments match what was owed, so nothing needs to move. Completing takes it off the '
      + 'list of reimbursements still to resolve.'
  }
  if (status === 'outstanding') {
    // Nothing repaid at all is the same arithmetic as a shortfall, but a much larger claim: it is not
    // "the rest", it is the whole thing, and saying "the rest" of an amount nobody paid back would
    // understate what the click does.
    if (!hasRepayment(reimbursement)) {
      return `Nothing has been received against this. Completing records the whole `
        + `${formatTransactionAmount(round2(reimbursement.residual))} as spending, in the month of the `
        + 'expense, under the category chosen below.'
    }
    return 'The rest was a real cost. Completing moves it onto the expense, which updates the month the '
      + 'expense is in — that is what makes it read correctly.'
  }
  if (status === 'surplus') {
    return 'More was received than went out. Settling books the difference against the repayment, in the '
      + 'month it arrived — the original expense is left alone.'
  }
  return ''
}

/*
 * Which member a residual would settle against. The sign decides the role, so the caller never offers
 * that as a choice — only *which* transaction, and only when the role has more than one candidate,
 * because nothing in the ledger can say which expense fell short.
 */
export function completionTargets(reimbursement) {
  const status = reimbursementStatus(reimbursement)
  if (status !== 'outstanding' && status !== 'surplus') return []
  const wanted = status === 'outstanding' ? 'expense' : 'repayment'
  return (reimbursement?.members || []).filter(member => !member.trashed && member.role === wanted)
}

export function needsTargetChoice(reimbursement) {
  return completionTargets(reimbursement).length > 1
}

/*
 * The panel's reading of receivable money on a row that no reimbursement has claimed yet. Not an error
 * state and not a nag: it is where every reimbursable starts, between the purchase and the repayment,
 * so it is phrased as something available rather than something wrong.
 */
export function looseReceivableSummary(unclaimed, receivable = 0) {
  const amount = round2(unclaimed)
  if (!amount) return ''
  // The branch names the direction, so the figure is a magnitude — see the module docstring.
  //
  // The second branch says *unmatched* rather than "came back against a reimbursement": this line only
  // ever renders for money no reimbursement has claimed, so naming one described the opposite of the
  // state it appears in.
  //
  // Where part of the row is already claimed, the figure is stated **of the whole**. On its own it is a
  // number with no visible cause: a $250 deposit with $10 claimed reports "$240.00 not yet matched",
  // and nothing on the panel accounts for the missing $10 — which is exactly how it read in use.
  const whole = round2(receivable)
  const scope = whole && Math.abs(whole - amount) >= CENT
    ? `${formatMoneyMagnitude(Math.abs(amount))} of ${formatMoneyMagnitude(Math.abs(whole))}`
    : formatMoneyMagnitude(Math.abs(amount))
  return amount > 0
    ? `${scope} awaiting reimbursement`
    : `${scope} not yet matched to a reimbursement`
}

/*
 * What one reimbursement claims of *this* row, for a panel listing several against it.
 *
 * Said only where the row is shared — a reimbursement claiming the whole thing would be restating the
 * figure beside it. Where it is shared this is the sentence that accounts for the difference between a
 * row's receivable and what the picker says is left, which was otherwise unexplained on screen.
 */
export function claimOnRow(reimbursement, txnId) {
  const member = (reimbursement?.members || []).find(entry => entry?.txn_id === txnId)
  return round2(member?.claim)
}

export function claimOnRowSummary(reimbursement, txnId, receivable) {
  const claim = claimOnRow(reimbursement, txnId)
  if (!claim) return ''
  const whole = round2(receivable)
  if (!whole || Math.abs(whole - claim) < CENT) return ''
  return `claims ${formatMoneyMagnitude(Math.abs(claim))} of this transaction`
}

/*
 * The label on a row's primary reimbursable action — which is a *different action* on each side.
 *
 * **The sign decides it**, the same fact roles are derived from. Money out is an expense: the thing to
 * do with it is say it is coming back, which needs no counterpart to exist yet. Money in is a
 * repayment: the thing to do with it is say what it repays. Offering "track this" on both is what sent
 * a repayment into a record of its own, where it sat as an unmatched credit that no expense could ever
 * be joined to — a claim belongs to one record, so tracking both sides separately spends each one's
 * money and leaves nothing to link them with.
 *
 * With one portion the click *is* the claim, so the button names the amount — which lets the line above
 * it go rather than state the same figure twice. With several the click only opens a chooser, so naming
 * an amount there would promise something the button does not do. "Remaining" appears only where part
 * of the row is already claimed; otherwise it is the whole receivable and the word is noise.
 */
export function receivableActionLabel({ unclaimed, receivable, portionCount } = {}) {
  const amount = round2(unclaimed)
  const repayment = amount < 0
  if (portionCount > 1) return repayment ? 'Match to an expense…' : 'Expect money back…'
  if (!amount) return repayment ? 'Match this to an expense' : 'Expect this back'
  const whole = round2(receivable)
  const partly = whole && Math.abs(whole - amount) >= CENT
  const figure = formatMoneyMagnitude(Math.abs(amount))
  return repayment
    ? `Match ${partly ? 'remaining ' : ''}${figure} to an expense`
    : `Expect ${partly ? 'remaining ' : ''}${figure} back`
}

/** Which side of a reimbursement this row's unclaimed money is: money in repays, money out is owed. */
export function isRepaymentRow(unclaimed) {
  return round2(unclaimed) < 0
}


/*
 * The outstanding report as two columns: what is owed back, and the money in that has not been claimed.
 *
 * **The tracked / not-tracked split is gone from the layout**, deliberately. Whether a row happens to
 * carry a reimbursement record is a fact about storage, not about the money, and making the reader sort
 * it out first was the source of most of the confusion this feature produced: *is it tracked, does it
 * need to be, why can't I link it.* Left is everything owed back — records and untracked expenses
 * together, newest first; right is money in that nothing has claimed. A record simply shows its members
 * nested beneath it, so "tracked" reads as *has something under it* rather than as a category to think
 * about.
 *
 * **Nested under the record, not under an expense.** A reimbursement may hold several expenses (which is
 * why settling has to ask which one a shortfall lands on) and one payment may be split across two
 * records. A strict expense→payments tree would misstate both; nesting under the record looks identical
 * in the ordinary one-expense case and stays true in the others, each nesting showing *that record's*
 * claim rather than the transaction's whole amount.
 *
 * A record whose only member is a repayment sits on the left with everything else: it is a record, and
 * what it is waiting for is an expense.
 */
export function reimbursementBoard(report, { ownerId = null, dueOnly = false, today } = {}) {
  const reminderDays = report?.reminder_days || 0
  const records = (report?.reimbursements || []).map(item => {
    const members = (item?.members || []).filter(member => !member?.trashed)
    const dates = members.map(member => member?.date).filter(Boolean).sort()
    return {
      kind: 'record',
      id: item.id,
      date: dates[0] || '',
      reimbursement: item,
      members,
      // Whose it is: the owners of the **expense** side, since the question a reminder asks is who is
      // owed. A repayment landing on someone else's account does not make the debt theirs.
      owners: ownersOf(members.filter(member => round2(member.claim) > 0)),
      dueOn: recordDueDate(item, reminderDays),
    }
  })
  const loose = (report?.loose || []).map(row => ({
    kind: 'row',
    id: row.txn_id,
    date: row.date || '',
    row,
    owners: ownersOf([row]),
    dueOn: looseDueDate(row, reminderDays),
  }))
  const owed = loose.filter(entry => round2(entry.row.unclaimed) > 0)
  const paid = loose.filter(entry => round2(entry.row.unclaimed) < 0)
  const keep = entry => matchesOwner(entry, ownerId) && (!dueOnly || isDue(entry.dueOn, today))
  return {
    // The right-hand pile is money *in*, which is never due and belongs to nobody in particular for the
    // purpose of chasing — narrowing it by the task's owner would hide the very repayments that could
    // settle what the task is about.
    expenses: byDateDescending([...records, ...owed].filter(keep)),
    income: byDateDescending(paid),
  }
}

// How many entries the report dialog lists, both columns, unfiltered. Counted off the board rather than
// the raw report so the figure on the button is the number of rows the dialog opens to.
export function reimbursementListedCount(report) {
  const board = reimbursementBoard(report)
  return board.expenses.length + board.income.length
}

/*
 * An untracked expense as the record that saving it in the editor would create, so the editor can
 * show a loose row with the same layout as a tracked one before anything is written.
 *
 * It claims the row's whole unclaimed amount, as a board drop onto the row does. With one expense and
 * nothing repaid, the figures the server would compute are just that amount, so nothing here is a
 * second copy of `_summarize`'s arithmetic.
 */
export function draftReimbursement(row) {
  const claim = round2(row?.unclaimed)
  return {
    id: null,
    counterparty: '',
    owed: claim,
    repaid: 0,
    residual: claim,
    completion: null,
    completed: false,
    remind_on: null,
    expense_date: row?.date || null,
    members: [{
      txn_id: row?.txn_id,
      date: row?.date,
      amount: row?.amount,
      payee: row?.payee,
      account_name: row?.account_name,
      trashed: false,
      claim,
      claim_label: null,
      receivable: row?.receivable,
      role: 'expense',
    }],
  }
}

function ownersOf(rows) {
  const seen = []
  for (const row of rows || []) {
    const id = row?.owner_id || UNASSIGNED_OWNER
    if (!seen.some(owner => owner.id === id)) {
      seen.push({ id, name: row?.owner_name || 'Unassigned', color: row?.owner_color || null })
    }
  }
  return seen
}

// `unassigned` rather than a null id, matching the token the transaction list's own owner facet uses —
// which is what lets a task deep-link to exactly the rows it counted.
export const UNASSIGNED_OWNER = 'unassigned'

function matchesOwner(entry, ownerId) {
  if (!ownerId) return true
  return (entry.owners || []).some(owner => owner.id === ownerId)
}

// Newest first, with the id as the tiebreak so the order is stable across reloads rather than following
// whatever order the two piles happened to arrive in.
function byDateDescending(entries) {
  return [...entries].sort((a, b) => (b.date || '').localeCompare(a.date || '')
    || String(a.id).localeCompare(String(b.id)))
}

/*
 * Whether a repayment row can be dropped on a board entry, and why not when it cannot.
 *
 * The same two rules the click-driven picker applies (`matchCandidates`), stated once so a drag cannot
 * quietly do what the list would have refused: a record already claiming the row would have its claim
 * **replaced** rather than added to, and a same-direction pairing is not a pairing at all.
 */
export function dropRefusal(entry, row) {
  const amount = round2(row?.unclaimed)
  if (!amount) return 'There is nothing left to claim on that row.'
  if (entry?.kind === 'row') {
    const target = round2(entry.row?.unclaimed)
    if (!target || (target < 0) === (amount < 0)) {
      return 'A repayment can only be matched to an expense.'
    }
    return ''
  }
  if (entry?.kind === 'record') {
    if (claimOnRow(entry.reimbursement, row?.txn_id)) {
      return 'That reimbursement already covers part of this transaction — open it to change the amount.'
    }
    return ''
  }
  return 'That cannot be matched here.'
}

/*
 * What a row could be paired with: both piles, not just the tracked one, and in **both directions**.
 *
 * The first cut of the sign-driven action offered only existing records, which left the common case
 * unreachable — an expense nobody has tracked yet cannot be chosen, so "this repays that" was impossible
 * until the expense had been made into a record by hand first. Money going out and money coming back are
 * both just receivable rows; which of them happens to have a record attached is not something the person
 * matching them should have to think about.
 *
 * **It answers for an expense as well as for a repayment.** Starting from a repayment offers the
 * expenses it could repay; starting from an expense offers the repayments already sitting in the ledger
 * waiting to be matched. The temporal norm is money out first and back later, so an expense usually has
 * nothing to offer and the caller falls through to plain tracking — but the case where a credit cleared
 * before its receipt was entered is real, and the asymmetry made it reachable only from the credit's
 * side. The sign still decides the *wording*; it no longer decides whether the question is asked.
 *
 * **Opposite sign only.** A repayment repays expenses; an expense is repaid by repayments. Same-sign
 * rows are not candidates, so the list never offers a pairing the server would refuse.
 *
 * **Records already claiming this row are excluded** from `tracked`. A reimbursement holds at most one
 * claim per transaction, so adding a second portion of the same row to the same record *replaces* the
 * first rather than adding to it — offering it here would look like accumulating and quietly overwrite.
 * Changing an existing claim is the editor's job.
 */
export function matchCandidates(report, { txnId, amount } = {}) {
  const claimSign = round2(amount) < 0 ? -1 : 1
  const tracked = (report?.reimbursements || []).filter(
    item => !item.completed && !claimOnRow(item, txnId),
  )
  const untracked = (report?.loose || []).filter(row => {
    if (row?.txn_id === txnId) return false
    const remaining = round2(row?.unclaimed)
    if (Math.abs(remaining) < CENT) return false
    return (remaining < 0 ? -1 : 1) !== claimSign
  })
  return { tracked, untracked }
}

/*
 * The question the match picker asks, which is not the same question in both directions.
 *
 * A repayment asks what it repays; an expense asks what repaid it. Rendering one sentence for both — or
 * the repayment's sentence with the amount swapped — would describe an expense as though it were money
 * coming back, which is the reading this feature has had to be corrected out of more than once.
 */
export function matchPrompt({ repayment, amountLabel } = {}) {
  if (repayment) return amountLabel ? `What does ${amountLabel} repay?` : 'What does this repay?'
  return amountLabel ? `What repaid ${amountLabel}?` : 'What repaid this?'
}

/** The quieter fallback beside the candidates, phrased for the side it is offered on. */
export function matchAloneHint({ repayment, empty } = {}) {
  if (empty) {
    return repayment
      ? 'Nothing is waiting to be repaid yet.'
      : 'Nothing has come back yet that could be matched to this.'
  }
  return repayment
    ? 'Or record it on its own until the expense is entered.'
    : 'Or just expect it back, and match the repayment when it arrives.'
}

/*
 * The whole second line of a reimbursement's card in a transaction's panel, composed once.
 *
 * Three readings that must not repeat each other: where the record stands, how far it has been repaid,
 * and what it claims of *this* row. The claim clause is dropped where the headline is the credit
 * reading, because that already names this row's figure — "Unmatched $240.00 credit · claims $240.00 of
 * this transaction" says one thing twice.
 */
export function reimbursementCardSummary(reimbursement, { txnId, receivable } = {}) {
  const claim = claimOnRow(reimbursement, txnId)
  return [
    residualSummary(reimbursement, { creditAmount: claim }),
    repaidProgressSummary(reimbursement),
    hasOwedSide(reimbursement) ? claimOnRowSummary(reimbursement, txnId, receivable) : '',
  ].filter(Boolean).join(' · ')
}

/*
 * The portions of a row a new reimbursement could claim, as the picker lists them.
 *
 * A row divided between two people offers two, and picking one is how the user says *whose* money this
 * is — the reading this feature had to be corrected out of was the summed figure, which described the
 * model rather than the money. A row with one portion (or none recorded) offers just the remaining
 * amount, so the ordinary case asks no question at all.
 */
export function claimablePortions({ parts, unclaimed } = {}) {
  const remaining = round2(unclaimed)
  if (!remaining) return []
  const portions = (parts || [])
    .map(part => ({ amount: round2(part.amount), label: part.label || null }))
    .filter(part => Math.abs(part.amount) >= CENT)
  // A row with one recorded portion, or none, is not a choice: it offers whatever is left, so the
  // ordinary case asks no question at all.
  if (portions.length <= 1) return [{ amount: remaining, label: null }]
  return portions
}

/*
 * The "everything still unclaimed" option, or null where choosing the portions themselves already says it.
 *
 * Claims are stored per transaction as an **amount** — never as a set of parts, since `save_split`
 * rewrites part rows wholesale — so once some of a row is claimed, its named portions no longer describe
 * what remains. A $250 deposit divided $10/$240 with $10 already claimed still lists both portions while
 * only $240 is available: every subset is still a legal claim, but none of them is *the remainder* by
 * name. This is that option, and it is offered only when the portions cannot express it — otherwise it
 * would sit beside a portion of identical value, which is how "The rest of it · $240.00" came to appear
 * directly beneath "part 2 · $240.00".
 */
export function claimRemainder({ parts, unclaimed } = {}) {
  const remaining = round2(unclaimed)
  const portions = claimablePortions({ parts, unclaimed })
  if (!remaining || portions.length <= 1) return null
  const covered = round2(portions.reduce((sum, part) => sum + part.amount, 0))
  if (covered === remaining) return null
  // It also says nothing new when it lands on a single portion's value — "Part i · $10.00" with
  // "Everything not yet claimed · $10.00" directly beneath it is the same money offered twice, which is
  // the redundancy this helper exists to remove.
  if (portions.some(portion => Math.abs(portion.amount - remaining) < CENT)) return null
  return remaining
}

/*
 * Why a chosen set of portions cannot stand as one claim, or '' when it can.
 *
 * A reimbursement holds at most one claim per transaction, so choosing several portions of a row means
 * one claim for their sum rather than several — which is also why the total has to be checked here: the
 * server refuses a claim larger than what is unclaimed, and finding that out on submit would be a
 * rejection for a limit the picker knew about all along.
 */
export function portionSelectionProblem(selectedAmounts, unclaimed, receivable = 0) {
  const total = round2((selectedAmounts || []).reduce((sum, amount) => sum + round2(amount), 0))
  const remaining = round2(unclaimed)
  const available = formatMoneyMagnitude(Math.abs(remaining))
  // The budget alone. Telling the reader to choose something restates the question the picker's own
  // heading is already asking.
  if (Math.abs(total) < CENT) return `${available} available`
  if (Math.abs(total) - Math.abs(remaining) > CENT) {
    // Stating the limit alone left the reader to work out where it came from, and on the row this was
    // reported from there was nothing on screen to work it out *from*: "Only $240.00 is unclaimed" on a
    // $250 transaction reads as being about some other figure entirely. Naming the selection and the
    // standing claim is what closes that.
    const claimed = round2(receivable) ? round2(round2(receivable) - remaining) : 0
    const asked = `That is ${formatMoneyMagnitude(Math.abs(total))}.`
    return claimed
      ? `${asked} ${formatMoneyMagnitude(Math.abs(claimed))} of this transaction is already claimed, `
        + `so ${available} is available.`
      : `${asked} Only ${available} of this transaction is unclaimed.`
  }
  return ''
}

/** The label a multi-portion claim carries: the chosen portions' own names, or none where they had none. */
export function portionSelectionLabel(portions) {
  const labels = (portions || []).map(portion => portion?.label).filter(Boolean)
  return labels.length ? labels.join(' + ') : null
}

/*
 * How a row's reimbursements read on a surface with room for one line. A row in two of them says so
 * rather than naming one and hiding the other, which is the failure the portion model exists to prevent.
 */
export function reimbursementListSummary(reimbursements) {
  const list = reimbursements || []
  if (!list.length) return ''
  if (list.length === 1) return residualSummary(list[0])
  const open = list.filter(item => reimbursementStatus(item) !== 'completed').length
  return open
    ? `${list.length} reimbursements · ${open} still to resolve`
    : `${list.length} reimbursements · all complete`
}

/*
 * The row marker's tooltip: the whole of what this feature tells a ledger row. Built from ordered parts
 * so one with no counterparty simply says less rather than saying "owed by  ".
 */
export function reimbursementMarkerTooltip(reimbursement) {
  if (!reimbursement) return ''
  const parts = []
  if ((reimbursement.counterparty || '').trim()) parts.push(reimbursement.counterparty.trim())
  if (reimbursement.claim_label) parts.push(reimbursement.claim_label)
  parts.push(residualSummary(reimbursement))
  return parts.join(' · ')
}

/*
 * Whether anything has actually come back yet.
 *
 * A reimbursement with an expense and no repayment linked can still be completed — that is the "nobody
 * ever paid me" write-off, and the residual settles onto the expense as a real cost. But it is far more
 * often a reimbursement that is simply *not finished yet*, where the repayment has arrived in the ledger
 * and has not been linked, or has not arrived at all. So the action stays visible and is held
 * unavailable with its reason, rather than being offered as an equal choice next to Save.
 */
export function hasRepayment(reimbursement) {
  return (reimbursement?.members || []).some(member => !member.trashed && member.role === 'repayment')
}

/*
 * Which of Complete and Save is the surface's main verb.
 *
 * Completing is the primary action exactly when it is the obviously right one: the two sides balance,
 * so there is nothing to decide and nothing to move. Anywhere else — a shortfall, a surplus, nothing
 * repaid yet — finishing is a judgement the user may not want to make on this visit, and the loud
 * button should not be the one that closes a record with money still unaccounted for.
 */
export function primaryAction(reimbursement) {
  if (!reimbursement || reimbursement.completed) return 'save'
  return reimbursementStatus(reimbursement) === 'square' && hasRepayment(reimbursement) ? 'complete' : 'save'
}

/*
 * Reminders — when a receivable stops being "waiting" and starts being "ask about it".
 *
 * **The clock runs from the transaction, never from the record.** A reimbursement entered today for a
 * charge in February is already months old, and dating it from the record would mean that tidying up —
 * the one act that should be encouraged — postpones the reminder every time. The server measures it the
 * same way; these helpers exist so the report and the editor can say the same thing without a second
 * round trip, reading the `reminder_days` the outstanding report already carries.
 *
 * **A record has three answers, not two.** No stored value means *follow the household default*; an
 * empty one means the user switched this record's reminder off; a date means they chose it. Collapsing
 * the first two would make "no reminder" silently revert on the next unrelated save, which is exactly
 * what a reminder must not do.
 */

export const FOLLOWING_DEFAULT = 'default'
export const REMINDER_OFF = 'off'
export const REMINDER_ON = 'date'

/** Which of the three answers a record currently holds. */
export function reminderMode(reimbursement) {
  const value = reimbursement?.remind_on
  if (value === undefined || value === null) return FOLLOWING_DEFAULT
  return value ? REMINDER_ON : REMINDER_OFF
}

export function addDays(isoDate, days) {
  if (!isoDate || !Number.isFinite(Number(days))) return null
  const parsed = new Date(`${String(isoDate).slice(0, 10)}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime())) return null
  parsed.setUTCDate(parsed.getUTCDate() + Number(days))
  return parsed.toISOString().slice(0, 10)
}

export function todayIso() {
  const now = new Date()
  // Local rather than UTC: "is this due today?" is a question about the user's calendar, and a UTC day
  // boundary would fire a reminder the evening before west of Greenwich.
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

/*
 * When a record starts nagging, or null where it never does.
 *
 * Only money still *owed* is ever due. A surplus is a gain waiting to be booked rather than something
 * to chase, and a completed record has no work left on it at all — nagging about either would be the
 * feature asking the user to go and collect something they already have.
 */
export function recordDueDate(reimbursement, reminderDays) {
  if (!reimbursement || reimbursement.completed) return null
  if (round2(reimbursement.residual) < CENT) return null
  const mode = reminderMode(reimbursement)
  if (mode === REMINDER_OFF) return null
  if (mode === REMINDER_ON) return String(reimbursement.remind_on).slice(0, 10)
  return reminderDays ? addDays(reimbursement.expense_date, reminderDays) : null
}

/*
 * When a loose row starts nagging. It answers only to the household default: there is no record to hang
 * a date on, which is what *Track this* is for — and a receivable worth deferring by hand is one worth
 * naming anyway.
 *
 * Money in is never due. An unmatched credit is not under-reported spending, so there is nothing to
 * chase about it.
 */
export function looseDueDate(row, reminderDays) {
  if (!row || round2(row.unclaimed) < CENT) return null
  return reminderDays ? addDays(row.date, reminderDays) : null
}

/** Whether a board entry has come due, computed the same way for both piles. */
export function entryDueDate(entry, reminderDays) {
  if (entry?.kind === 'record') return recordDueDate(entry.reimbursement, reminderDays)
  if (entry?.kind === 'row') return looseDueDate(entry.row, reminderDays)
  return null
}

export function isDue(dueOn, today = todayIso()) {
  return !!dueOn && dueOn <= today
}

/*
 * How a record's reminder reads where there is room for one line.
 *
 * The default case names the date it works out to rather than the rule behind it: "following the
 * household default" is a fact about configuration, and what the reader wants to know is when they will
 * next be asked about this money.
 */
export function reminderSummary(reimbursement, reminderDays, today = todayIso()) {
  const mode = reminderMode(reimbursement)
  if (mode === REMINDER_OFF) return 'No reminder'
  const dueOn = recordDueDate(reimbursement, reminderDays)
  if (!dueOn) {
    // Nothing owed, or the default is switched off and this record never chose a date of its own.
    return round2(reimbursement?.residual) < CENT ? 'Nothing outstanding' : 'No reminder'
  }
  const prefix = mode === FOLLOWING_DEFAULT ? 'Reminder' : 'Reminder set for'
  return isDue(dueOn, today) ? `${prefix} ${dueOn} — due now` : `${prefix} ${dueOn}`
}

/*
 * Portions held by *other* records, as the "move it here" list.
 *
 * Claims are exclusive, so the ordinary picker offers unclaimed money only — which leaves a row whose
 * receivable is entirely spoken for unreachable from anywhere but the record already holding it. Rows
 * landing on the wrong record are ordinary (a repayment matched to the wrong friend), so the fix should
 * not be releasing it first and hoping to find it again.
 *
 * Excluded here: this record's own claims (nothing to move), and rows it already covers — a record holds
 * one claim per transaction, so a move onto one of those would replace rather than add.
 */
export function movableClaims(report, linkId) {
  const target = (report?.reimbursements || []).find(item => item.id === linkId)
  const alreadyHere = new Set(
    (target?.members || []).map(member => member.txn_id),
  )
  const rows = []
  for (const record of report?.reimbursements || []) {
    if (record.id === linkId || record.completed) continue
    for (const member of record.members || []) {
      if (member.trashed || alreadyHere.has(member.txn_id)) continue
      if (Math.abs(round2(member.claim)) < CENT) continue
      rows.push({
        txn_id: member.txn_id,
        date: member.date,
        payee: member.payee,
        claim: round2(member.claim),
        claim_label: member.claim_label || null,
        from: { id: record.id, label: reimbursementListLabel(record) },
      })
    }
  }
  return rows.sort((a, b) => (b.date || '').localeCompare(a.date || '')
    || String(a.txn_id).localeCompare(String(b.txn_id)))
}
