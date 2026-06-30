// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: GPL-3.0-or-later

// The Backup / Restore tab of the Import / Export page: generate plain or
// RSA-encrypted data and Plaid-credential backups, and restore from a backup
// file (inspecting it first, prompting for the private key when encrypted).
// Both destructive restores route through an in-flow confirm overlay before
// replacing data.

import { useEffect, useState } from 'react'
import { api } from '../../lib/api.js'
import { Button, Card } from '../ui.jsx'
import { SectionTitle } from './importPresentational.jsx'
import { APP_NAME } from '../../lib/appConfig.js'

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
  const enabledRecipients = backupRecipients.filter(r => r.enabled)
  const hasStoredCredentials = !!credentialBackupStatus?.has_credentials

  useEffect(() => {
    api.getBackupRecipients().then(setBackupRecipients).catch(() => { })
    api.getCredentialsBackupStatus().then(setCredentialBackupStatus).catch(() => { })
  }, [])

  function startDownload(url) {
    window.location.assign(url)
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

  async function performRestore(file, type, force = false) {
    setPendingConfirm(null)
    if (type === 'credentials') {
      setRestoring(true)
      try {
        const r = await api.restoreCredentialsFile(file)
        setRestoreMsg(null)
        setRestoreSuccess(`Restored ${r.restored} credential(s).`)
      }
      catch (e) { setRestoreMsg(`❌ ${e.message}`) }
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
            <Button variant="ghost" onClick={() => startDownload(api.exportBackup(false))}>Generate backup</Button>
            <Button variant="ghost" disabled={enabledRecipients.length === 0} onClick={() => startDownload(api.exportBackup(true))}>Generate encrypted backup</Button>
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', opacity: hasStoredCredentials ? 1 : 0.58 }}>
            <a
              href={hasStoredCredentials ? api.exportCredentials(false) : undefined}
              onClick={event => {
                if (!hasStoredCredentials) event.preventDefault()
              }}
            >
              <Button disabled={!hasStoredCredentials}>Generate credentials backup</Button>
            </a>
            <a
              href={hasStoredCredentials && enabledRecipients.length > 0 ? api.exportCredentials(true) : undefined}
              onClick={event => {
                if (!hasStoredCredentials || enabledRecipients.length === 0) event.preventDefault()
              }}
            >
              <Button variant="ghost" disabled={!hasStoredCredentials || enabledRecipients.length === 0}>Generate encrypted credentials backup</Button>
            </a>
          </div>
          {!hasStoredCredentials ? (
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>
              No stored Plaid credentials exist to back up.
            </div>
          ) : enabledRecipients.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>
              Add an enabled backup recipient in Settings to enable encrypted backup creation.
            </div>
          ) : (
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>
              Encrypted credentials backups will be readable by: {enabledRecipients.map(r => r.label).join(', ')}.
            </div>
          )}
          {hasStoredCredentials ? (
            <div style={{ display: 'inline-block', fontSize: 13, background: 'color-mix(in srgb, var(--warning) 10%, var(--surface2))', border: '1px solid var(--warning)', borderRadius: 6, padding: '8px 12px', marginTop: 10 }}>
              ⚠️ Plain credentials backups contain Plaid access tokens.
            </div>
          ) : null}
        </div>
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
                  <input type="file" onChange={e => setPrivateKeyFile(e.target.files[0])} style={{ fontSize: 13 }} />
                  <input
                    type="password"
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
            <input type="file" accept=".json,.zip,application/json,application/zip" onChange={e => setCredsFile(e.target.files[0])} style={{ fontSize: 13 }} />
            <Button variant="ghost" disabled={!credsFile || restoring} onClick={() => requestRestore('credentials')}>
              {restoring ? 'Restoring…' : 'Restore credentials'}
            </Button>
          </div>
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
    </div>
  )
}
