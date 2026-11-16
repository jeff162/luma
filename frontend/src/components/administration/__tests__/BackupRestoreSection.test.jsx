// @vitest-environment jsdom

// The backup section's contracts:
//
//   * One backup, always everything, plain or encrypted from its own button; the page says beforehand when the
//     credentials will be left out of it.
//   * Where the browser has a save picker, the file is chosen before the backup is made: a cancel makes
//     nothing, the history is told the name chosen, and a backup that could not be written leaves the
//     history (it would name a file that does not exist).
//   * The databases are checked before a backup. A failure asks first rather than refusing, since a backup of
//     a failing database is worth more than none, and a restore that leaves them failing says so.
//   * A failed download reports itself. It used to be a browser navigation, so a refused export replaced
//     the app with a raw JSON error page; nothing in the section could say anything about it.
//   * Restoring follows from what the file is: a backup holding both parts offers each, and restoring
//     accounts that turn sign-in on asks for an administrator of the file once the server says so.
//   * A reason the credentials are left out that this user can clear is cleared on this page, through the
//     App-level vault gate, and the warning follows the server's new answer.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { useState } from 'react'
import { render, screen, cleanup, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const downloadUrl = vi.fn()
const saveUrlToFile = vi.fn()
const trashBackupHistoryEntry = vi.fn()
const restoreCredentialsFile = vi.fn()
const restoreBackupFile = vi.fn()
const runBackupPasskeyCeremony = vi.fn()
const unlockVault = vi.fn()
const changeVaultPassphrase = vi.fn()
// Mutable so a test can decide how many recipients exist before rendering: the picker's whole contract is
// that it appears only when there is more than one, so both sides of that need a different fixture.
let recipients = []
// What the chosen file turns out to be, per test.
let inspection = { kind: 'credentials', container: 'zip', encrypted: false }
const NOTHING_LEFT_OUT = { credentials_left_out: null, encrypted_credentials_left_out: null, passphrases_left_out: [] }
let backupStatus = NOTHING_LEFT_OUT
const PASSED = { ok: true, databases: {} }
let databaseCheck = PASSED
let checksRun = 0

vi.mock('../../../lib/api.js', () => ({
  downloadUrl: (...args) => downloadUrl(...args),
  saveUrlToFile: (...args) => saveUrlToFile(...args),
  holdSessionLost: () => { },
  api: {
    getBackupRecipients: async () => recipients,
    getAuthStatus: async () => ({ user: { vault_configured: true, vault_unlocked: true } }),
    getBackupStatus: async () => backupStatus,
    checkDatabases: async () => { checksRun += 1; return databaseCheck },
    getBackupHistory: async () => ({ backups: [], retention_days: 365 }),
    exportBackup: (encrypted, ids, savedAs) => (
      encrypted
        ? `/api/import-export/backup?encrypted=true${ids?.length ? `&recipients=${ids.join(',')}` : ''}`
        : `/api/import-export/backup${savedAs ? `?saved_as=${savedAs}` : ''}`
    ),
    trashBackupHistoryEntry: (...args) => trashBackupHistoryEntry(...args),
    inspectBackupFile: async () => inspection,
    getRestoreTargetStatus: async () => ({ has_data: true }),
    restoreCredentialsFile: (...args) => restoreCredentialsFile(...args),
    restoreBackupFile: (...args) => restoreBackupFile(...args),
    unlockVault: (...args) => unlockVault(...args),
    changeVaultPassphrase: (...args) => changeVaultPassphrase(...args),
    vaultCredentialsBackups: async () => ({ backups: [] }),
    vaultPassphraseStrength: async () => ({ score: 4, shortfall: null }),
  },
}))

// WebAuthn, which jsdom cannot run. Under test is what the section does with the ceremony's outcome.
vi.mock('../../../lib/vaultPasskey.js', async (importOriginal) => ({
  ...(await importOriginal()),
  runBackupPasskeyCeremony: (...args) => runBackupPasskeyCeremony(...args),
}))

const { default: BackupRestoreSection } = await import('../BackupRestoreSection.jsx')
const { AppSessionProvider } = await import('../../../lib/AppSessionContext.jsx')
const { VaultGateProvider, VaultGateRenderer } = await import('../../../contexts/VaultGateContext.jsx')

const VAULT_USER = { id: 'u1', vault_configured: true, vault_unlocked: true, vault_has_passphrase: true }

// The App's arrangement: the session holds the user, and the vault gate and its dialogs sit above the page.
function Harness({ user }) {
  const [currentUser, setCurrentUser] = useState(user)
  return (
    <AppSessionProvider value={{ demoLoaded: false, currentUser, setCurrentUser }}>
      <VaultGateProvider>
        <BackupRestoreSection />
        <VaultGateRenderer />
      </VaultGateProvider>
    </AppSessionProvider>
  )
}

const renderSection = (user = VAULT_USER) => render(<Harness user={user} />)

afterEach(() => {
  cleanup(); downloadUrl.mockReset(); restoreCredentialsFile.mockReset(); runBackupPasskeyCeremony.mockReset()
  saveUrlToFile.mockReset(); trashBackupHistoryEntry.mockReset(); delete window.showSaveFilePicker
  restoreBackupFile.mockReset(); unlockVault.mockReset(); changeVaultPassphrase.mockReset()
  recipients = []
  inspection = { kind: 'credentials', container: 'zip', encrypted: false }
  backupStatus = NOTHING_LEFT_OUT
  databaseCheck = PASSED
  checksRun = 0
})

const KEYS = [
  { id: 'r1', label: 'Home NAS', fingerprint: 'SHA256:aaa', enabled: 1 },
  { id: 'r2', label: 'Offsite drive', fingerprint: 'SHA256:bbb', enabled: 1 },
]

describe('the backup', () => {
  it('is plain from its own button', async () => {
    renderSection()
    await userEvent.click(await screen.findByRole('button', { name: 'Generate backup' }))
    await waitFor(() => expect(downloadUrl).toHaveBeenCalledWith('/api/import-export/backup'))
    expect(screen.queryByText('Generate credentials backup')).toBeNull()
  })

  it('cannot be encrypted until there is a backup key', async () => {
    renderSection()
    const button = await screen.findByRole('button', { name: 'Generate encrypted backup' })
    expect(button.disabled).toBe(true)
    expect(screen.getByText('Add a backup key below to encrypt backups.')).toBeTruthy()
  })

  it('says beforehand when the credentials will be left out, and why', async () => {
    backupStatus = { ...NOTHING_LEFT_OUT, credentials_left_out: { code: 'no_strong_unlock', message: 'Unencrypted backups will not contain the credentials.' } }
    renderSection()
    expect(await screen.findByText('Unencrypted backups will not contain the credentials.')).toBeTruthy()
  })

  it('names the passphrases an unencrypted backup leaves out', async () => {
    backupStatus = {
      ...NOTHING_LEFT_OUT,
      passphrases_left_out: [
        { user_id: 'u1', name: 'Robin', code: 'passphrase_unchecked', own: false },
        { user_id: 'u2', name: 'Sam', code: 'weak_passphrase', own: false },
      ],
    }
    renderSection()
    expect(await screen.findByText(
      'Unencrypted backups leave out these vault passphrases: Robin (not validated against the current strength rule), Sam (too easy to guess). Encrypted backups include them.',
    )).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Validate passphrase' })).toBeNull()
  })

  // The whole journey a user with a passkey makes, because each step depends on the last crossing a
  // component boundary: the page's button opens the App-level dialog, the dialog's answer replaces the
  // session user, and that is what makes the page ask the server again.
  it('lets an unchecked passphrase be checked and then changed without leaving the page', async () => {
    const user = { ...VAULT_USER, vault_passphrase_needs_check: true, vault_passkeys: [{ id: 'pk1' }] }
    const ownLeftOut = code => ({ ...NOTHING_LEFT_OUT, passphrases_left_out: [{ user_id: 'u1', name: 'Avery', code, own: true }] })
    backupStatus = ownLeftOut('passphrase_unchecked')
    // Typing it shows the passphrase fails the rule.
    unlockVault.mockImplementation(async () => {
      backupStatus = ownLeftOut('weak_passphrase')
      return { user: { ...user, vault_passphrase_needs_check: false, vault_passphrase_needs_change: true } }
    })
    changeVaultPassphrase.mockImplementation(async () => {
      backupStatus = NOTHING_LEFT_OUT
      return { user: { ...user, vault_passphrase_needs_check: false, vault_passphrase_needs_change: false } }
    })
    renderSection(user)

    await userEvent.click(await screen.findByRole('button', { name: 'Validate passphrase' }))
    await screen.findByText('Validate the vault passphrase')
    // A passkey would open the vault and leave the passphrase unjudged, so it is not offered.
    expect(screen.queryByRole('button', { name: /passkey/i })).toBeNull()
    await userEvent.type(screen.getByPlaceholderText('Vault passphrase'), 'the old passphrase')
    await userEvent.click(screen.getByRole('button', { name: 'Validate' }))
    expect(unlockVault).toHaveBeenCalledWith('the old passphrase')

    await userEvent.click(await screen.findByRole('button', { name: 'Change passphrase' }))
    await screen.findByText('Change the vault passphrase')
    const next = 'a much longer passphrase than before'
    await userEvent.type(screen.getByPlaceholderText(/^Current passphrase/), 'the old passphrase')
    await userEvent.type(screen.getByPlaceholderText('New passphrase'), next)
    await userEvent.type(screen.getByPlaceholderText('Confirm new passphrase'), next)
    await screen.findByText('Strong')
    // The warning's button and the dialog's share a name; the dialog renders after the page.
    await userEvent.click(screen.getAllByRole('button', { name: 'Change passphrase' }).at(-1))
    expect(changeVaultPassphrase).toHaveBeenCalledWith('the old passphrase', next)

    await waitFor(() => expect(screen.queryByText(/Avery \(too easy to guess\)/)).toBeNull())
  })

  it('asks before an unencrypted backup that would leave out a passphrase, and makes nothing on cancel', async () => {
    backupStatus = { ...NOTHING_LEFT_OUT, passphrases_left_out: [{ user_id: 'u2', name: 'Robin', code: 'weak_passphrase', own: false }] }
    renderSection()
    await userEvent.click(await screen.findByRole('button', { name: 'Generate backup' }))
    await screen.findByText('Generate an unencrypted backup?')
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(downloadUrl).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: 'Generate backup' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(downloadUrl).toHaveBeenCalledWith('/api/import-export/backup'))
  })

  it('asks before backing up databases that failed their check, and makes nothing on cancel', async () => {
    databaseCheck = { ok: false, databases: {} }
    renderSection()
    await userEvent.click(await screen.findByRole('button', { name: 'Generate backup' }))
    await screen.findByText('Back up a database that failed its check?')
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(downloadUrl).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: 'Generate backup' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Back up anyway' }))
    await waitFor(() => expect(downloadUrl).toHaveBeenCalledWith('/api/import-export/backup'))
  })

  it('refuses outright when the server cannot read attached document files', async () => {
    databaseCheck = { ok: false, databases: { documents: { ok: false, unreadable: 2 } } }
    renderSection()
    await userEvent.click(await screen.findByRole('button', { name: 'Generate backup' }))
    await waitFor(() => expect(checksRun).toBe(1))
    await act(async () => {})
    expect(screen.queryByText('Back up a database that failed its check?')).toBeNull()
    expect(downloadUrl).not.toHaveBeenCalled()
  })

  it('reports a failed download in the page instead of navigating away', async () => {
    downloadUrl.mockRejectedValueOnce(Object.assign(new Error('No enabled backup keys are configured'), { status: 400 }))

    renderSection()
    await userEvent.click(await screen.findByRole('button', { name: 'Generate backup' }))

    await waitFor(() => {
      expect(screen.getByText(/No enabled backup keys are configured/)).toBeTruthy()
    })
  })

  it('routes the download through the fetching helper, not an href', async () => {
    renderSection()
    const button = await screen.findByRole('button', { name: 'Generate backup' })
    // A <a href> wrapper is what made every error a raw JSON page; the button must not sit inside one.
    expect(button.closest('a')).toBeNull()
  })
})

describe('the backup with a save picker', () => {
  const pickFile = name => { window.showSaveFilePicker = vi.fn().mockResolvedValue({ name }) }

  it('makes nothing when the picker is cancelled', async () => {
    window.showSaveFilePicker = vi.fn().mockRejectedValue(new DOMException('cancelled', 'AbortError'))
    renderSection()
    await userEvent.click(await screen.findByRole('button', { name: 'Generate backup' }))

    await waitFor(() => expect(window.showSaveFilePicker).toHaveBeenCalled())
    expect(saveUrlToFile).not.toHaveBeenCalled()
    expect(downloadUrl).not.toHaveBeenCalled()
  })

  it('tells the history the name chosen and says where it was saved', async () => {
    pickFile('renamed.zip')
    saveUrlToFile.mockResolvedValue(undefined)
    renderSection()
    await userEvent.click(await screen.findByRole('button', { name: 'Generate backup' }))

    await screen.findByText('Saved as renamed.zip')
    expect(saveUrlToFile.mock.calls[0][0]).toBe('/api/import-export/backup?saved_as=renamed.zip')
    expect(downloadUrl).not.toHaveBeenCalled()
  })

  it('takes a backup that could not be written out of the history', async () => {
    pickFile('full-disk.zip')
    saveUrlToFile.mockRejectedValue(Object.assign(new DOMException('No space left', 'InvalidStateError'), {
      headers: new Headers({ 'X-Backup-Id': 'b1' }),
    }))
    trashBackupHistoryEntry.mockResolvedValue({ backups: [] })
    renderSection()
    await userEvent.click(await screen.findByRole('button', { name: 'Generate backup' }))

    await waitFor(() => expect(trashBackupHistoryEntry).toHaveBeenCalledWith('b1'))
    expect(screen.queryByText(/Saved as/)).toBeNull()
  })
})

// Choosing who can read an encrypted backup is a per-backup decision, but only when there is a decision:
// with one recipient the picker would be a dialog showing a single entry that is always accepted, which
// trains dismissal rather than providing verification.
describe('encrypted backup recipient scope', () => {
  it('starts immediately when there is only one recipient', async () => {
    const user = userEvent.setup()
    recipients = [KEYS[0]]
    renderSection()

    await user.click(await screen.findByRole('button', { name: 'Generate encrypted backup' }))

    expect(screen.queryByText(/Who should be able to read/)).toBeNull()
    expect(downloadUrl).toHaveBeenCalledWith('/api/import-export/backup?encrypted=true')
  })

  it('asks which keys when there is more than one, and downloads nothing until confirmed', async () => {
    const user = userEvent.setup()
    recipients = KEYS
    renderSection()

    await user.click(await screen.findByRole('button', { name: 'Generate encrypted backup' }))

    await screen.findByText(/Who should be able to read/)
    expect(downloadUrl).not.toHaveBeenCalled()

    // Every enabled recipient is pre-ticked; unticking one narrows the file to the rest.
    await user.click(screen.getByRole('checkbox', { name: /^Home NAS/ }))
    // The dialog's button shares the page button's label and renders after it.
    await user.click(screen.getAllByRole('button', { name: 'Generate encrypted backup' }).at(-1))

    expect(downloadUrl).toHaveBeenCalledWith('/api/import-export/backup?encrypted=true&recipients=r2')
  })

  it('cancelling downloads nothing', async () => {
    const user = userEvent.setup()
    recipients = KEYS
    renderSection()
    await user.click(await screen.findByRole('button', { name: 'Generate encrypted backup' }))
    await screen.findByText(/Who should be able to read/)

    await user.click(screen.getByText('Cancel'))

    expect(downloadUrl).not.toHaveBeenCalled()
  })
})

// The order is a decision, not an accident, and it is invisible in a diff that moves one JSX block: the
// key list is the only section that can grow, so it sits last where growth cannot push another heading
// off the page. Backup leads because it is what the section is for.
describe('section order', () => {
  it('runs Backup, then Restore, then the key list', async () => {
    recipients = KEYS
    renderSection()
    await screen.findByRole('button', { name: 'Generate backup' })

    const headings = ['Backup', 'Restore', 'Backup file encryption keys']
      .map(text => screen.getByText(text))
    const [backup, restore, keys] = headings
    // Node.compareDocumentPosition: 4 === the argument follows this node in the document.
    expect(backup.compareDocumentPosition(restore) & 4).toBeTruthy()
    expect(restore.compareDocumentPosition(keys) & 4).toBeTruthy()
  })
})

// A credentials backup whose credentials are not valid here as they stand has to be opened with one of the
// secrets of the member who made it. The server says which the file carries and which this page can use;
// the section offers exactly those, and sends back whichever one is used.
describe('restoring a credentials backup that needs a secret', () => {
  const FILE = new File(['{}'], 'luma_credentials.zip', { type: 'application/zip' })

  function secretRequired(options) {
    return Object.assign(new Error('This backup came from another install.'), {
      status: 400,
      detail: { code: 'backup_secret_required', message: 'This backup came from another install.', unlock_options: options },
    })
  }

  async function chooseAndAttempt(user) {
    await user.upload(screen.getByLabelText('Choose backup file to restore'), FILE)
    await screen.findByText(/Data provider credentials, still encrypted/)
    await user.click(screen.getByRole('button', { name: 'Restore credentials' }))
    // The confirmation overlay's own button, which carries the same label.
    const buttons = await screen.findAllByRole('button', { name: 'Restore credentials' })
    await user.click(buttons[buttons.length - 1])
  }

  // Restore again once a secret is typed: the button, then the confirmation's.
  async function chooseAgain(user) {
    await user.click(screen.getByRole('button', { name: 'Restore credentials' }))
    const buttons = await screen.findAllByRole('button', { name: 'Restore credentials' })
    await user.click(buttons[buttons.length - 1])
  }

  it('offers the passphrase and the dated recovery code the file carries, and sends the one typed', async () => {
    const user = userEvent.setup()
    restoreCredentialsFile
      .mockRejectedValueOnce(secretRequired({
        passphrase: true, recovery_code: { issued_at: '2026-09-01T10:00:00Z' }, passkeys: [], rp_id: null,
      }))
      .mockResolvedValueOnce({ restored: 2 })
    renderSection()
    await chooseAndAttempt(user)

    expect(await screen.findByPlaceholderText('Vault passphrase this backup was made with')).toBeTruthy()
    const code = screen.getByPlaceholderText(/recovery code issued Sep 1, 2026/)
    expect(screen.queryByText(/Restore with passkey/)).toBeNull()

    await user.type(code, 'ABCD-EFGH')
    await chooseAgain(user)
    await waitFor(() => expect(restoreCredentialsFile).toHaveBeenLastCalledWith(FILE, { recovery_code: 'ABCD-EFGH' }))
  })

  it('restores with a passkey the server offered, in one press', async () => {
    const user = userEvent.setup()
    restoreCredentialsFile
      .mockRejectedValueOnce(secretRequired({
        passphrase: true, recovery_code: null, rp_id: 'luma.local',
        passkeys: [{ credential_id: 'cred-1', prf_salt: 'c2FsdA==', label: 'Laptop' }],
      }))
      .mockResolvedValueOnce({ restored: 2 })
    runBackupPasskeyCeremony.mockResolvedValueOnce({ ok: true, credentialId: 'cred-1', prfOutput: 'cHJm' })
    renderSection()
    await chooseAndAttempt(user)

    await user.click(await screen.findByRole('button', { name: 'Restore with passkey “Laptop”' }))

    expect(runBackupPasskeyCeremony).toHaveBeenCalledWith({ rpId: 'luma.local', credentialId: 'cred-1', prfSalt: 'c2FsdA==' })
    await waitFor(() => expect(restoreCredentialsFile).toHaveBeenLastCalledWith(FILE, {
      passkey_credential_id: 'cred-1', passkey_prf_output: 'cHJm',
    }))
  })
})

// A backup holds both parts, and what to put back is the user's to choose. Restoring accounts that turn
// sign-in on needs an administrator of the file before anything is touched.
describe('restoring a backup that holds both parts', () => {
  const FILE = new File(['{}'], 'luma_backup.zip', { type: 'application/zip' })

  async function choose(user, extra = {}) {
    inspection = { kind: 'full', container: 'zip', encrypted: false, credentials_included: true, ...extra }
    await user.upload(screen.getByLabelText('Choose backup file to restore'), FILE)
    await screen.findByRole('group', { name: 'What to restore' })
  }

  // The restore button, then the confirmation's, which carries `confirmLabel` (the same label unless given).
  async function restore(user, label, confirmLabel = label) {
    await user.click(screen.getByRole('button', { name: label }))
    const buttons = await screen.findAllByRole('button', { name: confirmLabel })
    await user.click(buttons[buttons.length - 1])
  }

  const parts = (includeData, includeAccounts, adminUsername = '', adminPassword = '', includeCredentials = includeAccounts) => (
    { includeData, includeAccounts, includeCredentials, adminUsername, adminPassword }
  )

  it('restores everything by default, and says everyone was signed out', async () => {
    const user = userEvent.setup()
    restoreBackupFile.mockResolvedValue({ restored_counts: {}, accounts: { users: 2 }, signed_out: true })
    renderSection()
    await choose(user)

    await restore(user, 'Restore everything')
    await waitFor(() => expect(restoreBackupFile).toHaveBeenLastCalledWith(FILE, null, '', false, parts(true, true)))
    expect(await screen.findByText(/Everyone has been signed out/)).toBeTruthy()
  })

  it('says when the databases failed their check after the restore', async () => {
    const user = userEvent.setup()
    restoreBackupFile.mockResolvedValue({ restored_counts: {}, accounts: { users: 2 }, signed_out: true, database_check_passed: false })
    renderSection()
    await choose(user)

    await restore(user, 'Restore everything')
    expect(await screen.findByText(/The databases failed their check afterwards/)).toBeTruthy()
  })

  it('restores only what is ticked, and nothing when nothing is', async () => {
    const user = userEvent.setup()
    restoreBackupFile.mockResolvedValue({ accounts: { users: 1 }, signed_out: true })
    renderSection()
    await choose(user)

    await user.click(screen.getByRole('checkbox', { name: /Ledger/ }))
    await restore(user, 'Restore users & security')
    await waitFor(() => expect(restoreBackupFile).toHaveBeenLastCalledWith(FILE, null, '', false, parts(false, true)))

    await user.click(screen.getByRole('checkbox', { name: /Users & security/ }))
    expect(screen.getByRole('button', { name: 'Restore ledger' }).disabled).toBe(true)
  })

  it('restores only the ledger when that is all that is ticked', async () => {
    const user = userEvent.setup()
    restoreBackupFile.mockResolvedValue({ restored_counts: {} })
    renderSection()
    await choose(user)

    await user.click(screen.getByRole('checkbox', { name: /Users & security/ }))
    await restore(user, 'Restore ledger', 'Restore ledger backup')
    await waitFor(() => expect(restoreBackupFile).toHaveBeenLastCalledWith(FILE, null, '', false, parts(true, false)))
  })

  it('restores the users & security without the credentials when they are not ticked', async () => {
    const user = userEvent.setup()
    restoreBackupFile.mockResolvedValue({ restored_counts: {}, accounts: { users: 1 }, signed_out: true })
    renderSection()
    await choose(user)

    await user.click(screen.getByRole('checkbox', { name: /Data provider credentials/ }))
    await restore(user, 'Restore ledger, users & security')
    await waitFor(() => expect(restoreBackupFile).toHaveBeenLastCalledWith(FILE, null, '', false, parts(true, true, '', '', false)))
  })

  it('offers the credentials only with the users & security', async () => {
    const user = userEvent.setup()
    renderSection()
    await choose(user)

    await user.click(screen.getByRole('checkbox', { name: /Users & security/ }))
    expect(screen.getByRole('checkbox', { name: /Data provider credentials/ }).disabled).toBe(true)
  })

  it('says when the file holds no data provider credentials', async () => {
    const user = userEvent.setup()
    renderSection()
    await choose(user, { credentials_included: false })
    expect(screen.getByText(/This backup does not contain data provider credentials/)).toBeTruthy()
    expect(screen.queryByRole('checkbox', { name: /Data provider credentials/ })).toBeNull()
  })

  it('asks for an administrator of the backup when the server says so, and sends what is typed', async () => {
    const user = userEvent.setup()
    restoreBackupFile
      .mockRejectedValueOnce(Object.assign(new Error('This backup turns sign-in on.'), {
        status: 400,
        detail: { code: 'admin_password_required', message: 'This backup turns sign-in on.', admins: ['Avery'] },
      }))
      .mockResolvedValueOnce({ accounts: { users: 1 }, signed_out: true })
    renderSection()
    await choose(user)
    await restore(user, 'Restore everything')

    expect(await screen.findByText(/Administrators in it: Avery/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Restore everything' }).disabled).toBe(true)

    await user.type(screen.getByLabelText('Administrator username'), 'Avery')
    await user.type(screen.getByLabelText('Administrator password'), 'their-password')
    await restore(user, 'Restore everything')
    await waitFor(() => expect(restoreBackupFile).toHaveBeenLastCalledWith(
      FILE, null, '', false, parts(true, true, 'Avery', 'their-password'),
    ))
  })

  it('asks about credentials under a key this system retired, and restores with the answer', async () => {
    const user = userEvent.setup()
    restoreBackupFile
      .mockRejectedValueOnce(Object.assign(new Error('retired'), {
        status: 409,
        detail: {
          code: 'credentials_retired', reason: 'replaced', retired_at: '2026-11-07 04:49:56',
          confirm_phrase: 'RESTORE ANYWAY',
        },
      }))
      .mockResolvedValueOnce({ restored_counts: {}, accounts: { users: 1 }, signed_out: true })
    renderSection()
    await choose(user)
    await restore(user, 'Restore everything')

    expect(await screen.findByText(/This system replaced the vault key these credentials are under/)).toBeTruthy()
    const anyway = screen.getByRole('button', { name: 'Restore them anyway' })
    expect(anyway.disabled).toBe(true)
    await user.type(screen.getByLabelText('Confirmation phrase'), 'restore anyway')
    await user.click(anyway)
    await waitFor(() => expect(restoreBackupFile).toHaveBeenLastCalledWith(
      FILE, null, '', false,
      { ...parts(true, true), restoreRetiredCredentials: true, retiredCredentialsConfirm: 'restore anyway' },
    ))
  })
})
