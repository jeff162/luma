// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// The parts of the server-certificate hand-out that are not rendering: reading what the server has to
// offer, and deciding whether a fingerprint is its certificate's. The surface is
// `components/ServerCertificate.jsx`.

import { useEffect, useState } from 'react'
import { api } from './api.js'

const hexOnly = value => String(value || '').replace(/[^0-9a-f]/gi, '').toUpperCase()

// Whether a fingerprint read off a device is this certificate's: true, false, or null while what was
// entered is not yet a whole fingerprint of either kind. Devices disagree about case and separators, so
// only the hex digits are compared.
export function fingerprintMatches(entered, certificate) {
  const digits = hexOnly(entered)
  const known = [certificate.fingerprint, certificate.fingerprint_sha1].map(hexOnly).filter(Boolean)
  if (!known.some(value => value.length === digits.length)) return null
  return known.includes(digits)
}

// What the server has to hand out, or null while unknown and where there is nothing: the two are the
// same to every caller, which shows no entry point either way.
export function useServerCertificate() {
  const [certificate, setCertificate] = useState(null)
  useEffect(() => {
    let cancelled = false
    api.getProxyCertificate()
      .then(result => { if (!cancelled) setCertificate(result?.available ? result : null) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])
  return [certificate, setCertificate]
}
