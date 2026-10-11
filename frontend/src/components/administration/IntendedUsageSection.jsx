// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from 'react'
import { api } from '../../lib/api.js'
import { APP_NAME } from '../../lib/appConfig.js'
import { Card } from '../ui.jsx'
import { passwordPolicyHelpText } from '../../lib/passwordPolicy.js'

// The "Intended usage" selector. Three mutually-exclusive setup states, projected onto two orthogonal
// backend settings: the deployment `security_profile` (local_private / network_private) and the
// `data_provider_intended` flag. Standalone absorbs the "provider optional" case (a provider works over
// loopback with just a vault passphrase, so it needs no declaration); client-server splits into
// with/without a provider because that is exactly what flips HTTPS from recommended to required (and,
// in later phases, drives the HTTPS-readiness task + Connect-bank gate). It steers recommendations only
// — it does not force sign-in on or off.
const INTENDED_USAGE_OPTIONS = [
  {
    key: 'standalone',
    profile: 'local_private',
    dataProvider: false,
    label: 'Standalone',
    summary: 'Luma runs on this one computer and you use it right here. Nothing else connects to it. A bank or data provider can be configured if desired — it stays on this machine, so no HTTPS is needed.',
  },
  {
    key: 'client_server',
    profile: 'network_private',
    dataProvider: false,
    label: 'Client-server',
    summary: 'The backend runs on a computer on your network, and you (and anyone you allow) reach it from a browser on another device.',
  },
  {
    key: 'client_server_provider',
    profile: 'network_private',
    dataProvider: true,
    label: 'Client-server with an online data provider (e.g. Plaid)',
    summary: 'A networked setup where you also connect a bank or data provider. This requires HTTPS, because the secrets that unlock the provider travel across the network.',
  },
]

export default function IntendedUsageSection({ authEnabled, securityProfile, dataProviderIntended, passwordPolicy, onProfileChange, onDataProviderChange }) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  // local_private always maps to standalone (the provider flag is inert there); network_private splits
  // on the flag.
  const selectedKey = securityProfile !== 'network_private'
    ? 'standalone'
    : (dataProviderIntended ? 'client_server_provider' : 'client_server')
  // HTTPS is *recommended* for plain client-server (protects the login password/cookie — the operator's
  // call, not enforced), but *required* once a data provider is in play (enforced at connect time, since
  // the provider-unlock secrets cross the network).
  const recommendation = selectedKey === 'standalone'
    ? 'Sign-in protection is optional here — nothing outside this computer can reach Luma.'
    : selectedKey === 'client_server_provider'
      ? 'Turn on sign-in protection to control who can connect. HTTPS becomes required at the point you connect a data provider, because the secrets that unlock it cross the network — set it up before then.'
      : 'Turn on sign-in protection to control who can connect. HTTPS is recommended (not required) so sign-in passwords aren\'t sent across your network in the clear — strongly advised once sign-in is on.'

  async function selectOption(option) {
    setSaving(true)
    setError('')
    try {
      if (option.profile !== securityProfile) {
        const resp = await api.saveSecurityProfile(option.profile)
        onProfileChange?.(resp.security_profile || option.profile)
      }
      if (option.dataProvider !== !!dataProviderIntended) {
        const resp = await api.saveDataProviderIntent(option.dataProvider)
        onDataProviderChange?.(!!resp.data_provider_intended)
      }
    } catch (err) {
      setError(err.message || 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card style={{ padding: 20 }}>
      <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6, marginBottom: 14 }}>
        How will you run {APP_NAME}? This tells {APP_NAME} whether it runs on just this computer or is reached over your network — and whether you&apos;ll connect a bank — so it can recommend the right protections. It doesn&apos;t turn sign-in protection on or off by itself.
      </div>
      <div style={{ display: 'grid', gap: 8 }}>
        {INTENDED_USAGE_OPTIONS.map(option => (
          <label
            key={option.key}
            style={{
              display: 'grid',
              gap: 4,
              padding: '12px 14px',
              border: `1px solid ${selectedKey === option.key ? 'var(--accent)' : 'var(--border)'}`,
              borderRadius: 12,
              background: selectedKey === option.key
                ? 'color-mix(in srgb, var(--accent) 7%, var(--surface2))'
                : 'var(--surface2)',
              cursor: saving ? 'default' : 'pointer',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <input
                type="radio"
                name="intended-usage"
                checked={selectedKey === option.key}
                onChange={() => selectOption(option)}
                disabled={saving}
              />
              <span style={{ fontSize: 13, fontWeight: 600 }}>{option.label}</span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5, paddingLeft: 24 }}>
              {option.summary}
            </div>
          </label>
        ))}
      </div>

      <div style={{ marginTop: 14, padding: 12, borderRadius: 10, background: 'var(--surface2)', border: '1px solid var(--border)' }}>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Current recommendation</div>
        <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 }}>
          {recommendation}
        </div>
        {authEnabled && (
          <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.6, marginTop: 6 }}>
            Active password policy: {passwordPolicyHelpText(passwordPolicy)}
          </div>
        )}
      </div>

      {error && (
        <div style={{ marginTop: 12, color: '#ef4444', fontSize: 13 }}>
          {error}
        </div>
      )}
    </Card>
  )
}
