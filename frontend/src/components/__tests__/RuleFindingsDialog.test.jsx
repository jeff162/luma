// @vitest-environment jsdom

// The rule checkup panel. Every finding is derived server-side, so what is worth pinning is what the
// panel *says* about each kind — because the kinds mean different things and look similar otherwise,
// and because the range-drift ones come from a different endpoint than the rest.
//
// The range-drift half is the one with a fix attached, and the fix has two halves that must stay
// together: widening moves the bound *and* re-applies the rule, in one request, since a bound that moves
// without a re-apply leaves the charge exactly where it was. A failed action has to say so. It is offered on the
// outside-the-range kind alone — a charge still inside the range is already being claimed, so widening
// out to it would loosen the rule for nothing.
//
// The properties that break quietly, and the delete's placement is the one most likely to be "corrected"
// back to where it looks like it belongs. **Delete appears only on the rule the server marks removable**
// (`removable_rule_id`), never on an overlap that changes the outcome. That overlap is a modelling
// ambiguity whose answer is to refine the conditions, so removing a side is picking a winner rather than
// fixing anything — the panel must offer no removal and no amount edit there.
//
// Dismissal follows whether the winner changes anything, not whether the finding is a warning. A live
// overlap or co-match offers no Dismiss, because waving one through would let the panel call an
// arbitrary outcome settled; a pair whose two rules file identically does, because the ledger reads the
// same either way. The flag comes from the server (`dismissible`) rather than from a `kind` check in the
// layout, and neither end may sprout its own.
//
// The co-match card is the one that leads with a transaction. That is not decoration: unlike every other
// finding here it cannot be derived from the rules alone, so the row is what makes it true.
//
// Two more. The per-card sentence must say something specific to that pair — a restatement of the
// section header repeats itself down a panel of thirty findings and earns nothing. And a pair meeting at
// a single amount has to name that amount rather than render an empty-looking range, since capping one
// rule at the other's floor produces exactly that.

import { afterEach, describe, it, expect, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import RuleFindingsDialog from '../RuleFindingsDialog.jsx'
import { api } from '../../lib/api.js'
import { txnMutations } from '../../lib/txnMutations.js'

vi.mock('../../lib/api.js', () => ({
  api: {
    getRuleOverlaps: vi.fn(), deleteRule: vi.fn(),
    dismissRuleOverlap: vi.fn(), restoreRuleOverlap: vi.fn(),
    getRuleRangeDrift: vi.fn(), updateRule: vi.fn(),
    dismissRuleRangeDrift: vi.fn(), restoreRuleRangeDrift: vi.fn(),
  },
}))
// Panel geometry is remembered as a user preference; nothing here exercises that.
vi.mock('../../lib/UserPreferencesContext.jsx', () => ({
  useUserPreference: (_key, fallback) => [fallback, () => {}],
}))
vi.mock('../../lib/txnMutations.js', () => ({ txnMutations: { applyRule: vi.fn(), widenRuleRange: vi.fn() } }))

// Call counts are asserted below (a re-run of the check, a delete that must not fire), so the shared api
// mock has to be reset between tests as well as the DOM.
afterEach(() => { cleanup(); vi.clearAllMocks() })

const RULES = {
  broad: {
    id: 'broad', keyword: 'town of harborline', clauses: ['town of harborline'],
    amount_min: 300, amount_max: 4000, debit_credit: 'both', category_id: 'c1', category_name: 'Water', tags: [],
  },
  narrow: {
    id: 'narrow', keyword: 'town of harborline', clauses: ['town of harborline'],
    amount_min: 3000, amount_max: null, debit_credit: 'both', category_id: 'c2', category_name: 'Property Tax', tags: [],
  },
  short: {
    id: 'short', keyword: 'northgate', clauses: ['northgate'],
    amount_min: null, amount_max: null, debit_credit: 'both', category_id: 'c3', category_name: 'Shopping',
    owner_name: 'Alex', tags: [],
  },
  long: {
    id: 'long', keyword: 'northgate prime', clauses: ['northgate prime'],
    amount_min: null, amount_max: null, debit_credit: 'both', category_id: 'c4', category_name: 'Subscriptions', tags: [],
  },
  aji: {
    id: 'aji', keyword: 'aji', clauses: ['aji'], amount_min: null, amount_max: null, debit_credit: 'both',
    category_id: 'c5', category_name: 'Restaurants', match_source_text: 1, tags: [],
  },
  ajiRestaurant: {
    id: 'ajiRestaurant', keyword: 'aji restaurant', clauses: ['aji restaurant'],
    amount_min: null, amount_max: null, debit_credit: 'both',
    category_id: 'c5', category_name: 'Restaurants', tags: [],
  },
}

// Never dismissible: which of the two rules wins is decided but not reasoned, so it stays listed until refined.
const OVERLAP = {
  kind: 'amount_overlap', key: 'amount_overlap:broad:narrow', severity: 'warning', dismissible: false,
  rule_ids: ['broad', 'narrow'], overlap_min: 3000, overlap_max: 4000, winner_rule_id: 'broad',
}
// Categories differ, so the narrow rule is doing work of its own and is not removable.
const NESTING = {
  kind: 'matcher_nesting', key: 'matcher_nesting:short:long', severity: 'info',
  rule_ids: ['short', 'long'], winner_rule_id: 'long', removable_rule_id: null, dismissible: true,
}
// The shape the user actually has: both rules do the same thing, so the narrow half is surplus.
const REDUNDANT = {
  kind: 'matcher_nesting', key: 'matcher_nesting:aji:ajiRestaurant', severity: 'info',
  rule_ids: ['aji', 'ajiRestaurant'], winner_rule_id: 'ajiRestaurant', removable_rule_id: 'ajiRestaurant',
  dismissible: true,
}
// The shorter keyword wins on the owner limit only it carries.
const SCOPE_SPLIT = {
  kind: 'matcher_scope_split', key: 'matcher_scope_split:long:short', severity: 'info', dismissible: true,
  rule_ids: ['short', 'long'], winner_rule_id: 'short', deciding_scope: 'owner', removable_rule_id: null,
  txn_count: 1, txn_id: 't8', txn_date: '2026-06-03', txn_name: 'NORTHGATE PRIME', amount: 40,
}

// Two matchers that neither repeat nor contain each other, caught on a real row. The card leads with
// that row, because without it there would be no finding at all.
const CO_MATCH = {
  kind: 'matcher_co_match', key: 'matcher_co_match:long:short', severity: 'warning', dismissible: false,
  rule_ids: ['long', 'short'], winner_rule_id: 'long', txn_count: 3,
  txn_id: 't9', txn_date: '2026-07-14', txn_name: 'NORTHGATE PRIME SUPPLY', amount: 82.5,
}
// The same contention, between two rules that do the same thing — so the winner decides nothing and the
// pair drops out of the warnings into the acknowledgeable section.
const CO_MATCH_BENIGN = {
  ...CO_MATCH, kind: 'matcher_co_match_benign', key: 'matcher_co_match_benign:long:short',
  severity: 'info', dismissible: true,
}
const OVERLAP_BENIGN = {
  kind: 'amount_overlap_benign', key: 'amount_overlap_benign:broad:narrow', severity: 'info',
  dismissible: true, rule_ids: ['broad', 'narrow'], overlap_min: 3000, overlap_max: 4000,
  winner_rule_id: 'broad',
}

// A charge that missed a rule's maximum by 12%, on the rule that gates the water bill by size.
const DRIFT = {
  kind: 'rule_range', key: 'rule_range:broad:t4', severity: 'warning', dismissible: true, dismissed: false,
  rule_id: 'broad', amount_min: null, amount_max: 200, bound: 'max', percent: 12,
  txn_id: 't4', txn_date: '2026-08-02', txn_name: 'Town of Harborline', amount: 224,
  current_category_name: null, series_name: null,
}
// Still inside the range: the same warning one occurrence earlier, with nothing yet to take in.
const DRIFT_EDGE = {
  ...DRIFT, kind: 'rule_range_edge', key: 'rule_range_edge:broad:t5', severity: 'info',
  txn_id: 't5', amount: 195, percent: 2.5,
}

function payload(findings, dismissedCount) {
  // Counts describe the *open* set, as the server reports them — a dismissed finding is rendered but
  // never counted, which is the property the header depends on.
  const open = findings.filter(f => !f.dismissed)
  const counts = open.reduce((acc, f) => ({ ...acc, [f.kind]: (acc[f.kind] || 0) + 1 }), {})
  return { count: open.length, counts, dismissed_count: dismissedCount, findings, rules: RULES }
}

function renderDialog(findings, { dismissedCount = 0, drift = [], driftDismissedCount = 0 } = {}) {
  api.getRuleOverlaps.mockResolvedValue(payload(findings, dismissedCount))
  api.getRuleRangeDrift.mockResolvedValue(payload(drift, driftDismissedCount))
  api.deleteRule.mockResolvedValue({ ok: true })
  api.updateRule.mockResolvedValue({ ok: true })
  api.dismissRuleOverlap.mockResolvedValue({ ok: true })
  api.restoreRuleOverlap.mockResolvedValue({ ok: true })
  api.dismissRuleRangeDrift.mockResolvedValue({ ok: true })
  api.restoreRuleRangeDrift.mockResolvedValue({ ok: true })
  txnMutations.widenRuleRange.mockResolvedValue({ updated: 1 })
  const onEditRule = vi.fn()
  const onRulesChanged = vi.fn()
  const onClose = vi.fn()
  const dialog = props => (
    <RuleFindingsDialog onClose={onClose} onEditRule={onEditRule} onRulesChanged={onRulesChanged} {...props} />
  )
  const { rerender } = render(dialog({}))
  return { onEditRule, onRulesChanged, rerender: props => rerender(dialog(props)) }
}

describe('RuleFindingsDialog', () => {
  it('says which limit lets the shorter keyword win, and what that changes', async () => {
    renderDialog([SCOPE_SPLIT])
    await screen.findByText(/Rules where a limit decides/)
    const note = screen.getByText(/#1 is limited to Alex/).textContent
    expect(note).toMatch(/NORTHGATE PRIME/)
    expect(note).toMatch(/#1 files to Shopping where #2 files to Subscriptions/)
  })

  it('separates the kinds and counts them apart', async () => {
    renderDialog([OVERLAP, NESTING], { drift: [DRIFT] })
    expect(await screen.findByText('1 charge outside a range · 1 to settle · 1 for information')).toBeTruthy()
    expect(screen.getByText(/Charges outside a rule/)).toBeTruthy()
    expect(screen.getByText(/Amount ranges that overlap/)).toBeTruthy()
    expect(screen.getByText(/Merchant matchers that nest/)).toBeTruthy()
  })

  it('hands a rule off to the editor', async () => {
    const { onEditRule } = renderDialog([OVERLAP])
    const editButtons = await screen.findAllByText('Edit')
    await userEvent.click(editButtons[0])
    expect(onEditRule).toHaveBeenCalledWith('broad')
  })

  it('offers to delete the surplus half of a redundant nesting pair, once confirmed', async () => {
    const { onRulesChanged } = renderDialog([REDUNDANT])
    await userEvent.click(await screen.findByText('Delete'))
    // Arming the confirm must not itself delete anything.
    expect(api.deleteRule).not.toHaveBeenCalled()
    await userEvent.click(screen.getByText('Delete rule'))
    expect(api.deleteRule).toHaveBeenCalledWith('ajiRestaurant', { reconcile: false })
    // The check is re-run, because a delete dissolves every finding that rule appeared in.
    await waitFor(() => expect(api.getRuleOverlaps).toHaveBeenCalledTimes(2))
    expect(onRulesChanged).toHaveBeenCalled()
  })

  it('offers the delete on the narrow rule only, never the broad one', async () => {
    renderDialog([REDUNDANT])
    await screen.findByText(/Merchant matchers that nest/)
    expect(screen.getAllByText('Edit').length).toBe(2)
    expect(screen.getAllByText('Delete').length).toBe(1)
  })

  it('carries the re-evaluate opt-in through to the delete, defaulted off', async () => {
    renderDialog([REDUNDANT])
    await userEvent.click(await screen.findByText('Delete'))
    await userEvent.click(screen.getByLabelText(/re-evaluate its transactions/))
    await userEvent.click(screen.getByText('Delete rule'))
    expect(api.deleteRule).toHaveBeenCalledWith('ajiRestaurant', { reconcile: true })
  })

  it('abandons a delete on cancel', async () => {
    renderDialog([REDUNDANT])
    await userEvent.click(await screen.findByText('Delete'))
    await userEvent.click(screen.getByText('Cancel'))
    expect(api.deleteRule).not.toHaveBeenCalled()
    expect(screen.queryByText('Delete rule')).toBeNull()
  })

  it('offers no delete on an overlap, where the answer is to refine the conditions', async () => {
    renderDialog([OVERLAP])
    await screen.findByText(/Amount ranges that overlap/)
    expect(screen.getAllByText('Edit').length).toBe(2)
    expect(screen.queryByText('Delete')).toBeNull()
    expect(screen.getByText(/Which rule wins is arbitrary/)).toBeTruthy()
  })

  it('offers no delete on a nesting pair whose narrow rule files elsewhere', async () => {
    renderDialog([NESTING])
    await screen.findByText(/Merchant matchers that nest/)
    expect(screen.queryByText('Delete')).toBeNull()
    expect(screen.getByText('#2 files to Subscriptions where #1 files to Shopping.')).toBeTruthy()
  })

  it('dismisses an overlap finding in place, without re-running the ledger scan', async () => {
    renderDialog([NESTING])
    await userEvent.click(await screen.findByText('Dismiss'))
    expect(api.dismissRuleOverlap).toHaveBeenCalledWith(NESTING.key, 'matcher_nesting')
    expect(await screen.findByText('Nothing left to look at — 1 dismissed.')).toBeTruthy()
    expect(api.getRuleOverlaps).toHaveBeenCalledTimes(1)
  })

  it('never offers to dismiss an overlap, whose winner is arbitrary rather than informative', async () => {
    renderDialog([OVERLAP])
    await screen.findByText(/Amount ranges that overlap/)
    expect(screen.queryByText('Dismiss')).toBeNull()
  })

  it('hides the reveal control until there is something dismissed to reveal', async () => {
    renderDialog([NESTING])
    await screen.findByText(/Merchant matchers that nest/)
    expect(screen.queryByLabelText(/Show dismissed/)).toBeNull()
  })

  it('reveals dismissed findings on request, and restores one in place', async () => {
    renderDialog([{ ...NESTING, dismissed: true }], { dismissedCount: 1 })
    await screen.findByText('Nothing left to look at — 1 dismissed.')
    expect(screen.queryByText('Restore')).toBeNull()
    await userEvent.click(screen.getByLabelText(/Show dismissed \(1\)/))
    await userEvent.click(await screen.findByText('Restore'))
    expect(api.restoreRuleOverlap).toHaveBeenCalledWith(NESTING.key)
    expect(await screen.findByText('1 for information')).toBeTruthy()
    // Revealing and restoring are drawn from the one fetch, which already carried the dismissed set.
    expect(api.getRuleOverlaps).toHaveBeenCalledTimes(1)
    expect(api.getRuleOverlaps).toHaveBeenCalledWith({ includeDismissed: true })
  })

  it('re-runs its checks when an edit it opened is saved, and not before', async () => {
    const { rerender } = renderDialog([NESTING])
    await screen.findByText(/Merchant matchers that nest/)
    rerender({})
    expect(api.getRuleOverlaps).toHaveBeenCalledTimes(1)
    rerender({ refreshKey: 1 })
    await waitFor(() => expect(api.getRuleOverlaps).toHaveBeenCalledTimes(2))
    // The results stay on screen while it re-runs.
    expect(screen.getByText(/Merchant matchers that nest/)).toBeTruthy()
  })

  it('never counts a revealed dismissal as work still to do', async () => {
    renderDialog([{ ...NESTING, dismissed: true }], { dismissedCount: 1 })
    await userEvent.click(await screen.findByLabelText(/Show dismissed \(1\)/))
    // Not "0 to settle, 1 for information" — the one on screen is already acknowledged.
    expect(await screen.findByText('Restore')).toBeTruthy()
    expect(screen.getByText('Nothing left to look at — 1 dismissed.')).toBeTruthy()
    expect(screen.queryByText('Dismiss')).toBeNull()
  })

  // --- charges that drifted out of a range ---------------------------------------------------------

  it('widens the bound and re-applies the rule in one request', async () => {
    // Both halves or neither. As a rule update followed by a separate apply, a failure between the two could
    // leave the bound moved and the charge unclaimed, which the panel would then show as a near-edge warning.
    const { onRulesChanged } = renderDialog([], { drift: [DRIFT] })
    await userEvent.click(await screen.findByText('Widen to include'))
    await waitFor(() => expect(txnMutations.widenRuleRange).toHaveBeenCalledWith('broad', 'max', 224))
    expect(api.updateRule).not.toHaveBeenCalled()
    expect(txnMutations.applyRule).not.toHaveBeenCalled()
    expect(onRulesChanged).toHaveBeenCalled()
    // The whole checkup re-runs: widening can settle an overlap as well as this finding.
    await waitFor(() => expect(api.getRuleRangeDrift).toHaveBeenCalledTimes(2))
  })

  it('moves the minimum when that is the bound the charge missed', async () => {
    // The charge's own magnitude is sent; rounding outwards to the cent is the server's (test_rule_widen.py).
    renderDialog([], { drift: [{ ...DRIFT, bound: 'min', amount_min: 300, amount_max: null, amount: -245.845 }] })
    await userEvent.click(await screen.findByText('Widen to include'))
    await waitFor(() => expect(txnMutations.widenRuleRange).toHaveBeenCalledWith('broad', 'min', 245.845))
  })

  it('says so when an action fails, and still re-runs the check', async () => {
    // A failed fix used to leave the panel exactly as it was, with no word that anything had gone wrong.
    const { onRulesChanged } = renderDialog([], { drift: [DRIFT] })
    txnMutations.widenRuleRange.mockRejectedValue(new Error('database is locked'))
    await userEvent.click(await screen.findByText('Widen to include'))
    expect((await screen.findByRole('alert')).textContent).toMatch(/Could not save that change: database is locked/)
    await waitFor(() => expect(api.getRuleRangeDrift).toHaveBeenCalledTimes(2))
    expect(onRulesChanged).not.toHaveBeenCalled()
  })

  it('offers no widening on a charge still inside the range', async () => {
    // It is already being claimed; moving the bound out to it would loosen the rule for nothing.
    renderDialog([], { drift: [DRIFT_EDGE] })
    expect(await screen.findByText(/within 2.5% of the rule/)).toBeTruthy()
    expect(screen.queryByText('Widen to include')).toBeNull()
    expect(screen.getByText('Edit')).toBeTruthy()
  })

  it('dismisses one charge through its own store, not the overlap check\'s', async () => {
    renderDialog([], { drift: [DRIFT] })
    await userEvent.click(await screen.findByText('Dismiss'))
    await waitFor(() => expect(api.dismissRuleRangeDrift).toHaveBeenCalledWith(DRIFT.key, 'rule_range'))
    expect(api.dismissRuleOverlap).not.toHaveBeenCalled()
  })

  it('restores a revealed drift dismissal through the same store', async () => {
    renderDialog([], { drift: [{ ...DRIFT, dismissed: true }], driftDismissedCount: 1 })
    await userEvent.click(await screen.findByLabelText(/Show dismissed/i, { selector: 'input' }))
    await userEvent.click(await screen.findByText('Restore'))
    await waitFor(() => expect(api.restoreRuleRangeDrift).toHaveBeenCalledWith(DRIFT.key))
  })

  it('leads a co-match card with the transaction that proves it', async () => {
    // The evidence is the finding: these two rules are only in contention because a real row matched
    // both, and the row is also how the user judges whether the pair is worth untangling.
    renderDialog([CO_MATCH])
    expect(await screen.findByText(/Rules that match the same transaction/)).toBeTruthy()
    expect(screen.getByText(/NORTHGATE PRIME SUPPLY/)).toBeTruthy()
    expect(screen.getByText(/and 2 others/)).toBeTruthy()
  })

  it('offers neither delete nor dismiss on a live co-match', async () => {
    // Same reasoning as the overlap: the answer is to narrow a matcher, not to pick a side, and the
    // winner is arbitrary so there is nothing to acknowledge.
    renderDialog([CO_MATCH])
    expect(await screen.findByText(/NORTHGATE PRIME SUPPLY/)).toBeTruthy()
    expect(screen.queryByText('Dismiss')).toBeNull()
    expect(screen.queryByText('Delete')).toBeNull()
  })

  it('puts a pair whose rules file the same way out of the warnings and lets it be dismissed', async () => {
    renderDialog([OVERLAP_BENIGN, CO_MATCH_BENIGN])
    expect(await screen.findByText(/Competing rules that file the same way/)).toBeTruthy()
    // Neither warning section appears, because neither pair changes the ledger whichever rule wins.
    expect(screen.queryByText('Amount ranges that overlap')).toBeNull()
    expect(screen.queryByText('Rules that match the same transaction')).toBeNull()
    expect(screen.getAllByText('Dismiss').length).toBe(2)
  })

  it('offers to delete a benign pair\'s rule only where the other matches its every transaction', async () => {
    renderDialog([{ ...CO_MATCH_BENIGN, removable_rule_id: 'short' }])
    expect(await screen.findByText(/#2 has no transactions outside #1’s/)).toBeTruthy()
    expect(screen.getAllByText('Delete').length).toBe(1)
  })

  it('dismisses a benign pair through the overlap store', async () => {
    renderDialog([OVERLAP_BENIGN])
    await userEvent.click(await screen.findByText('Dismiss'))
    await waitFor(() => expect(api.dismissRuleOverlap)
      .toHaveBeenCalledWith(OVERLAP_BENIGN.key, 'amount_overlap_benign'))
    expect(api.dismissRuleRangeDrift).not.toHaveBeenCalled()
  })
})
