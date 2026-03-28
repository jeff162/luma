import { useState } from 'react'
import { api } from '../lib/api.js'
import { passwordPolicyHelpText, validatePasswordForPolicy } from '../lib/passwordPolicy.js'

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
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [twoFactorCode, setTwoFactorCode] = useState('')
  const [awaiting2fa, setAwaiting2fa] = useState(false)
  const [recoveryCodeCount, setRecoveryCodeCount] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e) {
    e.preventDefault()
    setSubmitting(true)
    setError('')
    try {
      const resp = needsBootstrap
        ? await api.bootstrap(username, password, displayName || username)
        : await api.login(username, password)
      if (resp.requires_2fa) {
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
        <div style={{ fontSize: 28, fontWeight: 700, marginBottom: 6 }}>FinTrack</div>
        <div style={{ fontSize: 14, color: 'var(--muted)', marginBottom: 20, lineHeight: 1.5 }}>
          {awaiting2fa
            ? `Enter the 6-digit code from your authenticator app to complete sign-in.${recoveryCodeCount ? ` You can also use one of your ${recoveryCodeCount} recovery codes.` : ''}`
            : needsBootstrap
            ? 'Create the first account for this FinTrack instance. That account becomes the initial tenant owner.'
            : 'Sign in to load your FinTrack workspace.'}
        </div>

        <div style={{ display: 'grid', gap: 12 }}>
          {!awaiting2fa && (
            <input
              value={username}
              onChange={e => setUsername(e.target.value)}
              placeholder="Username"
              autoComplete="username"
              style={s.input}
            />
          )}
          {!awaiting2fa && needsBootstrap && (
            <input
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              placeholder="Display name"
              autoComplete="name"
              style={s.input}
            />
          )}
          {!awaiting2fa ? (
            <>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
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
            <input
              value={twoFactorCode}
              onChange={e => setTwoFactorCode(e.target.value)}
              placeholder="123456"
              inputMode="numeric"
              autoComplete="one-time-code"
              style={s.input}
            />
          )}
        </div>

        {error && (
          <div style={{ marginTop: 14, fontSize: 13, color: '#ef4444' }}>
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
