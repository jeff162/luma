// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// The Backup / Restore tab of the Import / Export page: generate plain or
// RSA-encrypted data and data-source credential backups, and restore from a
// backup file.
//
// Restore is ONE picker for both kinds of backup. The file says which it is
// (the server reads that without decrypting, so an encrypted archive is
// identified before any key is asked for), and the flow follows from the
// answer: a data backup wants a private key when encrypted, a credentials
// backup may want the vault passphrase that sealed it. Asking the user to
// choose the right upload control first meant asking them to know how the app
// is split internally — and picking wrong produced an error about the names of
// members inside a ZIP. Both restores still route through the confirm overlay,
// which names the kind it is about to restore.

import { useEffect, useState } from 'react'
import { api, downloadUrl } from '../../lib/api.js'
import { AppDialog, Button, Card, Input } from '../ui.jsx'
import { SectionTitle } from './importPresentational.jsx'
import { BackupRecipients } from './BackupRecipients.jsx'
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
    api.getDemoDataStatus().then(r => { if (!cancelled) setDemoLoaded(!!r?.loaded) }).catch(() => { })
    return () => { cancelled = true }
  }, [])
  const [backupRecipients, setBackupRecipients] = useState([])
  const [credentialBackupStatus, setCredentialBackupStatus] = useState({ has_credentials: false, credential_count: 0 })
  const [restoreFile, setRestoreFile] = useState(null)
  // Whether this system already holds data — drives the restore confirmation wording (strong
  // overwrite warning vs. a light "load into a fresh system"). Default to true (cautious) until known.
  const [targetHasData, setTargetHasData] = useState(true)
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
  // Non-null while the recipient picker is open, holding the ids currently ticked.
  const [recipientChoice, setRecipientChoice] = useState(null)
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
  // What the chosen file turned out to be. Everything below the picker — which inputs appear, what the
  // button says and how alarming it looks, which endpoint runs — follows from this rather than from
  // which control the file was dropped on.
  const restoreKind = restoreInspection?.kind || null
  const restoreIsCredentials = restoreKind === 'credentials'
  // No restore of any kind while demo data is loaded, matching the server. Both kinds bring data in —
  // a credentials restore creates a live data source, which is precisely the state the demo tenant is
  // not allowed to reach — and the demo clear is only safe to erase everything because nothing
  // non-demo can have been added.
  const restoreBlocked = !restoreFile || restoring || inspectingRestore || !!inspectError || !restoreKind
    || demoLoaded
    || (restoreKind === 'data' && restoreInspection?.encrypted && !privateKeyFile)

  async function refreshVault() {
    const status = await api.getAuthStatus().catch(() => null)
    const u = status?.user || {}
    setVault({ configured: !!u.vault_configured, unlocked: !!u.vault_unlocked })
  }

  useEffect(() => {
    // Recipients are not fetched here: the section below owns that list and reports it up, so fetching
    // it again would be a second request for an answer already on the page.
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
  // With one enabled recipient there is no choice to make, so the encrypted backup starts immediately.
  // With several there is: a file going somewhere less trusted may not want every key on the list able to
  // open it. Deliberately conditional — a dialog that shows the same single entry every time and is always
  // accepted trains the user to dismiss it, which is worse than no dialog, since it looks like
  // verification while being a click-through.
  function startEncryptedBackup() {
    if (enabledRecipients.length > 1) {
      setRecipientChoice(enabledRecipients.map(r => r.id))
      return
    }
    startDownload(api.exportBackup(true))
  }

  function confirmRecipientChoice() {
    const chosen = recipientChoice
    setRecipientChoice(null)
    startDownload(api.exportBackup(true, chosen))
  }

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
    // A new file is a new question: whatever the previous one asked for does not carry over.
    setNeedsBackupPassphrase(false)
    setBackupPassphrase('')
    setRestoreMsg(null)
    setRestoreSuccess(null)
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

  function requestRestore() {
    if (restoreBlocked) return
    const name = restoreFile?.name ? ` from ${restoreFile.name}` : ''
    if (restoreKind === 'credentials') {
      setPendingConfirm({
        type: 'credentials',
        title: 'Restore credentials backup?',
        message: `This will replace the data-source credentials currently stored in ${APP_NAME}${name}. Your accounts and transactions are not touched.`,
        confirmLabel: 'Restore credentials',
        variant: 'warn',
      })
      return
    }
    setPendingConfirm(targetHasData ? {
      type: 'data',
      title: 'Replace all data with this backup?',
      message: `This will replace accounts, categories, rules, import settings, and transactions${name}.`,
      confirmLabel: 'Restore data backup',
      variant: 'danger',
    } : {
      type: 'data',
      title: 'Load this data backup?',
      message: `This system has no data yet, so this just loads the backup${name} into it — nothing is replaced.`,
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
          <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 10 }}>Contains categories, rules, owners, accounts, transactions. No data-source credentials.</div>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            <Button variant="ghost" disabled={downloading} onClick={() => startDownload(api.exportBackup(false))}>Generate backup</Button>
            <Button variant="ghost" disabled={enabledRecipients.length === 0 || downloading} onClick={startEncryptedBackup}>Generate encrypted backup</Button>
          </div>
          {enabledRecipients.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>
              Add an enabled backup key below to enable encrypted backup creation.
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
            Encrypted data-source credentials back up.
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
            <Button
              disabled={!hasStoredCredentials || downloading}
              onClick={() => startDownload(api.exportCredentials())}
            >Generate credentials backup</Button>
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>
            {hasStoredCredentials
              // Two facts that only bite elsewhere, and are easy to discover too late. The passphrase
              // named is *this* user's: the file carries the exporting account's vault slot and no
              // other, so in a shared workspace it is not interchangeable with a colleague's. Neither
              // applies to restoring here — this install's key opens its own backups whatever the
              // passphrase has since become — so the caveat is scoped to somewhere else.
              ? 'Restoring this requires this user\'s current vault passphrase\u2019s. Retain passphrases after a change to allow restoring older backups.'
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

      {recipientChoice ? (
        <AppDialog
          title="Who should be able to read this backup?"
          description="Every key ticked here can open the file with its matching private key. The manifest names them in plain text, so the file itself says which key it needs."
          onClose={() => setRecipientChoice(null)}
          actions={<>
            <Button variant="ghost" onClick={() => setRecipientChoice(null)}>Cancel</Button>
            {/* Not "Generate backup": that is the plain-backup button on the page behind this, and two
                controls with one label is a question about which one just ran. */}
            <Button onClick={confirmRecipientChoice} disabled={recipientChoice.length === 0}>
              Encrypt backup
            </Button>
          </>}
        >
          <div style={{ display: 'grid', gap: 8 }}>
            {enabledRecipients.map(recipient => (
              <label key={recipient.id} style={{ display: 'flex', gap: 10, alignItems: 'baseline', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  name={`backup-scope-${recipient.id}`}
                  checked={recipientChoice.includes(recipient.id)}
                  onChange={() => setRecipientChoice(prev => (
                    prev.includes(recipient.id)
                      ? prev.filter(id => id !== recipient.id)
                      : [...prev, recipient.id]
                  ))}
                />
                <span style={{ display: 'grid', gap: 2, minWidth: 0 }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{recipient.label}</span>
                  <span style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'monospace', wordBreak: 'break-all' }}>
                    {recipient.fingerprint}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </AppDialog>
      ) : null}

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
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Restore from backup</div>
          <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 10 }}>
            Restore a {APP_NAME} data backup or a data-source credentials backup.
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              type="file"
              name="restore-backup-file"
              aria-label="Choose backup file to restore"
              accept=".json,.zip,application/json,application/zip"
              onChange={e => handleRestoreFileChange(e.target.files[0])}
              style={{ fontSize: 13 }}
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
                {restoreIsCredentials
                  ? 'Credentials backup'
                  : restoreInspection.encrypted ? 'Encrypted data backup' : 'Data backup'}
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                {restoreIsCredentials
                  ? 'Data-source credentials, still encrypted. Restoring replaces the credentials stored here; accounts and transactions are not touched.'
                  : restoreInspection.encrypted
                    ? `${restoreInspection.cipher || 'Encrypted'} backup, readable by ${restoreInspection.recipient_count || 0} backup key${restoreInspection.recipient_count === 1 ? '' : 's'}. Restoring replaces all existing data.`
                    : `Readable ${restoreInspection.container === 'zip' ? 'zipped' : 'plain JSON'} backup file. Restoring replaces all existing data.`}
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
              {/* Only shown once the server says the file came from another install: its contents are
                  sealed under that vault's key, so they have to be reopened with that vault's passphrase
                  before they can be re-sealed under this one. Restoring your own backup never asks. */}
              {restoreIsCredentials && needsBackupPassphrase && (
                <div style={{ display: 'grid', gap: 6, maxWidth: 420 }}>
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                    This backup was made on another system. Enter the vault passphrase it was created
                    with — not this system&apos;s.
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
              )}
            </div>
          )}
          <div style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-start' }}>
            <Button
              variant={restoreIsCredentials ? 'ghost' : 'danger'}
              disabled={restoreBlocked}
              title={demoLoaded ? demoRestoreMessage : undefined}
              onClick={requestRestore}
            >
              {restoring
                ? 'Restoring…'
                : restoreIsCredentials ? 'Restore credentials' : 'Restore data'}
            </Button>
          </div>
        </div>
      </Card>

      {/* Last of the three, deliberately. Backup leads because it is what the page is for; Restore is a
          fixed height and keeps its heading on screen; the key list is the only section that can grow, so
          it goes where growth pushes nothing off the page. It is also the least-visited of the three —
          configuration for the encrypted backup above rather than an action in its own right. */}
      <SectionTitle>Backup Encryption Keys</SectionTitle>
      <BackupRecipients onRecipientsChange={setBackupRecipients} />

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
                onClick={() => performRestore(restoreFile, pendingConfirm.type, pendingConfirm.force)}
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
