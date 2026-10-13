// @vitest-environment jsdom

// The row menu must not open on one action and silently become another.
//
// "Create rule" and "Open matching rule" are different things to do, and which one applies is only
// known after an async lookup. Painting the menu first and rewriting the item when the answer lands
// shows the user something untrue — and the lookup is normally fast enough that the swap is over
// before it can be read, so the menu simply cannot be trusted and there is no visible reason why.
//
// Both directions matter, which is why the slow case is tested too: holding the paint forever would
// trade a flicker for an unresponsive right-click.

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { useTransactionRowActions, TransactionRowActionsChrome } from '../useTransactionRowActions.jsx'
import { api } from '../api.js'

// `bulkUpdateTransactions` is hoisted out as a bare mock rather than read through `api.*`: the
// transaction writes are lint-guarded so feature code cannot skip the invalidation layer.
const { bulkUpdateTransactions } = vi.hoisted(() => ({
  bulkUpdateTransactions: vi.fn(() => Promise.resolve({ ok: true })),
}))
vi.mock('../api.js', () => ({
  api: {
    getMatchingRuleForTransaction: vi.fn(),
    getTags: vi.fn(() => Promise.resolve([])),
    bulkUpdateTransactions,
  },
}))

const TXN = { id: 't1', display_name: 'Fixture Store', amount: 10, category_id: null }

// The Router wraps the component that *calls* the hook — the hook itself uses `useNavigate`, so a
// router nested inside its own consumer is too late.
function Rows() {
  const controller = useTransactionRowActions({ onOpenDetail: () => {} })
  return (
    <>
      <div
        data-testid="row"
        onContextMenu={e => controller.onContextMenu(e, TXN)}
        style={{ height: 20 }}
      >row</div>
      <TransactionRowActionsChrome controller={controller} />
    </>
  )
}

function Harness() {
  return <MemoryRouter><Rows /></MemoryRouter>
}

async function openMenu(user) {
  await user.pointer({ keys: '[MouseRight]', target: screen.getByTestId('row') })
}

beforeEach(() => { vi.useRealTimers() })
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('row menu rule action', () => {
  it('does not paint until the lookup has decided which action applies', async () => {
    const user = userEvent.setup()
    let settle
    api.getMatchingRuleForTransaction.mockReturnValue(new Promise(resolve => { settle = resolve }))
    render(<Harness />)

    await openMenu(user)
    // The lookup is outstanding, so nothing is shown yet — not the loading text, and above all not a
    // guess at which of the two actions this row wants.
    expect(screen.queryByText('✎ Edit transaction…')).toBeNull()
    expect(screen.queryByText('⚙ Create rule')).toBeNull()
    expect(screen.queryByText('⚙ Open matching rule')).toBeNull()

    settle({ rule_id: 'r1' })
    // It appears once, already saying the right thing.
    expect(await screen.findByText('⚙ Open matching rule')).toBeTruthy()
    expect(screen.queryByText('⚙ Create rule')).toBeNull()
  })

  it('opens straight onto Create rule when no rule matches', async () => {
    const user = userEvent.setup()
    api.getMatchingRuleForTransaction.mockResolvedValue({ rule_id: null })
    render(<Harness />)

    await openMenu(user)
    expect(await screen.findByText('⚙ Create rule')).toBeTruthy()
    expect(screen.queryByText('⚙ Loading rule…')).toBeNull()
  })

  it('still opens when the lookup fails, rather than swallowing the right-click', async () => {
    const user = userEvent.setup()
    api.getMatchingRuleForTransaction.mockRejectedValue(new Error('nope'))
    render(<Harness />)

    await openMenu(user)
    expect(await screen.findByText('⚙ Create rule')).toBeTruthy()
  })

  it('gives up waiting and opens if the lookup is slow', async () => {
    const user = userEvent.setup()
    // Never settles: the menu must still arrive, because an unresponsive right-click is the worse
    // failure and a label the user has had time to read is allowed to change afterwards.
    api.getMatchingRuleForTransaction.mockReturnValue(new Promise(() => {}))
    render(<Harness />)

    await openMenu(user)
    await waitFor(
      () => expect(screen.getByText('⚙ Loading rule…')).toBeTruthy(),
      { timeout: 2000 },
    )
  })
})


/*
 * A saved split has to reach the row it was saved from.
 *
 * The row carries its allocations inline (`split_parts`) for the ledger's hover, and the reconcile
 * patched only how *many* there were. So after an edit the hover listed the previous split's categories
 * and amounts — a $10/$240 division still shown beside an editor reading $140/$110 — and stayed wrong
 * until something refetched the page. Both halves are asserted: the parts reach the row, and a list of
 * expanded allocations asks its host to refetch, because a patch cannot restate figures the server
 * computed.
 */
describe('saving a split', () => {
  function controllerFor(handlers) {
    let api = null
    function Probe() {
      api = useTransactionRowActions({ onOpenDetail: () => {}, ...handlers })
      return null
    }
    // Router-wrapped for the same reason the fixture above is: the hook itself calls `useNavigate`.
    render(<MemoryRouter><Probe /></MemoryRouter>)
    return () => api
  }

  it('reconciles the allocations, not merely their count', () => {
    const reconcileRow = vi.fn()
    const get = controllerFor({ reconcileRow })
    const parts = [
      { category_id: 'c1', category_name: 'Entertainment', amount: 140, label: 'part 2' },
      { category_id: 'c2', category_name: 'Hobbies', amount: 110, label: null },
    ]
    get().handleSplitSaved('t1', { is_split: true, parts })

    const patch = reconcileRow.mock.calls[0][1]
    expect(patch.split_parts).toEqual(parts)
    expect(patch.split_part_count).toBe(2)
  })

  it('empties them when the split is removed', () => {
    const reconcileRow = vi.fn()
    const get = controllerFor({ reconcileRow })
    get().handleSplitSaved('t1', { is_split: false, parts: [] })
    expect(reconcileRow.mock.calls[0][1].split_parts).toEqual([])
  })

  it('tells the host, so a list of expanded allocations can refetch its scope', () => {
    const onSplitSaved = vi.fn()
    const get = controllerFor({ reconcileRow: vi.fn(), onSplitSaved })
    get().handleSplitSaved('t1', { is_split: true, parts: [] })
    expect(onSplitSaved).toHaveBeenCalledWith('t1', { is_split: true, parts: [] })
  })
})


/*
 * Marking a row reviewed offers an undo.
 *
 * Reviewing is usually settled on the spot, but not always — a charge may need checking on another site
 * first — so the press is reversible for a few seconds. The row itself never moves: the flag is patched
 * onto it in place both ways, so a list filtered to "Needs review" does not reshuffle under repeated
 * clicks (see ui-patterns.md → "Transaction lists").
 */
describe('marking reviewed', () => {
  function ReviewHarness({ reconcileRow }) {
    const controller = useTransactionRowActions({ onOpenDetail: () => {}, reconcileRow })
    return (
      <>
        <button onClick={() => controller.markReviewed(TXN)}>review</button>
        <TransactionRowActionsChrome controller={controller} />
      </>
    )
  }

  it('clears the flag in place and offers an undo that sets it again', async () => {
    const user = userEvent.setup()
    const reconcileRow = vi.fn()
    render(<MemoryRouter><ReviewHarness reconcileRow={reconcileRow} /></MemoryRouter>)

    await user.click(screen.getByText('review'))
    await waitFor(() => expect(reconcileRow).toHaveBeenCalledWith('t1', { needs_review: 0 }))
    expect(bulkUpdateTransactions).toHaveBeenCalledWith(
      { mode: 'ids', ids: ['t1'] }, [{ type: 'mark_reviewed' }],
    )
    expect(screen.getByText('Marked reviewed')).toBeTruthy()

    await user.click(screen.getByText('Undo'))
    await waitFor(() => expect(reconcileRow).toHaveBeenCalledWith('t1', { needs_review: 1 }))
    expect(bulkUpdateTransactions).toHaveBeenLastCalledWith(
      { mode: 'ids', ids: ['t1'] }, [{ type: 'set_review_status', needs_review: true }],
    )
    expect(screen.queryByText('Marked reviewed')).toBeNull()
  })

  it('offers no undo when the write failed, since nothing changed', async () => {
    const user = userEvent.setup()
    const reconcileRow = vi.fn()
    bulkUpdateTransactions.mockRejectedValueOnce(new Error('nope'))
    render(<MemoryRouter><ReviewHarness reconcileRow={reconcileRow} /></MemoryRouter>)

    await user.click(screen.getByText('review'))
    expect(await screen.findByText('Could not mark as reviewed')).toBeTruthy()
    expect(reconcileRow).not.toHaveBeenCalled()
    expect(screen.queryByText('Marked reviewed')).toBeNull()
  })
})
