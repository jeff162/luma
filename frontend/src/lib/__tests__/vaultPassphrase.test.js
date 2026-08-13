import { describe, expect, it } from 'vitest'

import {
  FALLBACK_MIN_DISTINCT,
  FALLBACK_MIN_LENGTH,
  passphraseLimits,
  passphraseMeetsFloor,
  passphraseShortfall,
} from '../vaultPassphrase.js'

// These mirror `passphrase_meets_production_min` in backend/services/crypto_service.py. The dialog gates
// its submit button on them, so a disagreement with the server shows up as the vault refusing what the UI
// just said was fine — which is why the limits are served rather than hardcoded, and why the fallbacks
// here are the *stricter* direction to fail in.

const LIMITS = { minLength: 20, minDistinct: 6 }

describe('passphraseLimits', () => {
  it('takes the server’s numbers when the session has loaded', () => {
    expect(passphraseLimits({ vault_passphrase_min_length: 24, vault_passphrase_min_distinct: 8 }))
      .toEqual({ minLength: 24, minDistinct: 8 })
  })

  it('falls back only when the session has not arrived yet', () => {
    expect(passphraseLimits(null)).toEqual({
      minLength: FALLBACK_MIN_LENGTH, minDistinct: FALLBACK_MIN_DISTINCT,
    })
  })
})

describe('passphraseShortfall', () => {
  it('says how many characters are still missing rather than only that it is too short', () => {
    expect(passphraseShortfall('a-short-one', LIMITS)).toBe('9 more characters needed (at least 20).')
    expect(passphraseShortfall('a-nineteen-char-pas', LIMITS)).toBe('1 more character needed (at least 20).')
  })

  it('rejects a long passphrase built from too few distinct characters', () => {
    // Clears the length floor with almost no entropy — the case length alone cannot catch.
    expect(passphraseShortfall('abababababababababababab', LIMITS)).toBe('Use at least 6 different characters.')
  })

  it('accepts one that clears both', () => {
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
