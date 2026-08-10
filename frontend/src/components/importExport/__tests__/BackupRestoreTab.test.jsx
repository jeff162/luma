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

vi.mock('../../../lib/api.js', () => ({
  downloadUrl: (...args) => downloadUrl(...args),
  api: {
    getDemoDataStatus:          async () => ({ loaded: false }),
    getBackupRecipients:        async () => [],
    getCredentialsBackupStatus: async () => ({ has_credentials: true, credential_count: 2 }),
    getAuthStatus:              async () => ({ user: { vault_configured: true, vault_unlocked: true } }),
    exportBackup:               () => '/api/import-export/backup',
    exportCredentials:          () => '/api/import-export/backup/credentials',
  },
}))

const { BackupRestoreTab } = await import('../BackupRestoreTab.jsx')

afterEach(() => { cleanup(); downloadUrl.mockReset() })

describe('BackupRestoreTab credentials backup', () => {
  it('offers exactly one credentials button, with no encrypted variant', async () => {
    render(<BackupRestoreTab />)
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

    render(<BackupRestoreTab />)
    await userEvent.click(await screen.findByText('Generate credentials backup'))

    await waitFor(() => {
      expect(screen.getByText(/Unlock the vault to export credentials/)).toBeTruthy()
    })
  })

  it('routes the download through the fetching helper, not an href', async () => {
    render(<BackupRestoreTab />)
    const button = await screen.findByText('Generate credentials backup')
    // A <a href> wrapper is what made every error a raw JSON page; the button must not sit inside one.
    expect(button.closest('a')).toBeNull()

    await userEvent.click(button)
    await waitFor(() => {
      expect(downloadUrl).toHaveBeenCalledWith('/api/import-export/backup/credentials')
    })
  })
})
