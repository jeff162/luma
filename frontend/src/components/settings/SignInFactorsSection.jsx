// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState, useEffect, useId } from 'react'
import { api } from '../../lib/api.js'
import { ONE_TIME_CODE_PROPS } from '../../lib/sensitiveFields.js'
import { Card, Button, InsetPanel, getFormControlStyle } from '../ui.jsx'
import { PASSKEY_SIGN_IN_UNAVAILABLE, ceremonyAvailability, registerSignInPasskey } from '../../lib/appPasskey.js'
import { formatDate } from '../../lib/utils.js'

// Sign-in passkeys, which are **not** the vault's passkeys. Both exist, both use the same browser
// prompt, and they are deliberately not merged: one crosses the login perimeter, the other opens
// encrypted data-source credentials. The copy here names the difference rather than assuming anyone
// will infer it, since an unlabelled second list of passkeys is the conflation the design guards against.
function SignInPasskeysPanel({ user, onUserChange }) {
  const [params, setParams] = useState(null)
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const passkeys = user?.app_passkeys || []

  useEffect(() => {
    let cancelled = false
    api.signInPasskeyParams()
      .then(resp => { if (!cancelled) setParams(resp) })
      .catch(() => { })
    return () => { cancelled = true }
  }, [])

  async function addPasskey() {
    setBusy(true)
    setError('')
    try {
      const { options } = await api.beginSignInPasskeyRegistration()
      const result = await registerSignInPasskey(options)
      if (!result.ok) {
        if (result.reason !== 'cancelled') {
          setError(PASSKEY_SIGN_IN_UNAVAILABLE[result.reason] || 'That passkey could not be added.')
        }
        return
      }
      const resp = await api.completeSignInPasskeyRegistration(result.credential, label.trim())
      onUserChange(resp.user)
      setLabel('')
    } catch (err) {
      setError(err.message || 'That passkey could not be added.')
    } finally {
      setBusy(false)
    }
  }

  async function removePasskey(passkeyId) {
    setBusy(true)
    setError('')
    try {
      onUserChange((await api.removeSignInPasskey(passkeyId)).user)
    } catch (err) {
      setError(err.message || 'That passkey could not be removed.')
    } finally {
      setBusy(false)
    }
  }

  const availability = ceremonyAvailability(params)
  const inputStyle = { ...getFormControlStyle({ size: 'md', surface: 'base' }), width: '100%', maxWidth: 260 }

  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 14, fontWeight: 600 }}>Sign-in passkeys</div>
      <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4, lineHeight: 1.5 }}>
        A passkey signs in with a fingerprint, face or device PIN instead of a password. The device check
        counts as the second factor, so a passkey sign-in does not ask for an authenticator code. The
        password still works and is still required on any connection that cannot run a passkey.
      </div>
      <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 6, lineHeight: 1.5 }}>
        These are separate from vault passkeys, which unlock stored data-source credentials. Adding one
        here grants no access to the vault.
      </div>

      {passkeys.length > 0 && (
        <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
          {passkeys.map(passkey => (
            <InsetPanel key={passkey.id} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <div>
                <div style={{ fontSize: 13 }}>{passkey.label || 'Passkey'}</div>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                  Added {formatDate(passkey.created_at)}
                  {passkey.last_used_at ? ` · Last used ${formatDate(passkey.last_used_at)}` : ' · Not used yet'}
                </div>
              </div>
              <Button small variant="ghost" disabled={busy} onClick={() => removePasskey(passkey.id)}>
                Remove
              </Button>
            </InsetPanel>
          ))}
        </div>
      )}

      {availability.available ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          <input
            value={label}
            onChange={e => setLabel(e.target.value)}
            placeholder="Name this device (optional)"
            aria-label="Passkey name"
            style={inputStyle}
          />
          <Button small onClick={addPasskey} disabled={busy}>
            {busy ? 'Waiting for the passkey...' : 'Add a passkey'}
          </Button>
        </div>
      ) : (
        <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 12 }}>
          {PASSKEY_SIGN_IN_UNAVAILABLE[availability.reason] || 'Passkeys cannot be added on this connection.'}
        </div>
      )}

      {error && <div style={{ marginTop: 10, color: 'var(--danger)', fontSize: 13 }}>{error}</div>}
    </div>
  )
}

// The signed-in user's own sign-in factors — passkeys and the authenticator app. Per-user, so a Settings
// section, unlike the installation-wide switch and password policy on Administration
// (`administration/AccountSecuritySection.jsx`). Listed only while sign-in protection is on.
export default function SignInFactorsSection() {
  const fieldIdBase = useId()
  const [currentUser, setCurrentUser] = useState(null)
  const [loading, setLoading] = useState(true)
  const [setup, setSetup] = useState(null)
  const [setupCode, setSetupCode] = useState('')
  const [disableCode, setDisableCode] = useState('')
  const [regenCode, setRegenCode] = useState('')
  const [recoveryCodes, setRecoveryCodes] = useState([])
  const [copiedCodes, setCopiedCodes] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function copyRecoveryCodes() {
    try {
      await navigator.clipboard.writeText(recoveryCodes.join('\n'))
      setCopiedCodes(true)
      setTimeout(() => setCopiedCodes(false), 2000)
    } catch {
      setError('Could not reach the clipboard — select the codes above and copy them manually.')
    }
  }

  async function load() {
    setLoading(true)
    try {
      const resp = await api.getCurrentUser()
      setCurrentUser(resp.user)
      setError('')
    } catch (err) {
      setError(err.message || 'Failed to load security settings')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  async function beginSetup() {
    setSaving(true)
    setError('')
    try {
      const resp = await api.startTwoFactorSetup()
      setSetup(resp)
      setSetupCode('')
    } catch (err) {
      setError(err.message || 'Failed to start authenticator setup')
    } finally {
      setSaving(false)
    }
  }

  async function confirmSetup(e) {
    e.preventDefault()
    setSaving(true)
    setError('')
    try {
      const resp = await api.confirmTwoFactorSetup(setup.secret, setupCode)
      setCurrentUser(resp.user)
      setRecoveryCodes(resp.recovery_codes || [])
      setSetup(null)
      setSetupCode('')
    } catch (err) {
      setError(err.message || 'Failed to enable authenticator app')
    } finally {
      setSaving(false)
    }
  }

  async function turnOff2fa(e) {
    e.preventDefault()
    setSaving(true)
    setError('')
    try {
      const resp = await api.disableTwoFactor(disableCode)
      setCurrentUser(resp.user)
      setDisableCode('')
    } catch (err) {
      setError(err.message || 'Failed to disable authenticator app')
    } finally {
      setSaving(false)
    }
  }

  async function regenerateCodes(e) {
    e.preventDefault()
    setSaving(true)
    setError('')
    try {
      const resp = await api.regenerateRecoveryCodes(regenCode)
      setCurrentUser(resp.user)
      setRecoveryCodes(resp.recovery_codes || [])
      setRegenCode('')
    } catch (err) {
      setError(err.message || 'Failed to regenerate recovery codes')
    } finally {
      setSaving(false)
    }
  }

  // Nothing while loading: the shared `Spinner` is a page-level block, and the wait is one request.
  if (loading || !currentUser) return null

  const inputStyle = {
    ...getFormControlStyle({ size: 'md', surface: 'base' }),
    width: '100%',
  }

  return (
    <Card style={{ padding: 20 }}>
      {/* Above the authenticator app because it changes what that section means: a passkey sign-in
          satisfies the second factor, so someone deciding between the two needs to read this first. */}
      <SignInPasskeysPanel user={currentUser} onUserChange={setCurrentUser} />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Authenticator app</div>
          <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>
            Status: {currentUser.two_factor_enabled ? 'Enabled' : 'Not enabled'}
          </div>
          {currentUser.two_factor_enabled && (
            <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>
              Recovery codes remaining: {currentUser.recovery_code_count}
            </div>
          )}
        </div>
        {!currentUser.two_factor_enabled && !setup && (
          <Button small onClick={beginSetup} disabled={saving}>Set up 2FA</Button>
        )}
      </div>

      {setup && !currentUser.two_factor_enabled && (
        <InsetPanel as="form" onSubmit={confirmSetup} style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>
            Scan this QR code with your authenticator app (or enter the key manually), then enter the current 6-digit code to confirm.
          </div>
          {setup.qr_svg && (
            <div style={{ display: 'flex', justifyContent: 'center' }}>
              <img
                src={setup.qr_svg}
                alt="Authenticator setup QR code"
                width={168}
                height={168}
                style={{ background: '#fff', padding: 8, borderRadius: 8, border: '1px solid var(--border)' }}
              />
            </div>
          )}
          <div>
            <div style={{ fontSize: 11, color: 'var(--muted)', display: 'block', marginBottom: 4 }}>Manual setup key</div>
            <div style={{ fontFamily: 'monospace', fontSize: 14, padding: '10px 12px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, wordBreak: 'break-all' }}>
              {setup.secret}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: 'var(--muted)', display: 'block', marginBottom: 4 }}>Provisioning URI</div>
            <div style={{ fontFamily: 'monospace', fontSize: 11, padding: '10px 12px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, wordBreak: 'break-all' }}>
              {setup.otpauth_uri}
            </div>
          </div>
          <input
            id={`${fieldIdBase}-setup-code`}
            name="settings-2fa-setup-code"
            value={setupCode}
            onChange={e => setSetupCode(e.target.value)}
            placeholder="Enter 6-digit code"
            aria-label="Authenticator app setup code"
            style={inputStyle}
            {...ONE_TIME_CODE_PROPS}
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <Button small type="submit" disabled={saving || setupCode.trim().length < 6}>
              {saving ? 'Enabling...' : 'Confirm setup'}
            </Button>
            <Button small variant="ghost" type="button" onClick={() => { setSetup(null); setSetupCode(''); setError('') }}>
              Cancel
            </Button>
          </div>
        </InsetPanel>
      )}

      {currentUser.two_factor_enabled && (
        <div style={{ display: 'grid', gap: 12 }}>
          <InsetPanel as="form" onSubmit={turnOff2fa}>
            <div style={{ fontSize: 13, color: 'var(--muted)' }}>
              Enter a current authenticator code to disable 2FA for this account.
            </div>
            <input
              id={`${fieldIdBase}-disable-code`}
              name="settings-2fa-disable-code"
              value={disableCode}
              onChange={e => setDisableCode(e.target.value)}
              placeholder="Enter 6-digit code"
              aria-label="Authenticator code to disable 2FA"
              style={inputStyle}
              {...ONE_TIME_CODE_PROPS}
            />
            <div>
              <Button small type="submit" disabled={saving || disableCode.trim().length < 6}>
                {saving ? 'Disabling...' : 'Disable 2FA'}
              </Button>
            </div>
          </InsetPanel>

          <InsetPanel as="form" onSubmit={regenerateCodes}>
            <div style={{ fontSize: 13, color: 'var(--muted)' }}>
              Regenerate your recovery codes. This invalidates the current set immediately.
            </div>
            <input
              id={`${fieldIdBase}-regen-code`}
              name="settings-2fa-regenerate-code"
              value={regenCode}
              onChange={e => setRegenCode(e.target.value)}
              placeholder="Enter current 6-digit code"
              aria-label="Authenticator code to regenerate recovery codes"
              style={inputStyle}
              {...ONE_TIME_CODE_PROPS}
            />
            <div>
              <Button small type="submit" disabled={saving || regenCode.trim().length < 6}>
                {saving ? 'Regenerating...' : 'Regenerate recovery codes'}
              </Button>
            </div>
          </InsetPanel>
        </div>
      )}

      {recoveryCodes.length > 0 && (
        <div style={{ marginTop: 14, padding: 14, border: '1px solid var(--warning)', borderRadius: 10, background: 'color-mix(in srgb, var(--warning) 10%, var(--surface))' }}>
          <div style={{ fontSize: 13, color: 'var(--muted)' }}>
            Save these recovery codes somewhere secure. They are shown only once and each code can be used one time.
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8, marginTop: 12 }}>
            {recoveryCodes.map(code => (
              <div key={code} style={{ fontFamily: 'monospace', fontSize: 13, padding: '8px 10px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8 }}>
                {code}
              </div>
            ))}
          </div>
          <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
            <Button small type="button" onClick={copyRecoveryCodes}>
              {copiedCodes ? 'Copied' : 'Copy codes'}
            </Button>
            <Button small variant="ghost" type="button" onClick={() => { setRecoveryCodes([]); setCopiedCodes(false) }}>
              Dismiss codes
            </Button>
          </div>
        </div>
      )}

      {error && (
        <div style={{ marginTop: 14, color: 'var(--danger)', fontSize: 13 }}>
          {error}
        </div>
      )}
    </Card>
  )
}
