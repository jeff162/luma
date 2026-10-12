// @vitest-environment jsdom

// The line the *locked* vault strip shows when somebody is waiting to be let in.
//
// It exists because the waiting count used to ride the "Vault settings" button, which only the unlocked
// strip renders — so a member who had not unlocked saw nothing at all, and the person waiting waited on
// a signal nobody was ever shown. Names rather than counts, for the reason the recovery dialog names
// members: "somebody is waiting" cannot be acted on, "Robin is waiting" can.

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

const { WaitingForAccess } = await import('../ConnectionsTab.jsx')

afterEach(cleanup)

const named = (...names) => names.map((display_name, i) => ({ slot_id: `s${i}`, display_name }))

describe('the waiting-for-access line', () => {
  it('renders nothing when nobody is waiting', () => {
    const { container } = render(<WaitingForAccess waiting={[]} />)
    expect(container.textContent).toBe('')
  })

  it('names one person, and points at the step before approving', () => {
    render(<WaitingForAccess waiting={named('Robin')} />)
    expect(screen.getByText(/Robin is waiting for vault access/)).toBeTruthy()
    // The button beside this line is Unlock, which is genuinely the next step: approving shares the key,
    // so the key has to be in hand first.
    expect(screen.getByText(/Unlock to approve/)).toBeTruthy()
  })

  it('joins two names, and agrees the verb', () => {
    render(<WaitingForAccess waiting={named('Robin', 'Frances')} />)
    expect(screen.getByText(/Robin and Frances are waiting/)).toBeTruthy()
  })

  it('joins three or more with commas and a final "and"', () => {
    render(<WaitingForAccess waiting={named('Robin', 'Frances', 'Sam')} />)
    expect(screen.getByText(/Robin, Frances and Sam are waiting/)).toBeTruthy()
  })

  it('falls back to "Somebody" rather than an empty subject', () => {
    // A request whose display name did not come back is still a request, and dropping the sentence would
    // hide it entirely — which is the failure this whole line exists to fix.
    render(<WaitingForAccess waiting={[{ slot_id: 's1', display_name: null }]} />)
    expect(screen.getByText(/Somebody is waiting/)).toBeTruthy()
  })
})
