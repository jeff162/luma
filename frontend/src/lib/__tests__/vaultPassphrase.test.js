import { describe, expect, it } from 'vitest'

import {
  FALLBACK_MIN_LENGTH,
  describeGuessable,
  passphraseLimits,
  passphraseMeetsFloor,
  passphraseShortfall,
} from '../vaultPassphrase.js'

// The length half mirrors `passphrase_shortfall` in backend/services/crypto_service.py. The dialog gates
// its submit button on it, so a disagreement with the server shows up as the vault refusing what the UI
// just said was fine — which is why the limit is served rather than hardcoded, and why the fallback here
// is the *stricter* direction to fail in. The guessability half is the server's alone.

const LIMITS = { minLength: 20 }

describe('passphraseLimits', () => {
  it('takes the server’s number when the session has loaded', () => {
    expect(passphraseLimits({ vault_passphrase_min_length: 24 })).toEqual({ minLength: 24 })
  })

  it('falls back only when the session has not arrived yet', () => {
    expect(passphraseLimits(null)).toEqual({ minLength: FALLBACK_MIN_LENGTH })
  })
})

describe('passphraseShortfall', () => {
  it('says how many characters are still missing rather than only that it is too short', () => {
    expect(passphraseShortfall('a-short-one', LIMITS)).toBe('9 more characters needed (at least 20).')
    expect(passphraseShortfall('a-nineteen-char-pas', LIMITS)).toBe('1 more character needed (at least 20).')
  })

  it('accepts one that is long enough', () => {
    expect(passphraseShortfall('a-strong-vault-passphrase', LIMITS)).toBeNull()
  })

  it('says nothing about an untouched field', () => {
    // A dialog that opens already complaining about the blank field it just rendered is noise; the
    // submit handler covers the empty case.
    expect(passphraseShortfall('', LIMITS)).toBeNull()
  })
})

describe('passphraseMeetsFloor', () => {
  it('is false for empty, unlike the shortfall message', () => {
    expect(passphraseMeetsFloor('', LIMITS)).toBe(false)
    expect(passphraseMeetsFloor('a-strong-vault-passphrase', LIMITS)).toBe(true)
  })
})

describe('describeGuessable', () => {
  it('says what the estimator found, then what to do about it', () => {
    expect(describeGuessable({ warning: 'This is a very common password.', suggestions: ['Add a word.', 'Avoid repeats.'] }))
      .toBe('This is a very common password. Add a word.')
  })

  it('still says something when the estimator gave no warning', () => {
    expect(describeGuessable({ warning: '', suggestions: [] })).toBe('This passphrase is too easy to guess.')
  })
})
