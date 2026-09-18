// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// The live feedback every app-password form reads. What matters is that each policy's shortfall is
// reported as the *specific* unmet condition, that an untouched field says nothing, and that the reason
// the button is greyed is always one the screen can show.

import { describe, expect, it } from 'vitest'
import {
  PASSWORD_MISMATCH, passwordIssue, passwordMismatchShown, passwordShortfall,
} from '../passwordPolicy.js'

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

  it('names exactly the character classes a strong password is missing', () => {
    expect(passwordShortfall('Abc1!', 'strong')).toBe('11 more characters needed (at least 16).')
    expect(passwordShortfall('abcdefghijklmnop', 'strong')).toBe('Add an uppercase letter, a number and a symbol.')
    expect(passwordShortfall('Abcdefghijklmnop1', 'strong')).toBe('Add a symbol.')
    expect(passwordShortfall('Abcdefghijklmn1!', 'strong')).toBeNull()
  })
})

describe('passwordIssue', () => {
  it('asks for a password before anything else, unless blank means "keep the current one"', () => {
    expect(passwordIssue({ password: '', policy: 'min_8' })).toBe('Enter a password.')
    expect(passwordIssue({ password: '', policy: 'min_8', optional: true })).toBe('')
    // An optional field that *has* been typed into is still held to the policy.
    expect(passwordIssue({ password: 'abc', policy: 'min_8', optional: true }))
      .toBe('5 more characters needed (at least 8).')
  })

  it('reports the policy before the confirmation', () => {
    expect(passwordIssue({ password: 'abc', confirm: 'xyz', policy: 'min_8', withConfirm: true }))
      .toBe('5 more characters needed (at least 8).')
  })

  it('asks for the confirmation, then for it to match', () => {
    const base = { password: 'mytest1234', policy: 'min_8', withConfirm: true }
    expect(passwordIssue({ ...base, confirm: '' })).toBe('Re-enter the password to confirm it.')
    expect(passwordIssue({ ...base, confirm: 'mytest123' })).toBe(PASSWORD_MISMATCH)
    expect(passwordIssue({ ...base, confirm: 'mytest1234' })).toBe('')
  })

  it('ignores a confirm value on a form that has no confirmation field', () => {
    expect(passwordIssue({ password: 'mytest1234', confirm: 'other', policy: 'min_8' })).toBe('')
  })
})

describe('passwordMismatchShown', () => {
  it('shows from the first confirm character, including a correct prefix', () => {
    expect(passwordMismatchShown('mytest1234', '')).toBe(false)
    expect(passwordMismatchShown('mytest1234', 'my')).toBe(true)
    expect(passwordMismatchShown('mytest1234', 'mytest1234')).toBe(false)
  })
})
