// @vitest-environment jsdom

// The Backup tab's two contracts after the credentials backup became a ciphertext artifact:
//
//   * ONE credentials button. The encrypted variant is gone — the payload is already encrypted under
//     the vault, so a second RSA layer was offering a choice that no longer means anything.
//   * A failed download reports itself. It used to be a browser navigation, so a locked vault replaced
//     the app with a raw JSON error page; nothing in the tab could say anything about it.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const downloadUrl = vi.fn()
// Mutable so a test can decide how many recipients exist before rendering: the picker's whole contract is
// that it appears only when there is more than one, so both sides of that need a different fixture.
let recipients = []
// Mutable for the same reason: whether restore is offered depends on who is signed in.
const SIGN_IN_OFF = { user: { vault_configured: true, vault_unlocked: true } }
let authStatus = SIGN_IN_OFF

vi.mock('../../../lib/api.js', () => ({
  downloadUrl: (...args) => downloadUrl(...args),
  api: {
    getBackupRecipients:        async () => recipients,
    getCredentialsBackupStatus: async () => ({ has_credentials: true, credential_count: 2 }),
    getAuthStatus:              async () => authStatus,
    exportBackup:               (encrypted, ids) => (
      encrypted
        ? `/api/import-export/backup?encrypted=true${ids?.length ? `&recipients=${ids.join(',')}` : ''}`
        : '/api/import-export/backup'
    ),
    exportCredentials:          () => '/api/import-export/backup/credentials',
  },
}))

const { BackupRestoreTab } = await import('../BackupRestoreTab.jsx')
const { AppSessionProvider } = await import('../../../lib/AppSessionContext.jsx')

const renderTab = () => render(<AppSessionProvider value={{ demoLoaded: false }}><BackupRestoreTab /></AppSessionProvider>)

afterEach(() => { cleanup(); downloadUrl.mockReset(); recipients = []; authStatus = SIGN_IN_OFF })

const KEYS = [
  { id: 'r1', label: 'Home NAS', fingerprint: 'SHA256:aaa', enabled: 1 },
  { id: 'r2', label: 'Offsite drive', fingerprint: 'SHA256:bbb', enabled: 1 },
]

describe('BackupRestoreTab credentials backup', () => {
  it('offers exactly one credentials button, with no encrypted variant', async () => {
    renderTab()
    await screen.findByText('Generate credentials backup')
    expect(screen.queryByText('Generate encrypted credentials backup')).toBeNull()
    // The data backup keeps its encrypted choice — that one is a real choice.
    expect(screen.getByText('Generate encrypted backup')).toBeTruthy()
  })

  it('reports a failed download in the page instead of navigating away', async () => {
    const failure = Object.assign(new Error('Unlock the vault to export credentials.'), {
      status: 423, detail: { code: 'vault_locked' },
    })
    downloadUrl.mockRejectedValueOnce(failure)

    renderTab()
    await userEvent.click(await screen.findByText('Generate credentials backup'))

    await waitFor(() => {
      expect(screen.getByText(/Unlock the vault to export credentials/)).toBeTruthy()
    })
  })

  it('routes the download through the fetching helper, not an href', async () => {
    renderTab()
    const button = await screen.findByText('Generate credentials backup')
    // A <a href> wrapper is what made every error a raw JSON page; the button must not sit inside one.
    expect(button.closest('a')).toBeNull()

    await userEvent.click(button)
    await waitFor(() => {
      expect(downloadUrl).toHaveBeenCalledWith('/api/import-export/backup/credentials')
    })
  })
})

// Choosing who can read an encrypted backup is a per-backup decision, but only when there is a decision:
// with one recipient the picker would be a dialog showing a single entry that is always accepted, which
// trains dismissal rather than providing verification.
describe('encrypted backup recipient scope', () => {
  it('starts immediately when there is only one recipient', async () => {
    const user = userEvent.setup()
    recipients = [KEYS[0]]
    renderTab()
    await screen.findByText('Generate encrypted backup')

    await user.click(screen.getByText('Generate encrypted backup'))

    expect(screen.queryByText(/Who should be able to read/)).toBeNull()
    expect(downloadUrl).toHaveBeenCalledWith('/api/import-export/backup?encrypted=true')
  })

  it('asks which keys when there is more than one, and downloads nothing until confirmed', async () => {
    const user = userEvent.setup()
    recipients = KEYS
    renderTab()
    await screen.findByText('Generate encrypted backup')

    await user.click(screen.getByText('Generate encrypted backup'))

    await screen.findByText(/Who should be able to read/)
    expect(downloadUrl).not.toHaveBeenCalled()

    // Every enabled recipient is pre-ticked; unticking one narrows the file to the rest.
    await user.click(screen.getByRole('checkbox', { name: /Home NAS/ }))
    await user.click(screen.getByText('Encrypt backup'))

    expect(downloadUrl).toHaveBeenCalledWith('/api/import-export/backup?encrypted=true&recipients=r2')
  })

  it('cancelling downloads nothing', async () => {
    const user = userEvent.setup()
    recipients = KEYS
    renderTab()
    await screen.findByText('Generate encrypted backup')
    await user.click(screen.getByText('Generate encrypted backup'))
    await screen.findByText(/Who should be able to read/)

    await user.click(screen.getByText('Cancel'))

    expect(downloadUrl).not.toHaveBeenCalled()
  })
})

// The order is a decision, not an accident, and it is invisible in a diff that moves one JSX block: the
// key list is the only section that can grow, so it sits last where growth cannot push another heading
// off the page. Backup leads because it is what the page is for.
describe('section order', () => {
  it('runs Backup, then Restore, then the key list', async () => {
    recipients = KEYS
    renderTab()
    await screen.findByText('Generate encrypted backup')

    const headings = ['Backup', 'Restore', 'Backup Encryption Keys']
      .map(text => screen.getByText(text))
    const [backup, restore, keys] = headings
    // Node.compareDocumentPosition: 4 === the argument follows this node in the document.
    expect(backup.compareDocumentPosition(restore) & 4).toBeTruthy()
    expect(restore.compareDocumentPosition(keys) & 4).toBeTruthy()
  })
})

// Restore replaces the whole workspace, so with sign-in on it needs an admin. The server refuses a member
// regardless; what the tab owes them is not offering a picker that can only end in a refusal.
describe('BackupRestoreTab restore authority', () => {
  const member = { auth_enabled: true, user: { role: 'member', vault_configured: true, vault_unlocked: true } }
  const admin = { auth_enabled: true, user: { role: 'admin', vault_configured: true, vault_unlocked: true } }

  it('tells a member that restoring needs an admin, and does not take a file from them', async () => {
    authStatus = member
    recipients = KEYS
    renderTab()
    await screen.findByText('Restoring a backup needs an admin.')
    expect(screen.getByLabelText('Choose backup file to restore').disabled).toBe(true)
    await screen.findByText('Adding, changing or removing backup keys needs an admin.')
    expect(screen.queryByText('Add a key')).toBeNull()
  })

  it('offers an admin the restore and the key controls', async () => {
    authStatus = admin
    renderTab()
    await screen.findByText('Add a key')
    expect(screen.queryByText('Restoring a backup needs an admin.')).toBeNull()
    expect(screen.getByLabelText('Choose backup file to restore').disabled).toBe(false)
  })
})
