// @vitest-environment jsdom

// The multi-payment purchase editor — the one place a purchase is changed, opened both from the ledger
// row's marker and from the detail panel's summary.
//
// Four things here are worth pinning. **It portals to the body**, which is not tidiness: one of its two
// hosts is a ledger row, and a `position: fixed` overlay inside a table stacks against whatever
// ancestor established a containing block — the bug `DocumentViewerDialog` records. **The typed
// magnitude leaves as a signed ledger amount**, so a test asserting only "6000 was sent" would pass
// against an implementation that dropped the derivation. **A reload does not reset the form**, since
// removing a payment refetches and re-seeding there would discard a name already typed. And **removing
// the second-to-last payment warns that it ungroups the purchase**, which is the one outcome a person
// would not predict from the button.
//
// Note the assertion style on buttons: a gate is asserted by clicking and checking the call never went
// out, which tests the action rather than the attribute.

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import PurchaseEditorDialog from '../PurchaseEditorDialog.jsx'
import { api } from '../../lib/api.js'

vi.mock('../../lib/api.js', () => ({
  api: {
    getTransactionPurchase: vi.fn(),
    updatePurchase: vi.fn(),
    removePurchasePayment: vi.fn(),
    deletePurchase: vi.fn(),
  },
}))

const payments = [
  { txn_id: 'dep', date: '2026-03-04', amount: 2400, payee: 'Riverstone Joinery', account_name: 'Rewards Card', trashed: false },
  { txn_id: 'bal', date: '2026-05-19', amount: 3600, payee: 'Riverstone Joinery', account_name: 'Rewards Card', trashed: false },
]

const PURCHASE = {
  id: 'p1',
  label: 'Kitchen counters',
  reference: 'INV-4471',
  expected_total: 6000,
  linked_total: 6000,
  unaccounted: 0,
  payment_count: 2,
  payments,
}

function renderDialog(props = {}) {
  return render(
    <PurchaseEditorDialog txnId="dep" onClose={() => {}} onSaved={() => {}} {...props} />,
  )
}

beforeEach(() => {
  api.getTransactionPurchase.mockResolvedValue({ purchase: PURCHASE })
  api.updatePurchase.mockResolvedValue(PURCHASE)
  api.removePurchasePayment.mockResolvedValue({ purchase: PURCHASE })
  api.deletePurchase.mockResolvedValue({ ok: true })
})

afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('where it renders', () => {
  it('escapes to the body rather than staying inside whatever opened it', async () => {
    // Its hosts include a ledger row, and a fixed overlay inside a table is clipped and mis-stacked by
    // its ancestors. Asserting the escape rather than the symptom, which needs real layout to see.
    const { container } = renderDialog()
    await screen.findByText('Kitchen counters')
    expect(container.innerHTML).toBe('')
    expect(document.body.textContent).toContain('Kitchen counters')
  })
})

describe('what it shows', () => {
  it('lists every payment, oldest first, in the ledger\'s display convention', async () => {
    renderDialog()
    await screen.findByText('Kitchen counters')
    expect(screen.getByText('Mar 4, 2026')).toBeTruthy()
    expect(screen.getByText('May 19, 2026')).toBeTruthy()
    // Spending is stored positive and displayed negative.
    expect(screen.getByText('-$2,400.00')).toBeTruthy()
    expect(screen.getByText('-$3,600.00')).toBeTruthy()
  })

  it('names the gap "Unaccounted" rather than claiming a payment is owed', async () => {
    api.getTransactionPurchase.mockResolvedValue({
      purchase: { ...PURCHASE, linked_total: 2400, unaccounted: 3600, payment_count: 1 },
    })
    renderDialog()
    expect(await screen.findByText('Unaccounted')).toBeTruthy()
    expect(screen.queryByText('Fully accounted for')).toBeNull()
  })

  it('leaves a trashed payment out of the total while still showing it', async () => {
    api.getTransactionPurchase.mockResolvedValue({
      purchase: {
        ...PURCHASE,
        linked_total: 2400,
        payment_count: 1,
        payments: [payments[0], { ...payments[1], trashed: true }],
      },
    })
    renderDialog()
    await screen.findByText('Kitchen counters')
    expect(screen.getByText('May 19, 2026')).toBeTruthy()
    expect(screen.getByText('Linked (1)')).toBeTruthy()
  })

  it('recomputes the gap against the total being typed, not the saved one', async () => {
    const user = userEvent.setup()
    renderDialog()
    await screen.findByText('Kitchen counters')
    expect(screen.getByText('Fully accounted for')).toBeTruthy()

    const totalField = screen.getByLabelText('Expected total')
    await user.clear(totalField)
    await user.type(totalField, '6500')
    expect(await screen.findByText('Unaccounted')).toBeTruthy()
  })

  it('says the purchase is gone rather than showing an empty form', async () => {
    api.getTransactionPurchase.mockResolvedValue({ purchase: null })
    renderDialog()
    expect(await screen.findByText('This transaction is no longer part of a purchase.')).toBeTruthy()
  })
})

describe('editing its fields', () => {
  it('sends the typed magnitude back signed in the ledger\'s convention', async () => {
    const user = userEvent.setup()
    renderDialog()
    await screen.findByText('Kitchen counters')

    const totalField = screen.getByLabelText('Expected total')
    await user.clear(totalField)
    await user.type(totalField, '6500')
    await user.click(screen.getByText('Save'))

    await waitFor(() => expect(api.updatePurchase).toHaveBeenCalled())
    // The payments are money out (stored positive), so the magnitude points that way too.
    expect(api.updatePurchase.mock.calls[0][1].expected_total).toBe(6500)
  })

  it('does not persist an edit that was cancelled', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    renderDialog({ onClose })
    await screen.findByText('Kitchen counters')

    await user.type(screen.getByLabelText('Purchase name'), ' extra')
    await user.click(screen.getByText('Cancel'))
    expect(api.updatePurchase).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it('shows a rejected save rather than swallowing it', async () => {
    api.updatePurchase.mockRejectedValue(new Error('That expected total is not an amount.'))
    const user = userEvent.setup()
    renderDialog()
    await screen.findByText('Kitchen counters')

    await user.click(screen.getByText('Save'))
    expect(await screen.findByText('That expected total is not an amount.')).toBeTruthy()
  })
})

describe('repairing a purchase', () => {
  const threePayments = {
    ...PURCHASE,
    payment_count: 3,
    payments: [...payments, { txn_id: 'x', date: '2026-06-02', amount: 100, payee: 'Northgate Supply', account_name: 'Rewards Card', trashed: false }],
  }

  it('asks before removing a payment, and warns when it would ungroup the purchase', async () => {
    const user = userEvent.setup()
    renderDialog()
    await screen.findByText('Kitchen counters')

    await user.click(screen.getAllByLabelText('Remove this payment from the purchase')[0])
    expect(await screen.findByText(/leaves only one payment/)).toBeTruthy()
    expect(api.removePurchasePayment).not.toHaveBeenCalled()
  })

  it('does not warn about ungrouping when enough payments remain', async () => {
    api.getTransactionPurchase.mockResolvedValue({ purchase: threePayments })
    const user = userEvent.setup()
    renderDialog()
    await screen.findByText('Kitchen counters')

    await user.click(screen.getAllByLabelText('Remove this payment from the purchase')[0])
    expect(await screen.findByText(/stops counting toward this purchase/)).toBeTruthy()
    expect(screen.queryByText(/leaves only one payment/)).toBeNull()
  })

  it('keeps what was already typed when a removal reloads the purchase', async () => {
    // Removing refetches, and re-seeding the form there would silently discard a name in progress.
    api.getTransactionPurchase.mockResolvedValue({ purchase: threePayments })
    api.removePurchasePayment.mockResolvedValue({ purchase: PURCHASE })
    const user = userEvent.setup()
    renderDialog()
    await screen.findByText('Kitchen counters')

    const nameField = screen.getByLabelText('Purchase name')
    await user.clear(nameField)
    await user.type(nameField, 'Deck rebuild')
    await user.click(screen.getAllByLabelText('Remove this payment from the purchase')[0])
    await user.click(await screen.findByText('Remove', { selector: 'button' }))

    await waitFor(() => expect(api.removePurchasePayment).toHaveBeenCalled())
    expect(screen.getByLabelText('Purchase name').value).toBe('Deck rebuild')
  })

  it('reports null and closes when removing the payment took the purchase with it', async () => {
    api.removePurchasePayment.mockResolvedValue({ purchase: null })
    const onSaved = vi.fn()
    const onClose = vi.fn()
    const user = userEvent.setup()
    renderDialog({ onSaved, onClose })
    await screen.findByText('Kitchen counters')

    await user.click(screen.getAllByLabelText('Remove this payment from the purchase')[0])
    await user.click(await screen.findByText('Remove', { selector: 'button' }))
    await waitFor(() => expect(onSaved).toHaveBeenLastCalledWith(null))
    expect(onClose).toHaveBeenCalled()
  })

  it('ungroups the whole purchase behind its own confirm', async () => {
    const onSaved = vi.fn()
    const user = userEvent.setup()
    renderDialog({ onSaved })
    await screen.findByText('Kitchen counters')

    await user.click(screen.getByText('Ungroup this purchase'))
    expect(api.deletePurchase).not.toHaveBeenCalled()

    const confirms = await screen.findAllByText('Ungroup')
    await user.click(confirms[confirms.length - 1])
    await waitFor(() => expect(api.deletePurchase).toHaveBeenCalledWith('p1'))
    await waitFor(() => expect(onSaved).toHaveBeenLastCalledWith(null))
  })
})
