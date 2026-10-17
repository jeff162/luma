// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// Administration -> Backup / Restore: generate a backup, plain or encrypted to
// backup keys, restore from a backup file, and manage the keys an encrypted
// backup is sealed to. All of it is admin-or-local on the server, which is why
// it is here rather than beside the importer.
//
// A backup is always everything: the financial data and the accounts & secrets
// (sign-in accounts and settings, backup keys, and the data provider credentials
// with the vault that opens them). What to put back is chosen at restore, from
// what the file holds. The one thing a backup can lack is the credentials, left
// out when the vault passphrase has not cleared the current rule or the person
// taking it cannot open the vault; the page says so before the file is made.
//
// Restore is ONE picker for every kind of backup. The file says what it holds
// (the server reads that without decrypting, so an encrypted archive is
// identified before any key is asked for), and the flow follows from the
// answer: an encrypted file wants a private key; restoring accounts that turn
// sign-in on wants the password of an administrator in the file, asked for only
// once the server says so; and an older standalone credentials backup may want
// one of the secrets of the member who made it. Asking the user to choose the
// right upload control first meant asking them to know how the app is split
// internally. Every restore routes through the confirm overlay, which names
// what it replaces.

import { useEffect, useState } from 'react'
import { api, downloadUrl } from '../../lib/api.js'
import { useAppSession } from '../../lib/AppSessionContext.jsx'
import { AppDialog, Button, Card, Input, PasswordInput, PasswordManagerUsername } from '../ui.jsx'
import { Subsection } from '../SectionListPage.jsx'
import { BackupRecipients } from './BackupRecipients.jsx'
import { APP_NAME } from '../../lib/appConfig.js'
import { useVaultGate } from '../../lib/useVaultGate.js'
import { VaultPassphraseDialog } from '../VaultPassphraseDialog.jsx'
import { runBackupPasskeyCeremony } from '../../lib/vaultPasskey.js'
import { formatDate } from '../../lib/utils.js'
import {
  BACKUP_KEY_PASSWORD_MANAGER_USERNAME, EXISTING_SECRET_PROPS, NO_AUTOFILL_PROPS, VAULT_PASSWORD_MANAGER_USERNAME,
} from '../../lib/sensitiveFields.js'

const RESTORE_KIND_TITLES = {
  data: 'financial data backup',
  credentials: 'credentials backup',
}

function restoreKindTitle(inspection) {
  const title = RESTORE_KIND_TITLES[inspection.kind] || 'backup'
  const text = inspection.encrypted ? `encrypted ${title}` : title
  return text.charAt(0).toUpperCase() + text.slice(1)
}

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

export default function BackupRestoreSection() {
  const demoRestoreMessage = 'Restoring a backup is disabled while demo data is loaded — clear it from the banner above first.'
  // Restore is blocked server-side while demo data is loaded; disable the file picker to match.
  const { demoLoaded } = useAppSession()
  const [backupRecipients, setBackupRecipients] = useState([])
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
  // What to put back from a backup holding both parts. Both by default: that restores the system.
  const [restoreData, setRestoreData] = useState(true)
  const [restoreAccounts, setRestoreAccounts] = useState(true)
  // Set once the server says the file turns sign-in on: the restore then needs an administrator of the
  // backup, so it cannot leave this system with no one able to sign in.
  const [adminPrompt, setAdminPrompt] = useState(null)
  const [adminUsername, setAdminUsername] = useState('')
  const [adminPassword, setAdminPassword] = useState('')
  const [pendingConfirm, setPendingConfirm] = useState(null)
  const [backupMsg, setBackupMsg] = useState(null)
  const [downloading, setDownloading] = useState(false)
  // Non-null while the recipient picker is open, holding the ids currently ticked.
  const [recipientChoice, setRecipientChoice] = useState(null)
  // Why a backup taken now would leave the data provider credentials out, or null.
  const [credentialsLeftOut, setCredentialsLeftOut] = useState(null)
  // A secret of the member who made a credentials backup — asked for only once the server says the
  // file's credentials are not valid here as they stand, so the ordinary "my own backup, this machine"
  // restore never sees a prompt at all. `unlockOptions` is the server's answer to which of that member's
  // secrets the file carries and this page can use (a passkey only where its host name matches).
  const [backupPassphrase, setBackupPassphrase] = useState('')
  const [backupRecoveryCode, setBackupRecoveryCode] = useState('')
  const [unlockOptions, setUnlockOptions] = useState(null)
  const [vault, setVault] = useState({ configured: false, unlocked: false })
  // Restoring credentials re-keys them under this workspace's DEK, so it needs the vault open. The gate
  // prompts and the action resumes itself — see lib/useVaultGate.js.
  const { mode: vaultDialog, ensureVault, closeVault } = useVaultGate(vault)
  const enabledRecipients = backupRecipients.filter(r => r.enabled)
  // What the chosen file turned out to be. Everything below the picker — which inputs appear, what the
  // button says and how alarming it looks, which endpoint runs — follows from this rather than from
  // which control the file was dropped on.
  const restoreKind = restoreInspection?.kind || null
  const restoreIsCredentials = restoreKind === 'credentials'
  const restoreHoldsBoth = restoreKind === 'full'
  const restoreReplacesData = restoreKind === 'data' || (restoreHoldsBoth && restoreData)
  const restoreReplacesAccounts = restoreHoldsBoth && restoreAccounts
  // No restore of any kind while demo data is loaded, matching the server. Both kinds bring data in —
  // a credentials restore creates a live data source, which is precisely the state the demo tenant is
  // not allowed to reach — and the demo clear is only safe to erase everything because nothing
  // non-demo can have been added.
  const restoreBlocked = !restoreFile || restoring || inspectingRestore || !!inspectError || !restoreKind
    || demoLoaded
    || (restoreHoldsBoth && !restoreData && !restoreAccounts)
    || (!restoreIsCredentials && restoreInspection?.encrypted && !privateKeyFile)
    || (!!adminPrompt && (!adminUsername.trim() || !adminPassword))
    // Once the file has asked for a secret, Restore means "with this one", so it waits for one typed.
    // A passkey has its own button, which restores directly.
    || (restoreIsCredentials && !!unlockOptions && !backupPassphrase && !backupRecoveryCode.trim())

  async function refreshVault() {
    const status = await api.getAuthStatus().catch(() => null)
    const u = status?.user || {}
    setVault({ configured: !!u.vault_configured, unlocked: !!u.vault_unlocked })
    // An unlock is what settles an unchecked passphrase, so the answer can change with the vault's state.
    const backup = await api.getBackupStatus().catch(() => null)
    setCredentialsLeftOut(backup?.credentials_left_out || null)
  }

  useEffect(() => {
    // Recipients are not fetched here: the section below owns that list and reports it up, so fetching
    // it again would be a second request for an answer already on the page.
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
  function generatePlainBackup() {
    startDownload(api.exportBackup(false))
  }

  function generateEncryptedBackup() {
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
    setUnlockOptions(null)
    setBackupPassphrase('')
    setBackupRecoveryCode('')
    setRestoreData(true)
    setRestoreAccounts(true)
    setAdminPrompt(null)
    setAdminUsername('')
    setAdminPassword('')
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

  // Whichever typed secret is filled in, passphrase first. A passkey is not typed: its button runs the
  // ceremony and restores in one press (`restoreWithPasskey`).
  function typedBackupSecret() {
    if (backupPassphrase) return { passphrase: backupPassphrase }
    if (backupRecoveryCode.trim()) return { recovery_code: backupRecoveryCode }
    return null
  }

  /** One credentials-restore attempt. Throws so the caller can run the gate's single 423 retry. */
  async function restoreCredentialsOnce(file, secret) {
    const r = await api.restoreCredentialsFile(file, secret)
    setRestoreMsg(null)
    setUnlockOptions(null)
    setBackupPassphrase('')
    setBackupRecoveryCode('')
    setRestoreSuccess(`Restored ${r.restored} credential(s).`)
  }

  async function restoreCredentials(file, secret) {
    setRestoring(true)
    try {
      await restoreCredentialsOnce(file, secret)
    } catch (e) {
      const code = e.detail?.code
      if (code === 'backup_secret_required' || code === 'incorrect_backup_secret') {
        // The file's credentials are sealed under a key this install does not hold, so they have to be
        // reopened with one of the secrets of the member who made it before they can be re-keyed under
        // this one. Reveal what the file can be opened with and let the user try again — none of this
        // is the local vault's own passphrase.
        setUnlockOptions(e.detail.unlock_options || null)
        setRestoreMsg(`❌ ${e.message}`)
      } else if (e.status === 423 && await ensureVault({ force: true })) {
        // A late 423: the vault flags said unlocked but the server's DEK had already expired (or was
        // never open). The gate prompts and the one retry runs against the state the unlock produced.
        try { await restoreCredentialsOnce(file, secret) }
        catch (retry) { setRestoreMsg(`❌ ${retry.message}`) }
      } else {
        setRestoreMsg(`❌ ${e.message}`)
      }
    }
    setRestoring(false)
  }

  async function restoreWithPasskey(passkey) {
    setRestoreMsg(null)
    const result = await runBackupPasskeyCeremony({
      rpId: unlockOptions?.rp_id, credentialId: passkey.credential_id, prfSalt: passkey.prf_salt,
    })
    if (!result.ok) {
      if (result.message) setRestoreMsg(`❌ ${result.message}`)
      return
    }
    await restoreCredentials(restoreFile, {
      passkey_credential_id: result.credentialId, passkey_prf_output: result.prfOutput,
    })
  }

  async function performRestore(file, type, force = false) {
    setPendingConfirm(null)
    if (type === 'credentials') {
      await restoreCredentials(file, typedBackupSecret())
      return
    }
    setRestoring(true)
    try {
      const result = await api.restoreBackupFile(file, privateKeyFile, privateKeyPassphrase, force, {
        includeData: restoreReplacesData,
        includeAccounts: restoreReplacesAccounts,
        adminUsername: adminPrompt ? adminUsername.trim() : '',
        adminPassword: adminPrompt ? adminPassword : '',
      })
      const sentences = []
      if (result.restored_counts) {
        const counts = result.restored_counts
        const pieces = [
          `${counts.owners ?? 0} owner${counts.owners === 1 ? '' : 's'}`,
          `${counts.accounts ?? 0} account${counts.accounts === 1 ? '' : 's'}`,
          `${counts.categories ?? 0} categor${counts.categories === 1 ? 'y' : 'ies'}`,
          `${counts.transactions ?? 0} transaction${counts.transactions === 1 ? '' : 's'}`,
        ]
        sentences.push(`Loaded ${pieces.join(', ')}.`)
      }
      if (result.accounts) {
        const users = result.accounts.users ?? 0
        sentences.push(`Restored ${users} sign-in account${users === 1 ? '' : 's'}. Everyone has been signed out.`)
      }
      setRestoreMsg(null)
      setAdminPassword('')
      setRestoreSuccess(`Restore completed. ${sentences.join(' ')}`)
    }
    catch (e) {
      const code = e.detail?.code
      if (code === 'admin_password_required' || code === 'incorrect_admin_password') {
        // Nothing was touched. The fields appear, and the next attempt carries what is typed in them.
        setRestoring(false)
        setAdminPrompt({ message: e.detail.message, admins: e.detail.admins || [] })
        setRestoreMsg(code === 'incorrect_admin_password' ? `❌ ${e.message}` : null)
        return
      }
      // The backend's compatibility guard (409) means this backup looks like it came from a
      // different system or access mode and the target already has data. Surface a second,
      // explicit confirmation rather than an error, and retry with force if the user accepts.
      if (e.status === 409 && code === 'restore_incompatible') {
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

  const restoreButtonLabel = restoreIsCredentials ? 'Restore credentials'
    : restoreReplacesAccounts ? (restoreReplacesData ? 'Restore everything' : 'Restore accounts & secrets')
      : 'Restore data'

  function requestRestore() {
    if (restoreBlocked) return
    const name = restoreFile?.name ? ` from ${restoreFile.name}` : ''
    if (restoreKind === 'credentials') {
      setPendingConfirm({
        type: 'credentials',
        title: 'Restore credentials backup?',
        message: `This will replace the data provider credentials currently stored in ${APP_NAME}${name}. Your accounts and transactions are not touched.`,
        confirmLabel: 'Restore credentials',
        variant: 'warn',
      })
      return
    }
    if (restoreReplacesAccounts) {
      const replaced = restoreReplacesData
        ? 'all financial data, the sign-in accounts and settings, backup keys and data provider credentials'
        : 'the sign-in accounts and settings, backup keys and data provider credentials'
      setPendingConfirm({
        type: 'data',
        title: restoreReplacesData ? 'Replace everything with this backup?' : 'Replace accounts & secrets with this backup?',
        message: `This replaces ${replaced}${name}, and signs everyone out.${restoreReplacesData ? '' : ' Financial data is not touched.'}`,
        confirmLabel: restoreButtonLabel,
        variant: 'danger',
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
    <div style={{ display: 'grid', gap: 18 }}>
      <Subsection title="Backup">
        <Card style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {credentialsLeftOut ? (
            <div style={{
              fontSize: 13, lineHeight: 1.5, borderRadius: 8, padding: '8px 12px',
              background: 'color-mix(in srgb, var(--warning, #d97706) 12%, var(--surface2))',
              border: '1px solid color-mix(in srgb, var(--warning, #d97706) 35%, var(--border))',
            }}>
              This backup will not include the data provider credentials. {credentialsLeftOut.message}
            </div>
          ) :
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Generate a backup</div>
          }
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <Button small variant="ghost" disabled={downloading} onClick={generatePlainBackup}>Generate backup</Button>
            <Button small variant="ghost" disabled={downloading || enabledRecipients.length === 0} onClick={generateEncryptedBackup}>
              Generate encrypted backup
            </Button>
          </div>
          {enabledRecipients.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>Add a backup key below to encrypt backups.</div>
          ) : null}
          {backupMsg ? (
            <div style={{
              padding: '10px 14px', borderRadius: 8, fontSize: 14,
              background: 'color-mix(in srgb, var(--danger) 12%, var(--surface2))',
              border: '1px solid color-mix(in srgb, var(--danger) 35%, var(--border))',
            }}>{backupMsg}</div>
          ) : null}
        </Card>
      </Subsection>

      {recipientChoice ? (
        <AppDialog
          title="Who should be able to read this backup?"
          description="Choose the keys that can open the backup. The key names appear in the backup in plain text so they can be 
          identified during the restore process."
          onClose={() => setRecipientChoice(null)}
          actions={<>
            <Button variant="ghost" onClick={() => setRecipientChoice(null)}>Cancel</Button>
            {/* Not "Generate encrypted backup": that is the button on the page behind this, and two
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

      <Subsection title="Restore">
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
                {/* A full backup's parts are the checkboxes below, so a heading and summary naming them
                    would only say the same thing twice. */}
                {restoreHoldsBoth ? null : (
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{restoreKindTitle(restoreInspection)}</div>
                )}
                {restoreHoldsBoth && !restoreInspection.encrypted ? null : (
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                    {[
                      restoreIsCredentials
                        ? 'Data provider credentials, still encrypted. Restoring replaces the credentials stored here; accounts and transactions are not touched.'
                        : restoreHoldsBoth ? null : 'Restoring replaces all financial data.',
                      restoreInspection.encrypted
                        ? `${restoreInspection.cipher || 'Encrypted'}, readable by ${restoreInspection.recipient_count || 0} backup key${restoreInspection.recipient_count === 1 ? '' : 's'}.`
                        : null,
                    ].filter(Boolean).join(' ')}
                  </div>
                )}
                {restoreHoldsBoth && (
                  <div role="group" aria-label="What to restore" style={{ display: 'grid', gap: 8 }}>
                    {[
                      ['restore-data', 'Financial data', restoreData, setRestoreData,
                        'Replaces the accounts, categories, rules, transactions, documents and preferences here.'],
                      ['restore-accounts', 'Accounts & secrets', restoreAccounts, value => { setRestoreAccounts(value); if (!value) setAdminPrompt(null) },
                        restoreInspection.credentials_included === false
                          ? 'Replaces the sign-in accounts and settings and the backup keys, and signs everyone out. This backup holds no data provider credentials, so those here are kept for whoever among the restored accounts can open the vault.'
                          : 'Replaces the sign-in accounts and settings, backup keys and data provider credentials, and signs everyone out. Afterwards the vault opens for the user who made the backup, with the passphrase, recovery code or passkey in force then; other members ask for vault access again.'],
                    ].map(([name, label, checked, setChecked, detail]) => (
                      <label key={name} style={{ display: 'flex', gap: 10, alignItems: 'baseline', cursor: 'pointer' }}>
                        <input type="checkbox" name={name} checked={checked} onChange={e => setChecked(e.target.checked)} />
                        <span style={{ display: 'grid', gap: 2 }}>
                          <span style={{ fontSize: 13, fontWeight: 600 }}>{label}</span>
                          <span style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>{detail}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                )}
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
                    <PasswordManagerUsername value={BACKUP_KEY_PASSWORD_MANAGER_USERNAME} />
                    <PasswordInput
                      aria-label="Private key passphrase"
                      value={privateKeyPassphrase}
                      onChange={setPrivateKeyPassphrase}
                      placeholder="Private key passphrase (optional)"
                      wrapperStyle={{ minWidth: 220 }}
                      style={{
                        background: 'var(--surface2)', color: 'var(--text)',
                        border: `1px solid ${privateKeyFile ? 'var(--border)' : 'color-mix(in srgb, var(--accent2) 60%, var(--border))'}`, borderRadius: 6,
                        padding: '6px 10px', fontSize: 13,
                      }}
                      {...EXISTING_SECRET_PROPS}
                    />
                  </div>
                )}
                {restoreInspection.encrypted && !privateKeyFile && (
                  <div style={{ fontSize: 12, color: 'var(--accent2)' }}>
                    Select a matching RSA private key file before restoring this backup.
                  </div>
                )}
                {adminPrompt && restoreReplacesAccounts && (
                  <div style={{ display: 'grid', gap: 8, maxWidth: 420 }}>
                    <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                      {adminPrompt.message}
                      {adminPrompt.admins.length ? ` Administrators in it: ${adminPrompt.admins.join(', ')}.` : ''}
                    </div>
                    <Input
                      aria-label="Administrator username"
                      value={adminUsername}
                      onChange={setAdminUsername}
                      placeholder="Administrator username"
                      autoComplete="username" autoCapitalize="off" autoCorrect="off" spellCheck={false}
                    />
                    <PasswordInput
                      aria-label="Administrator password"
                      value={adminPassword}
                      onChange={setAdminPassword}
                      placeholder="Their password"
                      {...EXISTING_SECRET_PROPS}
                    />
                  </div>
                )}
                {/* Only shown once the server says the file's credentials are sealed under a key this
                  install does not hold: they have to be reopened with one of the secrets of the member
                  who made it before they can be re-sealed under this one. Restoring your own backup here
                  never asks. Each field appears only if the file carries that kind of key, and a passkey
                  only where this page is served at the host name it was registered under. */}
                {restoreIsCredentials && unlockOptions && (
                  <div style={{ display: 'grid', gap: 8, maxWidth: 420 }}>
                    <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                      Open it with a secret of the member who made it, as it was when the backup was taken —
                      not this system&apos;s own passphrase.
                    </div>
                    {unlockOptions.passphrase ? (
                      <>
                        <PasswordManagerUsername value={VAULT_PASSWORD_MANAGER_USERNAME} />
                        <PasswordInput
                          value={backupPassphrase}
                          onChange={setBackupPassphrase}
                          placeholder="Vault passphrase this backup was made with"
                          autoFocus
                          {...EXISTING_SECRET_PROPS}
                        />
                      </>
                    ) : null}
                    {unlockOptions.recovery_code ? (
                      <Input
                        value={backupRecoveryCode}
                        onChange={setBackupRecoveryCode}
                        placeholder={unlockOptions.recovery_code.issued_at
                          ? `Or the recovery code issued ${formatDate(String(unlockOptions.recovery_code.issued_at).slice(0, 10))}`
                          : 'Or the recovery code'}
                        style={{ fontFamily: 'monospace' }}
                        {...NO_AUTOFILL_PROPS}
                      />
                    ) : null}
                    {(unlockOptions.passkeys || []).map(passkey => (
                      <div key={passkey.credential_id}>
                        <Button small variant="ghost" disabled={restoring} onClick={() => restoreWithPasskey(passkey)}>
                          Restore with passkey “{passkey.label}”
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            <div style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-start' }}>
              <Button
                small
                variant={restoreIsCredentials ? 'ghost' : 'danger'}
                disabled={restoreBlocked}
                onClick={requestRestore}
              >
                {restoring ? 'Restoring…' : restoreButtonLabel}
              </Button>
            </div>
          </div>
        </Card>
      </Subsection>

      {/* Last of the three, deliberately. Backup leads because it is what the section is for; Restore is a
          fixed height and keeps its heading on screen; the key list is the only section that can grow, so
          it goes where growth pushes nothing off the page. It is also the least-visited of the three —
          configuration for the encrypted backup above rather than an action in its own right. */}
      <Subsection title="Backup encryption keys">
        <BackupRecipients onRecipientsChange={setBackupRecipients} />
      </Subsection>

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
