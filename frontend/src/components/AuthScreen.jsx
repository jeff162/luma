// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from 'react'
import { api } from '../lib/api.js'
import { APP_NAME } from '../lib/appConfig.js'
import { passwordPolicyHelpText, validatePasswordForPolicy } from '../lib/passwordPolicy.js'
import { getSecurityProfile } from '../lib/securityProfiles.js'
import TransientTextInput from './TransientTextInput.jsx'

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

export default function AuthScreen({ needsBootstrap, passwordPolicy = 'min_8', securityProfile = 'local_private', onAuthenticated }) {
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
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const profile = getSecurityProfile(securityProfile)

  async function handleSubmit(e) {
    e.preventDefault()
    setSubmitting(true)
    setError('')
    try {
      const resp = needsBootstrap
        ? await api.bootstrap(username, password, displayName || username)
        : await api.login(username, password)
      if (resp.requires_2fa) {
        // Username/password can be accepted before the session is complete, so the form pivots into code entry in place.
        setAwaiting2fa(true)
        setRecoveryCodeCount(resp.recovery_code_count ?? null)
        setTwoFactorCode('')
        return
      }
      onAuthenticated(resp.user)
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
    ? (awaiting2fa ? 'Verifying code...' : (needsBootstrap ? 'Creating account...' : 'Signing in...'))
    : (awaiting2fa ? 'Verify code' : (needsBootstrap ? 'Create first account' : 'Sign in'))
  const bootstrapPasswordOk = validatePasswordForPolicy(password, passwordPolicy)

  return (
    <div style={s.page}>
      <form onSubmit={awaiting2fa ? handleTwoFactorSubmit : handleSubmit} style={s.card}>
        <div style={{ fontSize: 28, fontWeight: 700, marginBottom: 6 }}>{APP_NAME}</div>
        <div style={{ fontSize: 14, color: 'var(--muted)', marginBottom: 20, lineHeight: 1.5 }}>
          {awaiting2fa
            ? `Enter the 6-digit code from your authenticator app to complete sign-in.${recoveryCodeCount ? ` You can also use one of your ${recoveryCodeCount} recovery codes.` : ''}`
            : needsBootstrap
              ? `Create the first account. That account becomes the initial tenant owner. Security mode: ${profile.label}.`
              : `Sign in to load your workspace. Security mode: ${profile.label}.`}
        </div>
        {!awaiting2fa && (
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 16, lineHeight: 1.5 }}>
            {profile.summary}
          </div>
        )}

        <div style={{ display: 'grid', gap: 12 }}>
          {!awaiting2fa && (
            <TransientTextInput
              value={username}
              onChange={setUsername}
              restoreOnEscape
              onBlurCommit={false}
              placeholder="Username"
              autoComplete="username"
              style={s.input}
            />
          )}
          {!awaiting2fa && needsBootstrap && (
            <TransientTextInput
              value={displayName}
              onChange={setDisplayName}
              restoreOnEscape
              onBlurCommit={false}
              placeholder="Display name"
              autoComplete="name"
              style={s.input}
            />
          )}
          {!awaiting2fa ? (
            <>
              <TransientTextInput
                type="password"
                value={password}
                onChange={setPassword}
                restoreOnEscape
                onBlurCommit={false}
                placeholder="Password"
                autoComplete={needsBootstrap ? 'new-password' : 'current-password'}
                style={s.input}
              />
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
              restoreOnEscape
              onBlurCommit={false}
              placeholder="123456"
              inputMode="numeric"
              autoComplete="one-time-code"
              style={s.input}
            />
          )}
        </div>

        {error && (
          <div style={{ marginTop: 14, fontSize: 13, color: 'var(--danger)' }}>
            {error}
          </div>
        )}

        <button type="submit" disabled={submitting || (needsBootstrap && !awaiting2fa && !bootstrapPasswordOk)} style={{ ...s.button, marginTop: 18, opacity: (submitting || (needsBootstrap && !awaiting2fa && !bootstrapPasswordOk)) ? 0.7 : 1 }}>
          {buttonLabel}
        </button>
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
