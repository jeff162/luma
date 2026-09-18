// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
//
// The sign-in screen's second-factor step when the server drops the challenge: after too many wrong codes
// the password has to be proven again, so the screen has to go back to asking for it rather than keep
// offering a code box that nothing will accept.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('../../lib/api.js', () => ({
  api: {
    signInPasskeyParams: vi.fn(),
    login: vi.fn(),
    verifyTwoFactor: vi.fn(),
  },
}))

import { api } from '../../lib/api.js'
import AuthScreen from '../AuthScreen.jsx'

function refusal(detail) {
  const error = new Error(detail.message)
  error.status = 429
  error.detail = detail
  return error
}

beforeEach(() => {
  api.signInPasskeyParams.mockResolvedValue({ available: false, reason: 'insecure_context', any_registered: false })
  api.login.mockResolvedValue({ requires_2fa: true, recovery_code_count: 0 })
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

async function reachSecondFactor(user) {
  render(<AuthScreen needsBootstrap={false} passwordPolicy="min_8" onAuthenticated={vi.fn()} />)
  await user.type(screen.getByPlaceholderText('Username'), 'tester')
  await user.type(screen.getByPlaceholderText('Password'), 'a-password')
  await user.click(screen.getByRole('button', { name: 'Sign in' }))
  await screen.findByPlaceholderText('123456')
}

describe('second factor refused for too many attempts', () => {
  it('returns to the password step when the challenge was dropped', async () => {
    const user = userEvent.setup()
    await reachSecondFactor(user)
    api.verifyTwoFactor.mockRejectedValue(refusal({
      code: 'too_many_attempts', message: 'Too many attempts. Try again in 5 minutes.', restart_sign_in: true,
    }))

    await user.type(screen.getByPlaceholderText('123456'), '000000')
    await user.click(screen.getByRole('button', { name: 'Verify code' }))

    expect(await screen.findByText('Too many attempts. Try again in 5 minutes.')).toBeTruthy()
    expect(screen.queryByPlaceholderText('123456')).toBeNull()
    expect(screen.getByPlaceholderText('Password').value).toBe('')
  })

  it('stays on the code step when only the pace was refused', async () => {
    const user = userEvent.setup()
    await reachSecondFactor(user)
    api.verifyTwoFactor.mockRejectedValue(refusal({
      code: 'too_many_attempts', message: 'Too many attempts. Try again in 2 seconds.',
    }))

    await user.type(screen.getByPlaceholderText('123456'), '000000')
    await user.click(screen.getByRole('button', { name: 'Verify code' }))

    expect(await screen.findByText('Too many attempts. Try again in 2 seconds.')).toBeTruthy()
    expect(screen.getByPlaceholderText('123456')).toBeTruthy()
  })
})
