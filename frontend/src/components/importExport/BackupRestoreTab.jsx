// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// The Backup / Restore tab of the Import / Export page: generate plain or
// RSA-encrypted data and Plaid-credential backups, and restore from a backup
// file (inspecting it first, prompting for the private key when encrypted).
// Both destructive restores route through an in-flow confirm overlay before
// replacing data.

import { useEffect, useState } from 'react'
import { api, downloadUrl } from '../../lib/api.js'
import { Button, Card, Input } from '../ui.jsx'
import { SectionTitle } from './importPresentational.jsx'
import { APP_NAME } from '../../lib/appConfig.js'
import { useVaultGate } from '../../lib/useVaultGate.js'
import { VaultPassphraseDialog } from '../VaultPassphraseDialog.jsx'
import { SENSITIVE_FIELD_PROPS } from '../../lib/sensitiveFields.js'

// Human-readable explanation for the restore compatibility guard's 409 detail.
function describeRestoreIncompatibility(detail) {
  const reasons = Array.isArray(detail?.reasons) ? detail.reasons : []
  const parts = []
  if (reasons.includes('different_system')) {
    parts.push('This backup was made on a different system, and this one already has data — restoring will erase everything currently here and replace it with the backup.')
  }
  if (reasons.includes('mode_mismatch')) {
    parts.push(`The backup was created in "${detail?.backup_mode || 'a different'}" access mode, but this system is running in "${detail?.target_mode || 'another'}" mode.`)
  }
  if (reasons.includes('newer_schema')) {
    parts.push(`This backup was made by a newer version of ${APP_NAME} (data format v${detail?.backup_schema_version ?? '?'}, this version reads v${detail?.target_schema_version ?? '?'}). Restoring it here may drop data this version can't represent — update ${APP_NAME} first if you can.`)
  }
  return parts.join(' ') || 'This backup may not be compatible with the current system.'
}

export function BackupRestoreTab() {
  const demoRestoreMessage = 'Restoring a backup is disabled while demo data is loaded — clear it from the banner above first.'
  // Restore is blocked server-side while demo data is loaded; disable the file picker to match.
  const [demoLoaded, setDemoLoaded] = useState(false)
  useEffect(() => {
    let cancelled = false
    api.getDemoDataStatus().then(r => { if (!cancelled) setDemoLoaded(!!r?.loaded) }).catch(() => {})
    return () => { cancelled = true }
  }, [])
  const [backupRecipients, setBackupRecipients] = useState([])
  const [credentialBackupStatus, setCredentialBackupStatus] = useState({ has_credentials: false, credential_count: 0 })
  const [restoreFile, setRestoreFile] = useState(null)
  // Whether this system already holds data — drives the restore confirmation wording (strong
  // overwrite warning vs. a light "load into a fresh system"). Default to true (cautious) until known.
  const [targetHasData, setTargetHasData] = useState(true)
  const [credsFile, setCredsFile] = useState(null)
  const [restoreInspection, setRestoreInspection] = useState(null)
  const [inspectError, setInspectError] = useState('')
  const [inspectingRestore, setInspectingRestore] = useState(false)
  const [privateKeyFile, setPrivateKeyFile] = useState(null)
  const [privateKeyPassphrase, setPrivateKeyPassphrase] = useState('')
  const [restoring, setRestoring] = useState(false)
  const [restoreMsg, setRestoreMsg] = useState(null)
  const [restoreSuccess, setRestoreSuccess] = useState(null)
  const [pendingConfirm, setPendingConfirm] = useState(null)
  const [backupMsg, setBackupMsg] = useState(null)
  const [downloading, setDownloading] = useState(false)
  // The passphrase of the vault that produced a credentials backup — asked for only once the server
  // says the file came from elsewhere, so the ordinary "my own backup, this machine" restore never
  // sees a prompt at all.
  const [backupPassphrase, setBackupPassphrase] = useState('')
  const [needsBackupPassphrase, setNeedsBackupPassphrase] = useState(false)
  const [vault, setVault] = useState({ configured: false, unlocked: false })
  // Restoring credentials re-keys them under this workspace's DEK, so it needs the vault open. The gate
  // prompts and the action resumes itself — see lib/useVaultGate.js.
  const { mode: vaultDialog, ensureVault, closeVault } = useVaultGate(vault)
  const enabledRecipients = backupRecipients.filter(r => r.enabled)
  const hasStoredCredentials = !!credentialBackupStatus?.has_credentials

  async function refreshVault() {
    const status = await api.getAuthStatus().catch(() => null)
    const u = status?.user || {}
    setVault({ configured: !!u.vault_configured, unlocked: !!u.vault_unlocked })
  }

  useEffect(() => {
    api.getBackupRecipients().then(setBackupRecipients).catch(() => { })
    api.getCredentialsBackupStatus().then(setCredentialBackupStatus).catch(() => { })
    refreshVault()
  }, [])

  async function submitVault(passphrase) {
    if (vaultDialog === 'set') await api.setVaultPassphrase(passphrase)
    else await api.unlockVault(passphrase)
    await refreshVault()
    closeVault(true)
  }

  // The same settle the passphrase path performs, for an unlock the dialog ran with a passkey instead.
  // Restoring a credentials backup is a gated action like any other, so it must accept the same proof:
  // before this, a user with a passkey was still asked to type their passphrase here specifically.
  async function adoptPasskeyUnlock() {
    await refreshVault()
    closeVault(true)
  }

  // Fetch-and-save rather than navigate: a navigation hands the response to the browser, so any error
  // status renders as a raw JSON page with the app gone from under it.
  async function startDownload(url) {
    setBackupMsg(null)
    setDownloading(true)
    try {
      await downloadUrl(url)
    } catch (e) {
      setBackupMsg(`❌ ${e.message || 'Could not generate the backup'}`)
    }
    setDownloading(false)
  }

  async function handleRestoreFileChange(file) {
    setRestoreFile(file || null)
    setRestoreInspection(null)
    setInspectError('')
    setPrivateKeyFile(null)
    setPrivateKeyPassphrase('')
    if (!file) return
    setInspectingRestore(true)
    try {
      setRestoreInspection(await api.inspectBackupFile(file))
    } catch (e) {
      setInspectError(e.message || 'Unable to inspect backup file')
    } finally {
      setInspectingRestore(false)
    }
    try {
      const status = await api.getRestoreTargetStatus()
      setTargetHasData(!!status?.has_data)
    } catch {
      setTargetHasData(true)
    }
  }

  /** One credentials-restore attempt. Throws so the caller can run the gate's single 423 retry. */
  async function restoreCredentialsOnce(file) {
    const r = await api.restoreCredentialsFile(file, backupPassphrase || null)
    setRestoreMsg(null)
    setNeedsBackupPassphrase(false)
    setBackupPassphrase('')
    setRestoreSuccess(`Restored ${r.restored} credential(s).`)
  }

  async function performRestore(file, type, force = false) {
    setPendingConfirm(null)
    if (type === 'credentials') {
      setRestoring(true)
      try {
        await restoreCredentialsOnce(file)
      } catch (e) {
        const code = e.detail?.code
        if (code === 'backup_passphrase_required' || code === 'incorrect_backup_passphrase') {
          // The file came from another install, so its ciphertext has to be reopened with the vault
          // passphrase that sealed it before it can be re-keyed under this one. Reveal the field and
          // let the user press Restore again — this is not the local vault's passphrase.
          setNeedsBackupPassphrase(true)
          setRestoreMsg(`❌ ${e.message}`)
        } else if (e.status === 423 && await ensureVault({ force: true })) {
          // A late 423: the vault flags said unlocked but the server's DEK had already expired (or was
          // never open). The gate prompts and the one retry runs against the state the unlock produced.
          try { await restoreCredentialsOnce(file) }
          catch (retry) { setRestoreMsg(`❌ ${retry.message}`) }
        } else {
          setRestoreMsg(`❌ ${e.message}`)
        }
      }
      setRestoring(false); return
    }
    setRestoring(true)
    try {
      const result = await api.restoreBackupFile(file, privateKeyFile, privateKeyPassphrase, force)
      const counts = result.restored_counts || {}
      const pieces = [
        `${counts.owners ?? 0} owner${counts.owners === 1 ? '' : 's'}`,
        `${counts.accounts ?? 0} account${counts.accounts === 1 ? '' : 's'}`,
        `${counts.categories ?? 0} categor${counts.categories === 1 ? 'y' : 'ies'}`,
        `${counts.transactions ?? 0} transaction${counts.transactions === 1 ? '' : 's'}`,
      ]
      setRestoreMsg(null)
      setRestoreSuccess(`Restore completed. Loaded ${pieces.join(', ')}.`)
    }
    catch (e) {
      // The backend's compatibility guard (409) means this backup looks like it came from a
      // different system or access mode and the target already has data. Surface a second,
      // explicit confirmation rather than an error, and retry with force if the user accepts.
      if (e.status === 409 && e.detail?.code === 'restore_incompatible') {
        setRestoring(false)
        setPendingConfirm({
          type,
          title: 'Restore over a different system?',
          message: describeRestoreIncompatibility(e.detail),
          confirmLabel: 'Restore anyway',
          variant: 'danger',
          force: true,
        })
        return
      }
      setRestoreMsg(`❌ ${e.message}`)
    }
    setRestoring(false)
  }

  function requestRestore(type) {
    if (type === 'credentials') {
      if (!credsFile || restoring) return
      setPendingConfirm({
        type,
        title: 'Restore Plaid credentials?',
        message: `This will replace the Plaid credentials currently stored in ${APP_NAME}.`,
        confirmLabel: 'Restore credentials',
        variant: 'warn',
      })
      return
    }
    if (!restoreFile || restoring || inspectingRestore || inspectError || (restoreInspection?.encrypted && !privateKeyFile)) return
    setPendingConfirm(targetHasData ? {
      type,
      title: 'Replace all data with this backup?',
      message: 'This will replace accounts, categories, rules, import settings, and transactions with the selected backup.',
      confirmLabel: 'Restore data backup',
      variant: 'danger',
    } : {
      type,
      title: 'Load this backup?',
      message: 'This system has no data yet, so this just loads the backup into it — nothing is replaced.',
      confirmLabel: 'Load backup',
      variant: 'warn',
      note: '',
    })
  }

  return (
    <div>
      <SectionTitle>Backup</SectionTitle>
      <Card style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Data backup</div>
          <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 10 }}>All categories, rules, owners, accounts, transactions. No Plaid tokens.</div>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            <Button variant="ghost" disabled={downloading} onClick={() => startDownload(api.exportBackup(false))}>Generate backup</Button>
            <Button variant="ghost" disabled={enabledRecipients.length === 0 || downloading} onClick={() => startDownload(api.exportBackup(true))}>Generate encrypted backup</Button>
          </div>
          {enabledRecipients.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>
              Add an enabled backup recipient in Settings to enable encrypted backup creation.
            </div>
          ) : (
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>
              Encrypted backups will be readable by: {enabledRecipients.map(r => r.label).join(', ')}.
            </div>
          )}
        </div>
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Credentials backup</div>
          <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 10 }}>
            Your data-source credentials, backed up still encrypted. There is no separate encrypted
            version because the contents never leave the vault in the clear.
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
            <Button
              disabled={!hasStoredCredentials || downloading}
              onClick={() => startDownload(api.exportCredentials())}
            >Generate credentials backup</Button>
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>
            {hasStoredCredentials
              ? 'Restoring it needs the vault passphrase that was in force when it was made — that passphrase is the only thing protecting the file, so store it somewhere you would store a password.'
              : 'No stored data-source credentials exist to back up.'}
          </div>
        </div>
        {backupMsg ? (
          <div style={{
            padding: '10px 14px', borderRadius: 8, fontSize: 14,
            background: 'color-mix(in srgb, var(--danger) 12%, var(--surface2))',
            border: '1px solid color-mix(in srgb, var(--danger) 35%, var(--border))',
          }}>{backupMsg}</div>
        ) : null}
      </Card>

      <SectionTitle>Restore</SectionTitle>
      <Card style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        {restoreMsg && (
          <div
            style={{
              padding: '10px 14px',
              borderRadius: 8,
              fontSize: 14,
              background: restoreMsg.startsWith('✅')
                ? 'color-mix(in srgb, var(--success) 12%, var(--surface2))'
                : 'color-mix(in srgb, var(--danger) 12%, var(--surface2))',
              border: `1px solid ${restoreMsg.startsWith('✅') ? 'color-mix(in srgb, var(--success) 35%, var(--border))' : 'color-mix(in srgb, var(--danger) 35%, var(--border))'}`,
              display: 'flex',
              gap: 10,
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
            }}
          >
            <div>{restoreMsg}</div>
          </div>
        )}
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Restore from data backup</div>
          <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 10 }}>Replaces all existing data from the selected backup. Plaid credentials are not affected. Encrypted backups require the matching RSA private key file.</div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              type="file"
              name="restore-data-backup-file"
              aria-label="Choose data backup file to restore"
              accept=".json,.zip,application/json,application/zip"
              disabled={demoLoaded}
              title={demoLoaded ? demoRestoreMessage : undefined}
              onChange={e => handleRestoreFileChange(e.target.files[0])}
              style={{ fontSize: 13, cursor: demoLoaded ? 'not-allowed' : undefined }}
            />
          </div>
          {demoLoaded && (
            <div style={{ marginTop: 8, fontSize: 12, color: 'var(--muted)' }}>{demoRestoreMessage}</div>
          )}
          {inspectingRestore && (
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>
              Inspecting backup file...
            </div>
          )}
          {inspectError && (
            <div style={{ marginTop: 10, fontSize: 13, color: 'var(--danger)' }}>
              {inspectError}
            </div>
          )}
          {restoreInspection && !inspectError && (
            <div style={{
              marginTop: 12,
              padding: '12px 14px',
              borderRadius: 8,
              background: restoreInspection.encrypted
                ? 'color-mix(in srgb, var(--accent2) 10%, var(--surface2))'
                : 'var(--surface2)',
              border: `1px solid ${restoreInspection.encrypted ? 'color-mix(in srgb, var(--accent2) 40%, var(--border))' : 'var(--border)'}`,
              display: 'grid',
              gap: 8,
            }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>
                {restoreInspection.encrypted ? 'Encrypted backup detected' : 'Backup file looks valid'}
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                {restoreInspection.encrypted
                  ? `${restoreInspection.cipher || 'Encrypted'} backup for ${restoreInspection.recipient_count || 0} recipient${restoreInspection.recipient_count === 1 ? '' : 's'}.`
                  : `Readable ${restoreInspection.container === 'zip' ? 'zipped' : 'plain JSON'} backup file.`}
              </div>
              {restoreInspection.encrypted && Array.isArray(restoreInspection.recipients) && restoreInspection.recipients.length > 0 && (
                <div style={{ display: 'grid', gap: 6 }}>
                  {restoreInspection.recipients.map((recipient, idx) => (
                    <div key={`${recipient.recipient_id || recipient.fingerprint || recipient.label}-${idx}`} style={{ fontSize: 12, color: 'var(--muted)' }}>
                      {recipient.label}
                      {recipient.fingerprint ? ` (${recipient.fingerprint})` : ''}
                    </div>
                  ))}
                </div>
              )}
              {restoreInspection.encrypted && (
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  <input
                    type="file"
                    name="restore-private-key-file"
                    aria-label="Choose private key file for encrypted backup"
                    onChange={e => setPrivateKeyFile(e.target.files[0])}
                    style={{ fontSize: 13 }}
                  />
                  <input
                    type="password"
                    name="restore-private-key-passphrase"
                    aria-label="Private key passphrase"
                    value={privateKeyPassphrase}
                    onChange={e => setPrivateKeyPassphrase(e.target.value)}
                    placeholder="Private key passphrase (optional)"
                    style={{
                      background: 'var(--surface2)', color: 'var(--text)',
                      border: `1px solid ${privateKeyFile ? 'var(--border)' : 'color-mix(in srgb, var(--accent2) 60%, var(--border))'}`, borderRadius: 6,
                      padding: '6px 10px', fontSize: 13, minWidth: 220,
                    }}
                  />
                </div>
              )}
              {restoreInspection.encrypted && !privateKeyFile && (
                <div style={{ fontSize: 12, color: 'var(--accent2)' }}>
                  Select a matching RSA private key file before restoring this backup.
                </div>
              )}
            </div>
          )}
          <div style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-start' }}>
            <Button
              variant="danger"
              disabled={!restoreFile || restoring || inspectingRestore || !!inspectError || (restoreInspection?.encrypted && !privateKeyFile)}
              onClick={() => requestRestore('data')}
            >
              {restoring ? 'Restoring…' : 'Restore data'}
            </Button>
          </div>
        </div>
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Restore Plaid credentials</div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <input
              type="file"
              name="restore-credentials-backup-file"
              aria-label="Choose credentials backup file to restore"
              accept=".json,.zip,application/json,application/zip"
              onChange={e => setCredsFile(e.target.files[0])}
              style={{ fontSize: 13 }}
            />
            <Button variant="ghost" disabled={!credsFile || restoring} onClick={() => requestRestore('credentials')}>
              {restoring ? 'Restoring…' : 'Restore credentials'}
            </Button>
          </div>
          {/* Only shown once the server says the file came from another install: its contents are sealed
              under that vault's key, so they have to be reopened with that vault's passphrase before
              they can be re-sealed under this one. Restoring your own backup here never asks. */}
          {needsBackupPassphrase ? (
            <div style={{ display: 'grid', gap: 6, marginTop: 12, maxWidth: 420 }}>
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                This backup was made on another system. Enter the vault passphrase it was created with —
                not this system&apos;s.
              </div>
              <Input
                type="password"
                value={backupPassphrase}
                onChange={setBackupPassphrase}
                placeholder="Vault passphrase this backup was made with"
                autoFocus
                {...SENSITIVE_FIELD_PROPS}
              />
            </div>
          ) : null}
        </div>
      </Card>

      {pendingConfirm && (
        <div
          onClick={() => setPendingConfirm(null)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(15, 23, 42, 0.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
            zIndex: 1000,
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              width: 'min(520px, 100%)',
              background: 'var(--surface)',
              borderRadius: 14,
              border: `1px solid ${pendingConfirm.variant === 'danger' ? 'color-mix(in srgb, var(--danger) 35%, var(--border))' : 'var(--warning)'}`,
              boxShadow: '0 24px 60px rgba(15, 23, 42, 0.28)',
              padding: 20,
              display: 'grid',
              gap: 12,
            }}
          >
            <div style={{ fontSize: 16, fontWeight: 600 }}>{pendingConfirm.title}</div>
            <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>{pendingConfirm.message}</div>
            {pendingConfirm.note === '' ? null : (
              <div style={{
                fontSize: 12,
                color: pendingConfirm.variant === 'danger' ? 'var(--danger)' : '#b45309',
                background: pendingConfirm.variant === 'danger'
                  ? 'color-mix(in srgb, var(--danger) 10%, var(--surface2))'
                  : 'color-mix(in srgb, var(--warning) 10%, var(--surface2))',
                borderRadius: 8,
                padding: '8px 10px',
                textAlign: 'center',
              }}>
                {pendingConfirm.note
                  ? pendingConfirm.note
                  : pendingConfirm.variant === 'danger'
                    ? 'This action replaces existing data and cannot be undone.'
                    : 'You may need to reconnect accounts if these credentials have changed since the backup was created.'}
              </div>
            )}
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
              <Button variant="ghost" onClick={() => setPendingConfirm(null)}>
                Cancel
              </Button>
              <Button
                variant={pendingConfirm.variant === 'danger' ? 'danger' : 'primary'}
                onClick={() => performRestore(pendingConfirm.type === 'credentials' ? credsFile : restoreFile, pendingConfirm.type, pendingConfirm.force)}
              >
                {pendingConfirm.confirmLabel}
              </Button>
            </div>
          </div>
        </div>
      )}

      {restoreSuccess && (
        <div
          onClick={() => setRestoreSuccess(null)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(15, 23, 42, 0.38)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
            zIndex: 1000,
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              width: 'min(520px, 100%)',
              background: 'var(--surface)',
              borderRadius: 14,
              border: '1px solid color-mix(in srgb, var(--success) 35%, var(--border))',
              boxShadow: '0 24px 60px rgba(15, 23, 42, 0.24)',
              padding: 20,
              display: 'grid',
              gap: 12,
            }}
          >
            <div style={{ fontSize: 16, fontWeight: 600 }}>Restore completed</div>
            <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>{restoreSuccess}</div>
            <div style={{
              fontSize: 12,
              color: 'var(--success)',
              background: 'color-mix(in srgb, var(--success) 10%, var(--surface2))',
              borderRadius: 8,
              padding: '8px 10px',
              textAlign: 'center',
            }}>
              Reload the page to continue.
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <Button small onClick={() => window.location.reload()}>
                Reload now
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* The gate's prompt for THIS system's vault, raised when a restore needs to re-key credentials
          under the workspace DEK. Distinct from the backup-passphrase field above, which opens the
          file. `closeVault(true)` releases the waiting action; `false` declines it. */}
      {vaultDialog ? (
        <VaultPassphraseDialog mode={vaultDialog} onSubmit={submitVault}
          onUnlockedByPasskey={adoptPasskeyUnlock} onClose={() => closeVault(false)} />
      ) : null}
    </div>
  )
}
