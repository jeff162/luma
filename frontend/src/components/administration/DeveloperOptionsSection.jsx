// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from 'react'
import { api } from '../../lib/api.js'
import { useAppSession } from '../../lib/AppSessionContext.jsx'
import { localStore, sessionStore } from '../../lib/browserStorage.js'
import { Card, Button, AppConfirmDialog } from '../ui.jsx'
import { cornerTabStyle } from '../../lib/cornerTab.js'

function clearBrowserStoredState() {
  localStore.clear()
  sessionStore.clear()
}

export default function DeveloperOptionsSection({ authEnabled }) {
  const { currentUser, setCurrentUser } = useAppSession()
  const [workingAction, setWorkingAction] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  // Which card the outcome above belongs to, so it shows under the tool that produced it.
  const [messageFor, setMessageFor] = useState('resets')
  const [pendingActionConfirm, setPendingActionConfirm] = useState(null)

  async function runAction(actionKey, work) {
    setWorkingAction(actionKey)
    setMessageFor(actionKey === 'passphrases' ? 'testing' : 'resets')
    setMessage('')
    setError('')
    try {
      await work()
    } catch (err) {
      setError(err.message || 'Unable to complete that.')
    } finally {
      setWorkingAction('')
    }
  }

  function requestActionConfirm(actionKey) {
    const confirmConfig = {
      all: {
        title: 'Reset all stored state?',
        description: authEnabled
          ? 'Turn sign-in protection OFF and delete ALL users (passwords, 2FA, and recovery codes included), then clear browser-local state, saved preferences, and import memory and reload to the welcome screen?'
          : 'Delete all users, then clear browser-local state, saved preferences, and import memory and reload to the welcome screen?',
      },
      browser: {
        title: 'Clear browser-local state?',
        description: `Clear browser-local state and reload?`,
      },
      preferences: {
        title: 'Clear saved preferences?',
        description: 'Clear saved user/profile preferences and reload?',
      },
      importMemory: {
        title: 'Clear import memory?',
        description: 'Clear saved data sources and import snapshots, then reload?',
      },
      profiles: {
        title: 'Reset to first-run?',
        description: authEnabled
          ? 'Turn sign-in protection OFF and delete ALL users — passwords, 2FA, and recovery codes included — returning to the welcome screen?'
          : 'Delete all users and return to the welcome screen?',
      },
    }[actionKey]
    if (!confirmConfig) return
    setPendingActionConfirm({ actionKey, ...confirmConfig })
  }

  function executeConfirmedAction(actionKey) {
    if (actionKey === 'all') {
      return runAction('all', async () => {
        await api.clearUserPreferences()
        await api.clearImportMemory()
        await resetToFirstRun()
        clearBrowserStoredState()
        window.location.reload()
      })
    }
    if (actionKey === 'browser') {
      return runAction('browser', async () => {
        clearBrowserStoredState()
        window.location.reload()
      })
    }
    if (actionKey === 'preferences') {
      return runAction('preferences', async () => {
        await api.clearUserPreferences()
        window.location.reload()
      })
    }
    if (actionKey === 'importMemory') {
      return runAction('importMemory', async () => {
        await api.clearImportMemory()
        window.location.reload()
      })
    }
    if (actionKey === 'profiles') {
      return runAction('profiles', async () => {
        await resetToFirstRun()
        clearBrowserStoredState()
        window.location.reload()
      })
    }
    return Promise.resolve()
  }

  // No confirm, unlike the resets above: nothing is lost, and each member's next typed unlock undoes it,
  // the lock included.
  // The session user is replaced so every surface showing the check reacts without a reload.
  function markPassphrasesUnchecked() {
    return runAction('passphrases', async () => {
      const resp = await api.markVaultPassphrasesUnchecked()
      if (resp?.user) setCurrentUser?.(resp.user)
      setMessage(resp?.marked === 1 ? 'Marked 1 passphrase as unchecked.' : `Marked ${resp?.marked ?? 0} passphrases as unchecked.`)
    })
  }

  // Full reset to the first-run welcome screen. In auth mode this first turns sign-in protection off
  // (admin-gated) — which drops to local mode, so the identity endpoints become reachable and
  // delete_user's keep-one-admin guard no longer applies — then removes every user, the admin included.
  async function resetToFirstRun() {
    if (authEnabled) await api.disableAuth()
    // No bulk endpoint — identities are ordinary users — so remove them one by one; individual failures
    // are ignored so a partial reset still reloads to a clean welcome screen. Delete the current
    // session's own identity LAST: deleting it first invalidates the session and would 401 (and thus
    // strand) the remaining users.
    const resp = await api.getIdentities().catch(() => ({ identities: [] }))
    const ids = (resp?.identities || []).map(i => i.id)
    const currentId = currentUser?.id
    const ordered = [...ids.filter(id => id !== currentId), ...ids.filter(id => id === currentId)]
    for (const id of ordered) {
      await api.deleteIdentity(id).catch(() => { })
    }
  }

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <Card style={{ display: 'grid', gap: 16, position: 'relative', paddingTop: 18, overflow: 'hidden' }}>
        {pendingActionConfirm ? (
          <AppConfirmDialog
            title={pendingActionConfirm.title}
            description={pendingActionConfirm.description}
            confirmLabel="Clear"
            confirmVariant="danger"
            borderColor="color-mix(in srgb, var(--danger) 35%, var(--border))"
            onConfirm={() => {
              const actionKey = pendingActionConfirm.actionKey
              setPendingActionConfirm(null)
              executeConfirmedAction(actionKey)
            }}
            onCancel={() => setPendingActionConfirm(null)}
            width="min(560px, 100%)"
          />
        ) : null}

        <Button
          small
          variant="ghost"
          style={{
            ...cornerTabStyle({ corner: 'top-right', radius: 12 }),
            borderLeft: '1px solid var(--border)',
            borderBottom: '1px solid var(--border)',
            padding: '10px 18px',
          }}
          title={authEnabled
            ? "Turns sign-in protection off and deletes all users, then clears browser state, saved preferences, and import memory and reloads to the welcome screen."
            : "Deletes all users, then clears browser state, saved preferences, and import memory and reloads to the welcome screen."}
          onClick={() => requestActionConfirm('all')}
          disabled={!!workingAction}
        >
          {workingAction === 'all' ? 'Resetting…' : 'Clear all'}
        </Button>
        <div style={{ paddingRight: 146 }}>
          <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6, maxWidth: 560 }}>
            Tools to erase stored state; return to a clean starting point.
          </div>
        </div>
        <div style={{ display: 'grid', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 600 }}>Clear browser-local state</div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>
                Clears localStorage and sessionStorage for this browser, then reloads.
              </div>
            </div>
            <Button
              small
              variant="ghost"
              title="Clears this browser's localStorage and sessionStorage, then reloads the app."
              onClick={() => requestActionConfirm('browser')}
              disabled={!!workingAction}
            >
              {workingAction === 'browser' ? 'Clearing…' : 'Clear browser state'}
            </Button>
          </div>
          <div style={{ height: 1, background: 'var(--border)' }} />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 600 }}>Clear saved preferences</div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>
                Clears server-stored user or profile preferences, then reloads.
              </div>
            </div>
            <Button
              small
              variant="ghost"
              title="Clears saved user or local-profile preferences stored by the backend, then reloads the app."
              onClick={() => requestActionConfirm('preferences')}
              disabled={!!workingAction}
            >
              {workingAction === 'preferences' ? 'Clearing…' : 'Clear preferences'}
            </Button>
          </div>
          <div style={{ height: 1, background: 'var(--border)' }} />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 600 }}>Clear import memory</div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>
                Clears saved CSV data sources and import snapshots stored in the backend, then reloads.
              </div>
            </div>
            <Button
              small
              variant="ghost"
              title="Clears saved CSV data sources and remembered import snapshots in the backend, then reloads the app."
              onClick={() => requestActionConfirm('importMemory')}
              disabled={!!workingAction}
            >
              {workingAction === 'importMemory' ? 'Clearing…' : 'Clear import memory'}
            </Button>
          </div>
          <div style={{ height: 1, background: 'var(--border)' }} />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 600 }}>Reset to first-run</div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>
                {authEnabled
                  ? 'Turns sign-in protection off and deletes every user (passwords, 2FA, and recovery codes included), then reloads to the welcome screen.'
                  : 'Deletes every user, then reloads to the welcome screen.'}
              </div>
            </div>
            <Button
              small
              variant="ghost"
              title="Turns sign-in protection off (if on), deletes every user, then reloads the app to the first-run welcome screen."
              onClick={() => requestActionConfirm('profiles')}
              disabled={!!workingAction}
            >
              {workingAction === 'profiles' ? 'Resetting…' : 'Reset to first-run'}
            </Button>
          </div>
        </div>
        {message && messageFor === 'resets' ? (
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>{message}</div>
        ) : null}
        {error && messageFor === 'resets' ? (
          <div style={{ fontSize: 12, color: 'var(--danger)' }}>{error}</div>
        ) : null}
      </Card>
      {/* Apart from the card above, which is what Clear all covers: this puts state INTO a condition
          rather than erasing it, and Clear all does not run it. */}
      <Card style={{ display: 'grid', gap: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>Mark vault passphrases as unchecked</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>
              As after a strength-rule change and restart: every passphrase reads as unchecked and the vault is
            locked. Backups leave the credentials out until each is typed again.
            </div>
          </div>
          <Button
            small
            variant="ghost"
            title="Each member's next unlock with a typed passphrase checks it again."
            onClick={markPassphrasesUnchecked}
            disabled={!!workingAction}
            style={{ flexShrink: 0 }}
          >
            {workingAction === 'passphrases' ? 'Marking…' : 'Mark as unchecked'}
          </Button>
        </div>
        {message && messageFor === 'testing' ? (
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>{message}</div>
        ) : null}
        {error && messageFor === 'testing' ? (
          <div style={{ fontSize: 12, color: 'var(--danger)' }}>{error}</div>
        ) : null}
      </Card>
    </div>
  )
}
