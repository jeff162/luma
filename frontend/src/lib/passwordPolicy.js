// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

// The settings flow uses a small shared policy vocabulary so setup, validation, and persistence can talk about the same choices.
export const PASSWORD_POLICIES = [
  {
    value: 'none',
    label: 'No password restrictions',
    hint: 'Allow any non-empty password.',
  },
  {
    value: 'min_8',
    label: '8 character minimum',
    hint: 'Require at least 8 characters.',
  },
  {
    value: 'strong',
    label: 'Strong password requirements',
    hint: 'Require 16+ characters with upper, lower, number, and symbol.',
  },
]

export function passwordPolicyHelpText(policy) {
  if (policy === 'none') return 'Any non-empty password is allowed.'
  if (policy === 'strong') return 'Use 16+ characters with upper, lower, number, and symbol.'
  return 'Use at least 8 characters.'
}

export function validatePasswordForPolicy(password, policy) {
  if (policy === 'none') {
    return password.trim().length > 0
  }
  if (policy === 'strong') {
    return (
      password.length >= 16
      && /[a-z]/.test(password)
      && /[A-Z]/.test(password)
      && /[0-9]/.test(password)
      && /[^A-Za-z0-9]/.test(password)
    )
  }
  return password.length >= 8
}
