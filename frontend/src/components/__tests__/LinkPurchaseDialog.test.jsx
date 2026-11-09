// @vitest-environment jsdom

// The dialog behind the ledger's "Link as one purchase" bulk action.
//
// What is worth pinning is the decision it makes without asking: a selection that already touches one
// purchase *adds* to it, one that touches none *creates*, and one spanning two is refused rather than
// merged. Getting that wrong silently produces the wrong request against the wrong purchase, which is
// exactly the class of mistake a user would not notice until a total was wrong.
//
// The other property here is the sign seam: the box takes a magnitude and the request carries a signed
// ledger amount. A test asserting only that "6000 was sent" would pass against an implementation that
// dropped the derivation entirely.

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import LinkPurchaseDialog from '../LinkPurchaseDialog.jsx'
import { api } from '../../lib/api.js'

// A floating dialog remembers where it was left, a saved preference; local state stands in for the
// app's provider.
vi.mock('../../lib/UserPreferencesContext.jsx', async (importOriginal) => {
  const { useState } = await import('react')
  return { ...(await importOriginal()), useUserPreference: (_key, initial) => useState(initial) }
})

vi.mock('../../lib/api.js', () => ({
  api: { createPurchase: vi.fn(), addPurchasePayments: vi.fn() },
}))

const deposit = { id: 'dep', date: '2026-03-04', amount: 2400, display_name: 'Riverstone Joinery', purchase: null }
const balance = { id: 'bal', date: '2026-05-19', amount: 3600, display_name: 'Riverstone Joinery', purchase: null }

function renderDialog(rows, props = {}) {
  return render(
    <LinkPurchaseDialog rows={rows} onClose={() => {}} onLinked={() => {}} {...props} />,
  )
}

beforeEach(() => {
  api.createPurchase.mockResolvedValue({ id: 'p1' })
  api.addPurchasePayments.mockResolvedValue({ id: 'p1' })
})

afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('creating a purchase from unlinked payments', () => {
  it('lists the payments and their total so an extra row is visible before saving', () => {
    renderDialog([deposit, balance])
    expect(screen.getByText('Mar 4, 2026')).toBeTruthy()
    expect(screen.getByText('May 19, 2026')).toBeTruthy()
    expect(screen.getByText('Purchase total (2 payments)')).toBeTruthy()
    expect(screen.getByText('-$6,000.00')).toBeTruthy()
  })

  it('proposes the shared payee as the name', () => {
    renderDialog([deposit, balance])
    expect(screen.getByLabelText('Purchase name').value).toBe('Riverstone Joinery')
  })

  it('sends the typed magnitude as a signed ledger amount', async () => {
    const user = userEvent.setup()
    renderDialog([deposit, balance])
    await user.type(screen.getByLabelText('Expected total'), '6000')
    await user.click(screen.getByText('Link purchase'))

    await waitFor(() => expect(api.createPurchase).toHaveBeenCalled())
    expect(api.createPurchase.mock.calls[0][0]).toMatchObject({
      txn_ids: ['dep', 'bal'],
      // Money out is stored positive, and that is the direction these payments point.
      expected_total: 6000,
    })
  })

  it('sends no expected total when the box was left empty, rather than zero', async () => {
    const user = userEvent.setup()
    renderDialog([deposit, balance])
    await user.click(screen.getByText('Link purchase'))
    await waitFor(() => expect(api.createPurchase).toHaveBeenCalled())
    expect(api.createPurchase.mock.calls[0][0].expected_total).toBeNull()
  })

  it('shows a refusal from the server rather than swallowing it', async () => {
    api.createPurchase.mockRejectedValue(new Error('A payment can only belong to one purchase.'))
    const user = userEvent.setup()
    renderDialog([deposit, balance])
    await user.click(screen.getByText('Link purchase'))
    expect(await screen.findByText('A payment can only belong to one purchase.')).toBeTruthy()
  })
})

describe('adding to a purchase the selection already touches', () => {
  const linked = {
    ...balance,
    purchase: { id: 'p1', label: 'Kitchen counters', linked_total: 3600, payment_count: 1 },
  }

  it('adds the unlinked payments instead of creating a second purchase', async () => {
    const user = userEvent.setup()
    renderDialog([linked, deposit])
    expect(screen.getByText('Add to Kitchen counters')).toBeTruthy()

    await user.click(screen.getByText('Add payments'))
    await waitFor(() => expect(api.addPurchasePayments).toHaveBeenCalledWith('p1', ['dep']))
    expect(api.createPurchase).not.toHaveBeenCalled()
  })

  it('counts what is already linked into the total it shows', () => {
    renderDialog([linked, deposit])
    expect(screen.getByText('Purchase total once added')).toBeTruthy()
    expect(screen.getByText('-$6,000.00')).toBeTruthy()
  })
})

describe('selections it will not act on', () => {
  it('refuses one spanning two purchases rather than merging them', async () => {
    const user = userEvent.setup()
    renderDialog([
      { ...deposit, purchase: { id: 'p1', label: 'Deck' } },
      { ...balance, purchase: { id: 'p2', label: 'Kitchen' } },
    ])
    expect(screen.getByText(/already in different purchases/)).toBeTruthy()
    // No save button at all — an action that would fail is not offered.
    expect(screen.queryByText('Link purchase')).toBeNull()
    await user.click(screen.getByText('Cancel'))
    expect(api.createPurchase).not.toHaveBeenCalled()
  })

  it('says so when every selected payment is already in the same purchase', () => {
    const inOne = purchaseId => ({ id: purchaseId, label: 'Deck' })
    renderDialog([
      { ...deposit, purchase: inOne('p1') },
      { ...balance, purchase: inOne('p1') },
    ])
    expect(screen.getByText(/already grouped as Deck/)).toBeTruthy()
  })
})
