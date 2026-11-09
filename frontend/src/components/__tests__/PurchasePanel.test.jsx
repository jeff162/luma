// @vitest-environment jsdom

// The purchase *summary* on the transaction detail panel. Editing lives in `PurchaseEditorDialog` and
// is tested there; what matters here is that this section says the right thing, opens that editor, and
// keeps the ledger row behind it in step.
//
// Two properties are worth pinning because a green-looking component breaks them quietly. **It renders
// nothing when there is no purchase**, which is the whole reason it can sit on every transaction. And
// **a host's inline callback does not restart its fetch** — the defect the documents panel actually
// shipped, invisible to a test that passes a stable `vi.fn()` the way no real host does.

import { StrictMode, useState } from 'react'
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import PurchasePanel from '../PurchasePanel.jsx'
import { api } from '../../lib/api.js'

// A floating dialog remembers where it was left, a saved preference; local state stands in for the
// app's provider.
vi.mock('../../lib/UserPreferencesContext.jsx', async (importOriginal) => {
  const { useState } = await import('react')
  return { ...(await importOriginal()), useUserPreference: (_key, initial) => useState(initial) }
})

vi.mock('../../lib/api.js', () => ({
  api: {
    getTransactionPurchase: vi.fn(),
    updatePurchase: vi.fn(),
    removePurchasePayment: vi.fn(),
    deletePurchase: vi.fn(),
  },
}))

const PURCHASE = {
  id: 'p1',
  label: 'Kitchen counters',
  reference: 'INV-4471',
  expected_total: 6000,
  linked_total: 2400,
  unaccounted: 3600,
  payment_count: 2,
  payments: [
    { txn_id: 'dep', date: '2026-03-04', amount: 2400, payee: 'Riverstone Joinery', account_name: 'Rewards Card', trashed: false },
    { txn_id: 'bal', date: '2026-05-19', amount: 3600, payee: 'Riverstone Joinery', account_name: 'Rewards Card', trashed: false },
  ],
}

function renderPanel(props = {}) {
  return render(
    <StrictMode>
      <PurchasePanel txnId="dep" onPurchaseChange={() => {}} {...props} />
    </StrictMode>,
  )
}

beforeEach(() => {
  api.getTransactionPurchase.mockResolvedValue({ purchase: PURCHASE })
  api.updatePurchase.mockResolvedValue(PURCHASE)
  api.removePurchasePayment.mockResolvedValue({ purchase: PURCHASE })
  api.deletePurchase.mockResolvedValue({ ok: true })
})

afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('when the transaction is not part of a purchase', () => {
  it('renders nothing at all rather than an empty section', async () => {
    api.getTransactionPurchase.mockResolvedValue({ purchase: null })
    const { container } = renderPanel()
    await waitFor(() => expect(api.getTransactionPurchase).toHaveBeenCalled())
    expect(container.innerHTML).toBe('')
    expect(screen.queryByText('Purchase')).toBeNull()
  })

  it('stays silent when the read fails, rather than showing a broken section', async () => {
    api.getTransactionPurchase.mockRejectedValue(new Error('offline'))
    const { container } = renderPanel()
    await waitFor(() => expect(api.getTransactionPurchase).toHaveBeenCalled())
    expect(container.innerHTML).toBe('')
  })
})

describe('the summary it shows', () => {
  it('loads under StrictMode, which is what the app runs', async () => {
    renderPanel()
    expect(await screen.findByText('Kitchen counters')).toBeTruthy()
    expect(screen.getByText('INV-4471')).toBeTruthy()
  })

  it('states which payment this is and how the total stands', async () => {
    renderPanel()
    // Spending is stored positive and displayed negative.
    expect(await screen.findByText('Payment 1 of 2 · -$2,400.00 of -$6,000.00')).toBeTruthy()
  })

  it('says only what is known when no expected total was stated', async () => {
    api.getTransactionPurchase.mockResolvedValue({
      purchase: { ...PURCHASE, expected_total: null, unaccounted: null },
    })
    renderPanel()
    expect(await screen.findByText('Payment 1 of 2 · -$2,400.00 linked')).toBeTruthy()
  })

  it('opens the shared editor when the summary is clicked', async () => {
    const user = userEvent.setup()
    renderPanel()
    await user.click(await screen.findByText('Kitchen counters'))
    // The editor is the dialog, not a second inline form: its own fields appear.
    expect(await screen.findByLabelText('Expected total')).toBeTruthy()
  })
})

describe('the host callback contract', () => {
  it('does not refetch when the host passes a new callback identity on every render', async () => {
    // The real host patches its row from this callback, which re-renders the panel with a fresh inline
    // arrow. A panel that depended on that identity would loop between loading and loaded forever —
    // the defect the documents panel shipped, which a stable `vi.fn()` fixture cannot see.
    function Host() {
      const [renders, setRenders] = useState(0)
      return (
        <>
          <button type="button" onClick={() => setRenders(n => n + 1)}>rerender {renders}</button>
          <PurchasePanel txnId="dep" onPurchaseChange={() => {}} />
        </>
      )
    }
    const user = userEvent.setup()
    render(<StrictMode><Host /></StrictMode>)
    await screen.findByText('Kitchen counters')
    const callsAfterMount = api.getTransactionPurchase.mock.calls.length

    await user.click(screen.getByText(/rerender/))
    await user.click(screen.getByText(/rerender/))
    expect(api.getTransactionPurchase.mock.calls.length).toBe(callsAfterMount)
  })

  it('reports the purchase up so the host can keep the ledger row in step', async () => {
    const onPurchaseChange = vi.fn()
    renderPanel({ onPurchaseChange })
    await screen.findByText('Kitchen counters')
    expect(onPurchaseChange).toHaveBeenCalledWith(PURCHASE)
  })

  it('reports null up, and stops rendering, once the editor ungroups the purchase', async () => {
    api.deletePurchase.mockResolvedValue({ ok: true })
    const onPurchaseChange = vi.fn()
    const user = userEvent.setup()
    const { container } = renderPanel({ onPurchaseChange })

    await user.click(await screen.findByText('Kitchen counters'))
    await user.click(await screen.findByText('Ungroup this purchase'))
    const confirms = await screen.findAllByText('Ungroup')
    await user.click(confirms[confirms.length - 1])

    await waitFor(() => expect(onPurchaseChange).toHaveBeenLastCalledWith(null))
    await waitFor(() => expect(container.innerHTML).toBe(''))
  })
})
