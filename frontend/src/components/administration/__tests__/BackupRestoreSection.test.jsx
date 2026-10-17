// @vitest-environment jsdom

// The backup section's contracts:
//
//   * One backup, always everything, plain or encrypted from its own button; the page says beforehand when the
//     credentials will be left out of it.
//   * A failed download reports itself. It used to be a browser navigation, so a refused export replaced
//     the app with a raw JSON error page; nothing in the section could say anything about it.
//   * Restoring follows from what the file is: a backup holding both parts offers each, and restoring
//     accounts that turn sign-in on asks for an administrator of the file once the server says so.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const downloadUrl = vi.fn()
const restoreCredentialsFile = vi.fn()
const restoreBackupFile = vi.fn()
const runBackupPasskeyCeremony = vi.fn()
// Mutable so a test can decide how many recipients exist before rendering: the picker's whole contract is
// that it appears only when there is more than one, so both sides of that need a different fixture.
let recipients = []
// What the chosen file turns out to be, per test.
let inspection = { kind: 'credentials', container: 'zip', encrypted: false }
let backupStatus = { credentials_left_out: null }

vi.mock('../../../lib/api.js', () => ({
  downloadUrl: (...args) => downloadUrl(...args),
  api: {
    getBackupRecipients:        async () => recipients,
    getAuthStatus:              async () => ({ user: { vault_configured: true, vault_unlocked: true } }),
    getBackupStatus:            async () => backupStatus,
    exportBackup:               (encrypted, ids) => (
      encrypted
        ? `/api/import-export/backup?encrypted=true${ids?.length ? `&recipients=${ids.join(',')}` : ''}`
        : '/api/import-export/backup'
    ),
    inspectBackupFile:          async () => inspection,
    getRestoreTargetStatus:     async () => ({ has_data: true }),
    restoreCredentialsFile:     (...args) => restoreCredentialsFile(...args),
    restoreBackupFile:          (...args) => restoreBackupFile(...args),
  },
}))

// WebAuthn, which jsdom cannot run. Under test is what the section does with the ceremony's outcome.
vi.mock('../../../lib/vaultPasskey.js', async (importOriginal) => ({
  ...(await importOriginal()),
  runBackupPasskeyCeremony: (...args) => runBackupPasskeyCeremony(...args),
}))

const { default: BackupRestoreSection } = await import('../BackupRestoreSection.jsx')
const { AppSessionProvider } = await import('../../../lib/AppSessionContext.jsx')

const renderSection = () => render(<AppSessionProvider value={{ demoLoaded: false }}><BackupRestoreSection /></AppSessionProvider>)

afterEach(() => {
  cleanup(); downloadUrl.mockReset(); restoreCredentialsFile.mockReset(); runBackupPasskeyCeremony.mockReset()
  restoreBackupFile.mockReset()
  recipients = []
  inspection = { kind: 'credentials', container: 'zip', encrypted: false }
  backupStatus = { credentials_left_out: null }
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
    backupStatus = { credentials_left_out: { code: 'passphrase_unchecked', message: 'Unlock the vault by typing it.' } }
    renderSection()
    expect(await screen.findByText(/will not include the data provider credentials. Unlock the vault by typing it./)).toBeTruthy()
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
    await user.click(screen.getByText('Encrypt backup'))

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

    const headings = ['Backup', 'Restore', 'Backup encryption keys']
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

  const parts = (includeData, includeAccounts, adminUsername = '', adminPassword = '') => (
    { includeData, includeAccounts, adminUsername, adminPassword }
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

  it('restores only what is ticked, and nothing when nothing is', async () => {
    const user = userEvent.setup()
    restoreBackupFile.mockResolvedValue({ accounts: { users: 1 }, signed_out: true })
    renderSection()
    await choose(user)

    await user.click(screen.getByRole('checkbox', { name: /Financial data/ }))
    await restore(user, 'Restore accounts & secrets')
    await waitFor(() => expect(restoreBackupFile).toHaveBeenLastCalledWith(FILE, null, '', false, parts(false, true)))

    await user.click(screen.getByRole('checkbox', { name: /Accounts & secrets/ }))
    expect(screen.getByRole('button', { name: 'Restore data' }).disabled).toBe(true)
  })

  it('restores only the financial data when that is all that is ticked', async () => {
    const user = userEvent.setup()
    restoreBackupFile.mockResolvedValue({ restored_counts: {} })
    renderSection()
    await choose(user)

    await user.click(screen.getByRole('checkbox', { name: /Accounts & secrets/ }))
    await restore(user, 'Restore data', 'Restore data backup')
    await waitFor(() => expect(restoreBackupFile).toHaveBeenLastCalledWith(FILE, null, '', false, parts(true, false)))
  })

  it('says when the file holds no data provider credentials', async () => {
    const user = userEvent.setup()
    renderSection()
    await choose(user, { credentials_included: false })
    expect(screen.getByText(/This backup holds no data provider credentials/)).toBeTruthy()
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
})
