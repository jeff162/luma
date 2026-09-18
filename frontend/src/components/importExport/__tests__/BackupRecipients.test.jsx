// @vitest-environment jsdom

// Adding a recipient has one rule that is easy to enforce in the wrong place: names must be unique.
// The server refuses a duplicate whenever it is asked, but *when* the UI asks decides what a collision
// costs. In the generator it is the difference between "pick another name" and having already been told
// to save a key file named for a name that cannot be kept — the name is locked once the key exists, so
// a check at "add recipient" arrives after the expensive part.

// Note on the assertions: the shared `Button` simulates disabled with opacity and by dropping its
// handler, and never sets the DOM `disabled` attribute — so `button.disabled` is always false and would
// make every check here pass vacuously. These click the control and assert the call did not happen,
// which is the contract that matters anyway.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const generateBackupKeypair = vi.fn()
const createBackupRecipient = vi.fn()
const saveBlob = vi.fn()

vi.mock('../../../lib/api.js', () => ({
  saveBlob: (...args) => saveBlob(...args),
  api: {
    getBackupRecipients:    async () => ([
      { id: 'r1', label: 'test2', fingerprint: 'SHA256:aaa', enabled: 1, public_key: 'PUBLIC-PEM' },
    ]),
    generateBackupKeypair:  (...args) => generateBackupKeypair(...args),
    createBackupRecipient:  (...args) => createBackupRecipient(...args),
    updateBackupRecipient:  async () => ({}),
    deleteBackupRecipient:  async () => ({}),
  },
}))

const { BackupRecipients } = await import('../BackupRecipients.jsx')
const { BACKUP_KEY_PASSWORD_MANAGER_USERNAME } = await import('../../../lib/sensitiveFields.js')

afterEach(() => {
  cleanup()
  generateBackupKeypair.mockReset()
  createBackupRecipient.mockReset()
  saveBlob.mockReset()
})

// The real endpoint answers with the created row, and the list prepends whatever it gets — so a mock
// resolving to undefined is not just unrealistic, it puts a hole in the list the component then renders.
function createdRow(label) {
  return { id: `id-${label}`, label, fingerprint: 'SHA256:new', enabled: 1 }
}

async function openGenerateDialog(user) {
  render(<BackupRecipients />)
  await screen.findByText('test2')                       // the existing recipient has loaded
  await user.click(screen.getByText('Generate a key pair'))
  return screen.getByLabelText('Backup key name')
}

describe('backup recipient names are checked before the key is made', () => {
  it('refuses to generate under a name already in use', async () => {
    const user = userEvent.setup()
    const nameField = await openGenerateDialog(user)

    await user.type(nameField, 'test2')

    expect(screen.getByText(/already exists/)).toBeTruthy()
    await user.click(screen.getByText('Generate'))
    expect(generateBackupKeypair).not.toHaveBeenCalled()
  })

  it('matches the server comparison — trimmed and case-insensitive', async () => {
    const user = userEvent.setup()
    const nameField = await openGenerateDialog(user)

    // A client check looser than the server's waves through a name the server will refuse, which puts
    // the failure back where it was.
    await user.type(nameField, '  TEST2 ')

    expect(screen.getByText(/already exists/)).toBeTruthy()
    await user.click(screen.getByText('Generate'))
    expect(generateBackupKeypair).not.toHaveBeenCalled()
  })

  it('generates under a free name', async () => {
    const user = userEvent.setup()
    generateBackupKeypair.mockResolvedValueOnce({
      public_key: 'PUBLIC', private_key: 'PRIVATE', fingerprint: 'SHA256:bbb', encrypted: false,
    })
    const nameField = await openGenerateDialog(user)

    await user.type(nameField, 'test3')
    expect(screen.queryByText(/already exists/)).toBeNull()
    await user.click(screen.getByText('Generate'))

    expect(generateBackupKeypair).toHaveBeenCalled()
    expect(await screen.findByLabelText('Generated private key')).toBeTruthy()
  })

  it('applies the same check when pasting an existing key', async () => {
    const user = userEvent.setup()
    render(<BackupRecipients />)
    await screen.findByText('test2')
    await user.click(screen.getByText('Add a key'))

    await user.type(screen.getByLabelText('Backup key name'), 'test2')

    expect(screen.getByText(/already exists/)).toBeTruthy()
    await user.click(screen.getByText('Add key'))
    expect(createBackupRecipient).not.toHaveBeenCalled()
  })
})

// Saving the private key is what creates the recipient. Before it, nothing may create one (backups sealed
// to a key nobody kept); after it, nothing may discard one — a Cancel offered after the download is how a
// saved private key once ended up with no recipient behind it.
describe('saving the generated private key adds the recipient', () => {
  async function generateKey(user) {
    generateBackupKeypair.mockResolvedValueOnce({
      public_key: 'PUBLIC', private_key: 'PRIVATE', fingerprint: 'SHA256:bbb', encrypted: false,
    })
    const nameField = await openGenerateDialog(user)
    await user.type(nameField, 'test3')
    await user.click(screen.getByText('Generate'))
    return screen.findByLabelText('Generated private key')
  }

  it('adds on download, then offers only Done', async () => {
    const user = userEvent.setup()
    await generateKey(user)

    await user.click(screen.getByText('Done'))
    expect(createBackupRecipient).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Generated private key')).toBeTruthy()

    createBackupRecipient.mockResolvedValueOnce(createdRow('test3'))
    await user.click(screen.getByText('Download private key'))

    expect(createBackupRecipient).toHaveBeenCalledWith({ label: 'test3', public_key: 'PUBLIC' })
    await screen.findByText(/Backup key added/)
    expect(screen.queryByText('Cancel')).toBeNull()
    // The row's own name must not read back as a collision with itself.
    expect(screen.queryByText(/already exists/)).toBeNull()

    await user.click(screen.getByText('Done'))
    expect(screen.queryByLabelText('Generated private key')).toBeNull()
    expect(screen.getByText('test3')).toBeTruthy()
  })

  it('adds once however many copies are taken', async () => {
    const user = userEvent.setup()
    await generateKey(user)
    createBackupRecipient.mockResolvedValue(createdRow('test3'))

    await user.click(screen.getByText('Download private key'))
    await user.click(screen.getByText('Copy'))
    await screen.findByText(/Backup key added/)

    expect(createBackupRecipient).toHaveBeenCalledTimes(1)
  })

  it('counts a copy of the whole key made by hand', async () => {
    const user = userEvent.setup()
    const keyField = await generateKey(user)
    createBackupRecipient.mockResolvedValueOnce(createdRow('test3'))

    keyField.setSelectionRange(0, 3)
    fireEvent.copy(keyField)
    expect(createBackupRecipient).not.toHaveBeenCalled()

    keyField.setSelectionRange(0, keyField.value.length)
    fireEvent.copy(keyField)
    expect(createBackupRecipient).toHaveBeenCalledTimes(1)
  })

  it('offers a retry when adding fails', async () => {
    const user = userEvent.setup()
    await generateKey(user)
    createBackupRecipient.mockRejectedValueOnce(new Error('Server unavailable'))

    await user.click(screen.getByText('Download private key'))
    await screen.findByText('Server unavailable')

    createBackupRecipient.mockResolvedValueOnce(createdRow('test3'))
    await user.click(screen.getByText('Retry'))
    await screen.findByText(/Backup key added/)
    expect(createBackupRecipient).toHaveBeenCalledTimes(2)
  })
})

// The app holds the only copy of a public key once it is a recipient, so the row is the only place it can
// be got back from — which matters for adding the same recipient on a second install. (The private key
// needs no such export: a PKCS8 private key already contains its public half.)
describe('exporting a public key', () => {
  it('saves the row\u2019s key as a .pem named after the recipient', async () => {
    const user = userEvent.setup()
    render(<BackupRecipients />)
    await screen.findByText('test2')

    await user.click(screen.getByText('Export'))

    expect(saveBlob).toHaveBeenCalledTimes(1)
    const [blob, filename] = saveBlob.mock.calls[0]
    // `.pub` would read as an OpenSSH key, which this is not.
    expect(filename).toBe('test2-public-key.pem')
    expect(await blob.text()).toBe('PUBLIC-PEM')
  })
})

// A member sees the keys a backup is sealed to, and can export one, but cannot change them.
describe('BackupRecipients without authority to change the keys', () => {
  it('lists and exports the keys but offers nothing that changes them', async () => {
    render(<BackupRecipients canManage={false} />)
    await screen.findByText('test2')
    expect(screen.getByText('Adding, changing or removing backup keys needs an admin.')).toBeTruthy()
    expect(screen.queryByText('Add a key')).toBeNull()
    expect(screen.queryByText('Generate a key pair')).toBeNull()
    expect(screen.queryByLabelText('Delete backup key test2')).toBeNull()
    expect(screen.getByRole('checkbox').disabled).toBe(true)
    await userEvent.click(screen.getByText('Export'))
    expect(saveBlob).toHaveBeenCalled()
  })
})

describe('the key file passphrase', () => {
  it('is named ahead of the secret field, so a manager does not file it as the vault passphrase', async () => {
    const user = userEvent.setup()
    await openGenerateDialog(user)
    const username = document.querySelector('input[autocomplete="username"]')
    expect(username.value).toBe(BACKUP_KEY_PASSWORD_MANAGER_USERNAME)
    const secret = screen.getByLabelText('Passphrase for the generated key file')
    expect(username.compareDocumentPosition(secret) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
