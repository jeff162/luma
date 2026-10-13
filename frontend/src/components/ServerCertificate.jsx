// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// Handing a device the certificate it has to trust before the browser stops warning about this server.
//
// A server installation behind a TLS proxy presents a certificate issued by the proxy's own authority,
// which no device trusts until that authority's root is installed on it (`backend/services/
// proxy_certificate.py`). So the surface has to be reachable from a device that trusts nothing yet and
// has not signed in: it hangs off the sign-in screen as a dialog, and sits in Administration as a
// section for whoever runs the server. Both render one panel.
//
// It exists only where there is such a certificate. A desktop install and a plain-HTTP server have
// none, the server says so, and every entry point here renders nothing.
//
// The install steps are on the surface rather than in a Help topic because they are followed with the
// file in hand, on a device that may not be able to open anything else yet.

import { useState } from 'react'
import { api } from '../lib/api.js'
import { fingerprintMatches, useServerCertificate } from '../lib/serverCertificate.js'
import { AppDialog, Button, Input, Select } from './ui.jsx'

const DOWNLOAD_URL = '/api/app/proxy-certificate/download'

const DEVICES = [
  {
    value: 'ios',
    label: 'iPad / iPhone',
    steps: [
      'Download the certificate in Safari and allow the configuration profile.',
      'In Settings, open General, then VPN & Device Management, and install the downloaded profile.',
      'In Settings, open General, then About, then Certificate Trust Settings, and turn on full trust for the certificate.',
    ],
    removal: [
      'In Settings, open General, then VPN & Device Management.',
      'Select the certificate\u2019s profile and choose Remove Profile.',
    ],
  },
  {
    value: 'android',
    label: 'Android',
    steps: [
      'Download the certificate.',
      'In Settings, search for "CA certificate" (usually under Security, then Encryption & credentials, then Install a certificate).',
      'Choose CA certificate, confirm the warning, and pick the downloaded file.',
    ],
    removal: [
      'In Settings, search for "Trusted credentials" (usually under Security, then Encryption & credentials).',
      'On the User tab, select the certificate and choose Remove.',
    ],
  },
  {
    value: 'windows',
    label: 'Windows',
    steps: [
      'Download the certificate.',
      'In File Explorer, open the Downloads folder and double-click root-certificate.crt. If Windows asks which app to use, choose Crypto Shell Extensions.',
      'Choose Install Certificate, then Current User.',
      'Choose "Place all certificates in the following store", then Browse, and select Trusted Root Certification Authorities. Any other store appears to work and does not.',
      'Accept the security warning.',
    ],
    removal: [
      'Press Windows+R and run certmgr.msc.',
      'Open Trusted Root Certification Authorities, then Certificates.',
      'Select the certificate and delete it.',
    ],
    note: 'The browser\u2019s own certificate manager can import the file as well; the store to choose is the same.',
  },
  {
    value: 'mac',
    label: 'Mac',
    steps: [
      'Download the certificate and open the file, which adds it to Keychain Access.',
      'In Keychain Access, open the certificate and expand Trust.',
      'Set "When using this certificate" to Always Trust.',
    ],
    removal: [
      'Open Keychain Access and search for the certificate by name.',
      'Select it and delete it.',
    ],
  },
  {
    value: 'linux',
    label: 'Linux',
    steps: [
      'Download the certificate.',
      'In the browser’s settings, open the certificate manager and its Authorities list.',
      'Import the downloaded file and trust it for identifying websites.',
    ],
    removal: [
      'In the browser\u2019s settings, open the certificate manager and its Authorities list.',
      'Select the certificate and delete it.',
    ],
  },
]

function detectDevice() {
  const agent = typeof navigator === 'undefined' ? '' : navigator.userAgent
  if (/iPhone|iPad|iPod/.test(agent)) return 'ios'
  if (/Android/.test(agent)) return 'android'
  if (/Windows/.test(agent)) return 'windows'
  if (/Macintosh/.test(agent)) return 'mac'
  return 'linux'
}

// `checkable` adds the box that compares a fingerprint read off another device. It belongs only where
// this page itself can be believed — Administration, opened on the server or on a device that already
// trusts it. On a first visit the page arrives over the very connection in question, so a match
// announced there would mean nothing.
//
// `onAccept` is the administrator's half: present only where the viewer may take a changed certificate
// as the expected one. Without it a change is still stated, since a device being asked to trust a
// certificate should know the server itself did not expect it.
export function ServerCertificatePanel({ certificate, onAccept, checkable = false }) {
  const [device, setDevice] = useState(detectDevice)
  const [accepting, setAccepting] = useState(false)
  const [error, setError] = useState('')
  const [entered, setEntered] = useState('')
  const matches = fingerprintMatches(entered, certificate)
  const { steps, note, removal } = DEVICES.find(option => option.value === device)

  async function accept() {
    setAccepting(true)
    setError('')
    try {
      await onAccept()
    } catch (e) {
      setError(e.message || 'Could not accept the certificate')
    } finally {
      setAccepting(false)
    }
  }

  return (
    <div style={{ display: 'grid', gap: 14, fontSize: 13, lineHeight: 1.55 }}>
      {certificate.changed ? (
        <div role="alert" style={{ padding: 12, borderRadius: 10, border: '1px solid var(--warning, #d97706)', display: 'grid', gap: 8 }}>
          <div>
            This is not the certificate this server had before. That is expected after the reverse proxy was
            reinstalled or its data was lost, and every computer then needs the new certificate. If neither
            happened, do not install it.
          </div>
          {onAccept ? (
            <div><Button small onClick={accept} disabled={accepting}>{accepting ? 'Accepting…' : 'Accept the new certificate'}</Button></div>
          ) : null}
          {error ? <div style={{ color: '#dc2626' }}>{error}</div> : null}
        </div>
      ) : null}

      <div style={{ color: 'var(--muted)' }}>
        The connection to this server is encrypted with a certificate the server issued for itself. A browser
        warns about it until the certificate is installed on the computer, once.
      </div>
      <div style={{ color: 'var(--muted)' }}>
        Installing it trusts this server&rsquo;s certificate authority, which could then vouch for any website to
        that computer. It belongs only on computers whose owner trusts whoever runs this server, and is worth
        removing once the server is no longer used.
      </div>

      <div><Button onClick={() => { window.location.href = DOWNLOAD_URL }}>Download the certificate</Button></div>

      <div style={{ display: 'grid', gap: 8 }}>
        {/* A select rather than a row of options, which five device names outgrow in a narrow dialog. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ color: 'var(--muted)' }}>Steps for</span>
          <Select value={device} onChange={setDevice} options={DEVICES} aria-label="Steps for" />
        </div>
        <ol style={{ margin: 0, paddingLeft: 20, display: 'grid', gap: 4 }}>
          {steps.map(step => <li key={step}>{step}</li>)}
        </ol>
        {note ? <div style={{ color: 'var(--muted)' }}>{note}</div> : null}
        <div style={{ color: 'var(--muted)' }}>Close and reopen the browser afterwards.</div>
        <details>
          <summary style={{ fontSize: 12, color: 'var(--accent2)', cursor: 'pointer' }}>Removing it later</summary>
          <ol style={{ margin: '6px 0 0', paddingLeft: 20, display: 'grid', gap: 4 }}>
            {removal.map(step => <li key={step}>{step}</li>)}
          </ol>
          <div style={{ color: 'var(--muted)', marginTop: 4 }}>
            It is listed as {certificate.name}.
          </div>
        </details>
      </div>

      <div style={{ display: 'grid', gap: 4 }}>
        <div style={{ color: 'var(--muted)' }}>
          To be sure the certificate came from this server, compare its SHA-256 fingerprint on the computer with
          this one, read from the server itself: Administration on a computer that already trusts it, or the
          server&rsquo;s <code>--certificate-fingerprint</code> command.
        </div>
        <div style={{ color: 'var(--muted)', fontSize: 12 }}>SHA-256</div>
        <code data-testid="certificate-fingerprint" style={{ wordBreak: 'break-all', fontSize: 12 }}>
          {certificate.fingerprint}
        </code>
        <div style={{ color: 'var(--muted)', fontSize: 12 }}>SHA-1 (Windows shows this one, as Thumbprint)</div>
        <code style={{ wordBreak: 'break-all', fontSize: 12 }}>{certificate.fingerprint_sha1}</code>
        <div style={{ color: 'var(--muted)', fontSize: 12 }}>{certificate.name} · expires {certificate.expires}</div>
      </div>

      {checkable ? (
        <div style={{ display: 'grid', gap: 4 }}>
          <div style={{ color: 'var(--muted)' }}>
            Enter the fingerprint the other computer shows for the certificate.
          </div>
          <Input value={entered} onChange={setEntered} placeholder="Fingerprint shown on the other computer" aria-label="Fingerprint shown on the other computer" />
          {matches === true ? <div role="status" style={{ color: 'var(--success, #16a34a)' }}>Matches this server&rsquo;s certificate.</div> : null}
          {matches === false ? (
            <div role="alert" style={{ color: '#dc2626' }}>
              It does not match. That is a different certificate and should not be trusted.
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

// The sign-in screen's way in. A text link rather than a button: it is used once per device, and after
// that it should not compete with signing in.
export function ServerCertificateLink() {
  const [certificate] = useServerCertificate()
  const [open, setOpen] = useState(false)
  if (!certificate) return null
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={{
          background: 'none', border: 'none', padding: 0, marginTop: 16, cursor: 'pointer',
          color: 'var(--muted)', fontSize: 12, textDecoration: 'underline', fontFamily: 'inherit',
        }}
      >
        Browser warning about this server? Install its certificate
      </button>
      {open ? (
        <AppDialog
          title="Install this server's certificate"
          onClose={() => setOpen(false)}
          width="min(560px, 100%)"
          actions={<Button variant="ghost" small onClick={() => setOpen(false)}>Close</Button>}
        >
          <ServerCertificatePanel certificate={certificate} />
        </AppDialog>
      ) : null}
    </>
  )
}

// Administration's section. Accepting re-reads the certificate, so the warning clears on the answer
// the server gives rather than on the click.
export function ServerCertificateSection({ certificate, onChange }) {
  async function accept() {
    onChange(await api.acceptProxyCertificate())
  }
  return <ServerCertificatePanel certificate={certificate} onAccept={accept} checkable />
}
