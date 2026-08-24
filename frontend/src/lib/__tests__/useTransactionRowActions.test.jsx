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

vi.mock('../api.js', () => ({
  api: {
    getMatchingRuleForTransaction: vi.fn(),
    getTags: vi.fn(() => Promise.resolve([])),
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
