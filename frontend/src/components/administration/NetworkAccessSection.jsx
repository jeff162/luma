// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from 'react'
import { api } from '../../lib/api.js'
import { APP_NAME } from '../../lib/appConfig.js'
import { Card } from '../ui.jsx'

// How this installation is reached, as the server sees it, and what follows from that.
//
// Nothing here is chosen, and nothing is recommended: whether to run over plain HTTP, and whether to
// require a sign-in, are the operator's decisions. The section states the two facts those decisions
// rest on. One is about this browser's own connection — where the request came from and whether it was
// encrypted on the way — which is a fact of each request (`backend/transport.py`), so the same
// installation reads differently from two devices. The other is about the installation: whether any
// other device can open it at all, which is what decides who sign-in protection keeps out.
//
// Plain HTTP over a network is a supported way to run, so what it costs is stated as a cost and not as
// an error. The server enforces the one limit that is not the operator's to waive.
const LINKS = {
  local: {
    statement: `This browser is on the computer ${APP_NAME} runs on.`,
    notes: ['Nothing sent between this browser and the server leaves the computer.'],
  },
  https: {
    statement: `This browser reaches ${APP_NAME} over the network, with HTTPS.`,
    notes: ['Everything sent between this browser and the server is encrypted.'],
  },
  cleartext: {
    statement: `This browser reaches ${APP_NAME} over the network, without HTTPS.`,
    notes: [
      'Everything sent between this browser and the server, sign-in password included, crosses the network unencrypted.',
      'Passkeys are unavailable because a browser requires HTTPS or a connection via localhost.',
      'Data sources cannot be connected in this session because that requires HTTPS or a connection via localhost.',
    ],
  },
}

const REACH = {
  local: {
    statement: 'Only this computer can open this installation.',
    protects: 'Sign-in protection keeps other people who use this computer out of the data.',
  },
  network: {
    statement: 'Other devices on the network can open this installation.',
    protects: 'Sign-in protection keeps people on the network, and other people who use the computer, out of the data.',
  },
}

function linkKind(transport) {
  if (!transport) return null
  if (transport.is_loopback) return 'local'
  return transport.is_https ? 'https' : 'cleartext'
}

export default function NetworkAccessSection({ authEnabled }) {
  const [transport, setTransport] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    api.getAuthStatus()
      .then(status => { if (!cancelled) setTransport(status.transport || null) })
      .catch(err => { if (!cancelled) setError(err.message || 'Could not read how this browser is connected') })
    return () => { cancelled = true }
  }, [])

  const kind = linkKind(transport)
  if (error) return <Card style={{ padding: 20, color: '#ef4444', fontSize: 13 }}>{error}</Card>
  if (!kind) return null

  const link = LINKS[kind]
  // A browser that is not on the server is itself the proof that other devices get through.
  const reach = REACH[kind !== 'local' || transport.reachable_from_network ? 'network' : 'local']
  const listStyle = { margin: 0, paddingLeft: 20, display: 'grid', gap: 6, fontSize: 13, color: 'var(--muted)', lineHeight: 1.55 }
  const headingStyle = { fontSize: 13, fontWeight: 600, marginBottom: 10 }

  return (
    <Card style={{ padding: 20, display: 'grid', gap: 18 }}>
      <div>
        <div style={headingStyle}>{link.statement}</div>
        <ul style={listStyle}>
          {link.notes.map(note => <li key={note}>{note}</li>)}
        </ul>
      </div>
      <div>
        <div style={headingStyle}>{reach.statement}</div>
        <ul style={listStyle}>
          <li>{reach.protects}</li>
          <li>Sign-in protection is {authEnabled ? 'on' : 'off'}.</li>
        </ul>
      </div>
    </Card>
  )
}
