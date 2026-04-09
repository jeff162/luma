// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useState } from 'react'
import { api } from '../lib/api.js'

const WAITING_STORAGE_KEY = 'fintrack.runtimeConfigWaitingForRestart'
const WAITING_STORAGE_TTL_MS = 5 * 60 * 1000

/*
 * Saving runtime secrets can knock the backend offline before the browser hears back, so this screen remembers
 * "waiting for restart" in sessionStorage and keeps polling until the same tab sees the backend come back.
 */
function readWaitingState() {
  try {
    const raw = window.sessionStorage.getItem(WAITING_STORAGE_KEY)
    if (!raw) return false

    const savedAt = Number(raw)
    if (!Number.isFinite(savedAt)) {
      window.sessionStorage.removeItem(WAITING_STORAGE_KEY)
      return false
    }

    if (Date.now() - savedAt > WAITING_STORAGE_TTL_MS) {
      window.sessionStorage.removeItem(WAITING_STORAGE_KEY)
      return false
    }

    return true
  } catch {
    return false
  }
}

function writeWaitingState() {
  try {
    window.sessionStorage.setItem(WAITING_STORAGE_KEY, String(Date.now()))
  } catch {}
}

function clearWaitingState() {
  try {
    window.sessionStorage.removeItem(WAITING_STORAGE_KEY)
  } catch {}
}

function detectPlatformCommand() {
  const platform = (navigator.userAgentData?.platform || navigator.platform || '').toLowerCase()

  if (platform.includes('win')) {
    return {
      label: 'Windows',
      command: '.\\scripts\\start_backend.bat',
      detail: 'Restart the backend window now, or run this in Command Prompt:',
    }
  }

  if (platform.includes('mac')) {
    return {
      label: 'macOS',
      command: 'bash ./scripts/start_backend.sh',
      detail: 'Restart the backend process with:',
    }
  }

  return {
    label: 'Linux',
    command: 'bash ./scripts/start_backend.sh',
    detail: 'Restart the backend process with:',
  }
}

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
    maxWidth: 560,
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
    fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
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

export default function RuntimeConfigScreen({ runtimeConfig }) {
  const backendWaitingForRestart = !!runtimeConfig?.pending_restart
  const [sessionSecret, setSessionSecret] = useState('')
  const [appMasterKey, setAppMasterKey] = useState('')
  const [sessionCookieName, setSessionCookieName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [loadingDefaults, setLoadingDefaults] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const [waitingForRestart, setWaitingForRestart] = useState(() => readWaitingState() || backendWaitingForRestart)
  const [copiedCommand, setCopiedCommand] = useState(false)
  const waitingMode = waitingForRestart || backendWaitingForRestart
  const platformCommand = detectPlatformCommand()

  useEffect(() => {
    if (backendWaitingForRestart) {
      writeWaitingState()
      setWaitingForRestart(true)
      return
    }

    clearWaitingState()
    setWaitingForRestart(false)
  }, [backendWaitingForRestart])

  useEffect(() => {
    if (!waitingForRestart) return

    writeWaitingState()

    let cancelled = false
    const timer = window.setInterval(async () => {
      try {
        const status = await api.getAuthStatus()
        if (cancelled) return
        if (status?.runtime_config?.ok) {
          clearWaitingState()
          window.location.reload()
        }
      } catch {
        // Ignore transient errors while the backend is restarting.
      }
    }, 2000)

    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [waitingForRestart])

  useEffect(() => {
    if (!waitingForRestart) {
      clearWaitingState()
    }
  }, [waitingForRestart])

  async function handleUseDefaults() {
    setLoadingDefaults(true)
    setError('')
    try {
      const defaults = await api.getRuntimeConfigDefaults()
      setSessionSecret(defaults.session_secret || '')
      setAppMasterKey(defaults.app_master_key || '')
      setSessionCookieName(defaults.session_cookie_name || '')
    } catch (err) {
      setError(err.message || 'Request failed')
    } finally {
      setLoadingDefaults(false)
    }
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setSubmitting(true)
    setError('')
    try {
      await api.saveRuntimeConfig({
        session_secret: sessionSecret.trim() || null,
        app_master_key: appMasterKey.trim() || null,
        session_cookie_name: sessionCookieName.trim() || null,
      })
      writeWaitingState()
      setSaved(true)
      setWaitingForRestart(true)
    } catch (err) {
      setError(err.message || 'Request failed')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleCopyCommand() {
    try {
      await navigator.clipboard.writeText(platformCommand.command)
      setCopiedCommand(true)
      window.setTimeout(() => setCopiedCommand(false), 1500)
    } catch {
      setError('Could not copy the command automatically')
    }
  }

  return (
    <div style={s.page}>
      <form onSubmit={handleSubmit} style={s.card}>
        <div style={{ fontSize: 28, fontWeight: 700, marginBottom: 6 }}>
          {waitingMode ? 'Restart required' : 'FinTrack setup required'}
        </div>
        {!waitingMode && (
          <div style={{ fontSize: 14, color: 'var(--muted)', marginBottom: 16, lineHeight: 1.6 }}>
            {runtimeConfig.message}
          </div>
        )}

        {!waitingMode && (
          <div style={{ fontSize: 13, lineHeight: 1.7, marginBottom: 18 }}>
            <div><strong>Expected file:</strong> <code>{runtimeConfig.env_file_path}</code></div>
            <div><strong>.env present:</strong> {runtimeConfig.env_file_present ? 'yes' : 'no'}</div>
          </div>
        )}

        {!waitingMode && (
          <div style={{ display: 'grid', gap: 12 }}>
          <button
            type="button"
            onClick={handleUseDefaults}
            disabled={loadingDefaults || submitting || saved}
            style={{ ...s.button, background: 'transparent', color: 'var(--text)', border: '1px solid var(--border)' }}
          >
            {loadingDefaults ? 'Generating defaults...' : 'Use recommended values'}
          </button>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>SESSION_SECRET</div>
            <input
              value={sessionSecret}
              onChange={e => setSessionSecret(e.target.value)}
              placeholder="Leave blank to generate one automatically"
              style={s.input}
            />
          </div>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>SESSION_COOKIE_NAME</div>
            <input
              value={sessionCookieName}
              onChange={e => setSessionCookieName(e.target.value)}
              placeholder="Defaults to a name based on this install directory"
              style={s.input}
            />
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6, lineHeight: 1.5 }}>
              Helps keep browser sessions separate when multiple FinTrack installs run on the same machine.
            </div>
          </div>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>APP_MASTER_KEY</div>
            <input
              value={appMasterKey}
              onChange={e => setAppMasterKey(e.target.value)}
              placeholder="Leave blank to generate a recommended value automatically"
              style={s.input}
            />
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6, lineHeight: 1.5 }}>
              Recommended before linking bank accounts. FinTrack will generate a secure value if left blank.
            </div>
          </div>
          </div>
        )}

        {error && (
          <div style={{ marginTop: 14, fontSize: 13, color: '#ef4444' }}>
            {error}
          </div>
        )}

        {(saved || waitingForRestart) && (
          <div style={{ marginTop: 14, fontSize: 14, color: 'var(--text)', lineHeight: 1.7 }}>
            <code>{runtimeConfig.env_file_path}</code> has been updated. Waiting for the backend to restart and reload the new settings.
          </div>
        )}
        {waitingMode && (
          <div style={{ marginTop: 10, fontSize: 13, color: 'var(--text)', lineHeight: 1.7 }}>
            <div style={{ marginBottom: 10 }}>
              {platformCommand.detail}
            </div>
            <div style={{
              background: 'var(--surface2)',
              border: '1px solid var(--border)',
              borderRadius: 10,
              padding: '10px 12px',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
            }}>
              <div style={{
                flex: 1,
                fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
                fontSize: 13,
                color: 'var(--text)',
                wordBreak: 'break-all',
              }}>
                {platformCommand.command}
              </div>
              <button
                type="button"
                onClick={handleCopyCommand}
                style={{
                  border: '1px solid var(--border)',
                  background: 'var(--surface)',
                  color: 'var(--text)',
                  borderRadius: 8,
                  width: 34,
                  height: 34,
                  cursor: 'pointer',
                  fontSize: 15,
                  lineHeight: 1,
                  flexShrink: 0,
                }}
                title="Copy command"
                aria-label="Copy command"
              >
                {copiedCommand ? 'OK' : '[]'}
              </button>
            </div>
            <div style={{ marginTop: 10, color: 'var(--muted)' }}>
              {copiedCommand ? 'Command copied to clipboard.' : 'This page will continue automatically once the backend is running with the updated configuration.'}
            </div>
          </div>
        )}

        {!waitingMode && (
          <button type="submit" disabled={submitting || saved} style={{ ...s.button, marginTop: 18, opacity: submitting || saved ? 0.7 : 1 }}>
            {submitting ? 'Saving...' : saved ? 'Saved' : 'Create/update .env'}
          </button>
        )}
      </form>
    </div>
  )
}
