// SPDX-FileCopyrightText: 2026 Jeffrey Orlin
// SPDX-License-Identifier: AGPL-3.0-or-later

// Administration -> Backup / Restore: generate a backup, plain or encrypted to
// backup keys, restore from a backup file, and manage the keys an encrypted
// backup is sealed to. All of it is admin-or-local on the server, which is why
// it is here rather than beside the importer.
//
// A backup is always everything: the ledger, and the users & security (users,
// sign-in settings and data, backup keys, and the data provider credentials
// with the vault that opens them). What to put back is chosen at restore, from
// what the file holds; the credentials are a choice within the users & security,
// since the vault they come with belongs to the people restored beside them.
// An unencrypted backup leaves out any vault passphrase not validated against
// the current strength rule, and the credentials too when that leaves no way
// into the vault. The page says so before the file is made, and offers this
// user the check or the change where those would clear their own passphrase.
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
//
// Every restore of the ledger gives the system a new backup identifier, so a backup made before
// it reads as another system's. The completion panel says so, and it is the only way out: a restore that
// replaces the sign-in accounts has signed this tab out too, so the panel holds the shell's answer to the
// lost session (`holdSessionLost`) until its reload.

import { useEffect, useState } from 'react'
import { api, downloadUrl, holdSessionLost, saveUrlToFile } from '../../lib/api.js'
import { useAppSession } from '../../lib/AppSessionContext.jsx'
import { AppConfirmDialog, AppDialog, Button, Card, Input, PasswordInput, PasswordManagerUsername } from '../ui.jsx'
import { Subsection } from '../SectionListPage.jsx'
import { BackupRecipients } from './BackupRecipients.jsx'
import { BackupHistoryList } from './BackupHistoryList.jsx'
import { APP_NAME } from '../../lib/appConfig.js'
import { useVaultGateContext } from '../../contexts/VaultGateContext.jsx'
import { runBackupPasskeyCeremony } from '../../lib/vaultPasskey.js'
import { formatDate, formatTimestamp, localIsoDate, parseTimestamp } from '../../lib/utils.js'
import FileInput from '../FileInput.jsx'
import { PICKER_IDS, chooseSaveFile } from '../../lib/filePicker.js'
import {
  BACKUP_KEY_PASSWORD_MANAGER_USERNAME, EXISTING_SECRET_PROPS, NO_AUTOFILL_PROPS, VAULT_PASSWORD_MANAGER_USERNAME,
} from '../../lib/sensitiveFields.js'

// The name the server suggests (`_dated_backup_filename`), made here as well because the save picker opens
// before the server is asked for anything. The local date, so an evening backup is not dated tomorrow.
function suggestedBackupName(encrypted) {
  return `luma_backup-${localIsoDate()}${encrypted ? '.encrypted.zip' : '.zip'}`
}

const PASSPHRASE_LEFT_OUT_REASONS = {
  passphrase_unchecked: 'not validated against the current strength rule',
  weak_passphrase: 'too easy to guess',
}

// The backup surface's one notice about what a backup taken now would leave out. Credentials missing from
// every backup outranks credentials missing from an unencrypted one, which outranks passphrases missing
// from an unencrypted one. `ownCode` is set when this user's passphrase is among those left out.
function describeBackupStatus(status) {
  if (!status) return null
  const own = (status.passphrases_left_out || []).find(p => p.own)
  const ownCode = own ? own.code : null
  const leftOut = status.encrypted_credentials_left_out || status.credentials_left_out
  if (leftOut) return { message: leftOut.message, ownCode: status.encrypted_credentials_left_out ? null : ownCode }
  const passphrases = status.passphrases_left_out || []
  if (passphrases.length === 0) return null
  const names = passphrases.map(p => `${p.name} (${PASSPHRASE_LEFT_OUT_REASONS[p.code] || p.code})`).join(', ')
  return {
    message: `Unencrypted backups leave out these vault passphrases: ${names}. Encrypted backups include them.`,
    ownCode,
  }
}

const RESTORE_KIND_TITLES = {
  data: 'ledger backup',
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
  // The connections reconnected since the vault was last reset after a lost passphrase, which restoring
  // the accounts part of an older backup takes their current credentials from.
  const [relinkedSinceReset, setRelinkedSinceReset] = useState(null)
  const [restoreInspection, setRestoreInspection] = useState(null)
  const [inspectError, setInspectError] = useState('')
  const [inspectingRestore, setInspectingRestore] = useState(false)
  const [privateKeyFile, setPrivateKeyFile] = useState(null)
  const [privateKeyPassphrase, setPrivateKeyPassphrase] = useState('')
  const [restoring, setRestoring] = useState(false)
  const [restoreMsg, setRestoreMsg] = useState(null)
  const [restoreSuccess, setRestoreSuccess] = useState(null)
  const [restoreGaveNewIdentifier, setRestoreGaveNewIdentifier] = useState(false)
  // Whether the databases failed the check run after the restore finished.
  const [restoreCheckFailed, setRestoreCheckFailed] = useState(false)
  // The backup waiting on an answer because the databases failed the check run before it.
  const [backupCheckWarning, setBackupCheckWarning] = useState(null)
  const [history, setHistory] = useState(null)
  const [historyRetention, setHistoryRetention] = useState(null)
  const [savingRetention, setSavingRetention] = useState(false)
  const [historyError, setHistoryError] = useState('')
  // What to put back from a backup holding both parts. Both by default: that restores the system.
  const [restoreData, setRestoreData] = useState(true)
  const [restoreAccounts, setRestoreAccounts] = useState(true)
  const [restoreProviderCredentials, setRestoreProviderCredentials] = useState(true)
  // Set once the server says the file turns sign-in on: the restore then needs an administrator of the
  // backup, so it cannot leave this system with no one able to sign in.
  const [adminPrompt, setAdminPrompt] = useState(null)
  const [adminUsername, setAdminUsername] = useState('')
  const [adminPassword, setAdminPassword] = useState('')
  const [pendingConfirm, setPendingConfirm] = useState(null)
  const [backupMsg, setBackupMsg] = useState(null)
  // The name the last backup was saved under, where the save picker could report it.
  const [backupSavedAs, setBackupSavedAs] = useState(null)
  // Open while an unencrypted backup waits on the person confirming what it will leave out.
  const [confirmingPlainBackup, setConfirmingPlainBackup] = useState(false)
  const [downloading, setDownloading] = useState(false)
  // Non-null while the recipient picker is open, holding the ids currently ticked.
  const [recipientChoice, setRecipientChoice] = useState(null)
  // What a backup taken now would leave out (`accounts_backup.backup_status`), or null until asked.
  const [backupStatus, setBackupStatus] = useState(null)
  // A secret of the member who made a credentials backup — asked for only once the server says the
  // file's credentials are not valid here as they stand, so the ordinary "my own backup, this machine"
  // restore never sees a prompt at all. `unlockOptions` is the server's answer to which of that member's
  // secrets the file carries and this page can use (a passkey only where its host name matches).
  const [backupPassphrase, setBackupPassphrase] = useState('')
  const [backupRecoveryCode, setBackupRecoveryCode] = useState('')
  const [unlockOptions, setUnlockOptions] = useState(null)
  // Restoring credentials re-keys them under this workspace's DEK, so it needs the vault open. The gate
  // prompts and the action resumes itself — see lib/useVaultGate.js. It is the App-level one, so an unlock
  // here is the session's unlock and every other surface sees the vault open.
  const { vault, ensureVault, openVault, changePassphrase } = useVaultGateContext()
  const enabledRecipients = backupRecipients.filter(r => r.enabled)
  const backupNotice = describeBackupStatus(backupStatus)
  // What the chosen file turned out to be. Everything below the picker — which inputs appear, what the
  // button says and how alarming it looks, which endpoint runs — follows from this rather than from
  // which control the file was dropped on.
  const restoreKind = restoreInspection?.kind || null
  const restoreIsCredentials = restoreKind === 'credentials'
  const restoreHoldsBoth = restoreKind === 'full'
  const restoreReplacesData = restoreKind === 'data' || (restoreHoldsBoth && restoreData)
  const restoreReplacesAccounts = restoreHoldsBoth && restoreAccounts
  const restoreFileHasCredentials = restoreInspection?.credentials_included !== false
  const restoreReplacesCredentials = restoreReplacesAccounts && restoreFileHasCredentials && restoreProviderCredentials
  const restoreReplacesEverything = restoreReplacesData && restoreReplacesAccounts
    && (restoreReplacesCredentials || !restoreFileHasCredentials)
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

  // Re-asked whenever the session's vault state changes, because that is what moves the answer: checking
  // a passphrase settles 'passphrase_unchecked' (or turns it into 'weak_passphrase'), and changing it
  // settles 'weak_passphrase'. This user's own can be done from this page, and either can also happen on
  // another.
  // Recipients are not fetched here: the section below owns that list and reports it up, so fetching
  // it again would be a second request for an answer already on the page.
  useEffect(() => {
    let alive = true
    api.getBackupStatus()
      .then(status => { if (alive) setBackupStatus(status || null) })
      .catch(() => { })
    return () => { alive = false }
  }, [vault])

  async function loadHistory() {
    try {
      const res = await api.getBackupHistory()
      setHistory(res.backups || [])
      setHistoryRetention(res.retention_days ?? null)
    } catch (e) {
      setHistoryError(e.message || 'Could not load the backup history.')
    }
  }

  useEffect(() => { loadHistory() }, [])

  async function renameHistoryEntry(id, filename) {
    setHistoryError('')
    try {
      setHistory((await api.renameBackupHistoryEntry(id, filename)).backups || [])
    } catch (e) {
      setHistoryError(e.message || 'The filename could not be saved.')
      throw e
    }
  }

  async function trashHistoryEntry(id) {
    setHistoryError('')
    try {
      setHistory((await api.trashBackupHistoryEntry(id)).backups || [])
    } catch (e) {
      setHistoryError(e.message || 'That backup could not be moved to the trash.')
    }
  }

  async function saveHistoryRetention(days) {
    setSavingRetention(true)
    setHistoryError('')
    try {
      const res = await api.setBackupHistoryRetention(days)
      setHistory(res.backups || [])
      setHistoryRetention(res.retention_days ?? null)
    } catch (e) {
      setHistoryError(e.message || 'That setting could not be saved.')
    } finally {
      setSavingRetention(false)
    }
  }

  // Fetch-and-save rather than navigate: a navigation hands the response to the browser, so any error
  // status renders as a raw JSON page with the app gone from under it.
  // With one enabled recipient there is no choice to make, so the encrypted backup starts immediately.
  // With several there is: a file going somewhere less trusted may not want every key on the list able to
  // open it. Deliberately conditional — a dialog that shows the same single entry every time and is always
  // accepted trains the user to dismiss it, which is worse than no dialog, since it looks like
  // verification while being a click-through.
  // A notice above the buttons is easy to read past, so an unencrypted backup that would leave out a
  // passphrase (and with it, perhaps, the credentials) asks first. Only then: a panel shown on every backup
  // would be clicked through. An encrypted backup carries every passphrase, so it never asks.
  function generatePlainBackup() {
    if (backupStatus?.passphrases_left_out?.length) {
      setConfirmingPlainBackup(true)
      return
    }
    startBackup(false)
  }

  // This user's own passphrase is cleared here rather than on the Connections tab. The check takes a typed
  // passphrase only: a passkey opens the vault but cannot judge one. `before` closes a panel the vault
  // dialog would otherwise open on top of.
  function ownPassphraseAction(before = () => { }) {
    if (backupNotice?.ownCode === 'passphrase_unchecked') {
      return <Button onClick={() => { before(); openVault('check') }}>Validate passphrase</Button>
    }
    if (backupNotice?.ownCode === 'weak_passphrase') {
      return <Button onClick={() => { before(); changePassphrase() }}>Change passphrase</Button>
    }
    return null
  }

  function generateEncryptedBackup() {
    if (enabledRecipients.length > 1) {
      setRecipientChoice(enabledRecipients.map(r => r.id))
      return
    }
    startBackup(true)
  }

  function confirmRecipientChoice() {
    const chosen = recipientChoice
    setRecipientChoice(null)
    startBackup(true, chosen)
  }

  // The databases are checked first. A failure asks rather than refuses, since a backup of a failing database
  // is worth more than none; the server records the outcome on the history entry either way. A check that
  // cannot run does not hold the backup up. The save picker still opens within the click's activation, as
  // the check takes a fraction of a second, and after a warning the confirming click is the gesture.
  async function startBackup(encrypted, recipientIds = null) {
    setDownloading(true)
    const check = await api.checkDatabases().catch(() => null)
    setDownloading(false)
    if (check && !check.ok) {
      setBackupCheckWarning({ encrypted, recipientIds })
      return
    }
    saveBackup(encrypted, recipientIds)
  }

  // Where the browser has a save picker the file is chosen first, while the click still counts as one: a
  // cancel then makes no backup at all, the history records the name it was saved under, and the page can
  // say it was saved. Elsewhere, or if the picker refuses, the backup is a download and nothing reports
  // what became of it.
  async function saveBackup(encrypted, recipientIds = null) {
    setBackupMsg(null)
    setBackupSavedAs(null)
    let handle = null
    try {
      handle = await chooseSaveFile({
        id: PICKER_IDS.backupSave, suggestedName: suggestedBackupName(encrypted), accept: '.zip',
      })
    } catch {
      handle = null
    }
    if (handle === undefined) return
    setDownloading(true)
    try {
      if (handle) {
        await saveUrlToFile(api.exportBackup(encrypted, recipientIds, handle.name), handle)
        setBackupSavedAs(handle.name)
      } else {
        await downloadUrl(api.exportBackup(encrypted, recipientIds))
      }
    } catch (e) {
      // Made but not saved, so its history entry names a file that does not exist.
      const backupId = e.headers?.get('X-Backup-Id')
      if (backupId) await api.trashBackupHistoryEntry(backupId).catch(() => { })
      setBackupMsg(backupId
        ? `❌ The backup could not be saved: ${e.message || 'the file could not be written'}`
        : `❌ ${e.message || 'Could not generate the backup'}`)
    }
    loadHistory()
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
    setRestoreProviderCredentials(true)
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
      setRelinkedSinceReset(status?.relinked_since_reset || null)
    } catch {
      setTargetHasData(true)
      setRelinkedSinceReset(null)
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
    // Before the request rather than on its answer: the restore's own completion fires the app's refetches,
    // and with the accounts replaced each of them is a 401.
    if (restoreReplacesAccounts) holdSessionLost(true)
    try {
      const result = await api.restoreBackupFile(file, privateKeyFile, privateKeyPassphrase, force, {
        includeData: restoreReplacesData,
        includeAccounts: restoreReplacesAccounts,
        includeCredentials: restoreReplacesCredentials,
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
      if (result.credentials_withheld) {
        sentences.push('The data provider credentials were not restored, because the vault key they were sealed under was replaced or reset after an exposure.')
      }
      setRestoreMsg(null)
      setAdminPassword('')
      setRestoreGaveNewIdentifier(!!result.restored_counts)
      setRestoreCheckFailed(result.database_check_passed === false)
      setRestoreSuccess(`Restore completed. ${sentences.join(' ')}`)
    }
    catch (e) {
      holdSessionLost(false)
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
    : restoreReplacesEverything ? 'Restore everything'
      : restoreReplacesAccounts ? (restoreReplacesData ? 'Restore ledger, users & security' : 'Restore users & security')
        : 'Restore ledger'

  function requestRestore() {
    if (restoreBlocked) return
    const name = restoreFile?.name ? ` from ${restoreFile.name}` : ''
    const takenAt = formatTimestamp(restoreInspection?.exported_at)
    const taken = takenAt ? ` The backup was taken ${takenAt}.` : ''
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
      // Only where the file's date is known to precede the reset: a backup taken since holds the
      // reconnected credentials itself.
      const resetAt = relinkedSinceReset && parseTimestamp(relinkedSinceReset.reset_at)
      const relinkLost = resetAt && restoreReplacesCredentials && restoreInspection?.exported_at
        && parseTimestamp(restoreInspection.exported_at) < resetAt
        ? ` The vault was reset after this backup was taken, so ${relinkedSinceReset.connections.join(', ')} lose${relinkedSinceReset.connections.length === 1 ? 's' : ''} the credentials reconnected since.`
        : ''
      const replaced = `${restoreReplacesData ? 'the ledger, ' : ''}the sign-in accounts and settings${restoreReplacesCredentials ? ', backup keys and data provider credentials' : ' and backup keys'}`
      setPendingConfirm({
        type: 'data',
        title: restoreReplacesEverything ? 'Replace everything with this backup?'
          : restoreReplacesData ? 'Replace the ledger, users & security with this backup?' : 'Replace users & security with this backup?',
        message: `This replaces ${replaced}${name}, and signs everyone out.${restoreReplacesData ? '' : ' The ledger is not touched.'}${taken}${relinkLost}`,
        confirmLabel: restoreButtonLabel,
        variant: 'danger',
      })
      return
    }
    setPendingConfirm(targetHasData ? {
      type: 'data',
      title: 'Replace the ledger with this backup?',
      message: `This will replace accounts, categories, rules, import settings, and transactions${name}.${taken}`,
      confirmLabel: 'Restore ledger backup',
      variant: 'danger',
    } : {
      type: 'data',
      title: 'Load this ledger backup?',
      message: `This system has no data yet, so this just loads the backup${name} into it — nothing is replaced.${taken}`,
      confirmLabel: 'Load backup',
      variant: 'warn',
      note: '',
    })
  }

  return (
    <div style={{ display: 'grid', gap: 18 }}>
      <Subsection title="Backup">
        <Card style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {backupNotice ? (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10,
              fontSize: 13, lineHeight: 1.5, borderRadius: 8, padding: '8px 12px',
              background: 'color-mix(in srgb, var(--warning, #d97706) 12%, var(--surface2))',
              border: '1px solid color-mix(in srgb, var(--warning, #d97706) 35%, var(--border))',
            }}>
              <span>{backupNotice.message}</span>
              <span style={{ marginLeft: 'auto', flexShrink: 0 }}>{ownPassphraseAction()}</span>
            </div>
          ) :
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Generate a backup</div>
          }
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <Button variant="secondary" disabled={downloading} onClick={generatePlainBackup}>Generate backup</Button>
            <Button variant="secondary" disabled={downloading || enabledRecipients.length === 0} onClick={generateEncryptedBackup}>
              Generate encrypted backup
            </Button>
          </div>
          {enabledRecipients.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>Add a backup key below to encrypt backups.</div>
          ) : null}
          {backupSavedAs ? (
            <div style={{ fontSize: 13, color: 'var(--muted)' }}>Saved as {backupSavedAs}</div>
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

      <Subsection title="Backup history">
        <Card style={{ display: 'grid', gap: 12 }}>
          {historyError ? (
            <div style={{ fontSize: 13, color: 'var(--danger)' }}>{historyError}</div>
          ) : null}
          {history && history.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--muted)' }}>No backups have been made.</div>
          ) : null}
          {history && history.length > 0 ? (
            <BackupHistoryList rows={history} onRename={renameHistoryEntry} onTrash={trashHistoryEntry} />
          ) : null}
          {/* The history's one setting, in the shape the sync log gives its own: a sentence around a single
              number, saved on blur because shortening the window deletes the older rows at once. */}
          {historyRetention != null ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 12.5, color: 'var(--muted)' }}>
              <label htmlFor="backup-history-retention-days">Keep prior backups in the history for</label>
              <input
                key={historyRetention}
                id="backup-history-retention-days"
                type="number"
                min="1"
                max="3650"
                defaultValue={historyRetention}
                disabled={savingRetention}
                onBlur={e => {
                  const next = Number(e.target.value)
                  if (Number.isInteger(next) && next !== historyRetention) saveHistoryRetention(next)
                }}
                style={{
                  font: 'inherit', fontSize: 12.5, width: 72, padding: '3px 6px', borderRadius: 6,
                  border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)',
                }}
              />
              <span>days</span>
            </div>
          ) : null}
        </Card>
      </Subsection>

      {confirmingPlainBackup ? (
        <AppConfirmDialog
          title="Generate an unencrypted backup?"
          description={backupNotice?.message}
          confirmLabel="Continue"
          onConfirm={() => { setConfirmingPlainBackup(false); startBackup(false) }}
          onCancel={() => setConfirmingPlainBackup(false)}
          width="min(520px, 100%)"
        >
          {ownPassphraseAction(() => setConfirmingPlainBackup(false))}
        </AppConfirmDialog>
      ) : null}
      {backupCheckWarning ? (
        <AppConfirmDialog
          title="Back up a database that failed its check?"
          description="The check found damage. A backup made now may be missing rows the damage hides, and its history entry will say it was made from a database that failed its check. Settings → Database shows what was found."
          confirmLabel="Back up anyway"
          onConfirm={() => {
            const { encrypted, recipientIds } = backupCheckWarning
            setBackupCheckWarning(null)
            saveBackup(encrypted, recipientIds)
          }}
          onCancel={() => setBackupCheckWarning(null)}
          width="min(520px, 100%)"
        />
      ) : null}
      {recipientChoice ? (
        <AppDialog
          title="Who should be able to read this backup?"
          description="Choose the keys that can open the backup. The key names appear in the backup in plain text so they can be 
          identified during the restore process."
          onClose={() => setRecipientChoice(null)}
          actions={<>
            <Button variant="secondary" onClick={() => setRecipientChoice(null)}>Cancel</Button>
            <Button onClick={confirmRecipientChoice} disabled={recipientChoice.length === 0}>
              Generate encrypted backup
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
              <FileInput
                pickerId={PICKER_IDS.backupRestore}
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
                        : restoreHoldsBoth ? null : 'Restoring replaces the ledger.',
                      restoreInspection.encrypted
                        ? `${restoreInspection.cipher || 'Encrypted'}, readable by ${restoreInspection.recipient_count || 0} backup key${restoreInspection.recipient_count === 1 ? '' : 's'}.`
                        : null,
                    ].filter(Boolean).join(' ')}
                  </div>
                )}
                {/* Above both choices rather than inside one: it describes the file, and it answers the
                    question a restore raises either way — what happens to the credentials already here. */}
                {restoreHoldsBoth && restoreInspection.credentials_included === false && (
                  <div style={{ fontSize: 13, fontWeight: 500, lineHeight: 1.5 }}>
                    This backup does not contain data provider credentials, so any existing credentials will
                    remain after the restore.
                  </div>
                )}
                {restoreHoldsBoth && (
                  <div role="group" aria-label="What to restore" style={{ display: 'grid', gap: 8 }}>
                    {[
                      ['restore-data', 'Ledger', restoreData, setRestoreData,
                        'Accounts, categories, rules, transactions, documents and preferences replaced.'],
                      ['restore-accounts', 'Users & security', restoreAccounts, value => { setRestoreAccounts(value); if (!value) setAdminPrompt(null) },
                        'Users, Sign-in settings and data, backup keys replaced.'],
                      // Nested under users & security because the vault it brings opens for the people restored with it.
                      ...(restoreFileHasCredentials ? [['restore-credentials', 'Data provider credentials', restoreProviderCredentials, setRestoreProviderCredentials,
                        restoreProviderCredentials
                          ? 'The vault is replaced by the backup. Users with a passphrase, recovery code or passkey in the backup will have vault access. Other users request vault access again.'
                          : 'Existing vault preserved. The vault is indexed by user id so only users in the backup can have access. The vault is reset if none of the users in the backup have vault access.',
                        true]] : []),
                    ].map(([name, label, checked, setChecked, detail, nested]) => {
                      const disabled = nested && !restoreAccounts
                      return (
                        <label key={name} style={{
                          display: 'flex', gap: 10, alignItems: 'baseline', marginLeft: nested ? 24 : 0,
                          cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1,
                        }}>
                          <input type="checkbox" name={name} checked={checked} disabled={disabled} onChange={e => setChecked(e.target.checked)} />
                          <span style={{ display: 'grid', gap: 2 }}>
                            <span style={{ fontSize: 13, fontWeight: 600 }}>{label}</span>
                            <span style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>{detail}</span>
                          </span>
                        </label>
                      )
                    })}
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
                    <FileInput
                      pickerId={PICKER_IDS.backupPrivateKey}
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
                        <Button variant="secondary" disabled={restoring} onClick={() => restoreWithPasskey(passkey)}>
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
                variant={restoreIsCredentials ? 'secondary' : 'danger'}
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
      <Subsection title="Backup file encryption keys">
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
              <Button variant="secondary" onClick={() => setPendingConfirm(null)}>
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
            {restoreGaveNewIdentifier ? (
              <div style={{ fontSize: 13, lineHeight: 1.5 }}>This restore gave the system a new backup identifier.</div>
            ) : null}
            {restoreCheckFailed ? (
              <div role="alert" style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--danger)' }}>
                The databases failed their check afterwards. A restore rewrites the tables inside the existing
                files, so damage to a file can outlast it. To start from a clean file, stop {APP_NAME}, move its
                database files aside, start it again and restore this backup into the new, empty database.
                Settings → Database shows what failed.
              </div>
            ) : null}
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
              <Button onClick={() => window.location.assign('/')}>
                Reload now
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
