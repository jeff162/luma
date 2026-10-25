// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom

// The live feedback every app-password form reads. What matters is that each policy's shortfall is
// reported as the *specific* unmet condition, that an untouched field says nothing, and that the reason
// the button is greyed is always one the screen can show.

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { api } from '../api.js'
import {
  PASSWORD_MISMATCH, passwordIssue, passwordMismatchShown, passwordShortfall, usePasswordChecks,
} from '../passwordPolicy.js'

vi.mock('../api.js', () => ({ api: { passwordStrength: vi.fn() } }))

// A form's judge under a policy decided here, with no server involved.
const checkFor = policy => value => ({ shortfall: passwordShortfall(value, policy), pending: false })

describe('passwordShortfall', () => {
  it('says nothing about an untouched field', () => {
    for (const policy of ['none', 'min_8', 'strong']) {
      expect(passwordShortfall('', policy)).toBeNull()
      expect(passwordShortfall(undefined, policy)).toBeNull()
    }
  })

  it('counts down to the minimum length', () => {
    expect(passwordShortfall('mytest1', 'min_8')).toBe('1 more character needed (at least 8).')
    expect(passwordShortfall('abc', 'min_8')).toBe('5 more characters needed (at least 8).')
    // The case from the report: ten characters under an 8-character minimum is simply fine.
    expect(passwordShortfall('mytest1234', 'min_8')).toBeNull()
  })

  it('treats an unknown or missing policy as the 8-character minimum', () => {
    // The same fallback `passwordPolicyHelpText` uses, so the hint and the check cannot disagree.
    expect(passwordShortfall('short', undefined)).toBe('3 more characters needed (at least 8).')
  })

  it('under no restrictions refuses only a password made of spaces', () => {
    expect(passwordShortfall('a', 'none')).toBeNull()
    expect(passwordShortfall('   ', 'none')).toBe('A password cannot be only spaces.')
  })

  it('leaves a strong password to the server', () => {
    expect(passwordShortfall('abc', 'strong')).toBeNull()
  })
})

describe('usePasswordChecks', () => {
  beforeEach(() => { api.passwordStrength.mockReset() })

  it('asks the server under "Strong", and says what made a password guessable', async () => {
    api.passwordStrength.mockImplementation(async value => (value === 'password123'
      ? { strong: false, warning: 'This is a very common password.', suggestions: ['Add another word or two.'] }
      : { strong: true, warning: '', suggestions: [] }))
    const { result } = renderHook(() => usePasswordChecks('strong', ['password123', 'saddle-quartz-ember-tidy']))
    expect(result.current('password123')).toEqual({ shortfall: null, pending: true })
    await waitFor(() => expect(result.current('password123').pending).toBe(false))
    expect(result.current('password123').shortfall).toBe('This is a very common password. Add another word or two.')
    await waitFor(() => expect(result.current('saddle-quartz-ember-tidy')).toEqual({ shortfall: null, pending: false }))
  })

  it('does not block the form when the server cannot be asked', async () => {
    api.passwordStrength.mockRejectedValue(new Error('offline'))
    const { result } = renderHook(() => usePasswordChecks('strong', ['anything']))
    await waitFor(() => expect(result.current('anything')).toEqual({ shortfall: null, pending: false }))
  })

  it('judges the other policies here, without asking', () => {
    const { result } = renderHook(() => usePasswordChecks('min_8', ['abc']))
    expect(result.current('abc').shortfall).toBe('5 more characters needed (at least 8).')
    expect(api.passwordStrength).not.toHaveBeenCalled()
  })
})

describe('passwordIssue', () => {
  const check = checkFor('min_8')

  it('asks for a password before anything else, unless blank means "keep the current one"', () => {
    expect(passwordIssue({ password: '', check })).toBe('Enter a password.')
    expect(passwordIssue({ password: '', check, optional: true })).toBe('')
    // An optional field that *has* been typed into is still held to the policy.
    expect(passwordIssue({ password: 'abc', check, optional: true }))
      .toBe('5 more characters needed (at least 8).')
  })

  it('reports the policy before the confirmation', () => {
    expect(passwordIssue({ password: 'abc', confirm: 'xyz', check, withConfirm: true }))
      .toBe('5 more characters needed (at least 8).')
  })

  it('asks for the confirmation, then for it to match', () => {
    const base = { password: 'mytest1234', check, withConfirm: true }
    expect(passwordIssue({ ...base, confirm: '' })).toBe('Re-enter the password to confirm it.')
    expect(passwordIssue({ ...base, confirm: 'mytest123' })).toBe(PASSWORD_MISMATCH)
    expect(passwordIssue({ ...base, confirm: 'mytest1234' })).toBe('')
  })

  it('ignores a confirm value on a form that has no confirmation field', () => {
    expect(passwordIssue({ password: 'mytest1234', confirm: 'other', check })).toBe('')
  })

  it('holds the button while a "Strong" verdict is on its way', () => {
    const pending = () => ({ shortfall: null, pending: true })
    expect(passwordIssue({ password: 'anything', check: pending })).not.toBe('')
  })
})

describe('passwordMismatchShown', () => {
  it('shows from the first confirm character, including a correct prefix', () => {
    expect(passwordMismatchShown('mytest1234', '')).toBe(false)
    expect(passwordMismatchShown('mytest1234', 'my')).toBe(true)
    expect(passwordMismatchShown('mytest1234', 'mytest1234')).toBe(false)
  })
})
