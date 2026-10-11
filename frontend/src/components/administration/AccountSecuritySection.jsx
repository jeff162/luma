// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState, useEffect, useRef, useId } from 'react'
import { api } from '../../lib/api.js'
import { NEW_SECRET_PROPS, ONE_TIME_CODE_PROPS } from '../../lib/sensitiveFields.js'
import { Card, Button, FieldIssue, FormLabel, InsetPanel, getFormControlStyle, PasswordInput, PasswordManagerUsername, AppConfirmDialog, Toggle, Tooltip } from '../ui.jsx'
import { PASSWORD_MISMATCH, PASSWORD_POLICIES, passwordIssue, passwordMismatchShown, passwordPolicyHelpText, passwordShortfall } from '../../lib/passwordPolicy.js'
import { PASSKEY_SIGN_IN_UNAVAILABLE, ceremonyAvailability, registerSignInPasskey } from '../../lib/appPasskey.js'
import { formatDate } from '../../lib/utils.js'

// Password fields don't need the full card width — cap them so a ~40-50 character entry is visible
// without the field spanning the whole (wide) settings card.
const PASSWORD_FIELD_WIDTH = { maxWidth: 360 }
// Sized like the page's other form controls rather than the shared `Input`'s larger default.
const PASSWORD_FIELD_STYLE = getFormControlStyle({ size: 'md', surface: 'base' })

// Password-strength policy for new sign-ins and account passwords. Shares the PASSWORD_POLICIES
// vocabulary with AuthScreen and new-user validation, so all three agree on the same choices.
function PasswordPolicyPanel({ passwordPolicy, onChange }) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function handleChange(nextPolicy) {
    setSaving(true)
    setError('')
    try {
      const resp = await api.savePasswordPolicy(nextPolicy)
      onChange?.(resp.password_policy || nextPolicy)
    } catch (err) {
      setError(err.message || 'Failed to save password policy')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ display: 'grid', gap: 8, marginBottom: 18 }}>
      <div style={{ fontSize: 14, fontWeight: 600 }}>Password policy</div>
      <div style={{ fontSize: 13, color: 'var(--muted)' }}>
        Choose how strictly passwords are validated for new sign-ins and user accounts.
      </div>
      <div style={{ display: 'grid', gap: 6, paddingLeft: 14 }}>
        {PASSWORD_POLICIES.map(option => (
          <label
            key={option.value}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '8px 12px',
              border: `1px solid ${passwordPolicy === option.value ? 'var(--accent)' : 'var(--border)'}`,
              borderRadius: 999,
              background: passwordPolicy === option.value
                ? 'color-mix(in srgb, var(--accent) 8%, var(--surface2))'
                : 'var(--surface2)',
              cursor: saving ? 'default' : 'pointer',
            }}
          >
            <input
              type="radio"
              name="password-policy"
              checked={passwordPolicy === option.value}
              onChange={() => handleChange(option.value)}
              disabled={saving}
            />
            <span style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap' }}>{option.label}</span>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>{option.hint}</span>
          </label>
        ))}
      </div>
      {error && (
        <div style={{ color: '#ef4444', fontSize: 13 }}>
          {error}
        </div>
      )}
    </div>
  )
}

// The first row of Account security in both states: whether sign-in protection is on, and the switch
// that changes it. Neither direction takes effect on the click — turning on needs a password (the form
// that click opens), turning off reopens network access (a confirm) — so the switch shows the stored
// state and moves only once the change has been made. Off, there is no role to hold and anyone here may
// turn it on; on, only an admin may turn it off. The server applies the same split.
function SignInProtectionControl({ authEnabled, canManage, onRequestEnable }) {
  const [confirmingOff, setConfirmingOff] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // A flag flip — identities and their password hashes are preserved, so turning it back on later is
  // seamless — and the page reloads into local mode.
  async function turnOff() {
    setSaving(true)
    setError('')
    try {
      await api.disableAuth()
      window.location.reload()
    } catch (err) {
      setError(err.message || 'Failed to turn off sign-in protection')
      setSaving(false)
      setConfirmingOff(false)
    }
  }

  return (
    <div style={{ marginBottom: 18 }}>
      {confirmingOff ? (
        <AppConfirmDialog
          title="Turn off sign-in protection?"
          description="Anyone who can reach this installation on the network will be able to open it and pick any identity — no password, no 2FA. Accounts and their passwords are kept, so you can turn protection back on at any time."
          confirmLabel="Turn off sign-in protection"
          confirmVariant="danger"
          borderColor="color-mix(in srgb, var(--danger) 35%, var(--border))"
          onConfirm={turnOff}
          onCancel={() => setConfirmingOff(false)}
          confirmDisabled={saving}
          width="min(520px, 100%)"
        />
      ) : null}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Sign-in protection</div>
          <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>
            {authEnabled
              ? 'On — opening this installation requires signing in.'
              : 'Off — anyone who can reach this installation can open it and pick any user.'}
          </div>
        </div>
        {canManage && (
          <Toggle
            checked={authEnabled}
            onChange={next => (next ? onRequestEnable() : setConfirmingOff(true))}
            ariaLabel="Sign-in protection"
            disabled={saving}
          />
        )}
      </div>
      {error && <div style={{ marginTop: 12, color: '#ef4444', fontSize: 13 }}>{error}</div>}
    </div>
  )
}

// Turning sign-in protection on, opened by the switch above it. Identities are already unified
// `user_account` rows, so this only assigns passwords/roles: the operator claims one identity as the
// admin (setting a password), and may set an optional starting password for each other identity. Every
// non-claimed account is forced to set its own password at next login, so a blank starting password
// just means "the person claims it themselves." The password policy is the stored one, chosen in the
// policy panel above this form rather than inside it. On success the page reloads into authenticated
// mode signed in as the admin. `focusKey` changes on every press of the switch, so pressing it again
// while the form is already open returns to the password field instead of doing nothing visible.
function EnableSignInForm({ passwordPolicy: policy, activeLocalProfile, focusKey, onCancel }) {
  const [profiles, setProfiles] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [claimId, setClaimId] = useState('')
  const [adminPassword, setAdminPassword] = useState('')
  const [adminConfirm, setAdminConfirm] = useState('')
  const [otherPasswords, setOtherPasswords] = useState({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const adminPasswordRef = useRef(null)

  useEffect(() => {
    let cancelled = false
    api.getIdentities()
      .then(resp => {
        if (cancelled) return
        const list = (resp.identities || []).map(i => ({ id: i.id, name: i.display_name, username: i.username }))
        setProfiles(list)
        // Pre-select the operator's active identity as the claim; fall back to the first.
        const preferred = list.find(p => p.id === activeLocalProfile?.id) || list[0]
        setClaimId(preferred?.id || '')
      })
      .catch(err => { if (!cancelled) setLoadError(err.message || 'Failed to load users') })
    return () => { cancelled = true }
  }, [activeLocalProfile?.id])

  useEffect(() => { adminPasswordRef.current?.focus() }, [focusKey, profiles])

  // Checked as the fields change rather than on submit. `error` is left holding only what the server
  // said, and is cleared by any edit: a message about the previous attempt that outlives the fix reads
  // as a verdict on what is on screen now — which is how a valid password came to sit beside "does not
  // meet the policy".
  const others = (profiles || []).filter(p => p.id !== claimId)
  const adminIssue = passwordIssue({ password: adminPassword, confirm: adminConfirm, policy, withConfirm: true })
  const otherShortfall = id => passwordShortfall(otherPasswords[id], policy)
  const otherWithIssue = others.find(p => otherShortfall(p.id))
  const blockingIssue = !claimId ? 'Choose which user is yours.'
    : adminIssue || (otherWithIssue ? `Starting password for "${otherWithIssue.name}": ${otherShortfall(otherWithIssue.id)}` : '')
  const edited = setter => value => { setError(''); setter(value) }

  async function enableWithMigration(e) {
    e.preventDefault()
    // Guarded on the same issue the button is, so Enter can never submit what the button refuses.
    if (blockingIssue || saving) return
    setError('')
    const initial_passwords = {}
    for (const p of others) {
      const pw = otherPasswords[p.id] || ''
      if (pw) initial_passwords[p.id] = pw
    }
    setSaving(true)
    try {
      await api.enableAuth({ claim_user_id: claimId, admin_password: adminPassword, initial_passwords })
      window.location.reload()
    } catch (err) {
      setError(err.message || 'Failed to enable sign-in protection')
      setSaving(false)
    }
  }

  // With no existing identities there is nothing to claim — enable auth and let the sign-in screen
  // bootstrap the first admin.
  async function enablePlain() {
    setSaving(true)
    setError('')
    try {
      await api.enableAuth()
      window.location.reload()
    } catch (err) {
      setError(err.message || 'Failed to enable sign-in protection')
      setSaving(false)
    }
  }

  const cancelButton = (
    <Button small variant="ghost" type="button" onClick={onCancel} disabled={saving}>Cancel</Button>
  )

  // Nothing until the identities arrive: the shared `Spinner` is a page-level block, and the wait is one
  // local request.
  if (profiles === null && !loadError) return null

  if (loadError) {
    return <div style={{ color: '#ef4444', fontSize: 13 }}>{loadError}</div>
  }

  if (profiles.length === 0) {
    return (
      <InsetPanel>
        <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
          Turning this on enables authenticated mode. You&apos;ll then create the first user account and use that account to manage any additional users.
        </div>
        {error && <div style={{ color: '#ef4444', fontSize: 13 }}>{error}</div>}
        <div style={{ display: 'flex', gap: 8 }}>
          <Button small onClick={enablePlain} disabled={saving}>
            {saving ? 'Enabling...' : 'Enable sign-in protection'}
          </Button>
          {cancelButton}
        </div>
      </InsetPanel>
    )
  }

  const single = profiles.length === 1
  const claimed = profiles.find(p => p.id === claimId)

  return (
    <InsetPanel as="form" onSubmit={enableWithMigration} style={{ gap: 16 }}>
      <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
        {single
          ? 'Turning this on password-protects your user. Set a password to continue — you become the admin.'
          : 'Turning this on password-protects each user. Choose which user is yours (you become the admin), then optionally set a starting password for the others. Everyone without a password is required to set a password the next time they sign in.'}
      </div>

      {!single && (
        <div style={{ display: 'grid', gap: 8 }}>
          <FormLabel>Which user is yours?</FormLabel>
          {profiles.map(p => (
            <label key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, cursor: 'pointer' }}>
              <input type="radio" name="claim-profile" checked={claimId === p.id} onChange={() => edited(setClaimId)(p.id)} disabled={saving} />
              <span style={{ fontWeight: 600 }}>{p.name}</span>
            </label>
          ))}
        </div>
      )}

      <div style={{ display: 'grid', gap: 8 }}>
        <FormLabel>Your password (admin)</FormLabel>
        {claimed?.username ? (
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            Sign in with the username <strong>{claimed.username}</strong>.
          </div>
        ) : null}
        <PasswordManagerUsername value={claimed?.username || ''} />
        <PasswordInput ref={adminPasswordRef} aria-label="Your password" value={adminPassword} onChange={edited(setAdminPassword)} disabled={saving} wrapperStyle={PASSWORD_FIELD_WIDTH} style={PASSWORD_FIELD_STYLE} {...NEW_SECRET_PROPS} />
        <FieldIssue>{passwordShortfall(adminPassword, policy)}</FieldIssue>
        <PasswordInput value={adminConfirm} onChange={edited(setAdminConfirm)} placeholder="Confirm password" disabled={saving} wrapperStyle={PASSWORD_FIELD_WIDTH} style={PASSWORD_FIELD_STYLE} {...NEW_SECRET_PROPS} />
        <FieldIssue>{passwordMismatchShown(adminPassword, adminConfirm) ? PASSWORD_MISMATCH : ''}</FieldIssue>
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>{passwordPolicyHelpText(policy)}</div>
      </div>

      {!single && others.length > 0 && (
        <div style={{ display: 'grid', gap: 10 }}>
          <FormLabel>Starting passwords for the other users (optional)</FormLabel>
          <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
            Leave blank to let each person set their own on first sign-in. Whatever you enter, they will be asked to choose a new password the next time they sign in.
          </div>
          {others.map(p => (
            <div key={p.id} style={{ display: 'grid', gap: 4 }}>
              <span style={{ fontSize: 12, fontWeight: 600 }}>{p.name}</span>
              <PasswordInput
                placeholder="Leave blank to let them set it"
                wrapperStyle={PASSWORD_FIELD_WIDTH}
                value={otherPasswords[p.id] || ''}
                onChange={edited(value => setOtherPasswords(prev => ({ ...prev, [p.id]: value })))}
                disabled={saving}
                style={PASSWORD_FIELD_STYLE}
                {...NEW_SECRET_PROPS}
              />
              <FieldIssue>{otherShortfall(p.id)}</FieldIssue>
            </div>
          ))}
        </div>
      )}

      {error && <div style={{ color: '#ef4444', fontSize: 13 }}>{error}</div>}

      <div style={{ display: 'flex', gap: 8 }}>
        <Tooltip content={blockingIssue && !saving ? blockingIssue : ''}>
          <Button small type="submit" disabled={saving || !!blockingIssue}>
            {saving ? 'Enabling...' : 'Enable sign-in protection'}
          </Button>
        </Tooltip>
        {cancelButton}
      </div>
    </InsetPanel>
  )
}

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

// The signed-in user's own sign-in factors — passkeys and the authenticator app. Per-user, unlike the
// switch and policy above them in Account security, and shown only while sign-in protection is on.
function SignInFactorsPanel() {
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

  // Nothing while loading: the shared `Spinner` is a page-level block, and this sits mid-card.
  if (loading || !currentUser) return null

  const inputStyle = {
    ...getFormControlStyle({ size: 'md', surface: 'base' }),
    width: '100%',
  }

  return (
    <>
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
    </>
  )
}

// Everything about signing in, in one section whatever the state: the sign-in protection switch, the
// password policy, then either the form that turns protection on or the user's own passkeys and 2FA.
// One section rather than one per state, so the switch and the policy are in the same place on both
// sides of it. The switch and policy are installation-wide and so admin-only once protection is on.
export function AccountSecuritySection({ authEnabled, currentUser, activeLocalProfile, passwordPolicy, onPasswordPolicyChange }) {
  const canManage = !authEnabled || currentUser?.role === 'admin'
  // Counts presses of the switch while protection is off; non-zero means the enable form is open.
  const [enableRequest, setEnableRequest] = useState(0)

  return (
    <Card style={{ padding: 20 }}>
      <SignInProtectionControl
        authEnabled={authEnabled}
        canManage={canManage}
        onRequestEnable={() => setEnableRequest(n => n + 1)}
      />
      {canManage && <PasswordPolicyPanel passwordPolicy={passwordPolicy} onChange={onPasswordPolicyChange} />}
      {authEnabled ? (
        <SignInFactorsPanel />
      ) : enableRequest > 0 ? (
        <EnableSignInForm
          passwordPolicy={passwordPolicy}
          activeLocalProfile={activeLocalProfile}
          focusKey={enableRequest}
          onCancel={() => setEnableRequest(0)}
        />
      ) : null}
    </Card>
  )
}
