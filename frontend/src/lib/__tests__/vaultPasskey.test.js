// @vitest-environment jsdom

// The passkey ceremony's decision-making, with a stub authenticator.
//
// What is worth pinning here is not WebAuthn — it is that every way the ceremony can fail to produce
// key material comes back as a *reason* the caller can turn into "use a passphrase instead", rather
// than as an exception that would surface as an unexplained error. The vault has a real fallback, and
// these are the paths that have to reach it.

import { describe, expect, it, beforeEach, vi } from 'vitest'
import {
  PASSKEY_UNAVAILABLE, passkeyAvailability, registerPasskey, unlockWithPasskey, __testing,
} from '../vaultPasskey.js'

const { b64 } = __testing

function bytes(...values) {
  return Uint8Array.from(values).buffer
}

const PARAMS = {
  available: true,
  reason: null,
  rp_id: 'luma.example',
  user_handle: 'user-1',
  user_name: 'alex',
  display_name: 'Alex',
  register_salt: b64.encode(bytes(1, 2, 3, 4)),
  credentials: [],
}

function stubCredentials({ create, get }) {
  window.PublicKeyCredential = function PublicKeyCredential() {}
  navigator.credentials = { create, get }
}

function credentialWithPrf(rawId, prfResult, { enabled } = {}) {
  return {
    rawId,
    getClientExtensionResults: () => ({
      prf: { ...(enabled === undefined ? {} : { enabled }), ...(prfResult ? { results: { first: prfResult } } : {}) },
    }),
  }
}

beforeEach(() => {
  delete window.PublicKeyCredential
  navigator.credentials = undefined
})

describe('passkeyAvailability', () => {
  it('reports the browser as the blocker when WebAuthn is absent', () => {
    expect(passkeyAvailability(PARAMS)).toEqual({ available: false, reason: 'unsupported' })
  })

  it('passes through the server’s reason when the connection cannot host a ceremony', () => {
    stubCredentials({ create: vi.fn(), get: vi.fn() })
    // Both halves have to be able to say no, and the caller must not have to work out which did.
    expect(passkeyAvailability({ available: false, reason: 'ip_address_host' }))
      .toEqual({ available: false, reason: 'ip_address_host' })
  })

  it('every reason it can return has something to show the user', () => {
    // A reason with no copy would reach the UI as a blank explanation, which is the one outcome worse
    // than the refusal itself.
    for (const reason of ['unsupported', 'no_prf', 'insecure_context', 'ip_address_host', 'cancelled']) {
      expect(PASSKEY_UNAVAILABLE[reason]).toBeTruthy()
    }
  })
})

describe('registerPasskey', () => {
  it('returns the material the server stores as a slot', async () => {
    const rawId = bytes(9, 9, 9)
    const prf = bytes(7, 7, 7, 7)
    stubCredentials({
      create: vi.fn(async () => credentialWithPrf(rawId, null, { enabled: true })),
      get: vi.fn(async () => credentialWithPrf(rawId, prf)),
    })
    const result = await registerPasskey(PARAMS, { label: 'Laptop' })
    expect(result.ok).toBe(true)
    expect(result.credential_id).toBe(b64.encode(rawId))
    expect(result.prf_output).toBe(b64.encode(prf))
    // The salt goes back exactly as issued: the server pairs it with the credential, and a value that
    // drifted here would derive a KEK nothing could reproduce at unlock.
    expect(result.prf_salt).toBe(PARAMS.register_salt)
    expect(result.label).toBe('Laptop')
  })

  it('costs a single prompt when the browser evaluates PRF during creation', async () => {
    // The regression this exists for: asking only to *enable* PRF at creation and always evaluating in a
    // second ceremony meant two prompts, and the second is indistinguishable from a repeat of the first
    // — so dismissing it was the natural response to a registration that looked finished, and nothing
    // was saved.
    const rawId = bytes(9)
    const create = vi.fn(async () => credentialWithPrf(rawId, bytes(7, 7), { enabled: true }))
    const get = vi.fn()
    stubCredentials({ create, get })
    const result = await registerPasskey(PARAMS)
    expect(result.ok).toBe(true)
    expect(result.prf_output).toBe(b64.encode(bytes(7, 7)))
    expect(get).not.toHaveBeenCalled()
    // The salt has to be asked for at creation, or there is nothing for the authenticator to answer.
    expect(create.mock.calls[0][0].publicKey.extensions.prf.eval.first)
      .toEqual(b64.decode(PARAMS.register_salt))
  })

  it('falls back to a second ceremony when creation returns no result', async () => {
    // Browsers differ on whether create() returns PRF results. Where it does not, the assertion is the
    // only way to get key material — a registration that gave up here would produce a slot that nothing
    // can ever open.
    const rawId = bytes(4)
    const get = vi.fn(async () => credentialWithPrf(rawId, bytes(5, 5)))
    stubCredentials({ create: vi.fn(async () => credentialWithPrf(rawId, null)), get })
    const result = await registerPasskey(PARAMS)
    expect(result.ok).toBe(true)
    expect(result.prf_output).toBe(b64.encode(bytes(5, 5)))
    expect(get).toHaveBeenCalledTimes(1)
  })

  it('refuses an authenticator that reports no PRF support, without a second prompt', async () => {
    const get = vi.fn()
    stubCredentials({
      create: vi.fn(async () => credentialWithPrf(bytes(1), null, { enabled: false })),
      get,
    })
    expect(await registerPasskey(PARAMS)).toEqual({ ok: false, reason: 'no_prf' })
    expect(get).not.toHaveBeenCalled()
  })

  it('refuses when the follow-up ceremony yields no key material', async () => {
    // The subtler half of the same failure: the authenticator claimed nothing either way, and only the
    // evaluation reveals there is no secret to derive a KEK from.
    stubCredentials({
      create: vi.fn(async () => credentialWithPrf(bytes(1), null)),
      get: vi.fn(async () => credentialWithPrf(bytes(1), null)),
    })
    expect(await registerPasskey(PARAMS)).toEqual({ ok: false, reason: 'no_prf' })
  })

  it('treats a dismissed prompt as an answer rather than an error', async () => {
    const cancelled = Object.assign(new Error('denied'), { name: 'NotAllowedError' })
    stubCredentials({ create: vi.fn(async () => { throw cancelled }), get: vi.fn() })
    expect(await registerPasskey(PARAMS)).toEqual({ ok: false, reason: 'cancelled' })
  })

  it('lets a genuine failure through as an exception', async () => {
    // Only the *expected* refusals become reasons. A real fault must not be laundered into "use a
    // passphrase", which would hide a bug behind a plausible-sounding message.
    stubCredentials({ create: vi.fn(async () => { throw new Error('authenticator exploded') }), get: vi.fn() })
    await expect(registerPasskey(PARAMS)).rejects.toThrow('authenticator exploded')
  })
})

describe('unlockWithPasskey', () => {
  const registered = {
    ...PARAMS,
    credentials: [
      { credential_id: b64.encode(bytes(1)), prf_salt: b64.encode(bytes(10)), pending: false },
      { credential_id: b64.encode(bytes(2)), prf_salt: b64.encode(bytes(20)), pending: false },
    ],
  }

  it('returns the credential and PRF output of whichever passkey answers', async () => {
    stubCredentials({
      create: vi.fn(),
      get: vi.fn(async () => credentialWithPrf(bytes(2), bytes(8, 8))),
    })
    const result = await unlockWithPasskey(registered)
    expect(result.ok).toBe(true)
    expect(result.credentialId).toBe(b64.encode(bytes(2)))
    expect(result.prfOutput).toBe(b64.encode(bytes(8, 8)))
  })

  it('tries each registered passkey, since every one carries its own salt', async () => {
    // They cannot be offered together: the salt to evaluate is only known once the credential is.
    const get = vi.fn()
      .mockResolvedValueOnce(credentialWithPrf(bytes(1), null))
      .mockResolvedValueOnce(credentialWithPrf(bytes(2), bytes(3)))
    stubCredentials({ create: vi.fn(), get })
    const result = await unlockWithPasskey(registered)
    expect(result.ok).toBe(true)
    expect(get).toHaveBeenCalledTimes(2)
  })

  it('stops asking once the user dismisses a prompt', async () => {
    // Dismissal is an answer about the whole flow. Walking the remaining keys would prompt again for
    // each one, which reads as the app refusing to take no.
    const cancelled = Object.assign(new Error('denied'), { name: 'NotAllowedError' })
    const get = vi.fn(async () => { throw cancelled })
    stubCredentials({ create: vi.fn(), get })
    expect(await unlockWithPasskey(registered)).toEqual({ ok: false, reason: 'cancelled' })
    expect(get).toHaveBeenCalledTimes(1)
  })

  it('does not start a ceremony for a passkey still awaiting approval', async () => {
    // Its slot holds no key, so the prompt could only ever end in a refusal after the user had already
    // been asked to touch the authenticator.
    const get = vi.fn()
    stubCredentials({ create: vi.fn(), get })
    const pendingOnly = {
      ...PARAMS,
      credentials: [{ credential_id: b64.encode(bytes(1)), prf_salt: b64.encode(bytes(10)), pending: true }],
    }
    expect(await unlockWithPasskey(pendingOnly)).toEqual({ ok: false, reason: 'no_prf' })
    expect(get).not.toHaveBeenCalled()
  })
})
