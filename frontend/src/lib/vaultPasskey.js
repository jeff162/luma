// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// The WebAuthn side of a passkey vault slot: turning an authenticator into 32 secret bytes.
//
// A *plain* passkey is authentication only and yields no stable key material. The `prf` extension
// (CTAP2's `hmac-secret`) is what returns a secret, high-entropy value for a given salt — the same value
// every time, on that authenticator, for that credential — which is exactly the shape a KEK needs. So
// the vault treats a PRF output precisely as it treats a typed passphrase; everything provider-specific
// about WebAuthn stops at this file.
//
// **PRF support is discovered, never assumed.** It must be requested at *registration*, and an
// authenticator that ignores it registers perfectly happily and only then reports `enabled: false` —
// after the user has already been asked to touch it. That is why every entry point here returns a
// `{ ok, reason }` result rather than throwing: "your security key cannot do this, use a passphrase" is
// an ordinary answer to give someone, not an error condition, and the caller has a real fallback to
// offer. A thrown exception would arrive at the same UI as a genuine failure and read as a bug.
//
// **Registration asks the authenticator to evaluate the salt during `create()`, and only falls back to a
// second `get()` when the browser returns no result.** An earlier version always ran the follow-up
// ceremony, on the reasoning that `create()` results are not universally returned. That is true, but it
// made the common case cost *two* prompts — and the second one is indistinguishable from a repeat of the
// first, so dismissing it was the natural response to a registration that appeared to be over. Asking at
// creation costs nothing where it is unsupported (the field is ignored, and the fallback still runs), and
// removes a prompt where it is not.

import { api } from './api.js'

const PRF_UNSUPPORTED = { ok: false, reason: 'no_prf' }

const b64 = {
  encode(buffer) {
    const bytes = new Uint8Array(buffer)
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return btoa(binary)
  },
  decode(value) {
    // Accepts base64url as well as standard base64: credential ids come back from the browser in the
    // former and the server round-trips whatever it was given.
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
    const binary = atob(normalized)
    return Uint8Array.from(binary, ch => ch.charCodeAt(0))
  },
}

export const PASSKEY_UNAVAILABLE = {
  unsupported:      'This browser does not support passkeys.',
  no_prf:           'This authenticator cannot produce the key material a vault passkey needs. Use a passphrase instead.',
  insecure_context: 'Passkeys need an HTTPS connection. Use a passphrase on this connection.',
  ip_address_host:  'Passkeys need a named host, not an IP address. Use a passphrase on this connection.',
  // Says what the *outcome* was, not just what happened to the prompt: someone who reached this by
  // dismissing a step they thought was over needs to know nothing was saved.
  cancelled:        'The passkey prompt was closed before it finished, so nothing was added.',
}

export function passkeySupported() {
  return typeof window !== 'undefined' && !!window.PublicKeyCredential
}

// Whether a ceremony can run at all, folding the browser's own capability into the server's verdict on
// the connection (`available` / `reason` from `/auth/vault/passkey/params`). One reason string, so the
// caller never has to work out which of the two said no.
export function passkeyAvailability(params) {
  if (!passkeySupported()) return { available: false, reason: 'unsupported' }
  if (params && !params.available) return { available: false, reason: params.reason || 'unsupported' }
  return { available: true, reason: null }
}

function randomChallenge() {
  // Nothing verifies this: the vault's proof is that the PRF output opens the slot's wrapped private
  // key, not that an assertion signature checks out (see `crypto_service`). WebAuthn requires the field
  // regardless, so it is filled with real randomness rather than a constant — a fixed value would look
  // like a replayable ceremony to anyone reading this later.
  return crypto.getRandomValues(new Uint8Array(32))
}

function isCancellation(error) {
  return error && (error.name === 'NotAllowedError' || error.name === 'AbortError')
}

// The PRF result a ceremony returned, or null when it returned none. One reader for both `create()` and
// `get()` because the extension reports its output at the same path on either, and a second copy is how
// the two would come to disagree about where to look.
function prfResult(credential) {
  return credential?.getClientExtensionResults?.()?.prf?.results?.first || null
}

// Read the PRF output for one credential via an assertion. Used by unlock, and by registration only when
// `create()` did not already produce one — so both derive the KEK by exactly the same route.
async function evaluatePrf({ rpId, credentialIds, salt }) {
  let assertion
  try {
    assertion = await navigator.credentials.get({
      publicKey: {
        rpId,
        challenge: randomChallenge(),
        allowCredentials: credentialIds.map(id => ({ id: b64.decode(id), type: 'public-key' })),
        userVerification: 'required',
        extensions: { prf: { eval: { first: salt } } },
      },
    })
  } catch (error) {
    if (isCancellation(error)) return { ok: false, reason: 'cancelled' }
    throw error
  }
  const result = prfResult(assertion)
  if (!result) return PRF_UNSUPPORTED
  return {
    ok: true,
    credentialId: b64.encode(assertion.rawId),
    prfOutput: b64.encode(result),
  }
}

// Register a new authenticator and return the material the server stores as a slot.
//
// `params` is the `/auth/vault/passkey/params` payload. A credential that turns out to have no PRF is
// reported rather than kept: leaving it registered would give the user a passkey that authenticates but
// can never open the vault, which is worse than not having one.
export async function registerPasskey(params, { label } = {}) {
  const availability = passkeyAvailability(params)
  if (!availability.available) return { ok: false, reason: availability.reason }

  const salt = b64.decode(params.register_salt)
  let credential
  try {
    credential = await navigator.credentials.create({
      publicKey: {
        rp: { id: params.rp_id, name: 'Luma' },
        user: {
          id: new TextEncoder().encode(params.user_handle),
          name: params.user_name,
          displayName: params.display_name,
        },
        challenge: randomChallenge(),
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        // Discoverable where the authenticator offers it, so unlocking can start from the passkey
        // rather than requiring the user to say who they are first.
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
        excludeCredentials: (params.credentials || []).map(c => ({
          id: b64.decode(c.credential_id), type: 'public-key',
        })),
        // Enable PRF *and* ask for this slot's salt in the same breath. A browser that supports
        // evaluation at creation answers here and no second prompt is needed; one that does not simply
        // ignores `eval` and reports `enabled`, which the fallback below acts on.
        extensions: { prf: { eval: { first: salt } } },
      },
    })
  } catch (error) {
    if (isCancellation(error)) return { ok: false, reason: 'cancelled' }
    throw error
  }

  // `enabled: false` is a definite no, and worth catching before spending a second prompt on an
  // authenticator that has already said it cannot help.
  if (credential?.getClientExtensionResults?.()?.prf?.enabled === false) return PRF_UNSUPPORTED

  const credentialId = b64.encode(credential.rawId)
  const created = prfResult(credential)
  const evaluated = created
    ? { ok: true, credentialId, prfOutput: b64.encode(created) }
    // No result from creation: the browser enabled PRF but evaluates only during an assertion. This is
    // the second prompt, and it is now the exception rather than the rule.
    : await evaluatePrf({ rpId: params.rp_id, credentialIds: [credentialId], salt })
  if (!evaluated.ok) return evaluated
  return {
    ok: true,
    credential_id: evaluated.credentialId,
    prf_output: evaluated.prfOutput,
    prf_salt: params.register_salt,
    label: label || '',
  }
}

// Run an unlock ceremony against the passkeys already registered for this user.
export async function unlockWithPasskey(params) {
  const availability = passkeyAvailability(params)
  if (!availability.available) return { ok: false, reason: availability.reason }
  const usable = (params.credentials || []).filter(c => !c.pending)
  if (!usable.length) return { ok: false, reason: 'no_prf' }

  // Every registered credential carries its own salt, so the ceremony has to be scoped to one at a
  // time — offering all of them at once would leave no way to know which salt to evaluate.
  for (const candidate of usable) {
    const evaluated = await evaluatePrf({
      rpId: params.rp_id,
      credentialIds: [candidate.credential_id],
      salt: b64.decode(candidate.prf_salt),
    })
    if (evaluated.ok) return evaluated
    // A dismissed prompt is the user's answer for the whole flow, not a reason to ask again per key.
    if (evaluated.reason === 'cancelled') return evaluated
  }
  return { ok: false, reason: 'no_prf' }
}

export const __testing = { b64 }

// The whole unlock sequence, end to end: fetch this connection's parameters, run the ceremony, and hand
// the PRF output to the server. One function because it is one user-visible act, and because it has two
// callers that must not drift — the vault strip on the Connections tab, and the unlock dialog any gated
// action raises. The dialog was the one that mattered and the one that did not have it: a passkey could
// only be used by noticing the strip *before* triggering an action, so every disconnect, sync, or 423
// re-prompt demanded the passphrase from users who had set up a passkey precisely to avoid typing it.
//
// Returns `{ ok, user }` or `{ ok: false, reason, message }`, never throws, and reports a dismissed
// prompt with an empty `message` — the user closed it on purpose and does not need to be told what they
// just did. Every failure leaves the vault locked and the passphrase still available, which is why the
// callers keep their prompt open rather than treating this as terminal.
// One ceremony at a time, enforced here rather than left to each button.
//
// The browser refuses a second `navigator.credentials.get()` while one is pending, and its refusal
// arrives as an ordinary exception — so a double-click produced the passkey prompt *and* an error dialog
// quoting the browser ("a request is already in progress"), which the user then had to dismiss on top of
// the ceremony they actually wanted. Callers disable their own controls too, and should; this exists
// because "only one WebAuthn ceremony can be in flight" is a fact about WebAuthn rather than about any
// particular button, and it also covers a press that lands before a re-render can disable one.
//
// The duplicate resolves to a **silent** refusal: `message` is empty, and both callers surface a notice
// only when there is a message, so the extra press does nothing at all. That is the honest outcome —
// the ceremony the user asked for is already on screen, and nothing has gone wrong for them to read.
let unlockInFlight = false

export async function runVaultPasskeyUnlock() {
  if (unlockInFlight) return { ok: false, reason: 'in_progress', message: '' }
  unlockInFlight = true
  try {
    const params = await api.vaultPasskeyParams()
    const result = await unlockWithPasskey(params)
    if (!result.ok) {
      return {
        ok: false,
        reason: result.reason,
        message: result.reason === 'cancelled'
          ? ''
          : (PASSKEY_UNAVAILABLE[result.reason] || PASSKEY_UNAVAILABLE.unsupported),
      }
    }
    const resp = await api.unlockVaultWithPasskey(result.credentialId, result.prfOutput)
    return { ok: true, user: resp?.user || null }
  } catch (e) {
    return { ok: false, reason: 'failed', message: e?.message || 'The vault stayed locked.' }
  } finally {
    // `finally`, so a thrown ceremony cannot leave the flag set and wedge the button for the rest of
    // the session — a failure someone could only escape by reloading.
    unlockInFlight = false
  }
}

// The same ceremony, ending in a passphrase rather than an unlock. Shares `unlockInFlight` with the
// function above deliberately: the browser permits only one `navigator.credentials.get()` at a time, and
// the two are reachable from adjacent controls in the same dialog.
//
// One call to the server, not prove-then-set, for the reason recovery is one call: a ceremony spent with
// no passphrase written would leave the user having proved themselves and gained nothing.
export async function runVaultPasskeySetPassphrase(newPassphrase) {
  if (unlockInFlight) return { ok: false, reason: 'in_progress', message: '' }
  unlockInFlight = true
  try {
    const params = await api.vaultPasskeyParams()
    const result = await unlockWithPasskey(params)
    if (!result.ok) {
      return {
        ok: false,
        reason: result.reason,
        message: result.reason === 'cancelled'
          ? ''
          : (PASSKEY_UNAVAILABLE[result.reason] || PASSKEY_UNAVAILABLE.unsupported),
      }
    }
    const resp = await api.setVaultPassphraseWithPasskey(
      result.credentialId, result.prfOutput, newPassphrase,
    )
    return { ok: true, user: resp?.user || null }
  } catch (e) {
    // The passphrase floor arrives here as an ordinary error, and it is the one failure the caller can
    // do something about — so it is surfaced rather than flattened into "the passkey did not work".
    return { ok: false, reason: 'failed', message: e?.message || 'The passphrase was not changed.' }
  } finally {
    unlockInFlight = false
  }
}

// Whether this user has a passkey that can actually open the vault. A `pending` slot is one awaiting
// approval — registered, but not yet able to unlock anything — so offering it would produce a ceremony
// that can only fail. Read from the session user, which both callers already hold.
export function hasUsableVaultPasskey(user) {
  return (user?.vault_passkeys || []).some(pk => !pk.pending)
}
