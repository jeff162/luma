// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// The vault passphrase floor, client side.
//
// Every passphrase must clear it — there is no weaker tier and no test-mode exemption, so this is the
// only rule the dialogs have to express. It exists here so a dialog can *gate* rather than advise: a
// passphrase under the floor accepted by the UI and then refused by the server reads as the vault being
// broken.
//
// **The floor has two halves, and neither is assumed.**
//   - **Length** is checked on every keystroke against `vault_passphrase_min_length`, served on the
//     session payload because the server enforces the same number. The fallback exists only so a dialog
//     opened before the session has loaded is not accidentally permissive; being briefly stricter than
//     the server is the safe direction.
//   - **How guessable it is** is an estimate from dictionaries that live on the server, so the dialog asks
//     the server (`usePassphraseStrength`). A second estimator here would disagree with it at the margin,
//     which is the drift the served length exists to prevent.
// The server refuses anything this lets through regardless.

import { useEffect, useState } from 'react'
import { api } from './api.js'

export const FALLBACK_MIN_LENGTH = 20

// How long typing has to pause before the server is asked. Long enough that a steady typist sends one
// request per pause rather than one per key.
const STRENGTH_CHECK_DELAY_MS = 250

export function passphraseLimits(session) {
  return { minLength: session?.vault_passphrase_min_length ?? FALLBACK_MIN_LENGTH }
}

// Why this passphrase is too short yet, or null when its length is enough.
//
// Returns a *reason*, not a boolean, because a disabled button with no explanation is the worst version
// of this gate — the user cannot tell how far off they are. An empty passphrase yields null: the field is
// untouched, and telling someone their blank input is too short the moment a dialog opens is noise, so
// the submit handler covers that case instead.
export function passphraseShortfall(passphrase, { minLength }) {
  const value = passphrase || ''
  if (!value) return null
  if (value.length < minLength) {
    const missing = minLength - value.length
    return `${missing} more character${missing === 1 ? '' : 's'} needed (at least ${minLength}).`
  }
  return null
}

// The length half only, for a caller that has to decide synchronously — whether a generated suggestion
// fits — before any server verdict could exist.
export function passphraseMeetsFloor(passphrase, limits) {
  return !!passphrase && passphraseShortfall(passphrase, limits) === null
}

// The server's guessability verdict, said as something to act on: the estimator's own warning, then its
// first suggestion.
export function describeGuessable(shortfall) {
  const parts = [shortfall?.warning || 'This passphrase is too easy to guess.']
  if (shortfall?.suggestions?.length) parts.push(shortfall.suggestions[0])
  return parts.join(' ')
}

// The server's assessment of a passphrase being chosen, kept current as it is typed.
//
// `{ score, issue, pending }`: the estimator's latest 0–4 score for a meter (null until one arrives),
// what is still wrong in words (null once it clears the floor), and whether the verdict for what is on
// screen is still on its way. Length is judged here first and the server is asked only once it is met, since a
// short passphrase is refused for its length whatever it scores — though the score is still fetched for
// the meter. A failed request leaves `issue` empty rather than blocking: the server refuses a weak
// passphrase on submit anyway, and a dialog wedged by a lost request would be worse.
export function usePassphraseStrength(passphrase, limits, { enabled = true } = {}) {
  const [verdict, setVerdict] = useState({ for: null, score: null, shortfall: null })
  const value = enabled ? (passphrase || '') : ''

  useEffect(() => {
    if (!value) return undefined
    let alive = true
    const timer = setTimeout(() => {
      api.vaultPassphraseStrength(value)
        .then(r => { if (alive) setVerdict({ for: value, score: r.score, shortfall: r.shortfall }) })
        .catch(() => { if (alive) setVerdict({ for: value, score: null, shortfall: null }) })
    }, STRENGTH_CHECK_DELAY_MS)
    return () => { alive = false; clearTimeout(timer) }
  }, [value])

  if (!value) return { score: null, issue: null, pending: false }
  const lengthIssue = passphraseShortfall(value, limits)
  const current = verdict.for === value
  const guessable = current && verdict.shortfall?.reason === 'guessable'
  const issue = lengthIssue || (guessable ? describeGuessable(verdict.shortfall) : null)
  return {
    // Never the top score while something is still wrong, so a full meter only ever shows beside a
    // passphrase the vault will take — a short one can score well and still be refused for its length.
    score: issue && verdict.score === 4 ? 3 : verdict.score,
    issue,
    pending: !lengthIssue && !current,
  }
}
