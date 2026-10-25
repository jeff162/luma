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
//
// "Strong" is the server's strength estimator at its top score, the vault passphrase's test, so it cannot
// be judged here: `usePasswordChecks` asks the server as the password is typed. A failed request leaves no
// issue rather than wedging the form, since the server refuses a weak password on submit anyway.

import { useEffect, useRef, useState } from 'react'
import { api } from './api.js'

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
    label: 'Strong',
    hint: 'Require a password that is hard to guess.',
  },
]

export const PASSWORD_MISMATCH = 'The passwords do not match.'

export function passwordPolicyHelpText(policy) {
  if (policy === 'none') return 'Any non-empty password is allowed.'
  if (policy === 'strong') return 'Use a password that is hard to guess.'
  return 'Use at least 8 characters.'
}

function charactersNeeded(password, minimum) {
  const missing = minimum - password.length
  return `${missing} more character${missing === 1 ? '' : 's'} needed (at least ${minimum}).`
}

// Why this password does not meet a policy that can be judged here yet, or null when it does. "Strong"
// cannot, and always yields null: `usePasswordChecks` holds its verdict.
//
// A reason rather than a boolean, so the screen can say how many characters someone is short. An empty
// password yields null: an untouched field is not yet wrong, and telling someone their blank input fails
// the policy the moment a form opens is noise — `passwordIssue` covers the empty case separately, for the
// button's hover.
export function passwordShortfall(password, policy) {
  const value = password || ''
  if (!value) return null
  if (policy === 'none') {
    return value.trim() ? null : 'A password cannot be only spaces.'
  }
  if (policy === 'strong') return null
  return value.length < 8 ? charactersNeeded(value, 8) : null
}

// The server's verdict on a "Strong" password, said as something to act on: the estimator's own warning,
// then its first suggestion.
function describeWeak(verdict) {
  const parts = [verdict.warning || 'This password is too easy to guess.']
  if (verdict.suggestions?.length) parts.push(verdict.suggestions[0])
  return parts.join(' ')
}

// How long typing has to pause before the server is asked, so a steady typist sends one request per pause.
const STRENGTH_CHECK_DELAY_MS = 250

// A form's judge for its password fields under `policy`: `check(password)` gives `{ shortfall, pending }`,
// where `shortfall` is what is wrong in words (null when nothing is) and `pending` that a "Strong" verdict
// for that exact value is still on its way. `passwords` names every field the form judges, so one hook
// serves a form with several; verdicts are kept per value, so editing back to an earlier one asks nothing.
export function usePasswordChecks(policy, passwords) {
  const strong = policy === 'strong'
  const [verdicts, setVerdicts] = useState(() => new Map())
  const inFlight = useRef(new Set())
  const mounted = useRef(true)
  const wanted = strong ? [...new Set(passwords.filter(Boolean))] : []
  const key = JSON.stringify(wanted)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    const missing = JSON.parse(key).filter(value => !verdicts.has(value) && !inFlight.current.has(value))
    if (!missing.length) return undefined
    const timer = setTimeout(() => {
      for (const value of missing) {
        inFlight.current.add(value)
        api.passwordStrength(value)
          .catch(() => null)
          .then(verdict => {
            inFlight.current.delete(value)
            if (mounted.current) setVerdicts(prev => new Map(prev).set(value, verdict))
          })
      }
    }, STRENGTH_CHECK_DELAY_MS)
    return () => clearTimeout(timer)
  }, [key, verdicts])

  return password => {
    const value = password || ''
    if (!value) return { shortfall: null, pending: false }
    if (!strong) return { shortfall: passwordShortfall(value, policy), pending: false }
    if (!verdicts.has(value)) return { shortfall: null, pending: true }
    const verdict = verdicts.get(value)
    return { shortfall: verdict?.strong === false ? describeWeak(verdict) : null, pending: false }
  }
}

// Everything still wrong with a password field (and its confirmation, where the form has one), as the
// one sentence the form shows. One expression feeds both places it is needed — the note under the
// fields and the hover on the button it disables — so the two can never give different reasons.
//
// `check` is the form's `usePasswordChecks` judge. `optional` is for a field whose blank value means
// "leave it alone" (a user's password when editing them, another member's starting password): blank is
// then fine, not missing.
export function passwordIssue({ password, confirm, check, withConfirm = false, optional = false }) {
  const value = password || ''
  if (!value) return optional ? '' : 'Enter a password.'
  const { shortfall, pending } = check(value)
  if (shortfall) return shortfall
  if (pending) return 'Checking how hard the password is to guess.'
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
