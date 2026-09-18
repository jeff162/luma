// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// Binary <-> text for the two WebAuthn features, which need different spellings of the same encoding.
//
// The vault's slots were stored with standard base64 and round-trip whatever they were given, so
// `encodeBase64` must keep producing exactly that — changing it would orphan every registered vault
// passkey. Login passkeys are newer and speak base64url end to end, because that is what the WebAuthn
// JSON shapes and the server's verifier both use.
//
// Decoding is deliberately tolerant of both: a credential id arrives from the browser in one spelling
// and comes back from the server in whichever it was stored as, and a decoder that cared would fail on
// exactly the round trip it exists to support.

export function encodeBase64(buffer) {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export function encodeBase64Url(buffer) {
  return encodeBase64(buffer).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function decodeBase64(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(normalized)
  return Uint8Array.from(binary, ch => ch.charCodeAt(0))
}
