// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
//
// The sign-in screen's password-choosing steps, shaped like the report that prompted them: a correct
// password sat beside "does not meet the policy" because the message described the *previous* attempt,
// and nothing re-checked the field as it was typed. So each case here types, looks at what the screen
// says about what is typed *now*, and presses the button — asserting what the press did or did not do,
// rather than the disabled attribute alone.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('../../lib/api.js', () => ({
  api: {
    signInPasskeyParams: vi.fn(),
    // The screen asks whether the server has a certificate to hand out; here it has none.
    getProxyCertificate: () => Promise.resolve({ available: false }),
    login: vi.fn(),
    bootstrap: vi.fn(),
    changePassword: vi.fn(),
  },
}))

import { api } from '../../lib/api.js'
import AuthScreen from '../AuthScreen.jsx'

beforeEach(() => {
  api.signInPasskeyParams.mockResolvedValue({ available: false, reason: 'insecure_context', any_registered: false })
  api.login.mockResolvedValue({ requires_password_change: true })
  api.changePassword.mockResolvedValue({ user: { id: 'u1' } })
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

async function reachForcedChange(user) {
  render(<AuthScreen needsBootstrap={false} passwordPolicy="min_8" onAuthenticated={vi.fn()} />)
  await user.type(screen.getByPlaceholderText('Username'), 'tester')
  await user.type(screen.getByPlaceholderText('Password'), 'old-password')
  await user.click(screen.getByRole('button', { name: 'Sign in' }))
  await screen.findByPlaceholderText('New password')
}

describe('forced password change', () => {
  it('reports the shortfall as it is typed and will not submit it', async () => {
    const user = userEvent.setup()
    await reachForcedChange(user)

    await user.type(screen.getByPlaceholderText('New password'), 'mytest1')
    expect(screen.getByText('1 more character needed (at least 8).', { selector: '[role="status"]' })).toBeTruthy()

    await user.type(screen.getByPlaceholderText('Confirm new password'), 'mytest1')
    await user.click(screen.getByRole('button', { name: 'Set password' }))
    expect(api.changePassword).not.toHaveBeenCalled()
  })

  it('drops the note once the password meets the policy, and submits it', async () => {
    const user = userEvent.setup()
    await reachForcedChange(user)

    await user.type(screen.getByPlaceholderText('New password'), 'mytest1')
    await user.type(screen.getByPlaceholderText('New password'), '234')
    expect(screen.queryByText(/more character/)).toBeNull()

    await user.type(screen.getByPlaceholderText('Confirm new password'), 'mytest1234')
    await user.click(screen.getByRole('button', { name: 'Set password' }))
    await waitFor(() => expect(api.changePassword).toHaveBeenCalledWith('mytest1234'))
  })

  it('says the passwords differ from the first confirm character, and will not submit them', async () => {
    const user = userEvent.setup()
    await reachForcedChange(user)

    await user.type(screen.getByPlaceholderText('New password'), 'mytest1234')
    await user.type(screen.getByPlaceholderText('Confirm new password'), 'my')
    expect(screen.getByText('The passwords do not match.', { selector: '[role="status"]' })).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Set password' }))
    expect(api.changePassword).not.toHaveBeenCalled()
  })

  it('retires an error about the previous attempt as soon as the password is edited', async () => {
    // The reported case: a refusal left on screen beside the value that replaced it.
    api.changePassword.mockRejectedValueOnce(new Error('That password was refused.'))
    const user = userEvent.setup()
    await reachForcedChange(user)

    await user.type(screen.getByPlaceholderText('New password'), 'mytest1234')
    await user.type(screen.getByPlaceholderText('Confirm new password'), 'mytest1234')
    await user.click(screen.getByRole('button', { name: 'Set password' }))
    await screen.findByText('That password was refused.')

    await user.type(screen.getByPlaceholderText('New password'), '5')
    expect(screen.queryByText('That password was refused.')).toBeNull()
  })
})

describe('first account', () => {
  it('reports the shortfall as it is typed and will not create the account', async () => {
    const user = userEvent.setup()
    render(<AuthScreen needsBootstrap passwordPolicy="min_8" onAuthenticated={vi.fn()} />)

    await user.type(screen.getByPlaceholderText('Username'), 'tester')
    await user.type(screen.getByPlaceholderText('Password'), 'abc')
    expect(screen.getByText('5 more characters needed (at least 8).', { selector: '[role="status"]' })).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Create first account' }))
    expect(api.bootstrap).not.toHaveBeenCalled()
  })
})

describe('signing in', () => {
  it('holds an existing password to nothing — the policy may have tightened since it was set', async () => {
    api.login.mockResolvedValueOnce({ user: { id: 'u1' } })
    const user = userEvent.setup()
    render(<AuthScreen needsBootstrap={false} passwordPolicy="strong" onAuthenticated={vi.fn()} />)

    await user.type(screen.getByPlaceholderText('Username'), 'tester')
    await user.type(screen.getByPlaceholderText('Password'), 'short')
    expect(screen.queryByText(/more character/)).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(api.login).toHaveBeenCalledWith('tester', 'short'))
  })
})
