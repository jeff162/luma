// @vitest-environment jsdom

// Settings -> Security -> Password. The server decides whether the current password is right; what is pinned
// here is that the form sends both passwords, and that a refusal stays on screen with the form still open.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

vi.mock('../../../lib/api.js', () => ({
  api: {
    getCurrentUser: vi.fn(async () => ({ user: { id: 'u2', username: 'harbor', two_factor_enabled: false, app_passkeys: [] } })),
    signInPasskeyParams: vi.fn(async () => ({})),
    changeOwnPassword: vi.fn(),
  },
}))

const { api } = await import('../../../lib/api.js')
const { default: SignInFactorsSection } = await import('../SignInFactorsSection.jsx')

afterEach(() => { cleanup(); vi.clearAllMocks() })

async function openForm() {
  render(<SignInFactorsSection passwordPolicy="none" />)
  fireEvent.click(await screen.findByRole('button', { name: 'Change password' }))
  fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'the-old-one' } })
  fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'the-new-one' } })
  fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'the-new-one' } })
}

describe('changing your own password', () => {
  it('sends the current and the new password, then closes', async () => {
    api.changeOwnPassword.mockResolvedValue({ user: { id: 'u2' } })
    await openForm()
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }))
    await waitFor(() => expect(api.changeOwnPassword).toHaveBeenCalledWith('the-old-one', 'the-new-one'))
    await waitFor(() => expect(screen.queryByLabelText('Current password')).toBeNull())
  })

  it('keeps the form open on a refusal and says what the server said', async () => {
    api.changeOwnPassword.mockRejectedValue(new Error('The current password is not correct'))
    await openForm()
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }))
    expect(await screen.findByText('The current password is not correct')).toBeTruthy()
    expect(screen.getByLabelText('Current password')).toBeTruthy()
  })
})
