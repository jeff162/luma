// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// The vault passphrase floor, client side.
//
// Every passphrase must clear it — there is no weaker tier and no test-mode exemption, so this is the
// only rule the dialog has to express. It exists here so the dialog can *gate* rather than advise:
// before this, the strength meter was the only signal and a passphrase under the floor was accepted
// silently by the UI and then refused by the server, which reads as the vault being broken.
//
// **The limits are served, never assumed.** They arrive on the session payload
// (`vault_passphrase_min_length` / `vault_passphrase_min_distinct`) because the server enforces the same
// two numbers, and a client carrying its own copy would drift — blocking a passphrase the server accepts,
// or offering one it refuses. The fallbacks below exist only so a dialog opened before the session has
// loaded is not accidentally permissive; being briefly stricter than the server is the safe direction,
// and the server refuses anything this lets through regardless.

export const FALLBACK_MIN_LENGTH = 20
export const FALLBACK_MIN_DISTINCT = 6

export function passphraseLimits(session) {
  return {
    minLength: session?.vault_passphrase_min_length ?? FALLBACK_MIN_LENGTH,
    minDistinct: session?.vault_passphrase_min_distinct ?? FALLBACK_MIN_DISTINCT,
  }
}

// Why this passphrase is not acceptable yet, or null when it is.
//
// Returns a *reason*, not a boolean, because a disabled button with no explanation is the worst version
// of this gate — the user cannot tell whether they are three characters short or need more variety. An
// empty passphrase yields null: the field is untouched, and telling someone their blank input is too
// short the moment a dialog opens is noise, so the submit handler covers that case instead.
export function passphraseShortfall(passphrase, { minLength, minDistinct }) {
  const value = passphrase || ''
  if (!value) return null
  if (value.length < minLength) {
    const missing = minLength - value.length
    return `${missing} more character${missing === 1 ? '' : 's'} needed (at least ${minLength}).`
  }
  // Length alone can be met by one character repeated, which clears the bar while carrying almost no
  // entropy — the same reason the server checks distinct characters rather than length alone.
  if (new Set(value).size < minDistinct) {
    return `Use at least ${minDistinct} different characters.`
  }
  return null
}

export function passphraseMeetsFloor(passphrase, limits) {
  return !!passphrase && passphraseShortfall(passphrase, limits) === null
}
