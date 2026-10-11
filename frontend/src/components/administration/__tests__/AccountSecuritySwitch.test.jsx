// @vitest-environment jsdom

// The sign-in protection switch at the top of Administration's sign-in section.
//
// Neither direction takes effect on the click — turning on needs a password, turning off needs a confirm —
// so the switch has to keep showing the stored state until the change is made. A switch that slid to "on"
// beside an empty password field would be reporting a perimeter that does not exist.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

vi.mock('../../../lib/api.js', () => ({
  api: {
    getIdentities: vi.fn(async () => ({ identities: [{ id: 'u1', display_name: 'Harbor', username: 'harbor' }] })),
    disableAuth: vi.fn(),
    enableAuth: vi.fn(),
    savePasswordPolicy: vi.fn(),
  },
}))

const { AccountSecuritySection } = await import('../AccountSecuritySection.jsx')

afterEach(cleanup)

const renderSection = props => render(
  <AccountSecuritySection passwordPolicy="none" onPasswordPolicyChange={() => {}} {...props} />,
)

describe('the sign-in protection switch', () => {
  it('opens the enable form without moving, and Cancel closes it', async () => {
    renderSection({ authEnabled: false })
    const toggle = screen.getByRole('switch', { name: 'Sign-in protection' })
    fireEvent.click(toggle)
    expect(await screen.findByLabelText('Your password')).toBeTruthy()
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByLabelText('Your password')).toBeNull()
  })

  it('asks before turning off, and stays on until confirmed', () => {
    renderSection({ authEnabled: true })
    const toggle = screen.getByRole('switch', { name: 'Sign-in protection' })
    fireEvent.click(toggle)
    expect(screen.getByText('Turn off sign-in protection?')).toBeTruthy()
    expect(toggle.getAttribute('aria-checked')).toBe('true')
  })
})
