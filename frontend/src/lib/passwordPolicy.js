// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// The settings flow uses a small shared policy vocabulary so setup, validation, and persistence can talk about the same choices.
//
// Every form that sets an app password — enabling sign-in, the first account, a forced change at
// sign-in, adding and editing users — reads its feedback from `passwordIssue` below, so each one says
// what is still wrong *while* the password is typed and greys its button for that reason, rather than
// accepting the click and answering with an error. That is the vault passphrase dialog's shape
// (`VaultPassphraseDialog.jsx`, `vaultPassphrase.js`), and the rule it came with applies here too: a
// control must never be greyed for a reason the screen does not give.
//
// The server (`validate_password_for_policy` in `db/control_database.py`) enforces the same policies and
// refuses anything this lets through, so this is feedback rather than the gate. Where the two differ the
// client is the stricter one — `none` refuses a password made only of spaces, which the server accepts —
// and that is the safe direction for them to disagree in.

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

export const PASSWORD_MISMATCH = 'The passwords do not match.'

export function passwordPolicyHelpText(policy) {
  if (policy === 'none') return 'Any non-empty password is allowed.'
  if (policy === 'strong') return 'Use 16+ characters with upper, lower, number, and symbol.'
  return 'Use at least 8 characters.'
}

function charactersNeeded(password, minimum) {
  const missing = minimum - password.length
  return `${missing} more character${missing === 1 ? '' : 's'} needed (at least ${minimum}).`
}

// Why this password does not meet the policy yet, or null when it does.
//
// A reason rather than a boolean, so the screen can say whether someone is two characters short or is
// missing a symbol. An empty password yields null: an untouched field is not yet wrong, and telling
// someone their blank input fails the policy the moment a form opens is noise — `passwordIssue` covers
// the empty case separately, for the button's hover.
export function passwordShortfall(password, policy) {
  const value = password || ''
  if (!value) return null
  if (policy === 'none') {
    return value.trim() ? null : 'A password cannot be only spaces.'
  }
  if (policy === 'strong') {
    if (value.length < 16) return charactersNeeded(value, 16)
    const missing = [
      !/[a-z]/.test(value) && 'a lowercase letter',
      !/[A-Z]/.test(value) && 'an uppercase letter',
      !/[0-9]/.test(value) && 'a number',
      !/[^A-Za-z0-9]/.test(value) && 'a symbol',
    ].filter(Boolean)
    if (!missing.length) return null
    const list = missing.length === 1
      ? missing[0]
      : `${missing.slice(0, -1).join(', ')} and ${missing[missing.length - 1]}`
    return `Add ${list}.`
  }
  return value.length < 8 ? charactersNeeded(value, 8) : null
}

// Everything still wrong with a password field (and its confirmation, where the form has one), as the
// one sentence the form shows. One expression feeds both places it is needed — the note under the
// fields and the hover on the button it disables — so the two can never give different reasons.
//
// `optional` is for a field whose blank value means "leave it alone" (a user's password when editing
// them, another member's starting password): blank is then fine, not missing.
export function passwordIssue({ password, confirm, policy, withConfirm = false, optional = false }) {
  const value = password || ''
  if (!value) return optional ? '' : 'Enter a password.'
  const shortfall = passwordShortfall(value, policy)
  if (shortfall) return shortfall
  if (withConfirm) {
    if (!confirm) return 'Re-enter the password to confirm it.'
    if (value !== confirm) return PASSWORD_MISMATCH
  }
  return ''
}

// Whether the "do not match" note belongs on screen. Shown from the first character typed into the
// confirmation — including while what has been typed is still a correct prefix, because staying silent
// there reads as "so far so good" and leaves someone who stopped a character short with a greyed button
// and nothing to explain it. The vault dialog's reasoning, unchanged.
export function passwordMismatchShown(password, confirm) {
  return !!confirm && (password || '') !== confirm
}
