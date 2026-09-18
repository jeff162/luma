// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api.js'
import { PASSKEY_SIGN_IN_UNAVAILABLE, assertSignInPasskey, signInAvailability } from '../lib/appPasskey.js'
import { ONE_TIME_CODE_PROPS } from '../lib/sensitiveFields.js'
import { APP_NAME } from '../lib/appConfig.js'
import {
  PASSWORD_MISMATCH, passwordIssue, passwordMismatchShown, passwordPolicyHelpText, passwordShortfall,
} from '../lib/passwordPolicy.js'
import TransientTextInput from './TransientTextInput.jsx'
import { FieldIssue, PasswordInput, PasswordManagerUsername, Tooltip } from './ui.jsx'

const s = {
  page: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    background: 'linear-gradient(180deg, color-mix(in srgb, var(--accent) 10%, var(--bg)), var(--bg))',
  },
  card: {
    width: '100%',
    maxWidth: 420,
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 16,
    padding: 24,
    boxShadow: '0 18px 50px rgba(0,0,0,0.18)',
  },
  input: {
    width: '100%',
    background: 'var(--surface2)',
    color: 'var(--text)',
    border: '1px solid var(--border)',
    borderRadius: 10,
    padding: '10px 12px',
    fontSize: 14,
    outline: 'none',
  },
  button: {
    width: '100%',
    background: 'var(--accent)',
    color: '#fff',
    border: 'none',
    borderRadius: 10,
    padding: '11px 14px',
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
  },
}

export default function AuthScreen({ needsBootstrap, passwordPolicy = 'min_8', onAuthenticated }) {
  /*
   * Bootstrap, password login, and 2FA confirmation share one shell here so the active security profile,
   * password rules, and recovery-code guidance stay in the same flow instead of bouncing the user between screens.
   */
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [twoFactorCode, setTwoFactorCode] = useState('')
  const [awaiting2fa, setAwaiting2fa] = useState(false)
  const [recoveryCodeCount, setRecoveryCodeCount] = useState(null)
  // A migrated/claimable account (or an admin-forced reset) must set a new password before the session
  // completes; login/change-password can return `requires_password_change`, pivoting the form in place.
  const [awaitingPasswordChange, setAwaitingPasswordChange] = useState(false)
  const [newPassword, setNewPassword] = useState('')
  const [newPasswordConfirm, setNewPasswordConfirm] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  // Whether this connection can run a ceremony *and* anyone has registered a passkey here. Both halves
  // come from one public call, so the button is offered only where pressing it could actually work —
  // a passkey button that explains itself away after the click is worse than no button.
  const [passkeyParams, setPasskeyParams] = useState(null)
  const [passkeyBusy, setPasskeyBusy] = useState(false)

  // The two steps that *choose* a password — the first account, and a forced change — are checked as
  // they are typed, and their button is greyed for the reason shown (`lib/passwordPolicy.js`). Signing in
  // with an existing password is not held to the policy here: the policy may have been tightened since
  // that password was set, and the server is the one to say whether it still opens the account.
  const passwordStepIssue = awaitingPasswordChange
    ? passwordIssue({ password: newPassword, confirm: newPasswordConfirm, policy: passwordPolicy, withConfirm: true })
    : (needsBootstrap && !awaiting2fa) ? passwordIssue({ password, policy: passwordPolicy }) : ''
  // An error is about the attempt that produced it, so editing a password field retires it — otherwise a
  // refusal of the previous value sits beside the corrected one and reads as a verdict on it.
  const edited = setter => value => { setError(''); setter(value) }

  // TransientTextInput intercepts Enter (preventDefault + commit), so the native "Enter submits the
  // form" never fires. Wire it explicitly: Enter advances to the next field, and Enter on the final
  // field submits (requestSubmit routes through the form's onSubmit and respects a disabled button,
  // e.g. an invalid bootstrap password).
  const formRef = useRef(null)
  const displayNameRef = useRef(null)
  const passwordRef = useRef(null)
  const newPasswordConfirmRef = useRef(null)
  const advanceOnEnter = ref => e => { if (e.key === 'Enter') ref.current?.focus() }
  const submitOnEnter = e => { if (e.key === 'Enter') formRef.current?.requestSubmit() }

  // Route a login/change-password response to the right in-place step (password change, then 2FA, then done).
  function applyAuthResponse(resp) {
    if (resp.requires_password_change) {
      setAwaitingPasswordChange(true)
      setNewPassword('')
      setNewPasswordConfirm('')
      return
    }
    if (resp.requires_2fa) {
      setAwaiting2fa(true)
      setRecoveryCodeCount(resp.recovery_code_count ?? null)
      setTwoFactorCode('')
      return
    }
    onAuthenticated(resp.user)
  }

  useEffect(() => {
    // Bootstrap has no account to hold a passkey yet, so the call is skipped rather than answered and
    // ignored. A failure here leaves the button hidden: the password form behind it always works.
    if (needsBootstrap) return
    let cancelled = false
    api.signInPasskeyParams()
      .then(params => { if (!cancelled) setPasskeyParams(params) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [needsBootstrap])

  async function handlePasskeySignIn() {
    setPasskeyBusy(true)
    setError('')
    try {
      const { options } = await api.beginPasskeySignIn()
      const result = await assertSignInPasskey(options)
      if (!result.ok) {
        // A dismissed prompt is not a failure worth shouting about, and the password field is right
        // there: say what happened only when there is something to say.
        if (result.reason !== 'cancelled') {
          setError(PASSKEY_SIGN_IN_UNAVAILABLE[result.reason] || 'That passkey could not be used.')
        }
        return
      }
      applyAuthResponse(await api.completePasskeySignIn(result.credential))
    } catch (err) {
      setError(err.message || 'That passkey could not be used.')
    } finally {
      setPasskeyBusy(false)
    }
  }

  async function handleSubmit(e) {
    e.preventDefault()
    if (passwordStepIssue || submitting) return
    setSubmitting(true)
    setError('')
    try {
      const resp = needsBootstrap
        ? await api.bootstrap(username, password, displayName || username)
        : await api.login(username, password)
      applyAuthResponse(resp)
    } catch (err) {
      setError(err.message || 'Request failed')
    } finally {
      setSubmitting(false)
    }
  }

  async function handlePasswordChangeSubmit(e) {
    e.preventDefault()
    // Guarded on the same issue the button is, so Enter can never submit what the button refuses.
    if (passwordStepIssue || submitting) return
    setSubmitting(true)
    setError('')
    try {
      const resp = await api.changePassword(newPassword)
      setAwaitingPasswordChange(false)
      applyAuthResponse(resp)
    } catch (err) {
      setError(err.message || 'Request failed')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleTwoFactorSubmit(e) {
    e.preventDefault()
    setSubmitting(true)
    setError('')
    try {
      const resp = await api.verifyTwoFactor(twoFactorCode)
      onAuthenticated(resp.user)
    } catch (err) {
      setError(err.message || 'Request failed')
    } finally {
      setSubmitting(false)
    }
  }

  const buttonLabel = submitting
    ? (awaitingPasswordChange ? 'Saving password...' : (awaiting2fa ? 'Verifying code...' : (needsBootstrap ? 'Creating account...' : 'Signing in...')))
    : (awaitingPasswordChange ? 'Set password' : (awaiting2fa ? 'Verify code' : (needsBootstrap ? 'Create first account' : 'Sign in')))
  // Only on the first step. Once a sign-in is part-way through a forced password change or a second
  // factor, a passkey is not an alternative route — it is a different sign-in, and offering it there
  // would abandon the one in progress.
  const passkeyOffered = !needsBootstrap && !awaiting2fa && !awaitingPasswordChange
    && signInAvailability(passkeyParams).available
  const formSubmit = awaitingPasswordChange
    ? handlePasswordChangeSubmit
    : (awaiting2fa ? handleTwoFactorSubmit : handleSubmit)

  return (
    <div style={s.page}>
      <form ref={formRef} onSubmit={formSubmit} style={s.card}>
        <div style={{ fontSize: 28, fontWeight: 700, marginBottom: 6 }}>{APP_NAME}</div>
        <div style={{ fontSize: 14, color: 'var(--muted)', marginBottom: 20, lineHeight: 1.5 }}>
          {awaitingPasswordChange
            ? 'Set a new password to finish signing in.'
            : awaiting2fa
              ? `Enter the 6-digit code from your authenticator app to complete sign-in.${recoveryCodeCount ? ` You can also use one of your ${recoveryCodeCount} recovery codes.` : ''}`
              : needsBootstrap
                ? 'Create the first account. That account becomes the workspace admin.'
                : 'Sign in to load your workspace.'}
        </div>

        <div style={{ display: 'grid', gap: 12 }}>
          {!awaiting2fa && !awaitingPasswordChange && (
            <TransientTextInput
              value={username}
              onChange={setUsername}
              onKeyDown={advanceOnEnter(needsBootstrap ? displayNameRef : passwordRef)}
              restoreOnEscape
              onBlurCommit={false}
              placeholder="Username"
              autoComplete="username"
              style={s.input}
            />
          )}
          {!awaiting2fa && !awaitingPasswordChange && needsBootstrap && (
            <TransientTextInput
              ref={displayNameRef}
              value={displayName}
              onChange={setDisplayName}
              onKeyDown={advanceOnEnter(passwordRef)}
              restoreOnEscape
              onBlurCommit={false}
              placeholder="Display name"
              autoComplete="name"
              style={s.input}
            />
          )}
          {awaitingPasswordChange ? (
            <>
              {/* The username field is gone by this step, so name the account the new password is for —
                  otherwise a manager saves it with no username, beside the one it should replace. */}
              <PasswordManagerUsername value={username} />
              <PasswordInput
                as={TransientTextInput}
                value={newPassword}
                onChange={edited(setNewPassword)}
                onKeyDown={advanceOnEnter(newPasswordConfirmRef)}
                restoreOnEscape
                onBlurCommit={false}
                placeholder="New password"
                autoComplete="new-password"
                style={s.input}
              />
              <FieldIssue style={{ marginTop: -4 }}>{passwordShortfall(newPassword, passwordPolicy)}</FieldIssue>
              <PasswordInput
                as={TransientTextInput}
                ref={newPasswordConfirmRef}
                value={newPasswordConfirm}
                onChange={edited(setNewPasswordConfirm)}
                onKeyDown={submitOnEnter}
                restoreOnEscape
                onBlurCommit={false}
                placeholder="Confirm new password"
                autoComplete="new-password"
                style={s.input}
              />
              <FieldIssue style={{ marginTop: -4 }}>
                {passwordMismatchShown(newPassword, newPasswordConfirm) ? PASSWORD_MISMATCH : ''}
              </FieldIssue>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: -4 }}>
                {passwordPolicyHelpText(passwordPolicy)}
              </div>
            </>
          ) : !awaiting2fa ? (
            <>
              <PasswordInput
                as={TransientTextInput}
                ref={passwordRef}
                value={password}
                onChange={edited(setPassword)}
                onKeyDown={submitOnEnter}
                restoreOnEscape
                onBlurCommit={false}
                placeholder="Password"
                autoComplete={needsBootstrap ? 'new-password' : 'current-password'}
                style={s.input}
              />
              {needsBootstrap && (
                <FieldIssue style={{ marginTop: -4 }}>{passwordShortfall(password, passwordPolicy)}</FieldIssue>
              )}
              {needsBootstrap && (
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: -4 }}>
                  {passwordPolicyHelpText(passwordPolicy)}
                </div>
              )}
            </>
          ) : (
            <TransientTextInput
              value={twoFactorCode}
              onChange={setTwoFactorCode}
              onKeyDown={submitOnEnter}
              restoreOnEscape
              onBlurCommit={false}
              placeholder="123456"
              style={s.input}
              {...ONE_TIME_CODE_PROPS}
            />
          )}
        </div>

        {error && (
          <div style={{ marginTop: 14, fontSize: 13, color: 'var(--danger)' }}>
            {error}
          </div>
        )}

        {/* Full-width trigger: the tooltip wraps its child only while it has something to say, and its
            default inline wrapper would shrink this full-width button exactly when it greys out. */}
        <Tooltip content={passwordStepIssue && !submitting ? passwordStepIssue : ''} triggerStyle={{ display: 'flex', width: '100%' }}>
          <button type="submit" disabled={submitting || !!passwordStepIssue} style={{ ...s.button, marginTop: 18, opacity: (submitting || passwordStepIssue) ? 0.7 : 1 }}>
            {buttonLabel}
          </button>
        </Tooltip>
        {passkeyOffered && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '14px 0 4px' }}>
              <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>or</div>
              <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
            </div>
            <button
              type="button"
              onClick={handlePasskeySignIn}
              disabled={passkeyBusy}
              style={{ ...s.button, marginTop: 10, background: 'transparent', color: 'var(--text)', border: '1px solid var(--border)', opacity: passkeyBusy ? 0.7 : 1 }}
            >
              {passkeyBusy ? 'Waiting for the passkey...' : 'Sign in with a passkey'}
            </button>
          </>
        )}
        {awaiting2fa && (
          <button
            type="button"
            onClick={() => { setAwaiting2fa(false); setTwoFactorCode(''); setError('') }}
            style={{ ...s.button, marginTop: 10, background: 'transparent', color: 'var(--text)', border: '1px solid var(--border)' }}
          >
            Back
          </button>
        )}
      </form>
    </div>
  )
}
