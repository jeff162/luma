// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
//
// The sign-in ceremony's decision-making, against a stub authenticator. Two things are worth pinning
// here and neither is WebAuthn itself: that a dismissed prompt comes back as an *answer* rather than an
// exception, since the password field is right there to fall back on; and that this feature encodes as
// base64url where the vault's encodes as standard base64 — the two speak to different verifiers, and a
// single shared encoder would break one of them silently.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  PASSKEY_SIGN_IN_UNAVAILABLE,
  assertSignInPasskey,
  ceremonyAvailability,
  registerSignInPasskey,
  signInAvailability,
} from '../appPasskey.js'

const bytes = (...values) => new Uint8Array(values).buffer

function withCredentials(impl) {
  navigator.credentials = impl
}

describe('availability', () => {
  beforeEach(() => { window.PublicKeyCredential = function () {} })
  afterEach(() => { delete window.PublicKeyCredential })

  it('says nothing while the server has not answered', () => {
    // The distinction that matters to the caller: not available *yet* carries no message, so a sign-in
    // screen does not flash an explanation for a call still in flight.
    expect(ceremonyAvailability(null)).toEqual({ available: false, reason: null })
  })

  it('passes the server\'s stated reason through', () => {
    expect(ceremonyAvailability({ available: false, reason: 'ip_address_host' }))
      .toEqual({ available: false, reason: 'ip_address_host' })
    expect(PASSKEY_SIGN_IN_UNAVAILABLE.ip_address_host).toMatch(/named host/)
  })

  it('reports an unsupported browser before asking the server anything', () => {
    delete window.PublicKeyCredential
    expect(ceremonyAvailability({ available: true, any_registered: true }).reason).toBe('unsupported')
  })

  it('separates "can run a ceremony" from "has something to sign in with"', () => {
    // The whole reason the two predicates exist: registering the first passkey happens on a connection
    // where none is registered, so a single check would hide the button that creates one.
    const params = { available: true, rp_id: 'localhost', any_registered: false }
    expect(ceremonyAvailability(params).available).toBe(true)
    expect(signInAvailability(params)).toEqual({ available: false, reason: 'no_credential' })
  })
})

describe('ceremonies', () => {
  beforeEach(() => { window.PublicKeyCredential = function () {} })
  afterEach(() => { delete window.PublicKeyCredential; delete navigator.credentials })

  const OPTIONS = {
    challenge: 'AQIDBA',
    rp: { id: 'localhost', name: 'Luma' },
    user: { id: 'dXNlcg', name: 'tester', displayName: 'Tester' },
    allowCredentials: [{ id: 'BQYHCA', type: 'public-key' }],
  }

  it('decodes the binary fields the browser requires and leaves the rest alone', async () => {
    const seen = vi.fn()
    withCredentials({
      get: async request => {
        seen(request.publicKey)
        return {
          id: 'abc', rawId: bytes(1), type: 'public-key',
          response: {
            clientDataJSON: bytes(2), authenticatorData: bytes(3),
            signature: bytes(4), userHandle: bytes(5),
          },
        }
      },
    })
    await assertSignInPasskey(OPTIONS)
    const publicKey = seen.mock.calls[0][0]
    expect(publicKey.challenge).toBeInstanceOf(Uint8Array)
    expect(publicKey.allowCredentials[0].id).toBeInstanceOf(Uint8Array)
    // Untouched pass-through, so a field added server-side needs no edit here.
    expect(publicKey.rp).toEqual({ id: 'localhost', name: 'Luma' })
    expect(publicKey.allowCredentials[0].type).toBe('public-key')
  })

  it('serializes an assertion into the base64url shape the server verifies', async () => {
    withCredentials({
      get: async () => ({
        id: 'abc', rawId: bytes(251, 255), type: 'public-key',
        response: {
          clientDataJSON: bytes(1), authenticatorData: bytes(2),
          signature: bytes(3), userHandle: bytes(4),
        },
      }),
    })
    const result = await assertSignInPasskey(OPTIONS)
    expect(result.ok).toBe(true)
    // base64url, not standard base64: no '+', no '/', no padding. Standard base64 of [251,255] is
    // "+/8=", so this asserts the encoding actually differs from the vault's.
    expect(result.credential.rawId).toBe('-_8')
    expect(result.credential.response.signature).toBe('Aw')
    expect(result.credential.type).toBe('public-key')
  })

  it('reports a dismissed prompt as an answer rather than throwing', async () => {
    withCredentials({
      get: async () => { throw Object.assign(new Error('nope'), { name: 'NotAllowedError' }) },
    })
    await expect(assertSignInPasskey(OPTIONS)).resolves.toEqual({ ok: false, reason: 'cancelled' })
  })

  it('lets a genuine failure through', async () => {
    withCredentials({
      get: async () => { throw Object.assign(new Error('broken'), { name: 'NotSupportedError' }) },
    })
    await expect(assertSignInPasskey(OPTIONS)).rejects.toThrow('broken')
  })

  it('carries the transports a registration reports', async () => {
    withCredentials({
      create: async () => ({
        id: 'abc', rawId: bytes(9), type: 'public-key',
        response: {
          clientDataJSON: bytes(1),
          attestationObject: bytes(2),
          getTransports: () => ['internal', 'hybrid'],
        },
      }),
    })
    const result = await registerSignInPasskey(OPTIONS)
    expect(result.ok).toBe(true)
    expect(result.credential.response.transports).toEqual(['internal', 'hybrid'])
  })

  it('registers without transports when the browser reports none', async () => {
    // `getTransports` is optional, and an older browser omitting it must not break registration.
    withCredentials({
      create: async () => ({
        id: 'abc', rawId: bytes(9), type: 'public-key',
        response: { clientDataJSON: bytes(1), attestationObject: bytes(2) },
      }),
    })
    const result = await registerSignInPasskey(OPTIONS)
    expect(result.ok).toBe(true)
    expect(result.credential.response.transports).toEqual([])
  })
})
