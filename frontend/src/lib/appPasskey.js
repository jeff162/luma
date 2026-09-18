// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// The browser half of passkey **sign-in**. Its sibling, `vaultPasskey.js`, is a different feature that
// happens to use the same API: that one derives key material to open the credential vault, this one
// proves an identity to the login perimeter. They never share a ceremony, and a user who has both is
// prompted twice on purpose — see `services/app_passkey.py` for why.
//
// No PRF here, which is why this reaches further than a vault passkey can: a plain assertion is all an
// ordinary authenticator has to produce, so devices that could never hold a vault slot can still sign in.
//
// The ceremony result is serialized by hand rather than through `PublicKeyCredential.toJSON()`. The
// helper is newer than the API it serializes, and the field-by-field version is short and has no
// browser-support question hanging over it.

import { encodeBase64Url, decodeBase64 } from './base64url.js'

// Each of these is a real answer to give somebody, not an error: the way out of every one of them is to
// use the password, which the sign-in screen is already showing. `vaultPasskey.js` keeps its own copy
// because it can additionally fail for a reason this feature does not have (no PRF support), and the two
// vocabularies drifting apart is better than one list that has to be read twice to see which half applies.
export const PASSKEY_SIGN_IN_UNAVAILABLE = {
  unsupported:      'This browser does not support passkeys.',
  insecure_context: 'Passkeys need an HTTPS connection. Sign in with a password on this connection.',
  ip_address_host:  'Passkeys need a named host, not an IP address. Sign in with a password on this connection.',
  cancelled:        'The passkey prompt was closed, so nothing was signed in.',
  no_credential:    'That passkey is not registered here. Sign in with a password.',
}

export function passkeySupported() {
  return typeof window !== 'undefined' && !!window.PublicKeyCredential
}

// Whether a ceremony can run here at all: the browser's own capability folded into the server's verdict
// on this connection, so a caller never has to work out which of the two said no. Absent params means
// the server has not answered yet — not available, and with no reason to show, because there is nothing
// to tell the user about a call still in flight.
export function ceremonyAvailability(params) {
  if (!passkeySupported()) return { available: false, reason: 'unsupported' }
  if (!params) return { available: false, reason: null }
  if (!params.available) return { available: false, reason: params.reason || 'unsupported' }
  return { available: true, reason: null }
}

// The sign-in screen's question, which is the one above plus "is there anything to sign in with". The
// two are separate because *registering* a passkey is exactly the case where none exists yet, so a
// single predicate would hide the button that creates the first one.
export function signInAvailability(params) {
  const ceremony = ceremonyAvailability(params)
  if (!ceremony.available) return ceremony
  if (!params.any_registered) return { available: false, reason: 'no_credential' }
  return { available: true, reason: null }
}

function isCancellation(error) {
  return error && (error.name === 'NotAllowedError' || error.name === 'AbortError')
}

// The server sends options as WebAuthn JSON (base64url strings); `navigator.credentials` wants
// ArrayBuffers. Only the fields that are binary are converted, and the rest is passed through untouched
// so an option added server-side does not need a matching edit here.
function toPublicKeyOptions(options) {
  const converted = { ...options, challenge: decodeBase64(options.challenge) }
  if (options.user) {
    converted.user = { ...options.user, id: decodeBase64(options.user.id) }
  }
  for (const key of ['excludeCredentials', 'allowCredentials']) {
    if (Array.isArray(options[key])) {
      converted[key] = options[key].map(entry => ({ ...entry, id: decodeBase64(entry.id) }))
    }
  }
  return converted
}

function serializeRegistration(credential) {
  return {
    id: credential.id,
    rawId: encodeBase64Url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: encodeBase64Url(credential.response.clientDataJSON),
      attestationObject: encodeBase64Url(credential.response.attestationObject),
      transports: credential.response.getTransports?.() || [],
    },
    clientExtensionResults: {},
  }
}

function serializeAssertion(credential) {
  return {
    id: credential.id,
    rawId: encodeBase64Url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: encodeBase64Url(credential.response.clientDataJSON),
      authenticatorData: encodeBase64Url(credential.response.authenticatorData),
      signature: encodeBase64Url(credential.response.signature),
      // Present only for a discoverable credential, which is what registration asks for — but an
      // authenticator is free to answer with one it holds from elsewhere, so the field is optional here
      // rather than assumed.
      userHandle: credential.response.userHandle
        ? encodeBase64Url(credential.response.userHandle)
        : null,
    },
    clientExtensionResults: {},
  }
}

// Register a new passkey against the signed-in account. Returns `{ ok, reason }` on a ceremony the user
// abandoned, and throws only for a genuine failure, so a dismissed prompt never reads as a bug.
export async function registerSignInPasskey(options) {
  let credential
  try {
    credential = await navigator.credentials.create({ publicKey: toPublicKeyOptions(options) })
  } catch (error) {
    if (isCancellation(error)) return { ok: false, reason: 'cancelled' }
    throw error
  }
  if (!credential) return { ok: false, reason: 'cancelled' }
  return { ok: true, credential: serializeRegistration(credential) }
}

// Run a sign-in assertion. No `allowCredentials` comes back from the server, so the browser offers
// whichever discoverable passkey it holds for this host and the account follows from the answer — which
// is what lets the sign-in screen offer this before anyone has typed a username.
export async function assertSignInPasskey(options) {
  let assertion
  try {
    assertion = await navigator.credentials.get({ publicKey: toPublicKeyOptions(options) })
  } catch (error) {
    if (isCancellation(error)) return { ok: false, reason: 'cancelled' }
    throw error
  }
  if (!assertion) return { ok: false, reason: 'cancelled' }
  return { ok: true, credential: serializeAssertion(assertion) }
}
