// @vitest-environment jsdom

// The rule checkup panel. Every finding is derived server-side, so what is worth pinning is what the
// panel *says* about each kind — because the three kinds mean different things and look similar
// otherwise, and because two of them come from a different endpoint than the third.
//
// The range-drift half is the one with a fix attached, and the fix has two halves that must stay
// together: widening moves the bound *and* re-applies the rule, since a bound that moves without a
// re-apply leaves the charge exactly where it was while the panel reports success. It is offered on the
// outside-the-range kind alone — a charge still inside the range is already being claimed, so widening
// out to it would loosen the rule for nothing.
//
// The properties that break quietly, and the delete's placement is the one most likely to be "corrected"
// back to where it looks like it belongs. **Delete is on the nesting half, not the overlap half.** An
// overlap is a modelling ambiguity whose answer is to refine the conditions, so removing a side is
// picking a winner rather than fixing anything — the panel must offer no removal and no amount edit
// there. A nesting pair whose two rules file to one category under one scope has a genuinely surplus
// narrow rule, which is what delete is for; it is offered on the narrow rule alone, because deleting
// the broad one strands every row the narrow matcher misses.
//
// Dismissal is the nesting half's, and only its. An overlap has no deterministic winner, so a Dismiss
// button there would let the panel call an arithmetic accident settled — the flag comes from the server
// (`dismissible`) rather than from a `kind` check in the layout, and neither end may sprout its own.
//
// Three more. The per-card sentence must say something specific to that pair — a restatement of the
// section header repeats itself down a panel of thirty findings and earns nothing. The redundancy flag
// covers the *category* only, so a rename or tag held by one rule and not the other has to be called out
// before the delete, or it changes hands silently. And a pair meeting at a single amount has to name
// that amount rather than render an empty-looking range, since capping one rule at the other's floor
// produces exactly that.

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
vi.mock('../../lib/txnMutations.js', () => ({ txnMutations: { applyRule: vi.fn() } }))

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
    category_id: 'c5', category_name: 'Restaurants', clean_name: 'AJI Newton', match_source_text: 1, tags: [],
  },
  ajiRestaurant: {
    id: 'ajiRestaurant', keyword: 'aji restaurant', clauses: ['aji restaurant'],
    amount_min: null, amount_max: null, debit_credit: 'both',
    category_id: 'c5', category_name: 'Restaurants', tags: [],
  },
}

// Never dismissible: nothing decides which of the two rules wins, so it stays listed until refined.
const OVERLAP = {
  kind: 'amount_overlap', key: 'amount_overlap:broad:narrow', severity: 'warning', dismissible: false,
  rule_ids: ['broad', 'narrow'], overlap_min: 3000, overlap_max: 4000, winner_rule_id: 'broad',
}
// Categories differ, so the narrow rule is doing work of its own and is not removable.
const NESTING = {
  kind: 'matcher_nesting', key: 'matcher_nesting:short:long', severity: 'info',
  rule_ids: ['short', 'long'], winner_rule_id: 'long', narrower_is_redundant: false, dismissible: true,
}
// The shape the user actually has: one category, one scope, so the narrow half is surplus.
const REDUNDANT = {
  kind: 'matcher_nesting', key: 'matcher_nesting:aji:ajiRestaurant', severity: 'info',
  rule_ids: ['aji', 'ajiRestaurant'], winner_rule_id: 'ajiRestaurant', narrower_is_redundant: true,
  dismissible: true,
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
  const onEditRule = vi.fn()
  const onRulesChanged = vi.fn()
  render(<RuleFindingsDialog onClose={vi.fn()} onEditRule={onEditRule} onRulesChanged={onRulesChanged} />)
  return { onEditRule, onRulesChanged }
}

describe('RuleFindingsDialog', () => {
  it('names the band two overlapping rules both claim, and proposes no fix', async () => {
    renderDialog([OVERLAP])
    await screen.findByText(/Amount ranges that overlap/)
    expect(screen.getByText(/charges from/)).toBeTruthy()
    expect(screen.getByText(/\$3,000/)).toBeTruthy()
    // The whole point of the finding: it hands the decision back rather than making one.
    expect(screen.getByText(/Refining the two rules/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /cap|widen|fix/i })).toBeNull()
  })

  it('names the single amount when the two ranges meet at one value', async () => {
    renderDialog([{ ...OVERLAP, overlap_min: 3000, overlap_max: 3000 }])
    await screen.findByText(/Amount ranges that overlap/)
    expect(screen.getByText(/a charge of exactly/)).toBeTruthy()
    expect(screen.queryByText(/charges from/)).toBeNull()
  })

  it('marks which rule takes the contested charges today', async () => {
    renderDialog([OVERLAP])
    expect(await screen.findByText('claims them today')).toBeTruthy()
  })

  it('reports a nesting pair as information, with no call to action', async () => {
    renderDialog([NESTING])
    await screen.findByText(/Merchant matchers that nest/)
    expect(screen.getByText('wins where both match')).toBeTruthy()
    expect(screen.queryByText(/Refining the two rules/)).toBeNull()
  })

  it('explains a nesting pair only when the broader rule is the one that wins', async () => {
    renderDialog([NESTING])
    await screen.findByText(/Merchant matchers that nest/)
    // The narrower matcher wins, which is what a reader expects — nothing to explain.
    expect(screen.queryByText(/rule wins here/)).toBeNull()

    cleanup()
    renderDialog([{ ...NESTING, winner_rule_id: 'short' }])
    await screen.findByText(/Merchant matchers that nest/)
    expect(screen.getByText(/rule wins here/)).toBeTruthy()
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

  it('names what the removed rule takes with it before the delete', async () => {
    // The broad rule renames and the narrow one does not, so removal is not a no-op on those rows.
    renderDialog([REDUNDANT])
    expect(await screen.findByText(/pick up the rename to “AJI Newton”/)).toBeTruthy()
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
    expect(screen.getByText(/Refining the two rules/)).toBeTruthy()
  })

  it('offers no delete on a nesting pair whose narrow rule files elsewhere', async () => {
    renderDialog([NESTING])
    await screen.findByText(/Merchant matchers that nest/)
    expect(screen.queryByText('Delete')).toBeNull()
    expect(screen.getByText(/doing work of its own/)).toBeTruthy()
  })

  it('dismisses a finding and re-runs the check', async () => {
    renderDialog([NESTING])
    await userEvent.click(await screen.findByText('Dismiss'))
    expect(api.dismissRuleOverlap).toHaveBeenCalledWith(NESTING.key, 'matcher_nesting')
    await waitFor(() => expect(api.getRuleOverlaps).toHaveBeenCalledTimes(2))
  })

  it('never offers to dismiss an overlap, which is nondeterminism rather than information', async () => {
    renderDialog([OVERLAP])
    await screen.findByText(/Amount ranges that overlap/)
    expect(screen.queryByText('Dismiss')).toBeNull()
    expect(screen.getByText(/stays listed until then/)).toBeTruthy()
  })

  it('hides the reveal control until there is something dismissed to reveal', async () => {
    renderDialog([NESTING])
    await screen.findByText(/Merchant matchers that nest/)
    expect(screen.queryByLabelText(/Show dismissed/)).toBeNull()
  })

  it('reveals dismissed findings on request, and offers to restore them', async () => {
    renderDialog([NESTING], { dismissedCount: 3 })
    await userEvent.click(await screen.findByLabelText(/Show dismissed \(3\)/))
    await waitFor(() => expect(api.getRuleOverlaps).toHaveBeenCalledWith({ includeDismissed: true }))

    cleanup()
    renderDialog([{ ...NESTING, dismissed: true }], { dismissedCount: 1 })
    await userEvent.click(await screen.findByText('Restore'))
    expect(api.restoreRuleOverlap).toHaveBeenCalledWith(NESTING.key)
  })

  it('never counts a revealed dismissal as work still to do', async () => {
    renderDialog([{ ...NESTING, dismissed: true }], { dismissedCount: 1 })
    // Not "0 to settle, 1 for information" — the one on screen is already acknowledged.
    expect(await screen.findByText('Nothing left to look at — 1 dismissed.')).toBeTruthy()
    expect(screen.getByText('Restore')).toBeTruthy()
    expect(screen.queryByText('Dismiss')).toBeNull()
  })

  it('says so when nothing is wrong with the rule set', async () => {
    renderDialog([])
    await waitFor(() => {
      expect(screen.getByText(/Every rule claims the charges it should/)).toBeTruthy()
    })
    expect(screen.queryByText(/Amount ranges that overlap/)).toBeNull()
    expect(screen.queryByText(/Charges outside a rule/)).toBeNull()
  })

  // --- charges that drifted out of a range ---------------------------------------------------------

  it('names what a drifted range cost and where the charge landed instead', async () => {
    renderDialog([], { drift: [DRIFT] })
    expect(await screen.findByText(/12% above the maximum of \$200\.00/)).toBeTruthy()
    // The consequence, not just the arithmetic — this is the part the user cannot see anywhere else.
    expect(screen.getByText(/the rule did not claim it/)).toBeTruthy()
    expect(screen.getByText(/It is uncategorized as a result/)).toBeTruthy()
  })

  it('says which series the charge fell out of, where the rule feeds one', async () => {
    renderDialog([], { drift: [{ ...DRIFT, series_name: 'Town of Harborline' }] })
    expect(await screen.findByText(/It dropped out of the Town of Harborline series too/)).toBeTruthy()
  })

  it('widens the bound and re-applies the rule, as one action', async () => {
    // Both halves or neither: a bound that moves without a re-apply leaves the charge exactly where it
    // was, while the panel reports the fix as done.
    const { onRulesChanged } = renderDialog([], { drift: [DRIFT] })
    await userEvent.click(await screen.findByText('Widen to include'))
    await waitFor(() => {
      expect(api.updateRule).toHaveBeenCalledWith('broad', { amount_max: 224 })
      expect(txnMutations.applyRule).toHaveBeenCalledWith('broad', { preserveManual: true })
    })
    expect(onRulesChanged).toHaveBeenCalled()
    // The whole checkup re-runs: widening can settle an overlap as well as this finding.
    await waitFor(() => expect(api.getRuleRangeDrift).toHaveBeenCalledTimes(2))
  })

  it('rounds the widened bound outwards, so the charge it names actually matches', async () => {
    renderDialog([], { drift: [{ ...DRIFT, amount: 224.005 }] })
    await userEvent.click(await screen.findByText('Widen to include'))
    await waitFor(() => expect(api.updateRule).toHaveBeenCalledWith('broad', { amount_max: 224.01 }))
  })

  it('moves the minimum when that is the bound the charge missed', async () => {
    renderDialog([], { drift: [{ ...DRIFT, bound: 'min', amount_min: 300, amount_max: null, amount: 245.845 }] })
    await userEvent.click(await screen.findByText('Widen to include'))
    await waitFor(() => expect(api.updateRule).toHaveBeenCalledWith('broad', { amount_min: 245.84 }))
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
})
