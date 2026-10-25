// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState, useEffect, useRef } from 'react'
import { api } from '../../lib/api.js'
import { NEW_SECRET_PROPS } from '../../lib/sensitiveFields.js'
import { Card, Button, FieldIssue, FormLabel, InsetPanel, getFormControlStyle, PasswordInput, PasswordManagerUsername, AppConfirmDialog, Toggle, Tooltip } from '../ui.jsx'
import { PASSWORD_MISMATCH, PASSWORD_POLICIES, passwordIssue, passwordMismatchShown, passwordPolicyHelpText, usePasswordChecks } from '../../lib/passwordPolicy.js'

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

// The first row of the section in both states: whether sign-in protection is on, and the switch that
// changes it. Neither direction takes effect on the click — turning on needs a password (the form that
// click opens), turning off reopens network access (a confirm) — so the switch shows the stored state
// and moves only once the change has been made.
function SignInProtectionControl({ authEnabled, onRequestEnable }) {
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
        <Toggle
          checked={authEnabled}
          onChange={next => (next ? onRequestEnable() : setConfirmingOff(true))}
          ariaLabel="Sign-in protection"
          disabled={saving}
        />
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
  const adminConfirmRef = useRef(null)

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
  const check = usePasswordChecks(policy, [adminPassword, ...others.map(p => otherPasswords[p.id] || '')])
  const adminIssue = passwordIssue({ password: adminPassword, confirm: adminConfirm, check, withConfirm: true })
  const otherIssue = id => passwordIssue({ password: otherPasswords[id], check, optional: true })
  const otherWithIssue = others.find(p => otherIssue(p.id))
  const blockingIssue = !claimId ? 'Choose which user is yours.'
    : adminIssue || (otherWithIssue ? `Starting password for "${otherWithIssue.name}": ${otherIssue(otherWithIssue.id)}` : '')
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
    <Button variant="secondary" type="button" onClick={onCancel} disabled={saving}>Cancel</Button>
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
          <Button onClick={enablePlain} disabled={saving}>
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
        <PasswordInput
          ref={adminPasswordRef} aria-label="Your password" value={adminPassword} onChange={edited(setAdminPassword)} disabled={saving}
          wrapperStyle={PASSWORD_FIELD_WIDTH} style={PASSWORD_FIELD_STYLE} {...NEW_SECRET_PROPS}
          suggestion="password" onSuggest={() => { setAdminConfirm(''); adminConfirmRef.current?.focus() }}
        />
        <FieldIssue>{check(adminPassword).shortfall}</FieldIssue>
        <PasswordInput ref={adminConfirmRef} value={adminConfirm} onChange={edited(setAdminConfirm)} placeholder="Confirm password" disabled={saving} wrapperStyle={PASSWORD_FIELD_WIDTH} style={PASSWORD_FIELD_STYLE} {...NEW_SECRET_PROPS} />
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
                suggestion="password"
              />
              <FieldIssue>{check(otherPasswords[p.id]).shortfall}</FieldIssue>
            </div>
          ))}
        </div>
      )}

      {error && <div style={{ color: '#ef4444', fontSize: 13 }}>{error}</div>}

      <div style={{ display: 'flex', gap: 8 }}>
        <Tooltip content={blockingIssue && !saving ? blockingIssue : ''}>
          <Button type="submit" disabled={saving || !!blockingIssue}>
            {saving ? 'Enabling...' : 'Enable sign-in protection'}
          </Button>
        </Tooltip>
        {cancelButton}
      </div>
    </InsetPanel>
  )
}

// Administration's sign-in section: the sign-in protection switch, the password policy, and the form
// that turns protection on. All three are installation-wide, which is why they are here while each
// user's own passkeys and 2FA are a Settings section (`settings/SignInFactorsSection.jsx`). The page
// is not shown to anyone who may not change them, so nothing here checks a role; the server does.
export function AccountSecuritySection({ authEnabled, activeLocalProfile, passwordPolicy, onPasswordPolicyChange }) {
  // Counts presses of the switch while protection is off; non-zero means the enable form is open.
  const [enableRequest, setEnableRequest] = useState(0)

  return (
    <Card style={{ padding: 20 }}>
      <SignInProtectionControl
        authEnabled={authEnabled}
        onRequestEnable={() => setEnableRequest(n => n + 1)}
      />
      <PasswordPolicyPanel passwordPolicy={passwordPolicy} onChange={onPasswordPolicyChange} />
      {!authEnabled && enableRequest > 0 ? (
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
